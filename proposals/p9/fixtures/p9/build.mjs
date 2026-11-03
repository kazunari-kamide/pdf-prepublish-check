// SPDX-License-Identifier: AGPL-3.0-only
//
// P9（添付ファイル）の合成 PDF と正解データを作る。
//   node fixtures/p9/build.mjs
// 名前・団体はすべて架空（山田太郎、○○市 など）。添付の中身も、作り物の小さなバイト列。
// 日時を固定しているので、何度作っても同じバイト列になる（乱数は使わない）。

import { createHash } from "node:crypto";
import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXED = new Date(Date.UTC(2026, 10, 1, 0, 0, 0));

// ---------- 添付の中身（作り物） ----------
const enc = (s) => new TextEncoder().encode(s);
const fakeXlsx = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...enc("fake-xlsx: 氏名,住所\n山田太郎,○○市1-2-3\n")]);
const fakeDocx = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...enc("fake-docx: 見積の原本（架空）\n")]);
const fakeOle = () => new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...enc("fake-xls\n")]);
const csv = (s) => enc(s);

async function base(label, pages = 1) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([420, 300]);
    page.drawText(`P9 test: ${label} (page ${p})`, { x: 40, y: 250, size: 14, font });
  }
  return { doc, font };
}

const attach = (doc, bytes, name, mimeType) =>
  doc.attach(bytes, name, { mimeType, description: "test", creationDate: FIXED, modificationDate: FIXED });

/** 中身のストリームと、それを指すファイル指定を作る（名前の木に入れない）。返す：ファイル指定の参照 */
function makeFilespec(doc, bytes, name, subtype) {
  const ctx = doc.context;
  const ef = ctx.register(ctx.flateStream(bytes, { Type: "EmbeddedFile", Subtype: subtype, Params: { Size: bytes.length } }));
  return ctx.register(ctx.obj({ Type: "Filespec", F: PDFString.of("attachment.bin"), UF: PDFHexString.fromText(name), EF: { F: ef, UF: ef } }));
}

/** 中身のない（外のファイルを指すだけの）ファイル指定 */
const externalFilespec = (doc, name) => doc.context.register(doc.context.obj({ Type: "Filespec", F: PDFString.of("external.bin"), UF: PDFHexString.fromText(name) }));

function addAnnot(doc, pageIndex, dict) {
  const page = doc.getPages()[pageIndex];
  page.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Rect: [40, 40, 60, 60], F: 4, ...dict })));
}

const fileAttachmentAnnot = (doc, pageIndex, fsRef) =>
  addAnnot(doc, pageIndex, { Subtype: "FileAttachment", FS: fsRef, Name: "PushPin", Contents: PDFHexString.fromText("添付") });

const save = (doc, objectStreams = false) => doc.save({ useObjectStreams: objectStreams, addDefaultPage: false, updateFieldAppearances: false });

const latin1 = (b) => Buffer.from(b).toString("latin1");

/** 増分更新：文書の根（/Root）を、添付を持たない新しい中身で上書きする（表の形の xref） */
function appendCatalogWithoutAttachments(bytes) {
  const s = latin1(bytes);
  const tr = s.slice(s.lastIndexOf("trailer"));
  const size = Number(/\/Size\s+(\d+)/.exec(tr)[1]);
  const rootNum = Number(/\/Root\s+(\d+)\s+0\s+R/.exec(tr)[1]);
  const prev = Number(/startxref\s+(\d+)/.exec(s.slice(s.lastIndexOf("startxref")))[1]);
  const cat = new RegExp(`(?:^|\\n)${rootNum} 0 obj[\\s\\S]*?/Pages\\s+(\\d+)\\s+0\\s+R`).exec(s);
  const pagesNum = Number(cat[1]);
  const objAt = bytes.length + 1;
  const obj = `${rootNum} 0 obj\n<< /Type /Catalog /Pages ${pagesNum} 0 R >>\nendobj\n`;
  const xrefAt = objAt + Buffer.byteLength(obj, "latin1");
  const text = `\n${obj}xref\n${rootNum} 1\n${String(objAt).padStart(10, "0")} 00000 n \ntrailer\n<< /Size ${size} /Root ${rootNum} 0 R /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const out = new Uint8Array(bytes.length + Buffer.byteLength(text, "latin1"));
  out.set(bytes, 0);
  out.set(Buffer.from(text, "latin1"), bytes.length);
  return out;
}

// ---------- 合成 PDF の一覧 ----------
// leaks：残っている添付ファイル（検出率の分母）。name と where（どこから指されているか）。
// negatives：紛らわしいが添付ファイルでないもの（誤検知率の分母）。

const CASES = [
  {
    name: "p9-01-names-xlsx",
    description: "名前の木に、名簿の Excel（のふり）が添付されている",
    async make() {
      const { doc } = await base("01");
      await attach(doc, fakeXlsx(), "名簿.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      return save(doc);
    },
    leaks: [["名簿.xlsx", "names"]],
    negatives: [],
  },
  {
    name: "p9-02-two-names",
    description: "名前の木に、Word の原本と CSV の2つ",
    async make() {
      const { doc } = await base("02");
      await attach(doc, fakeDocx(), "見積書_原本.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      await attach(doc, csv("番号,氏名\n1,佐藤花子\n"), "集計.csv", "text/csv");
      return save(doc);
    },
    leaks: [["見積書_原本.docx", "names"], ["集計.csv", "names"]],
    negatives: [],
  },
  {
    name: "p9-03-annotation",
    description: "ページの添付ファイルの注釈（クリップのしるし）に、メモが入っている。URL のリンクもある",
    async make() {
      const { doc } = await base("03");
      fileAttachmentAnnot(doc, 0, makeFilespec(doc, enc("内部メモ：○○様へは後日連絡\n"), "メモ.txt", "text/plain"));
      addAnnot(doc, 0, { Subtype: "Link", Rect: [100, 40, 200, 60], A: { S: "URI", URI: PDFString.of("https://example.com/notice.pdf") } });
      return save(doc);
    },
    leaks: [["メモ.txt", "annotation"]],
    negatives: [["url_link", "https://example.com/notice.pdf"]],
  },
  {
    name: "p9-04-annotation-page2",
    description: "2ページ目の添付ファイルの注釈",
    async make() {
      const { doc } = await base("04", 2);
      fileAttachmentAnnot(doc, 1, makeFilespec(doc, fakeOle(), "旧様式.xls", "application/vnd.ms-excel"));
      return save(doc);
    },
    leaks: [["旧様式.xls", "annotation"]],
    negatives: [],
  },
  {
    name: "p9-05-nested-tree",
    description: "名前の木が入れ子（/Kids）になっていて、3つの添付が2つの枝に分かれている",
    async make() {
      const { doc } = await base("05");
      const ctx = doc.context;
      const fa = makeFilespec(doc, csv("a\n"), "資料A.csv", "text/csv");
      const fb = makeFilespec(doc, csv("b\n"), "資料B.csv", "text/csv");
      const fc = makeFilespec(doc, csv("c\n"), "資料C.csv", "text/csv");
      const leaf1 = ctx.register(ctx.obj({ Limits: [PDFHexString.fromText("資料A.csv"), PDFHexString.fromText("資料B.csv")], Names: [PDFHexString.fromText("資料A.csv"), fa, PDFHexString.fromText("資料B.csv"), fb] }));
      const leaf2 = ctx.register(ctx.obj({ Limits: [PDFHexString.fromText("資料C.csv"), PDFHexString.fromText("資料C.csv")], Names: [PDFHexString.fromText("資料C.csv"), fc] }));
      const mid = ctx.register(ctx.obj({ Kids: [leaf2] }));
      const rootNode = ctx.register(ctx.obj({ Kids: [leaf1, mid] }));
      doc.catalog.set(PDFName.of("Names"), ctx.obj({ EmbeddedFiles: rootNode }));
      return save(doc);
    },
    leaks: [["資料A.csv", "names"], ["資料B.csv", "names"], ["資料C.csv", "names"]],
    negatives: [],
  },
  {
    name: "p9-06-af-only",
    description: "名前の木には入れず、文書の関連ファイル（/AF）だけから指している",
    async make() {
      const { doc } = await base("06");
      const fs = makeFilespec(doc, fakeXlsx(), "元データ.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      doc.catalog.set(PDFName.of("AF"), doc.context.obj([fs]));
      return save(doc);
    },
    leaks: [["元データ.xlsx", "af"]],
    negatives: [],
  },
  {
    name: "p9-07-object-stream",
    description: "xref ストリームとオブジェクトストリームで保存（ファイル指定がストリームの中にある）",
    async make() {
      const { doc } = await base("07");
      await attach(doc, fakeDocx(), "議事録_下書き.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      return save(doc, true);
    },
    leaks: [["議事録_下書き.docx", "names"]],
    negatives: [],
  },
  {
    name: "p9-08-unreferenced",
    description: "中身のストリームとファイル指定は残っているが、どこからも指されていない（名前の木から外しただけ）",
    async make() {
      const { doc } = await base("08");
      makeFilespec(doc, fakeXlsx(), "外したはずの名簿.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      return save(doc);
    },
    leaks: [["外したはずの名簿.xlsx", "unreferenced"]],
    negatives: [],
  },
  {
    name: "p9-09-incremental-removed",
    description: "増分更新で、文書の根から添付を外した（前の版の中身が、ファイルの中に残っている）",
    async make() {
      const { doc } = await base("09");
      await attach(doc, csv("番号,氏名\n1,高橋次郎\n"), "応募者一覧.csv", "text/csv");
      return appendCatalogWithoutAttachments(await save(doc));
    },
    leaks: [["応募者一覧.csv", "unreferenced"]],
    negatives: [],
  },
  {
    name: "p9-10-japanese-name",
    description: "ファイル名に個人名が入った添付（日本語のファイル名）",
    async make() {
      const { doc } = await base("10");
      await attach(doc, new Uint8Array([0x25, 0x50, 0x44, 0x46, ...enc("-1.7 fake\n")]), "山田太郎_履歴書.pdf", "application/pdf");
      return save(doc);
    },
    leaks: [["山田太郎_履歴書.pdf", "names"]],
    negatives: [],
  },
  {
    name: "p9-11-many",
    description: "名前の木に5つの添付",
    async make() {
      const { doc } = await base("11");
      for (let i = 1; i <= 5; i++) await attach(doc, csv(`row,${i}\n`), `別紙${i}.csv`, "text/csv");
      return save(doc);
    },
    leaks: [1, 2, 3, 4, 5].map((i) => [`別紙${i}.csv`, "names"]),
    negatives: [],
  },
  {
    name: "p9-12-same-file-two-places",
    description: "同じ中身を、名前の木と注釈の両方から指している（1件と数える）",
    async make() {
      const { doc } = await base("12");
      const fs = makeFilespec(doc, fakeDocx(), "決裁文書.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      doc.catalog.set(PDFName.of("Names"), doc.context.obj({ EmbeddedFiles: { Names: [PDFHexString.fromText("決裁文書.docx"), fs] } }));
      fileAttachmentAnnot(doc, 0, fs);
      return save(doc);
    },
    leaks: [["決裁文書.docx", "names"]],
    negatives: [],
  },
  {
    name: "p9-13-names-and-annotation",
    description: "名前の木の添付と、別の注釈の添付。中身のない（外のファイルを指すだけの）注釈もある",
    async make() {
      const { doc } = await base("13");
      await attach(doc, fakeXlsx(), "単価表.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      fileAttachmentAnnot(doc, 0, makeFilespec(doc, enc("校正のメモ\n"), "校正メモ.txt", "text/plain"));
      fileAttachmentAnnot(doc, 0, externalFilespec(doc, "参考資料.docx"));
      return save(doc);
    },
    leaks: [["単価表.xlsx", "names"], ["校正メモ.txt", "annotation"]],
    negatives: [["external_ref", "参考資料.docx"]],
  },
  {
    name: "p9-n01-external-refs",
    description: "添付ファイルの注釈が3つあるが、どれも外のファイルを指すだけで、中身（/EF）がない",
    async make() {
      const { doc } = await base("n01");
      for (const n of ["共有フォルダの資料.docx", "様式1.xlsx", "写真.jpg"]) fileAttachmentAnnot(doc, 0, externalFilespec(doc, n));
      return save(doc);
    },
    leaks: [],
    negatives: [["external_ref", "共有フォルダの資料.docx"], ["external_ref", "様式1.xlsx"], ["external_ref", "写真.jpg"]],
  },
  {
    name: "p9-n02-links",
    description: "リンクだけ（URL を開く・外のファイルを開く・別の PDF に飛ぶ）。添付ではない",
    async make() {
      const { doc } = await base("n02");
      addAnnot(doc, 0, { Subtype: "Link", A: { S: "URI", URI: PDFString.of("https://example.com/form.xlsx") } });
      addAnnot(doc, 0, { Subtype: "Link", Rect: [80, 40, 100, 60], A: { S: "Launch", F: externalFilespec(doc, "申請書.xlsx") } });
      addAnnot(doc, 0, { Subtype: "Link", Rect: [120, 40, 140, 60], A: { S: "GoToR", F: externalFilespec(doc, "別冊.pdf"), D: [0, PDFName.of("Fit")] } });
      return save(doc);
    },
    leaks: [],
    negatives: [["url_link", "https://example.com/form.xlsx"], ["launch_external", "申請書.xlsx"], ["goto_remote", "別冊.pdf"]],
  },
  {
    name: "p9-n03-empty-tree",
    description: "名前の木はあるが、中が空（片付けたあと）",
    async make() {
      const { doc } = await base("n03");
      doc.catalog.set(PDFName.of("Names"), doc.context.obj({ EmbeddedFiles: { Names: PDFArray.withContext(doc.context) } }));
      return save(doc);
    },
    leaks: [],
    negatives: [["empty_names_tree", ""]],
  },
  {
    name: "p9-n04-names-without-content",
    description: "名前の木に2つあるが、どちらも外のファイルを指すだけで、中身がない",
    async make() {
      const { doc } = await base("n04");
      const a = externalFilespec(doc, "別添1.pdf");
      const b = externalFilespec(doc, "別添2.pdf");
      doc.catalog.set(PDFName.of("Names"), doc.context.obj({ EmbeddedFiles: { Names: [PDFHexString.fromText("別添1.pdf"), a, PDFHexString.fromText("別添2.pdf"), b] } }));
      return save(doc);
    },
    leaks: [],
    negatives: [["external_ref", "別添1.pdf"], ["external_ref", "別添2.pdf"]],
  },
  {
    name: "p9-n05-other-streams",
    description: "画像と XMP のストリームはあるが、添付ではない",
    async make() {
      const { doc } = await base("n05");
      const ctx = doc.context;
      const img = ctx.register(ctx.flateStream(new Uint8Array(16).fill(128), { Type: "XObject", Subtype: "Image", Width: 4, Height: 4, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
      doc.getPages()[0].node.newXObject("Im", img);
      const xmp = ctx.register(ctx.stream(enc('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta><?xpacket end="w"?>'), { Type: "Metadata", Subtype: "XML" }));
      doc.catalog.set(PDFName.of("Metadata"), xmp);
      return save(doc);
    },
    leaks: [],
    negatives: [["other_stream", "image"], ["other_stream", "xmp"]],
  },
  {
    name: "p9-n06-javascript-names",
    description: "名前の木に JavaScript があるが、添付の木（/EmbeddedFiles）ではない（P12 の範囲）",
    async make() {
      const { doc } = await base("n06");
      const js = doc.context.register(doc.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert('test');") }));
      doc.catalog.set(PDFName.of("Names"), doc.context.obj({ JavaScript: { Names: [PDFString.of("init"), js] } }));
      return save(doc);
    },
    leaks: [],
    negatives: [["javascript_names", "init"]],
  },
  {
    name: "p9-n07-decoy-text",
    description: "ページの字に「/Type /EmbeddedFile」と書いてある（字であって、添付ではない）",
    async make() {
      const { doc, font } = await base("n07");
      doc.getPages()[0].drawText("/Type /EmbeddedFile /Filespec /EF", { x: 40, y: 200, size: 12, font });
      return save(doc);
    },
    leaks: [],
    negatives: [["decoy_text", ""]],
  },
];

// ---------- 書き出し ----------

for (const f of readdirSync(HERE)) {
  if (/^p9-.*\.(pdf|expected\.json)$/.test(f)) unlinkSync(path.join(HERE, f));
}

const rows = [];
const hashes = [];
let totalLeaks = 0;
let totalNeg = 0;
for (const c of CASES) {
  const bytes = await c.make();
  const file = `${c.name}.pdf`;
  writeFileSync(path.join(HERE, file), bytes);
  const expected = {
    file,
    description: c.description,
    leaks: c.leaks.map(([name, where], i) => ({ id: `${c.name}#L${i + 1}`, pattern: "P9", name, where })),
    negatives: c.negatives.map(([kind, name], i) => ({ id: `${c.name}#N${i + 1}`, kind, name })),
  };
  writeFileSync(path.join(HERE, `${c.name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  hashes.push(`${sha}  ${file}`);
  rows.push(`| ${file} | ${c.description} | ${c.leaks.length} | ${c.negatives.length} | \`${sha.slice(0, 16)}\` |`);
  totalLeaks += c.leaks.length;
  totalNeg += c.negatives.length;
}

writeFileSync(path.join(HERE, "hashes.txt"), hashes.join("\n") + "\n");
writeFileSync(
  path.join(HERE, "index.md"),
  `# P9（添付ファイル）の合成 PDF の一覧

\`node fixtures/p9/build.mjs\` で作り直せる。日時を固定しているので、作り直しても SHA-256 は変わらない。
名前・団体・添付の中身は、すべて架空。

- 合成 PDF：${CASES.length} 個
- 漏れ（検出率の分母）：${totalLeaks} 件
- 漏れでないもの（誤検知率の分母）：${totalNeg} 件

| ファイル | 何を再現しているか | 漏れ | 漏れでない | SHA-256（先頭16桁） |
|---|---|---|---|---|
${rows.join("\n")}
`,
);
console.log(`合成 PDF ${CASES.length} 個、漏れ ${totalLeaks} 件、漏れでないもの ${totalNeg} 件`);

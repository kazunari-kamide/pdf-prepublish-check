// SPDX-License-Identifier: AGPL-3.0-only
//
// P1（文書情報）の合成 PDF と正解データを作る。
//   node fixtures/p1/build.mjs
// 名前・団体はすべて架空（山田太郎、○○市、○○課 など）。実在の PDF・個人名・団体名は使わない。
// 日時を固定しているので、何度作っても同じバイト列になる（乱数は使わない）。

import { createHash } from "node:crypto";
import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXED_DATE = "D:20261101090000+09'00'";

/** ページが1枚の、文書情報を自分で決める PDF（pdf-lib の既定の Producer・Creator は入れない） */
async function base(label) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([420, 300]);
  page.drawText(`P1 test: ${label}`, { x: 40, y: 250, size: 14, font });
  return doc;
}

const info = (doc) => doc.getInfoDict();
/** UTF-16BE（BOM あり）の 16 進文字列で入れる（日本語の値。Office などの書き方） */
const setUtf16 = (doc, key, text) => info(doc).set(PDFName.of(key), PDFHexString.fromText(text));
/** ( ) の文字列で入れる（ASCII の値） */
const setLiteral = (doc, key, text) => info(doc).set(PDFName.of(key), PDFString.of(text));
const setDates = (doc) => {
  setLiteral(doc, "CreationDate", FIXED_DATE);
  setLiteral(doc, "ModDate", FIXED_DATE);
};

const save = (doc, objectStreams = false) => doc.save({ useObjectStreams: objectStreams, addDefaultPage: false, updateFieldAppearances: false });

const latin1 = (b) => Buffer.from(b).toString("latin1");
const fromLatin1 = (s) => new Uint8Array(Buffer.from(s, "latin1"));
const concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/** 表の形の xref で保存した PDF の、最後の trailer を読む（Size・Root・Info・startxref） */
function lastTrailer(bytes) {
  const s = latin1(bytes);
  const t = s.lastIndexOf("trailer");
  const tr = s.slice(t);
  const size = Number(/\/Size\s+(\d+)/.exec(tr)[1]);
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(tr)[1];
  const infoM = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(tr);
  const startxref = Number(/startxref\s+(\d+)/.exec(s.slice(s.lastIndexOf("startxref")))[1]);
  return { size, root, info: infoM ? Number(infoM[1]) : null, startxref };
}

/**
 * 増分更新を書き足す（表の形の xref）。objects：[{ num, body }]。infoNum：新しい trailer の /Info（null なら書かない）
 */
function appendUpdate(bytes, objects, infoNum) {
  const tr = lastTrailer(bytes);
  let text = "\n";
  const offsets = [];
  let at = bytes.length + 1;
  for (const o of objects) {
    const chunk = `${o.num} 0 obj\n${o.body}\nendobj\n`;
    offsets.push({ num: o.num, offset: at });
    text += chunk;
    at += Buffer.byteLength(chunk, "latin1");
  }
  const xrefAt = at;
  const size = Math.max(tr.size, ...objects.map((o) => o.num + 1));
  text += "xref\n";
  for (const { num, offset } of offsets.sort((a, b) => a.num - b.num)) {
    text += `${num} 1\n${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  text += `trailer\n<< /Size ${size} /Root ${tr.root}${infoNum !== null ? ` /Info ${infoNum} 0 R` : ""} /Prev ${tr.startxref} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return concat(bytes, fromLatin1(text));
}

/** PDF の文字列として、UTF-16BE の 16 進を作る */
const hexUtf16 = (s) => PDFHexString.fromText(s).toString();

// ---------- 合成 PDF の一覧 ----------
// leaks：数える欄（検出率の分母）。negatives：あるが漏れでない欄（誤検知率の分母）。
// out_of_scope：前の版の文書情報など、P1 の分母に入れないもの（P5 の範囲。参考）

const CASES = [
  {
    name: "p1-01-author-name",
    description: "作成者（Author）に個人名が残っている。作成ソフト名（Producer）と日付もある",
    async make() {
      const d = await base("01");
      setUtf16(d, "Author", "山田太郎");
      setLiteral(d, "Producer", "Example PDF Library 1.0");
      setDates(d);
      return save(d);
    },
    leaks: ["Author"],
    negatives: [["Producer", "producer"], ["CreationDate", "date"], ["ModDate", "date"]],
  },
  {
    name: "p1-02-all-standard",
    description: "決まった欄（タイトル・作成者・題・キーワード・作成アプリ）がすべて埋まっている",
    async make() {
      const d = await base("02");
      setUtf16(d, "Title", "○○事業 委託仕様書（案）");
      setUtf16(d, "Author", "佐藤花子");
      setUtf16(d, "Subject", "○○課 内部検討用");
      setUtf16(d, "Keywords", "非公開, 決裁前");
      setLiteral(d, "Creator", "Example Word Processor");
      setLiteral(d, "Producer", "Example PDF Library 1.0");
      setDates(d);
      return save(d);
    },
    leaks: ["Title", "Author", "Subject", "Keywords", "Creator"],
    negatives: [["Producer", "producer"], ["CreationDate", "date"], ["ModDate", "date"]],
  },
  {
    name: "p1-03-custom-keys",
    description: "決まった欄の外の、独自の欄（会社名・管理者・元のファイルの更新日時）が残っている",
    async make() {
      const d = await base("03");
      setUtf16(d, "Company", "株式会社○○");
      setUtf16(d, "Manager", "鈴木一郎");
      setLiteral(d, "SourceModified", "D:20261020153000");
      return save(d);
    },
    leaks: ["Company", "Manager", "SourceModified"],
    negatives: [],
  },
  {
    name: "p1-04-literal-and-pdfdoc",
    description: "( ) の文字列の作成者と、PDFDocEncoding の8進エスケープを含むタイトル",
    async make() {
      const d = await base("04");
      setLiteral(d, "Author", "Taro Yamada");
      // \225 は PDFDocEncoding の「Ł」、\204 は「—」
      info(d).set(PDFName.of("Title"), PDFString.of("Draft \\204 Section \\225"));
      return save(d);
    },
    leaks: ["Author", "Title"],
    negatives: [],
  },
  {
    name: "p1-05-object-stream",
    description: "xref ストリームとオブジェクトストリームで保存（文書情報がストリームの中にある）",
    async make() {
      const d = await base("05");
      setUtf16(d, "Author", "高橋次郎");
      setUtf16(d, "Title", "○○市 議事要旨（未定稿）");
      setLiteral(d, "Producer", "Example PDF Library 1.0");
      return save(d, true);
    },
    leaks: ["Author", "Title"],
    negatives: [["Producer", "producer"]],
  },
  {
    name: "p1-06-direct-info",
    description: "trailer の中に文書情報を直接書いている（参照でない）",
    async make() {
      const d = await base("06");
      const bytes = await save(d);
      const s = latin1(bytes);
      const t = s.lastIndexOf("trailer");
      // updateMetadata: false の pdf-lib は、文書情報に触らなければ trailer に /Info を書かない。そこに直接の辞書を足す
      const tail = s.slice(t).replace(/\/Root\s+\d+\s+\d+\s+R/, (m) => `${m}\n/Info << /Author ${hexUtf16("伊藤三郎")} >>`);
      if (tail === s.slice(t)) throw new Error("trailer に /Root がない");
      return fromLatin1(s.slice(0, t) + tail);
    },
    leaks: ["Author"],
    negatives: [],
  },
  {
    name: "p1-07-empty-values",
    description: "欄はあるが、値が空・空白だけ（片付けで空にした形）",
    async make() {
      const d = await base("07");
      setLiteral(d, "Author", "");
      setUtf16(d, "Title", "　 ");
      setLiteral(d, "Keywords", " ");
      return save(d);
    },
    leaks: [],
    negatives: [["Author", "empty"], ["Title", "empty"], ["Keywords", "empty"]],
  },
  {
    name: "p1-08-no-info",
    description: "文書情報がない（trailer に /Info がない）",
    async make() {
      // updateMetadata: false の pdf-lib は、文書情報に触らなければ trailer に /Info を書かない
      const d = await base("08");
      const bytes = await save(d);
      if (/\/Info\s/.test(latin1(bytes).slice(latin1(bytes).lastIndexOf("trailer")))) throw new Error("/Info が残っている");
      return bytes;
    },
    leaks: [],
    negatives: [],
  },
  {
    name: "p1-09-incremental-overwrite",
    description: "増分更新で、作成者を個人名から課の名前に書き換えた（前の版に個人名が残る）",
    async make() {
      const d = await base("09");
      setUtf16(d, "Author", "中村四郎");
      const bytes = await save(d);
      const tr = lastTrailer(bytes);
      return appendUpdate(bytes, [{ num: tr.info, body: `<< /Author ${hexUtf16("○○市○○課")} >>` }], tr.info);
    },
    leaks: ["Author"],
    negatives: [],
    out_of_scope: [{ key: "Author", where: "previous", note: "前の版の個人名（P5 の範囲）" }],
    previous_info: true,
  },
  {
    name: "p1-10-incremental-cleaned",
    description: "増分更新で、文書情報を新しい番号の Producer だけのものに差し替えた（前の版に作成者が残る）",
    async make() {
      const d = await base("10");
      setUtf16(d, "Author", "小林五郎");
      setUtf16(d, "Title", "○○計画（内部資料）");
      const bytes = await save(d);
      const tr = lastTrailer(bytes);
      return appendUpdate(bytes, [{ num: tr.size, body: "<< /Producer (Example Cleaner 1.0) >>" }], tr.size);
    },
    leaks: [],
    negatives: [["Producer", "producer"]],
    out_of_scope: [
      { key: "Author", where: "previous", note: "前の版（P5 の範囲）" },
      { key: "Title", where: "previous", note: "前の版（P5 の範囲）" },
    ],
    previous_info: true,
  },
  {
    name: "p1-11-path-in-title",
    description: "タイトルに、作った PC のファイルの場所が残っている（P4 とも重なる）",
    async make() {
      const d = await base("11");
      setUtf16(d, "Title", "C:\\Users\\yamada\\Desktop\\○○_決裁用.docx");
      return save(d);
    },
    leaks: ["Title"],
    negatives: [],
  },
  {
    name: "p1-12-dates-only",
    description: "日付だけが残っている",
    async make() {
      const d = await base("12");
      setDates(d);
      return save(d);
    },
    leaks: [],
    negatives: [["CreationDate", "date"], ["ModDate", "date"]],
  },
  {
    name: "p1-13-escaped-key",
    description: "名前に #20（空白）を含む独自の欄",
    async make() {
      const d = await base("13");
      info(d).set(PDFName.of("Doc Owner"), PDFHexString.fromText("渡辺六郎"));
      return save(d);
    },
    leaks: ["Doc Owner"],
    negatives: [],
  },
  {
    name: "p1-14-department-author",
    description: "作成者が課の名前（意図して残すこともある）",
    async make() {
      const d = await base("14");
      setUtf16(d, "Author", "○○市 総務部 ○○課");
      return save(d);
    },
    leaks: ["Author"],
    negatives: [],
  },
  {
    name: "p1-15-trapped-and-creator",
    description: "作成アプリ（Creator）と、Trapped（印刷の設定）・Producer",
    async make() {
      const d = await base("15");
      setLiteral(d, "Creator", "Example Spreadsheet");
      setLiteral(d, "Producer", "Example PDF Library 1.0");
      info(d).set(PDFName.of("Trapped"), PDFName.of("False"));
      return save(d);
    },
    leaks: ["Creator"],
    negatives: [["Producer", "producer"], ["Trapped", "trapped"]],
  },
  {
    name: "p1-16-subject-keywords",
    description: "題とキーワードに、担当と内部の番号が残っている。日付もある",
    async make() {
      const d = await base("16");
      setUtf16(d, "Subject", "担当：○○係 山本七郎");
      setLiteral(d, "Keywords", "INTERNAL-2026-0123");
      setLiteral(d, "Producer", "Example PDF Library 1.0");
      setDates(d);
      return save(d);
    },
    leaks: ["Subject", "Keywords"],
    negatives: [["Producer", "producer"], ["CreationDate", "date"], ["ModDate", "date"]],
  },
  {
    name: "p1-17-utf8-bom",
    description: "UTF-8 の BOM つきの作成者（PDF 2.0 の書き方）",
    async make() {
      const d = await base("17");
      const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("加藤八郎")]);
      info(d).set(PDFName.of("Author"), PDFHexString.of(Buffer.from(bytes).toString("hex")));
      return save(d);
    },
    leaks: ["Author"],
    negatives: [],
  },
  {
    name: "p1-18-object-stream-incremental-clean",
    description: "オブジェクトストリームで保存した PDF で、文書情報を空にした（正しく片付けた形。前の版はない）",
    async make() {
      const d = await base("18");
      setLiteral(d, "Author", "");
      setLiteral(d, "Producer", "Example Cleaner 1.0");
      return save(d, true);
    },
    leaks: [],
    negatives: [["Author", "empty"], ["Producer", "producer"]],
  },
];

// ---------- 書き出し ----------

for (const f of readdirSync(HERE)) {
  if (/^p1-.*\.(pdf|expected\.json)$/.test(f)) unlinkSync(path.join(HERE, f));
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
    leaks: c.leaks.map((key, i) => ({ id: `${c.name}#L${i + 1}`, pattern: "P1", key, where: "current" })),
    negatives: c.negatives.map(([key, kind], i) => ({ id: `${c.name}#N${i + 1}`, kind, key })),
    out_of_scope: c.out_of_scope ?? [],
    previous_info: c.previous_info ?? false,
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
  `# P1（文書情報）の合成 PDF の一覧

\`node fixtures/p1/build.mjs\` で作り直せる。日時を固定しているので、作り直しても SHA-256 は変わらない。
名前・団体はすべて架空。

- 合成 PDF：${CASES.length} 個
- 漏れ（検出率の分母）：${totalLeaks} 件
- 漏れでない欄（誤検知率の分母）：${totalNeg} 件

| ファイル | 何を再現しているか | 漏れ | 漏れでない | SHA-256（先頭16桁） |
|---|---|---|---|---|
${rows.join("\n")}
`,
);
console.log(`合成 PDF ${CASES.length} 個、漏れ ${totalLeaks} 件、漏れでない欄 ${totalNeg} 件`);

// SPDX-License-Identifier: AGPL-3.0-only
//
// 誤検知しない型（型の一覧の F01・F04・F05・F06・F07）の対照の合成 PDF と正解データを作る（採点する側に足す案）。
//   node proposals/a-gaps/controls/build.mjs [出力先のフォルダ]
// 出力先を省くと、このフォルダの out/ に書く。人が中身を見て、fixtures/p5・p6・p7 に移す（README.md）。
// 名前はすべて架空。日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));
const PAGE = [400, 300];
const ASC = 0.718; // Helvetica の Ascent・Descent
const DESC = -0.207;
const r2 = (v) => Math.round(v * 100) / 100;
const enc = (s) => new TextEncoder().encode(s);

/** Helvetica で s を大きさ size で x・y に描いたときの箱 */
function box(font, s, x, y, size = 12) {
  const w = font.widthOfTextAtSize(s, size);
  return [r2(x), r2(y + DESC * size), r2(x + w), r2(y + ASC * size)];
}

async function base() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage(PAGE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, page, font };
}

/** ページの資源に Helvetica を F1 として入れ、中身の流れを1つ置く */
function setContent(doc, page, font, content, extra = {}) {
  const res = { Font: { F1: font.ref, ...(extra.fonts ?? {}) } };
  if (extra.extgstate) res.ExtGState = extra.extgstate;
  if (extra.xobject) res.XObject = extra.xobject;
  page.node.set(PDFName.of("Resources"), doc.context.obj(res));
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(content)));
}

// ---------------------------------------------------------------- F01：Word の「ハイブリッド xref」（P5）

/**
 * 古い形の xref の表と、/XRefStm で指す xref ストリームを両方持つ、版が1つの PDF を手で組む（Word が保存する形）。
 * 表では、オブジェクトストリームの中の番号を「使っていない（f）」とし、xref ストリームの側で中身の場所を示す。
 * 増分更新はしていないので、前の版の残りはない
 */
function hybridXref() {
  const parts = [];
  const offsets = {};
  let len = 0;
  const push = (s) => {
    const b = typeof s === "string" ? enc(s) : s;
    parts.push(b);
    len += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = len;
    push(`${n} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  };
  push("%PDF-1.5\n%\xE2\xE3\xCF\xD3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 6 0 R >> /ExtGState << /GS1 7 0 R >> >> /Contents 4 0 R >>");
  const content = "BT /F1 12 Tf 40 250 Td (Meeting notes of the planning section) Tj ET\nBT /F1 12 Tf 40 230 Td (Prepared by the general affairs office) Tj ET\n";
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
  // オブジェクトストリーム（5）の中に、書体の辞書（6）と、重ね方の設定（7）を入れる（どちらもページから使う）
  const in6 = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  const in7 = "<< /Type /ExtGState /CA 1 /ca 1 >>";
  const header = `6 0 7 ${in6.length + 1} `;
  const body = `${in6}\n${in7}\n`;
  obj(5, `<< /Type /ObjStm /N 2 /First ${header.length} /Length ${header.length + body.length} >>\nstream\n${header}${body}endstream`);
  // xref ストリーム（8）：W [1 4 2]。0〜8 を載せる
  const rows = [];
  const row = (t, f2, f3) => {
    const b = new Uint8Array(7);
    b[0] = t;
    b[1] = (f2 >>> 24) & 255;
    b[2] = (f2 >>> 16) & 255;
    b[3] = (f2 >>> 8) & 255;
    b[4] = f2 & 255;
    b[5] = (f3 >>> 8) & 255;
    b[6] = f3 & 255;
    rows.push(b);
  };
  const xrefStmOffset = len;
  offsets[8] = xrefStmOffset;
  row(0, 0, 65535);
  for (const n of [1, 2, 3, 4, 5]) row(1, offsets[n], 0);
  row(2, 5, 0); // 6 はオブジェクトストリーム 5 の 0 番目
  row(2, 5, 1); // 7 は 1 番目
  row(1, xrefStmOffset, 0);
  const data = new Uint8Array(rows.length * 7);
  rows.forEach((b, i) => data.set(b, i * 7));
  push(`8 0 obj\n<< /Type /XRef /Size 9 /W [1 4 2] /Root 1 0 R /Length ${data.length} >>\nstream\n`);
  push(data);
  push("\nendstream\nendobj\n");
  // 古い形の表：6・7 は「使っていない」として載せる（Word と同じ）
  const xrefOffset = len;
  const line = (o, g, t) => `${String(o).padStart(10, "0")} ${String(g).padStart(5, "0")} ${t} \n`;
  let table = "xref\n0 9\n" + line(0, 65535, "f");
  for (const n of [1, 2, 3, 4, 5]) table += line(offsets[n], 0, "n");
  table += line(0, 0, "f") + line(0, 0, "f") + line(xrefStmOffset, 0, "n");
  push(table);
  push(`trailer\n<< /Size 9 /Root 1 0 R /XRefStm ${xrefStmOffset} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- 一覧

const CASES = [
  {
    dir: "p5",
    name: "p5-26-word-hybrid-xref",
    description: "Word と同じ「ハイブリッド xref」（古い形の表＋/XRefStm の xref ストリーム）で保存した、版が1つの PDF（前の版の残りはない）",
    async make() {
      return { bytes: hybridXref(), leaks: [], negatives: [] };
    },
  },
  {
    dir: "p5",
    name: "p5-27-scan-unused-font",
    description: "スキャン画像だけのページに、どこからも使われていないフォントの部品（辞書・説明・本体）が残っている。版は1つ（正しく墨消ししたスキャンの見本の形）",
    async make() {
      const doc = await PDFDocument.create({ updateMetadata: false });
      const page = doc.addPage(PAGE);
      const ctx = doc.context;
      const img = ctx.register(ctx.flateStream(new Uint8Array(64).fill(235), { Type: "XObject", Subtype: "Image", Width: 8, Height: 8, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
      page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { Im1: img } }));
      page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("q 400 0 0 300 0 0 cm /Im1 Do Q")));
      // フォントの本体：TrueType の頭（00 01 00 00）と、たまたま字の命令に見える並び（>"）を含むバイト列
      const ff = new Uint8Array(256);
      ff.set([0, 1, 0, 0, 0, 9, 0, 128]);
      ff.set(enc(">\"<0041>"), 40);
      for (let i = 60; i < ff.length; i++) ff[i] = (i * 37) & 255;
      const fontFile = ctx.register(ctx.flateStream(ff, { Length1: ff.length }));
      const desc = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "ABCDEF+TestGothic", Flags: 4, FontBBox: [0, -120, 1000, 880], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 700, StemV: 80, FontFile2: fontFile }));
      const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "TrueType", BaseFont: "ABCDEF+TestGothic", FirstChar: 32, LastChar: 32, Widths: [250], FontDescriptor: desc }));
      const neg = (ref, n) => ({ object: ref.objectNumber, kind: "structure", where: "unreferenced", note: n });
      return {
        doc,
        leaks: [],
        negatives: [neg(font, "使われていないフォントの辞書"), neg(desc, "その説明"), neg(fontFile, "その本体（字の中身ではない）")],
      };
    },
  },
  {
    dir: "p6",
    name: "p6-d10-same-text-redrawn",
    description: "黒い帯の下に書いた見出しを、帯の上に同じ字で白く描き直した（下の字は上に見えている字と同じなので、漏れでない）",
    async make() {
      const { doc, page, font } = await base();
      const s = "Section 3 Budget";
      const t = box(font, s, 40, 200);
      const c = [
        `0 g BT /F1 12 Tf 40 200 Td (${s}) Tj ET`,
        "0 g 30 190 300 26 re f",
        `1 g BT /F1 12 Tf 40 200 Td (${s}) Tj ET`,
        `0 g BT /F1 12 Tf 40 150 Td (The plan for the next year is shown below.) Tj ET`,
      ].join("\n");
      setContent(doc, page, font, c);
      return { doc, leaks: [], negatives: [{ kind: "same_text_redrawn", page: 1, rect: [30, 190, 330, 216], note: `帯の上に同じ字（${t.join(", ")}）` }] };
    },
  },
  {
    dir: "p7",
    name: "p7-26-outline-transparent-fill",
    description: "描き方 2（塗り＋輪郭）で、塗りは透明（不透明さ 0）、輪郭は黒く不透明な字（輪郭が見えるので、見えない字ではない）",
    async make() {
      const { doc, page, font } = await base();
      const s = "OUTLINE TITLE";
      const t = box(font, s, 40, 220, 20);
      const t2 = box(font, "Body text in black.", 40, 180);
      setContent(doc, page, font, `q /GS1 gs 0 g 0 G 0.6 w 2 Tr BT /F1 20 Tf 40 220 Td (${s}) Tj ET Q\n0 g BT /F1 12 Tf 40 180 Td (Body text in black.) Tj ET`, {
        extgstate: { GS1: { Type: "ExtGState", ca: 0, CA: 1 } },
      });
      return {
        doc,
        leaks: [],
        negatives: [
          { kind: "outline_visible", page: 1, rect: t, note: "塗りは透明、輪郭は黒" },
          { kind: "plain_text", page: 1, rect: t2, note: "ふつうの字" },
        ],
      };
    },
  },
  {
    dir: "p7",
    name: "p7-27-bold-ligature-actualtext",
    description: "太字のための同じ字の2度描き（少しずらす）、合字（fi）を素直に取り出す対応表、描いた字と同じ ActualText（どれも漏れでない）",
    async make() {
      const { doc, page, font } = await base();
      const ctx = doc.context;
      const cmap = [
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Lig-UCS def /CMapType 2 def",
        "1 begincodespacerange <00> <FF> endcodespacerange",
        "6 beginbfchar <01> <00660069> <02> <006C> <03> <0065> <04> <0020> <05> <0046> <06> <0069> endbfchar",
        "endcmap CMapName currentdict /CMap defineresource pop end end",
      ].join("\n");
      const lig = ctx.register(
        ctx.obj({
          Type: "Font",
          Subtype: "Type1",
          BaseFont: "Helvetica",
          Encoding: { Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: [1, "fi", "l", "e", "space", "F", "i"] },
          ToUnicode: ctx.register(ctx.stream(cmap)),
        }),
      );
      const bold = "Notice to residents";
      const tb = box(font, bold, 40, 230);
      // 合字の箱：fi 500・l 222・e 556（1000 分の）
      const tl = [40, r2(190 + DESC * 12), r2(40 + (0.5 + 0.222 + 0.556) * 12), r2(190 + ASC * 12)];
      const at = "Taro Yamada";
      const ta = box(font, at, 40, 150);
      const c = [
        `0 g BT /F1 12 Tf 40 230 Td (${bold}) Tj ET`,
        `0 g BT /F1 12 Tf 40.35 230 Td (${bold}) Tj ET`,
        "0 g BT /F2 12 Tf 40 190 Td <010203> Tj ET",
        `/Span << /ActualText (${at}) >> BDC 0 g BT /F1 12 Tf 40 150 Td (${at}) Tj ET EMC`,
      ].join("\n");
      setContent(doc, page, font, c, { fonts: { F2: lig } });
      return {
        doc,
        leaks: [],
        negatives: [
          { kind: "bold_double", page: 1, rect: tb, note: "同じ字を 0.35 ずらして2度描き" },
          { kind: "ligature", page: 1, rect: tl, note: "合字 fi を fi と取り出す" },
          { kind: "plain_actualtext", page: 1, rect: ta, note: "描いた字と同じ ActualText" },
        ],
      };
    },
  },
];

mkdirSync(OUT, { recursive: true });
const lines = [];
for (const c of CASES) {
  const r = await c.make();
  const bytes = r.bytes ?? new Uint8Array(await r.doc.save({ useObjectStreams: false }));
  const dir = path.join(OUT, c.dir);
  mkdirSync(dir, { recursive: true });
  const file = `${c.name}.pdf`;
  writeFileSync(path.join(dir, file), bytes);
  const expected = { file, description: c.description };
  if (c.dir !== "p5") expected.pages = 1;
  expected.leaks = r.leaks;
  expected.negatives = r.negatives.map((n, i) => ({ id: `${c.name}#N${i + 1}`, ...n }));
  writeFileSync(path.join(dir, `${c.name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  lines.push(`${c.dir}/${file}  ${sha.slice(0, 16)}  漏れでない ${expected.negatives.length}`);
}
console.log(lines.join("\n"));

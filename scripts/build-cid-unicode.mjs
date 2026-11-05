// SPDX-License-Identifier: AGPL-3.0-only
//
// ルールの字の読み取り（rules/shared/fonts.ts）で使う「Adobe-Japan1 の CID → 字」の表を作る（2026-11-06）。
//   node scripts/build-cid-unicode.mjs          … rules/shared/cid-unicode/adobe-japan1.ts を書き直す
//   node scripts/build-cid-unicode.mjs --check  … 作り直したものが、リポジトリのものと 1 バイトも違わないかを確かめる
//
// なぜ要るか：埋め込みの CID の書体（Identity-H）で ToUnicode のない PDF は、字の番号（CID）しか持たない。
// 番号から字を引く表（Adobe の Adobe-Japan1-UCS2。npm の pdfjs-dist の cmaps/ にある）がないと、字の中身を読めない。
//
// 作り方（PDF.js のコードは写さない）：ToUnicode のない Adobe-Japan1 の書体で、CID 0〜23,059 を 1 つずつ別の行に描いた PDF を
// ここで作り、依存のライブラリの PDF.js（pdfjs-dist。Node で動く版）に読ませ、PDF.js が返した字を、CID の順に表にする。
// 表の元は Adobe の Adobe-Japan1-UCS2（BSD-3-Clause。ライセンスの文を表の隣に置く：rules/shared/cid-unicode/LICENSE-adobe-cmaps）。
// 通信はしない（ファイルを読んで書くだけ）。

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "rules", "shared", "cid-unicode");
const OUT = path.join(OUT_DIR, "adobe-japan1.ts");
const CMAPS = path.join(ROOT, "node_modules", "pdfjs-dist", "cmaps");
/** Adobe-Japan1-7 の CID の数 */
const CID_COUNT = 23060;
const PER_PAGE = 400;
/** 字のない CID と、2 字以上になる CID の印（U+0000） */
const NONE = String.fromCodePoint(0);
const NL = String.fromCodePoint(10);

async function makePdf() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const cid = ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "CIDFontType0",
      BaseFont: "KasouMincho",
      CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Japan1"), Supplement: 7 },
      FontDescriptor: ctx.obj({ Type: "FontDescriptor", FontName: "KasouMincho", Flags: 4, FontBBox: [0, -141, 1000, 859], ItalicAngle: 0, Ascent: 859, Descent: -141, CapHeight: 700, StemV: 80 }),
      DW: 1000,
    }),
  );
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "KasouMincho", Encoding: "Identity-H", DescendantFonts: [cid] }));
  for (let start = 0; start < CID_COUNT; start += PER_PAGE) {
    const page = doc.addPage([200, PER_PAGE * 20 + 40]);
    page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font } }));
    const ops = [];
    for (let c = start; c < Math.min(CID_COUNT, start + PER_PAGE); c++) {
      const hex = c.toString(16).padStart(4, "0").toUpperCase();
      ops.push(`BT /F1 10 Tf 20 ${PER_PAGE * 20 - (c - start) * 20} Td <${hex}> Tj ET`);
    }
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(ops.join(NL))));
  }
  return doc.save({ useObjectStreams: false });
}

async function build() {
  const data = await makePdf();
  const loading = pdfjs.getDocument({
    data,
    // Node の PDF.js は、file: の URL ではなく、/ で区切ったパスで読む
    cMapUrl: `${CMAPS.split(path.sep).join("/")}/`,
    cMapPacked: true,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const pdf = await loading.promise;
  const table = new Array(CID_COUNT).fill("");
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent({ disableNormalization: true });
    // 行の高さから CID を求める（1 行に 1 字。空の字は items に出ない）
    for (const it of tc.items) {
      // U+FFFD（字の決まっていない CID。.notdef など）は、字なしにする
      if (!("str" in it) || it.str === "" || it.str === String.fromCodePoint(0xfffd)) continue;
      const row = Math.round((PER_PAGE * 20 - it.transform[5]) / 20);
      const c = (p - 1) * PER_PAGE + row;
      if (c >= 0 && c < CID_COUNT) table[c] = it.str;
    }
  }
  await loading.destroy();
  // 形：chars は、CID の順に 1 字ずつ並べた文字列（コードポイントで数える）。multi は、2 字以上になる CID の字（{ CID: "字" }）
  const multi = {};
  let chars = "";
  for (let c = 0; c < CID_COUNT; c++) {
    const s = table[c];
    if (s && [...s].length === 1 && s !== NONE) chars += s;
    else {
      chars += NONE;
      if (s) multi[c] = s;
    }
  }
  const mapped = table.filter(Boolean).length;
  const body = JSON.stringify({ cidCount: CID_COUNT, mapped, chars, multi });
  const ts = [
    "// SPDX-License-Identifier: BSD-3-Clause",
    "//",
    "// Adobe-Japan1 の CID → 字の表。scripts/build-cid-unicode.mjs が作る（直接書き換えない。作り直すときは npm の pdfjs-dist を更新してから）。",
    "// 元は Adobe の Adobe-Japan1-UCS2（pdfjs-dist の cmaps/。ライセンスは同じフォルダの LICENSE-adobe-cmaps）。",
    "// chars は CID の順に 1 字ずつ並べた文字列（コードポイントで数える。字のない CID と、2 字以上になる CID は U+0000）。multi は 2 字以上になる CID の字",
    `export const ADOBE_JAPAN1 = ${body} as const;`,
    "",
  ].join(NL);
  return { ts, mapped, multiCount: Object.keys(multi).length };
}

const { ts, mapped, multiCount } = await build();
const rel = path.relative(ROOT, OUT);
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== ts) {
    console.error(`${rel} が、作り直したものと違います。node scripts/build-cid-unicode.mjs で書き直してください`);
    process.exit(1);
  }
  console.log(`${rel} は、作り直したものと同じです（字のある CID ${mapped} 個・2 字以上の CID ${multiCount} 個）`);
} else {
  writeFileSync(OUT, ts);
  copyFileSync(path.join(CMAPS, "LICENSE"), path.join(OUT_DIR, "LICENSE-adobe-cmaps"));
  console.log(`${rel} を書きました（字のある CID ${mapped} 個・2 字以上の CID ${multiCount} 個・${Buffer.byteLength(ts)} バイト）`);
}

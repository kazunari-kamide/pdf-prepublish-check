// SPDX-License-Identifier: AGPL-3.0-only
//
// 決まった字の対応表（日本語の predefined CMap）の「例外の表」を作る（2026-11-06）。
//   node scripts/build-predefined-cmaps.mjs          … rules/shared/cid-unicode/predefined-cmaps.ts を書き直す
//   node scripts/build-predefined-cmaps.mjs --check  … 作り直したものが、リポジトリのものと 1 バイトも違わないかを確かめる
//
// なぜ要るか：rules/shared/predefined-cmaps.ts は、字の中身（Shift-JIS・Unicode）から Adobe-Japan1 の表を逆に引いて CID を選ぶ。
// たいていの字はそれで Adobe の対応表と同じ CID になるが、合わない字（0x5C が半角の円記号になる、縦書きの句読点が縦書き用の CID になる など）がある。
// その字だけを、対応表ごとに「コード → CID」として持つ。
//
// 作り方（PDF.js のコードは写さない）：対応表ごとに、コードを 1 つずつ別の行に描いた PDF をここで作る。CID ごとに違う幅（/W。縦書きは /W2 の送り）を
// 入れておき、依存のライブラリの PDF.js（pdfjs-dist。Adobe の対応表 cmaps/ を持つ）に読ませ、返った幅から CID を、字から確からしさを確かめる。
// ここでの読み方（例外なし）で選んだ CID と違うコードだけを、例外の表に書く。通信はしない（ファイルを読んで書くだけ）。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { makePredefinedCMap } from "../rules/shared/predefined-cmaps.ts";
import { japan1Char } from "../rules/shared/cid-unicode.ts";
import { ADOBE_JAPAN1 } from "../rules/shared/cid-unicode/adobe-japan1.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "rules", "shared", "cid-unicode", "predefined-cmaps.ts");
const CMAPS = path.join(ROOT, "node_modules", "pdfjs-dist", "cmaps");
const NL = String.fromCodePoint(10);
const CID_COUNT = ADOBE_JAPAN1.cidCount;
const PER_PAGE = 400;
/** CID を幅に埋める刻み（1000 分の 1 em）。幅 = 1 + CID × STEP */
const STEP = 0.04;

/**
 * 例外の表を作る対応表（書体を埋め込まない日本語の PDF で使われるもの。Windows の MS 明朝・MS ゴシックと、Acrobat が書く Unicode の表）。
 * Mac・古い版の表（83pv・90pv・Add・Ext など）は、例外が多く表が大きくなるわりに、今の PDF ではまれなので入れない（これまでどおり 2 バイトずつ区切る）
 */
const NAMES = [
  "90ms-RKSJ-H", "90ms-RKSJ-V", "90msp-RKSJ-H", "90msp-RKSJ-V", "RKSJ-H", "RKSJ-V",
  "UniJIS-UCS2-H", "UniJIS-UCS2-V", "UniJIS-UCS2-HW-H", "UniJIS-UCS2-HW-V", "UniJIS-UTF16-H", "UniJIS-UTF16-V",
];

/** 対応表で試すコード（バイト列） */
function codesOf(name) {
  const out = [];
  if (/RKSJ/.test(name)) {
    for (let b = 0; b < 256; b++) if (!((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc))) out.push([b]);
    for (let l = 0x81; l <= 0xfc; l++) {
      if (l > 0x9f && l < 0xe0) continue;
      for (let t = 0x40; t <= 0xfc; t++) if (t !== 0x7f) out.push([l, t]);
    }
    return out;
  }
  for (let c = 0; c < 0x10000; c++) if (c < 0xd800 || c > 0xdfff) out.push([c >> 8, c & 255]);
  if (/UTF16/.test(name)) {
    // BMP の外の字は、Adobe-Japan1 の表にある字だけを試す
    const seen = new Set();
    for (const ch of ADOBE_JAPAN1.chars) {
      const cp = ch.codePointAt(0);
      if (cp > 0xffff && !seen.has(cp)) {
        seen.add(cp);
        const h = 0xd800 + ((cp - 0x10000) >> 10);
        const l = 0xdc00 + ((cp - 0x10000) & 1023);
        out.push([h >> 8, h & 255, l >> 8, l & 255]);
      }
    }
  }
  return out;
}

const hexOf = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

/** PDF.js が読んだ「コード → CID」（Adobe の表に字がない・PDF.js が代わりの字を出したコードは 0。読めなかったコードは入れない） */
async function oracle(name, list) {
  const vertical = /-V$/.test(name);
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const w = [];
  for (let c = 0; c < CID_COUNT; c++) w.push(Number((1 + c * STEP).toFixed(2)));
  const cid = ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "CIDFontType0",
      BaseFont: "KasouMincho",
      CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Japan1"), Supplement: 7 },
      FontDescriptor: ctx.obj({ Type: "FontDescriptor", FontName: "KasouMincho", Flags: 4, FontBBox: [0, -141, 1000, 859], ItalicAngle: 0, Ascent: 859, Descent: -141, CapHeight: 700, StemV: 80 }),
      DW: 1000,
      W: [0, w],
      ...(vertical ? { W2: [0, w.flatMap((x) => [-x, 500, 880])] } : {}),
    }),
  );
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "KasouMincho", Encoding: name, DescendantFonts: [cid] }));
  for (let start = 0; start < list.length; start += PER_PAGE) {
    const page = doc.addPage([3000, PER_PAGE * 20 + 40]);
    page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font } }));
    const ops = [];
    for (let k = start; k < Math.min(list.length, start + PER_PAGE); k++) {
      ops.push(`BT /F1 1000 Tf 0.001 0 0 0.001 20 ${PER_PAGE * 20 - (k - start) * 20} Tm <${hexOf(list[k])}> Tj ET`);
    }
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(ops.join(NL))));
  }
  const data = await doc.save({ useObjectStreams: false });
  const loading = pdfjs.getDocument({
    data,
    cMapUrl: `${CMAPS.split(path.sep).join("/")}/`,
    cMapPacked: true,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const pdf = await loading.promise;
  const got = new Map();
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent({ disableNormalization: true });
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      if (vertical && it.width === 0) continue; // 縦書きの字の間に PDF.js が足す空白
      const row = Math.round((PER_PAGE * 20 - it.transform[5]) / 20);
      const k = (p - 1) * PER_PAGE + row;
      if (k < 0 || k >= list.length) continue;
      const adv = vertical ? it.height : it.width;
      const c = Math.round((adv * 1000 - 1) / STEP);
      const ok = c > 0 && c < CID_COUNT && (it.str === japan1Char(c) || (it.str === "" && japan1Char(c) === ""));
      got.set(hexOf(list[k]), ok ? c : 0);
    }
  }
  await loading.destroy();
  return got;
}

async function build() {
  const tables = {};
  const stats = [];
  for (const name of NAMES) {
    const list = codesOf(name);
    const want = await oracle(name, list);
    const plain = makePredefinedCMap(name, {});
    const ex = {};
    let mapped = 0;
    for (const bytes of list) {
      const key = hexOf(bytes);
      if (!want.has(key)) continue;
      const c = want.get(key);
      if (c > 0) mapped++;
      const r = plain.read(Uint8Array.from(bytes), 0);
      if (r.len !== bytes.length) continue; // 区切りが違うコード（単独のサロゲートなど）は、ここでは扱わない
      // Adobe の表に字がないコード（c が 0）は持たない。表を作った側がふつう書かないコードで、こちらで字を読んでも害が小さいため（表を小さく保つ）
      if (c > 0 && r.cid !== c) ex[parseInt(key, 16).toString(16)] = c;
    }
    tables[name] = ex;
    stats.push(`${name}：字のあるコード ${mapped}、例外 ${Object.keys(ex).length}`);
  }
  const ts = [
    "// SPDX-License-Identifier: BSD-3-Clause",
    "//",
    "// 決まった字の対応表（日本語の predefined CMap）の例外の表。scripts/build-predefined-cmaps.mjs が作る（直接書き換えない）。",
    "// rules/shared/predefined-cmaps.ts の読み方で選んだ CID が、Adobe の対応表と違うコードだけを持つ（コードの 16 進 → CID）。",
    "// 元は Adobe の対応表（pdfjs-dist の cmaps/。ライセンスは同じフォルダの LICENSE-adobe-cmaps）。",
    `export const PREDEFINED_CMAP_EXCEPTIONS = ${JSON.stringify(tables)} as const;`,
    "",
  ].join(NL);
  return { ts, stats };
}

const { ts, stats } = await build();
const rel = path.relative(ROOT, OUT);
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== ts) {
    console.error(`${rel} が、作り直したものと違います。node scripts/build-predefined-cmaps.mjs で書き直してください`);
    process.exit(1);
  }
  console.log(`${rel} は、作り直したものと同じです`);
} else {
  writeFileSync(OUT, ts);
  console.log(`${rel} を書きました（${Buffer.byteLength(ts)} バイト）`);
}
for (const s of stats) console.log(s);

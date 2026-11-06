// SPDX-License-Identifier: AGPL-3.0-only
//
// P6 の案：スキャン画像の画素は黒く塗ったのに、文字認識の層（描き方 3 の見えない字）に氏名が残る形。
//   node build.mjs [出力先のフォルダ]
// 出力先を省くと、このファイルの横の out/ に書く。
// - 名前・住所はすべて架空。黒い四角の塗り（re f）や注釈の覆いは置かない。
// - 日時は使わない。模様は種を決めた乱数（同じ種なら同じ列）で作るので、何度作っても同じバイト列になる。
// - 字は Helvetica（PDF の標準の字体。埋め込まない）で、ローマ字の架空の名前にする。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDFDocument, StandardFonts, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
  beginText, endText, setFontAndSize, moveText, showText, setTextRenderingMode, TextRenderingMode,
} from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));
const PAGE = [400, 300];
const ASC = 0.718; // Helvetica の Ascent・Descent（1em に対する割合）
const DESC = -0.207;
const SIZE = 12;
const SCALE = 1.25; // 1 ポイントあたりの画素
const W = Math.round(PAGE[0] * SCALE);
const H = Math.round(PAGE[1] * SCALE);
const PAPER = 238;
const r2 = (v) => Math.round(v * 100) / 100;
const chars = (s) => [...s.replace(/\s/g, "")].length;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Helvetica で s を x・y（字の下端）に描いたときの箱 */
const textBox = (font, s, x, y, size = SIZE) => [r2(x), r2(y + DESC * size), r2(x + font.widthOfTextAtSize(s, size)), r2(y + ASC * size)];
const pad = (b, p) => [r2(b[0] - p), r2(b[1] - p), r2(b[2] + p), r2(b[3] + p)];

/** ページの箱を、画素の範囲（x0, x1, y0, y1。上から数える）にする */
function pxRange(box) {
  return [
    Math.max(0, Math.floor(box[0] * SCALE)), Math.min(W, Math.ceil(box[2] * SCALE)),
    Math.max(0, Math.floor((PAGE[1] - box[3]) * SCALE)), Math.min(H, Math.ceil((PAGE[1] - box[1]) * SCALE)),
  ];
}
function fillBox(px, box, v) {
  const [x0, x1, y0, y1] = pxRange(box);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[y * W + x] = v;
}
/** 箱の中に、字の形をまねた線の模様を値 v で描く（文字認識はしないので、本物の字である必要はない） */
function glyphs(px, box, seed, v) {
  const rand = rng(seed);
  const cell = box[3] - box[1];
  for (let x = box[0]; x + cell * 0.6 <= box[2]; x += cell * 0.62) {
    if (rand() < 0.1) continue;
    const strokes = 2 + Math.floor(rand() * 3);
    for (let k = 0; k < strokes; k++) {
      const vertical = rand() < 0.5;
      const a = 1 + rand() * (cell * 0.6 - 2);
      const a2 = 1 + rand() * (cell - 2);
      const b0 = 1 + rand() * 2, b1 = (vertical ? cell : cell * 0.6) - 1 - rand() * 2;
      for (let t = b0; t <= b1; t += 0.4) {
        const [X, Y] = vertical ? [x + a, box[1] + t] : [x + t, box[1] + a2];
        const PX = Math.round(X * SCALE), PY = Math.round((PAGE[1] - Y) * SCALE);
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
          const xx = PX + dx, yy = PY + dy;
          if (xx >= 0 && xx < W && yy >= 0 && yy < H) px[yy * W + xx] = v;
        }
      }
    }
  }
}
/** 箱の下の画素のうち、濃い（明るさ 0.5 未満）ものの割合 */
function darkRatio(px, box) {
  const [x0, x1, y0, y1] = pxRange(box);
  let dark = 0, all = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { all++; if (px[y * W + x] < 128) dark++; }
  return all ? Math.round((dark / all) * 1000) / 1000 : 0;
}

// 文字認識の層の行（y は字の下端）。スキャンの模様も同じ位置に描く
const LINES = [
  { s: "Certificate of residence (application)", y: 250 },
  { s: "Applicant: ", name: "Hanako Kitagawa", y: 220 },
  { s: "Address: 1-2-3 Sample-cho, Example City", y: 190 },
  { s: "Date: 2026-11-01", y: 160 },
];
const BAND = { s: "NOTICE TO APPLICANTS", y: 110 }; // 対照：黒い帯に白抜きの字

async function make(name, description, { removeNameText, withBand }) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage(PAGE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const px = new Uint8Array(W * H).fill(PAPER);
  const leaks = [], negatives = [];
  const ocr = []; // [字, x, y]
  const measured = {};
  LINES.forEach((ln, i) => {
    const full = ln.s + (ln.name ?? "");
    glyphs(px, textBox(font, full, 40, ln.y), 100 + i, 30);
    ocr.push([removeNameText && ln.name ? ln.s : full, 40, ln.y]);
  });
  // 氏名の所の画素を、画像の中で黒く塗る（画素そのものを消す）
  const ln = LINES[1];
  const nameBox = textBox(font, ln.name, 40 + font.widthOfTextAtSize(ln.s, SIZE), ln.y);
  const burned = pad(nameBox, 1.5);
  fillBox(px, burned, 0);
  measured.nameBox = darkRatio(px, nameBox);
  measured.plainLine = darkRatio(px, textBox(font, LINES[0].s, 40, LINES[0].y));
  if (withBand) {
    const tb = textBox(font, BAND.s, 40, BAND.y);
    const band = pad(tb, 4);
    fillBox(px, band, 0);
    glyphs(px, tb, 200, 250);
    ocr.push([BAND.s, 40, BAND.y]);
    measured.band = darkRatio(px, tb);
    negatives.push({ kind: "ocr_on_dark_band", page: 1, rect: tb, note: "黒い帯に白抜きの字のスキャン。帯の上の文字認識の字は、画像の字と同じ（隠していない）" });
  }
  // 画像を置く（1ページ全体）
  const img = doc.context.register(doc.context.flateStream(px, {
    Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceGray", BitsPerComponent: 8,
  }));
  const im = page.node.newXObject("Im", img);
  const fk = page.node.newFontDictionary("F", font.ref);
  const ops = [pushGraphicsState(), concatTransformationMatrix(PAGE[0], 0, 0, PAGE[1], 0, 0), drawObject(im), popGraphicsState()];
  for (const [s, x, y] of ocr) {
    ops.push(beginText(), setTextRenderingMode(TextRenderingMode.Invisible), setFontAndSize(fk, SIZE), moveText(x, y), showText(font.encodeText(s)), endText());
  }
  page.pushOperators(...ops);

  if (removeNameText) {
    negatives.unshift({ kind: "redacted_correctly", page: 1, rect: burned, note: "画素を黒く塗り、その上の文字認識の字も消してある" });
  } else {
    leaks.push({ pattern: "P6", layer: "text", cover: "burned_pixels", page: 1, rect: nameBox, remaining: { chars: chars(ln.name) } });
  }
  for (const [s, x, y] of ocr) {
    if (s === BAND.s) continue;
    negatives.push({ kind: "ocr_layer", page: 1, rect: textBox(font, s, x, y), note: "塗っていない所の文字認識の字（お知らせだけ）" });
  }
  const bytes = await doc.save({ useObjectStreams: false });
  const expected = {
    file: `${name}.pdf`, description, pages: 1,
    leaks: leaks.map((l, i) => ({ id: `${name}#L${i + 1}`, ...l })),
    negatives: negatives.map((n, i) => ({ id: `${name}#N${i + 1}`, ...n })),
  };
  writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
  writeFileSync(path.join(OUT, `${name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
  return { name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, measured };
}

mkdirSync(OUT, { recursive: true });
const rows = [
  await make("e-ocr-01-burned-but-text-left", "スキャン画像の氏名の所の画素を黒く塗ったが、その上の文字認識の層（描き方 3）に氏名が残る。覆いの図形・注釈は無い", { removeNameText: false, withBand: false }),
  await make("e-ocr-02-burned-and-text-removed", "対照：画素を黒く塗り、文字認識の層からも氏名を消した。黒い帯に白抜きの字のスキャン（上に文字認識の字）も置く", { removeNameText: true, withBand: true }),
];
for (const r of rows) console.log(`${r.sha256}  ${r.name}.pdf  ${r.bytes} バイト  濃い画素の割合 ${JSON.stringify(r.measured)}`);

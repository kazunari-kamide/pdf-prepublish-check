// SPDX-License-Identifier: AGPL-3.0-only
//
// P6 の案：画像の一部を、やわらかい型抜き（/SMask）で透明にして消したが、透明な所の元の画素（RGB）が残る形。
//   node build.mjs [出力先のフォルダ]
// 出力先を省くと、このファイルの横の out/ に書く。
// - 画像の中の「字」は、字の形をまねた線の模様（文字認識はしないので、本物の字である必要はない）。中身はすべて架空。
// - ページの上にも下にも、覆いの図形・注釈は置かない。
// - 日時は使わない。模様は種を決めた乱数（同じ種なら同じ列）で作るので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));
const PAGE = [400, 300];
const r2 = (v) => Math.round(v * 100) / 100;

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

// 画像は 240×96 画素。ページの [80, 110, 320, 206] に 1 画素 = 1 ポイントで置く
const IW = 240, IH = 96;
const PLACE = [80, 110, 320, 206];
// 画像の中の字の行（画素。上から数える）。行 1 の x 70〜200 が氏名
const ROWS = [{ y: 10, x0: 10, x1: 230 }, { y: 40, x0: 10, x1: 200 }, { y: 70, x0: 10, x1: 180 }];
const NAME_PX = { x0: 68, x1: 202, y0: 36, y1: 58 }; // 透明にする所（画素）
const pxToPage = (b) => [PLACE[0] + b.x0, PLACE[3] - b.y1, PLACE[0] + b.x1, PLACE[3] - b.y0];

function card(seed) {
  const rand = rng(seed);
  const rgbPx = new Uint8Array(IW * IH * 3).fill(255);
  const set = (x, y, v) => {
    if (x < 0 || x >= IW || y < 0 || y >= IH) return;
    const i = (y * IW + x) * 3;
    rgbPx[i] = v; rgbPx[i + 1] = v; rgbPx[i + 2] = Math.min(255, v + 10);
  };
  const cell = 14;
  for (const row of ROWS) {
    for (let x = row.x0; x + cell <= row.x1; x += cell) {
      if (rand() < 0.1) continue;
      const strokes = 2 + Math.floor(rand() * 3);
      for (let k = 0; k < strokes; k++) {
        const vertical = rand() < 0.5;
        const a = 2 + Math.floor(rand() * (cell - 4));
        const b0 = 1 + Math.floor(rand() * 3), b1 = cell - 1 - Math.floor(rand() * 3);
        for (let t = b0; t <= b1; t++) {
          const [X, Y] = vertical ? [x + a, row.y + t] : [x + t, row.y + a];
          set(X, Y, 35); set(X + 1, Y, 35);
        }
      }
    }
  }
  return rgbPx;
}
function fillRgb(px, b, v) {
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) { const i = (y * IW + x) * 3; px[i] = v; px[i + 1] = v; px[i + 2] = v; }
}
function alphaWithHole(b) {
  const a = new Uint8Array(IW * IH).fill(255);
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) a[y * IW + x] = 0;
  return a;
}

function placeImage(doc, page, rgbPx, alpha, w, h, box) {
  const ctx = doc.context;
  const smask = ctx.register(ctx.flateStream(alpha, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
  const img = ctx.register(ctx.flateStream(rgbPx, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8, SMask: smask }));
  const name = page.node.newXObject("Im", img);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(box[2] - box[0], 0, 0, box[3] - box[1], box[0], box[1]), drawObject(name), popGraphicsState());
}

async function base() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage(PAGE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Attached: scanned membership card (image)", { x: 40, y: 250, size: 12, font, color: rgb(0, 0, 0) });
  return { doc, page };
}

async function save(doc, name, description, leaks, negatives) {
  const bytes = await doc.save({ useObjectStreams: false });
  const expected = {
    file: `${name}.pdf`, description, pages: 1,
    leaks: leaks.map((l, i) => ({ id: `${name}#L${i + 1}`, ...l })),
    negatives: negatives.map((n, i) => ({ id: `${name}#N${i + 1}`, ...n })),
  };
  writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
  writeFileSync(path.join(OUT, `${name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
  return { name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

mkdirSync(OUT, { recursive: true });
const rows = [];

// 漏れ：氏名の所だけ透明（型抜き 0）。RGB の側には、元の字の模様がそのまま残る
{
  const { doc, page } = await base();
  placeImage(doc, page, card(7), alphaWithHole(NAME_PX), IW, IH, PLACE);
  const rect = pxToPage(NAME_PX).map(r2);
  rows.push(await save(doc, "e-alpha-01-name-erased-to-transparent",
    "画像の氏名の所を、型抜き（/SMask）で透明にしただけ。透明な所の RGB の画素に、元の字の模様が残る。覆いの図形・注釈は無い",
    [{ pattern: "P6", layer: "image", cover: "smask", page: 1, rect, remaining: {} }], []));
}

// 対照：透明にした所の RGB を白に塗ってから透明にした画像と、縁をやわらかく透明にした写真のような画像
{
  const { doc, page } = await base();
  const px = card(7);
  fillRgb(px, NAME_PX, 255);
  placeImage(doc, page, px, alphaWithHole(NAME_PX), IW, IH, PLACE);
  // 写真のような画像（120×60 画素）。縁 12 画素を、外へ向かって透明にしていく。透明な所にも模様が残る（字ではない）
  const PW = 120, PH = 60, PBOX = [240, 20, 360, 80];
  const rand = rng(99);
  const photo = new Uint8Array(PW * PH * 3);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const base = 90 + Math.round(60 * Math.sin(x / 9) * Math.cos(y / 7));
    const n = Math.floor(rand() * 30);
    const i = (y * PW + x) * 3;
    photo[i] = Math.min(255, base + n); photo[i + 1] = Math.min(255, base + 20 + n); photo[i + 2] = Math.min(255, base + 40);
  }
  const feather = new Uint8Array(PW * PH);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const d = Math.min(x, y, PW - 1 - x, PH - 1 - y);
    feather[y * PW + x] = d >= 12 ? 255 : Math.round((d / 12) * 255);
  }
  placeImage(doc, page, photo, feather, PW, PH, PBOX);
  rows.push(await save(doc, "e-alpha-02-uniform-and-feathered",
    "対照：透明にした所の RGB を白に塗ってから透明にした画像と、縁をやわらかく透明にした写真のような画像（縁の透明な所にも模様が残るが、字ではない）",
    [], [
      { kind: "uniform_under_alpha", page: 1, rect: pxToPage(NAME_PX).map(r2), note: "透明な所の画素は一様に白（元の字は残っていない）" },
      { kind: "feathered_photo", page: 1, rect: PBOX, note: "縁のぼかし。透明な所に写真の模様が残る（字ではない）。扱いはルールを作る段で決める【仮】" },
    ]));
}

for (const r of rows) console.log(`${r.sha256}  ${r.name}.pdf  ${r.bytes} バイト`);

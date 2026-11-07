// SPDX-License-Identifier: AGPL-3.0-only
//
// 黒塗りのそばの記号（barcode-scan）の合成 PDF。鍵は「row」（黒い四角のそばに残った記号の列 1 つ）。中身はすべて架空。
// 根拠の実物はスキャンの画像のページなので、黒い四角も記号の列も、ページの全面の画像（灰色・Flate）の画素として描く。
// 図形の命令では描かない。記号の線の高さと並びは架空の値で、意味のある値を表していない。

import { PDFDocument, PDFName } from "pdf-lib";
import type { BarcodeReport } from "../../rules/barcode-scan/index.ts";
import type { Case } from "./pdf.ts";

export const keysOf = (r: BarcodeReport) => r.findings.map(() => "row");

type Rect = { x: number; y: number; w: number; h: number };
type Scan = { pxPerPt: number; paper: number; ink: number; noise: number; boxes: Rect[]; rows: Array<{ x: number; cy: number; heights: number[] }>; text: boolean };

/** 架空の書類のスキャンを、画素で描いて 1 ページの PDF にする（ページは 420×300pt。座標は pt・上が 0） */
async function scanPdf(o: Scan): Promise<Uint8Array> {
  const PW = 420;
  const PH = 300;
  const W = Math.round(PW * o.pxPerPt);
  const H = Math.round(PH * o.pxPerPt);
  const px = new Uint8Array(W * H).fill(o.paper);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const fill = (x: number, y: number, w: number, h: number) => {
    const x0 = Math.round(x * o.pxPerPt);
    const y0 = Math.round(y * o.pxPerPt);
    const x1 = Math.round((x + w) * o.pxPerPt);
    const y1 = Math.round((y + h) * o.pxPerPt);
    for (let yy = Math.max(0, y0); yy < Math.min(H, y1); yy++) for (let xx = Math.max(0, x0); xx < Math.min(W, x1); xx++) px[yy * W + xx] = o.ink;
  };
  // 字の行の代わりの、幅も間もそろわない濃いかたまり（字のように見える所）
  if (o.text) {
    for (let line = 0; line < 6; line++) {
      let x = 30;
      while (x < 380) {
        const w = 5 + Math.floor(rnd() * 9);
        fill(x, 20 + line * 14, w, 8);
        x += w + 2 + Math.floor(rnd() * 5);
      }
    }
  }
  // 記号の列：線の幅 1.5pt・間 3.5pt。高さは渡した並び（中心をそろえる）
  for (const r of o.rows) {
    r.heights.forEach((h, i) => fill(r.x + i * 3.5, r.cy - h / 2, 1.5, h));
  }
  for (const b of o.boxes) fill(b.x, b.y, b.w, b.h);
  for (let i = 0; i < px.length; i++) px[i] = Math.max(0, Math.min(255, px[i]! + Math.round((rnd() - 0.5) * 2 * o.noise)));

  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([PW, PH]);
  const img = doc.context.flateStream(px, { Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
  page.node.setXObject(PDFName.of("Im0"), doc.context.register(img));
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(`q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`)));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

/** 架空の 4 種の高さの並び（長い・上の半分・下の半分の代わりに 3 つの高さ＋短い線） */
const fourState = (n: number) => Array.from({ length: n }, (_, i) => [10, 7, 7, 3.5][(i * 7 + (i >> 2)) % 4]!);
const single = (n: number) => Array.from({ length: n }, () => 8);

const ROWS = [
  { x: 40, cy: 125, heights: fourState(60) },
  { x: 260, cy: 205, heights: single(12) },
];
/** 宛先の欄を塗った四角 */
const ADDRESS_BOX: Rect = { x: 40, y: 140, w: 220, h: 45 };

export const CASES: Case[] = [
  {
    id: "bs-l01",
    kind: "leak",
    description: "架空の通知書のスキャン（144dpi）。宛先の欄を黒く塗り、すぐ上の 4 種の高さの記号の列（60 本）と、そばの 1 種の高さの列（12 本）は塗られずに残る",
    leaks: ["row", "row"],
    build: () => scanPdf({ pxPerPt: 2, paper: 240, ink: 40, noise: 10, boxes: [ADDRESS_BOX], rows: ROWS, text: true }),
  },
  {
    id: "bs-l02",
    kind: "leak",
    description: "荒いスキャン（約 115dpi・黒が浅い・ざらつきが強い）で、宛先の欄だけを塗り、上の 4 種の高さの記号の列は残る",
    leaks: ["row"],
    build: () => scanPdf({ pxPerPt: 1.6, paper: 225, ink: 70, noise: 18, boxes: [ADDRESS_BOX], rows: [ROWS[0]!], text: true }),
  },
  {
    id: "bs-l03",
    kind: "leak",
    description: "細かいスキャン（216dpi）で、記号の列を四角の下に残したもの",
    leaks: ["row"],
    build: () => scanPdf({ pxPerPt: 3, paper: 245, ink: 30, noise: 8, boxes: [{ x: 40, y: 100, w: 220, h: 40 }], rows: [{ x: 40, cy: 160, heights: fourState(60) }], text: true }),
  },
  {
    id: "bs-c01",
    kind: "control",
    description: "同じ書式で、記号の列も黒い四角で覆ったもの（正しい墨消し）",
    leaks: [],
    build: () => scanPdf({ pxPerPt: 2, paper: 240, ink: 40, noise: 10, boxes: [{ x: 35, y: 110, w: 280, h: 110 }], rows: ROWS, text: true }),
  },
  {
    id: "bs-c02",
    kind: "control",
    description: "墨消しのないページに、中身と関係のない固定の記号の列だけがあるもの",
    leaks: [],
    build: () => scanPdf({ pxPerPt: 2, paper: 240, ink: 40, noise: 10, boxes: [], rows: ROWS, text: true }),
  },
  {
    id: "bs-c03",
    kind: "control",
    description: "墨消しはあるが、そばに記号の列が無いもの（字の行だけ）",
    leaks: [],
    build: () => scanPdf({ pxPerPt: 2, paper: 240, ink: 40, noise: 10, boxes: [ADDRESS_BOX], rows: [], text: true }),
  },
];

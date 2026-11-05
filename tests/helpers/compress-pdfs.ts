// SPDX-License-Identifier: AGPL-3.0-only
//
// ファイルを小さくする（sanitize/compress.ts）の合成 PDF。中身はすべて架空（模様と見本の字だけ）。
// 毎回同じものができるように、乱れ（紙のざらつき・写真の粒）は決まった種から作る。

import { deflateSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDict, PDFRawStream, type PDFContext, type PDFRef } from "pdf-lib";
import { buildPdf, imageFlate, textAt } from "./redact-pdfs.ts";

/** 決まった種の乱数（0〜1） */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** スキャンのような灰色：白い紙のざらつき（±6）の上に、字の行のような濃い横縞 */
export function scanGray(w: number, h: number, seed = 1): Uint8Array {
  const r = random(seed);
  const px = new Uint8Array(w * h);
  const line = Math.max(8, Math.round(h / 120));
  for (let y = 0; y < h; y++) {
    const inLine = y % (line * 2) < line && y > h * 0.08 && y < h * 0.92;
    for (let x = 0; x < w; x++) {
      const ink = inLine && x > w * 0.1 && x < w * 0.9 && Math.floor(x / line) % 5 !== 0;
      px[y * w + x] = Math.max(0, Math.min(255, (ink ? 40 : 245) + Math.round((r() - 0.5) * 12)));
    }
  }
  return px;
}

/** 写真のような RGB：なめらかな色の移り変わりに、細かな粒 */
export function photoRgb(w: number, h: number, seed = 2): Uint8Array {
  const r = random(seed);
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const n = (r() - 0.5) * 16;
      px[i] = Math.max(0, Math.min(255, 60 + (150 * x) / w + n));
      px[i + 1] = Math.max(0, Math.min(255, 90 + 100 * Math.sin((y / h) * Math.PI) + n));
      px[i + 2] = Math.max(0, Math.min(255, 200 - (120 * y) / h + n));
    }
  }
  return px;
}

/** RGB の画素を JPEG（質 92）の画像にする */
export async function jpegImage(ctx: PDFContext, w: number, h: number, rgb: Uint8Array): Promise<PDFRef> {
  const canvas = createCanvas(w, h);
  const g = canvas.getContext("2d");
  const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = rgb[i * 3]!;
    img.data[i * 4 + 1] = rgb[i * 3 + 1]!;
    img.data[i * 4 + 2] = rgb[i * 3 + 2]!;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const bytes = new Uint8Array(await canvas.encode("jpeg", 92));
  return ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" }), bytes));
}

/** 1 ビットの白黒画像（Flate） */
export function bitonalImage(ctx: PDFContext, w: number, h: number): PDFRef {
  const row = Math.ceil(w / 8);
  const data = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < row; x++) data[y * row + x] = y % 16 < 8 ? 0xaa : 0xff;
  return ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 1, Filter: "FlateDecode" }) as unknown as PDFDict, new Uint8Array(deflateSync(data))));
}

/** A4（ポイント） */
export const A4: [number, number] = [595, 842];
/** A4 を dpi で描いたときの画素の数 */
export const a4px = (dpi: number): [number, number] => [Math.round((A4[0] / 72) * dpi), Math.round((A4[1] / 72) * dpi)];

export type CompressScene = {
  name: string;
  /** 画像を書き直すと見込むか */
  expectChanged: boolean;
  make: () => Promise<Uint8Array>;
};

const full = (w = A4[0], h = A4[1]) => `q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q\n`;

export const SCENES: CompressScene[] = [
  {
    name: "スキャン（灰色・Flate・300dpi の A4）",
    expectChanged: true,
    make: () => buildPdf((doc) => {
      const [w, h] = a4px(300);
      return { pages: [{ size: A4, content: full(), images: [imageFlate(doc.context, w, h, 1, scanGray(w, h))] }] };
    }),
  },
  {
    name: "スキャン（RGB・JPEG・300dpi の A4）",
    expectChanged: true,
    make: () => buildPdf(async (doc) => {
      const [w, h] = a4px(300);
      const g = scanGray(w, h, 3);
      const rgb = new Uint8Array(w * h * 3);
      for (let i = 0; i < w * h; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = g[i]!;
      return { pages: [{ size: A4, content: full(), images: [await jpegImage(doc.context, w, h, rgb)] }] };
    }),
  },
  {
    name: "写真（RGB・JPEG・300dpi で半ページ）と字",
    expectChanged: true,
    make: () => buildPdf(async (doc) => {
      const [w, h] = [Math.round((500 / 72) * 300), Math.round((350 / 72) * 300)];
      return {
        pages: [{ size: A4, content: textAt(50, 790, "氏名見本花子") + `q 500 0 0 350 47 400 cm /Im1 Do Q\n`, images: [await jpegImage(doc.context, w, h, photoRgb(w, h))] }],
      };
    }),
  },
  {
    name: "同じ画像を小さく・大きく2か所に描く（大きい方の細かさで縮める）",
    expectChanged: true,
    make: () => buildPdf((doc) => {
      const [w, h] = [1600, 1200];
      return {
        pages: [{ size: A4, content: `q 120 0 0 90 50 700 cm /Im1 Do Q\nq 480 0 0 360 50 200 cm /Im1 Do Q\n`, images: [imageFlate(doc.context, w, h, 3, photoRgb(w, h, 5))] }],
      };
    }),
  },
  {
    name: "透明の型（/SMask）のある写真（型はそのまま）",
    expectChanged: true,
    make: () => buildPdf((doc) => {
      const [w, h] = [1500, 1000];
      const mask = new Uint8Array(w * h).fill(255);
      for (let i = 0; i < w * h; i += 7) mask[i] = 128;
      return { pages: [{ size: A4, content: `q 300 0 0 200 50 400 cm /Im1 Do Q\n`, images: [imageFlate(doc.context, w, h, 3, photoRgb(w, h, 7), mask)] }] };
    }),
  },
  {
    name: "白黒（1 ビット）のスキャン（手を付けない）",
    expectChanged: false,
    make: () => buildPdf((doc) => {
      const [w, h] = a4px(300);
      return { pages: [{ size: A4, content: full(), images: [bitonalImage(doc.context, w, h)] }] };
    }),
  },
  {
    name: "もう粗い画像（72dpi。手を付けない）",
    expectChanged: false,
    make: () => buildPdf((doc) => {
      const [w, h] = a4px(72);
      return { pages: [{ size: A4, content: full(), images: [imageFlate(doc.context, w, h, 1, scanGray(w, h, 9))] }] };
    }),
  },
  {
    name: "注釈の見た目からも使う画像（手を付けない）",
    expectChanged: false,
    make: () => buildPdf((doc) => {
      const ctx = doc.context;
      const [w, h] = [1200, 900];
      const im = imageFlate(ctx, w, h, 3, photoRgb(w, h, 11));
      const ap = ctx.register(ctx.stream("q 100 0 0 75 0 0 cm /I Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 75], Resources: { XObject: { I: im } } }));
      return {
        pages: [{ size: A4, content: `q 100 0 0 75 50 600 cm /Im1 Do Q\n`, images: [im], annots: [{ Subtype: "Stamp", Rect: [300, 600, 400, 675], AP: { N: ap } }] }],
      };
    }),
  },
  {
    name: "対照：字だけ（画像なし）",
    expectChanged: false,
    make: () => buildPdf(() => ({ pages: [{ size: A4, content: textAt(50, 790, "氏名見本花子") + textAt(50, 760, "住所東西南北町") }] })),
  },
];

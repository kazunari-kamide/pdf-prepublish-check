// SPDX-License-Identifier: AGPL-3.0-only
//
// 画像の地の色を読む（0.7.0 から）。P7 の「画像と同じ色の字」（字の下の画像の色が、字の色と同じで見えない）を決めるため。
// 画像を明るさ（0〜1）の並びに解き、字の箱の下の画素の明るさの、いちばん暗い・明るい・平均を返す。
// 解けない画像・大きすぎる画像は null（呼ぶ側は「分からない」として、字を消さない）。

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObjectCopier, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFContext, type PDFObject } from "pdf-lib";
import { apply, type Matrix, type Rect } from "../rules/p6-text/geometry.ts";
import { luminanceOf } from "../rules/p6-text/page.ts";
import type { ImageCodec } from "./types.ts";

/** 画像1つだけを描いた小さな PDF（codec.decode に渡す。片付けの images.ts・compress.ts と同じ形） */
export async function onePagePdf(ctx: PDFContext, stream: PDFStream, colorSpaces: PDFDict | undefined): Promise<Uint8Array> {
  const one = await PDFDocument.create({ updateMetadata: false });
  const copier = PDFObjectCopier.for(ctx, one.context);
  const copy = copier.copy(stream) as PDFStream;
  const cs = stream.dict.get(PDFName.of("ColorSpace"));
  if (cs instanceof PDFName && colorSpaces?.get(cs)) copy.dict.set(PDFName.of("ColorSpace"), copier.copy(colorSpaces.get(cs)!));
  copy.dict.delete(PDFName.of("SMask"));
  copy.dict.delete(PDFName.of("Mask"));
  const ref = one.context.register(copy);
  const page = one.addPage([1, 1]);
  page.node.set(PDFName.of("Resources"), one.context.obj({ XObject: { I: ref } }));
  page.node.set(PDFName.of("Contents"), one.context.register(one.context.stream("q 1 0 0 1 0 0 cm /I Do Q")));
  return one.save({ useObjectStreams: false });
}

export type LumaImage = { w: number; h: number; luma: Float32Array };

const num = (ctx: PDFContext, d: PDFDict, k: string): number => {
  const v = ctx.lookup(d.get(PDFName.of(k)));
  return v instanceof PDFNumber ? v.asNumber() : 0;
};

/** 色空間の成分の数（DeviceGray・DeviceRGB・DeviceCMYK と、ICCBased の /N）。それ以外は 0 */
function components(ctx: PDFContext, cs: PDFObject | undefined, spaces: PDFDict | undefined): number {
  let v = cs instanceof PDFRef ? ctx.lookup(cs) : cs;
  if (v instanceof PDFName && spaces?.get(v)) v = ctx.lookup(spaces.get(v));
  if (v instanceof PDFName) {
    const n = v.decodeText();
    return n === "DeviceGray" ? 1 : n === "DeviceRGB" ? 3 : n === "DeviceCMYK" ? 4 : 0;
  }
  if (v instanceof PDFArray && ctx.lookup(v.get(0)) === PDFName.of("ICCBased")) {
    const st = ctx.lookup(v.get(1));
    const n = st instanceof PDFStream ? st.dict.lookup(PDFName.of("N")) : undefined;
    return n instanceof PDFNumber ? n.asNumber() : 0;
  }
  return 0;
}

/** 画像を明るさの並びに解く。8 ビットの灰色・RGB・CMYK（予測・/Decode なし）は手元で、それ以外は画像の道具で解く */
export async function decodeLuma(ctx: PDFContext, stream: PDFStream, colorSpaces: PDFDict | undefined, codec: ImageCodec | undefined, maxPixels: number): Promise<LumaImage | null> {
  const d = stream.dict;
  const w = Math.floor(num(ctx, d, "Width"));
  const h = Math.floor(num(ctx, d, "Height"));
  if (w <= 0 || h <= 0 || w * h > maxPixels) return null;
  const n = components(ctx, d.get(PDFName.of("ColorSpace")), colorSpaces);
  const bpc = num(ctx, d, "BitsPerComponent");
  const parms = ctx.lookup(d.get(PDFName.of("DecodeParms")));
  const predictor = parms instanceof PDFDict ? num(ctx, parms, "Predictor") : 0;
  if (n > 0 && bpc === 8 && predictor <= 1 && !d.has(PDFName.of("Decode")) && stream instanceof PDFRawStream) {
    try {
      const raw = decodePDFRawStream(stream).decode();
      if (raw.length >= w * h * n) {
        const luma = new Float32Array(w * h);
        const c = new Array<number>(n);
        for (let i = 0; i < w * h; i++) {
          for (let k = 0; k < n; k++) c[k] = raw[i * n + k]! / 255;
          luma[i] = luminanceOf(c, n) ?? 0;
        }
        return { w, h, luma };
      }
    } catch {
      // 手元で解けない形（JPEG など）：画像の道具に回す
    }
  }
  if (!codec) return null;
  try {
    const dec = await codec.decode(await onePagePdf(ctx, stream, colorSpaces), w * h);
    if (!dec || dec.width !== w || dec.height !== h) return null;
    const luma = new Float32Array(w * h);
    if (dec.kind === "gray1") {
      const row = Math.ceil(w / 8);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) luma[y * w + x] = (dec.data[y * row + (x >> 3)]! >> (7 - (x & 7))) & 1;
    } else {
      if (dec.data.length < w * h * 3) return null;
      for (let i = 0; i < w * h; i++) luma[i] = luminanceOf([dec.data[i * 3]! / 255, dec.data[i * 3 + 1]! / 255, dec.data[i * 3 + 2]! / 255], 3) ?? 0;
    }
    return { w, h, luma };
  } catch {
    return null;
  }
}

/** 逆の行列（画像の単位の正方形 ← ページの座標）。逆にできなければ null */
function invert(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** ページの座標の箱の下にある画素の明るさ（いちばん暗い・明るい・平均）。箱が画像に掛からなければ null */
export function sampleLuma(img: LumaImage, ctm: Matrix, rect: Rect): { min: number; max: number; mean: number } | null {
  const inv = invert(ctm);
  if (!inv) return null;
  const pts = [apply(inv, rect[0], rect[1]), apply(inv, rect[2], rect[1]), apply(inv, rect[0], rect[3]), apply(inv, rect[2], rect[3])];
  const us = pts.map((p) => p[0]);
  const vs = pts.map((p) => p[1]);
  // 画像の単位の正方形：u は左から右、v は下から上（画素の行は上から下）
  const x0 = Math.max(0, Math.floor(Math.min(...us) * img.w));
  const x1 = Math.min(img.w, Math.ceil(Math.max(...us) * img.w));
  const y0 = Math.max(0, Math.floor((1 - Math.max(...vs)) * img.h));
  const y1 = Math.min(img.h, Math.ceil((1 - Math.min(...vs)) * img.h));
  if (x1 <= x0 || y1 <= y0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = img.luma[y * img.w + x]!;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      n++;
    }
  }
  return n ? { min, max, mean: sum / n } : null;
}

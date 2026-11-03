// SPDX-License-Identifier: AGPL-3.0-only
//
// 画像（Image XObject）が「ほぼ全部が濃い」かを測る（P6 の text/image：黒い画像を字の上に貼った型）。
// 画像の画素を読み、明るさが darkLuminanceMax 以下の画素の割合を返す。
// 読めない画像（JPEG など、このルールで解けない圧縮）は「分からない」として返し、濃いとはみなさない。
// 入ってくる画像は細工されている前提で扱う。大きすぎる画像は解かずに「分からない」とする。

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { luminanceOf } from "./page.ts";

export type ImageDarkness =
  | { kind: "measured"; darkFraction: number }
  | { kind: "unknown"; reason: "unsupported_filter" | "too_large" | "unsupported_color" | "broken" };

/** 画素の数を数える点の上限。これを超える画像は、縦横を間引いて数える */
const MAX_SAMPLES = 256 * 256;

type ColorModel =
  | { kind: "direct"; comps: number; space: number } // space は luminanceOf の成分の数（1・3・4）。0 は分からない
  | { kind: "indexed"; base: number; hival: number; lookup: Uint8Array };

function filterNames(ctx: PDFContext, dict: PDFDict): string[] {
  const f = dict.lookup(PDFName.of("Filter"));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((o) => ctx.lookup(o)).filter((o): o is PDFName => o instanceof PDFName).map((n) => n.decodeText());
  return [];
}

const DECODABLE = new Set(["FlateDecode", "Fl", "LZWDecode", "LZW", "ASCIIHexDecode", "AHx", "ASCII85Decode", "A85", "RunLengthDecode", "RL"]);

function spaceComponents(ctx: PDFContext, cs: PDFObject | undefined, colorSpaces: PDFDict | undefined, depth = 0): ColorModel | null {
  if (depth > 4) return null;
  const v = cs ? ctx.lookup(cs) : undefined;
  if (v instanceof PDFName) {
    const n = v.decodeText();
    if (n === "DeviceGray" || n === "G" || n === "CalGray") return { kind: "direct", comps: 1, space: 1 };
    if (n === "DeviceRGB" || n === "RGB" || n === "CalRGB") return { kind: "direct", comps: 3, space: 3 };
    if (n === "DeviceCMYK" || n === "CMYK") return { kind: "direct", comps: 4, space: 4 };
    const named = colorSpaces?.get(PDFName.of(n));
    return named ? spaceComponents(ctx, named, undefined, depth + 1) : null;
  }
  if (v instanceof PDFArray) {
    const head = ctx.lookup(v.get(0));
    const k = head instanceof PDFName ? head.decodeText() : "";
    if (k === "CalGray") return { kind: "direct", comps: 1, space: 1 };
    if (k === "CalRGB") return { kind: "direct", comps: 3, space: 3 };
    if (k === "ICCBased") {
      const st = ctx.lookup(v.get(1));
      const n = st instanceof PDFStream ? st.dict.lookup(PDFName.of("N")) : undefined;
      const c = n instanceof PDFNumber ? n.asNumber() : 0;
      return c === 1 || c === 3 || c === 4 ? { kind: "direct", comps: c, space: c } : null;
    }
    if (k === "Indexed" || k === "I") {
      const base = spaceComponents(ctx, v.get(1), colorSpaces, depth + 1);
      const hv = ctx.lookup(v.get(2));
      const lk = ctx.lookup(v.get(3));
      if (!base || base.kind !== "direct" || !(hv instanceof PDFNumber)) return null;
      let lookup: Uint8Array | null = null;
      if (lk instanceof PDFString || lk instanceof PDFHexString) lookup = lk.asBytes();
      else if (lk instanceof PDFRawStream) lookup = decodePDFRawStream(lk).decode();
      else if (lk instanceof PDFStream) lookup = lk.getContents();
      if (!lookup) return null;
      return { kind: "indexed", base: base.comps, hival: Math.max(0, Math.min(255, Math.floor(hv.asNumber()))), lookup };
    }
  }
  return null; // Separation・DeviceN・Lab・Pattern などは、いまは見分けない
}

/** PNG の予測（Predictor 10〜15）を戻す。1行の先頭に予測の種類の1バイトがある */
function undoPngPredictor(data: Uint8Array, colors: number, bpc: number, columns: number): Uint8Array {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)]!;
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i]!;
      const left = i >= bpp ? out[dst + i - bpp]! : 0;
      const up = r > 0 ? out[dst - rowLen + i]! : 0;
      const ul = r > 0 && i >= bpp ? out[dst - rowLen + i - bpp]! : 0;
      let v: number;
      switch (type) {
        case 1: v = x + left; break;
        case 2: v = x + up; break;
        case 3: v = x + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - ul;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - ul);
          v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
          break;
        }
        default: v = x;
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

/** TIFF の予測（Predictor 2）を戻す。8 ビットの成分だけ */
function undoTiffPredictor(data: Uint8Array, colors: number, bpc: number, columns: number): Uint8Array {
  if (bpc !== 8) return data;
  const rowLen = colors * columns;
  const out = data.slice();
  for (let r = 0; r + rowLen <= out.length; r += rowLen) {
    for (let i = colors; i < rowLen; i++) out[r + i] = (out[r + i]! + out[r + i - colors]!) & 0xff;
  }
  return out;
}

function decodeParms(ctx: PDFContext, dict: PDFDict): PDFDict | undefined {
  const p = dict.lookup(PDFName.of("DecodeParms")) ?? dict.lookup(PDFName.of("DP"));
  if (p instanceof PDFDict) return p;
  if (p instanceof PDFArray) {
    for (const o of p.asArray()) {
      const d = ctx.lookup(o);
      if (d instanceof PDFDict) return d;
    }
  }
  return undefined;
}

function numOf(dict: PDFDict, key: string, fallback: number): number {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

/** 画像の画素のバイト列（圧縮と予測を戻したもの）。解けなければ理由を返す */
function pixelBytes(ctx: PDFContext, stream: PDFStream, comps: number, bpc: number, width: number):
  | { ok: true; data: Uint8Array }
  | { ok: false; reason: "unsupported_filter" | "broken" } {
  const filters = filterNames(ctx, stream.dict);
  if (filters.some((f) => !DECODABLE.has(f))) return { ok: false, reason: "unsupported_filter" };
  let data: Uint8Array;
  try {
    data = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  } catch {
    return { ok: false, reason: "broken" };
  }
  const parms = decodeParms(ctx, stream.dict);
  if (parms) {
    const predictor = numOf(parms, "Predictor", 1);
    const colors = numOf(parms, "Colors", comps);
    const pbpc = numOf(parms, "BitsPerComponent", bpc);
    const columns = numOf(parms, "Columns", width);
    if (predictor >= 10) data = undoPngPredictor(data, colors, pbpc, columns);
    else if (predictor === 2) data = undoTiffPredictor(data, colors, pbpc, columns);
  }
  return { ok: true, data };
}

/** 行の中の x 番目の、c 番目の成分を 0〜(2^bpc − 1) の整数で読む */
function sampleAt(data: Uint8Array, rowStart: number, index: number, bpc: number): number {
  if (bpc === 8) return data[rowStart + index] ?? 0;
  if (bpc === 16) return data[rowStart + index * 2] ?? 0; // 上位バイトだけで十分
  const bit = index * bpc;
  const byte = data[rowStart + (bit >> 3)] ?? 0;
  const shift = 8 - bpc - (bit & 7);
  return (byte >> shift) & ((1 << bpc) - 1);
}

export type ImageInput = {
  ctx: PDFContext;
  stream: PDFStream;
  colorSpaces: PDFDict | undefined;
  /** ImageMask（型抜き）のときに塗る色の明るさ。分からなければ null */
  fillLuminance: number | null;
  darkLuminanceMax: number;
  opacityMin: number;
  maxImageBytes: number;
};

/** 画像のうち、濃い（明るさ darkLuminanceMax 以下で、不透明な）画素の割合 */
export function measureImageDarkness(input: ImageInput): ImageDarkness {
  const { ctx, stream } = input;
  const d = stream.dict;
  const width = Math.floor(numOf(d, "Width", 0));
  const height = Math.floor(numOf(d, "Height", 0));
  if (width <= 0 || height <= 0) return { kind: "unknown", reason: "broken" };
  const maskFlag = d.lookup(PDFName.of("ImageMask"));
  const isMask = maskFlag instanceof PDFBool && maskFlag.asBoolean();
  const bpc = isMask ? 1 : Math.floor(numOf(d, "BitsPerComponent", 8));
  if (![1, 2, 4, 8, 16].includes(bpc)) return { kind: "unknown", reason: "broken" };

  let model: ColorModel | null;
  if (isMask) model = { kind: "direct", comps: 1, space: 1 };
  else {
    model = spaceComponents(ctx, d.get(PDFName.of("ColorSpace")), input.colorSpaces);
    if (!model) return { kind: "unknown", reason: "unsupported_color" };
  }
  const comps = model.kind === "direct" ? model.comps : 1;
  const rowLen = Math.ceil((width * comps * bpc) / 8);
  if (rowLen * height > input.maxImageBytes) return { kind: "unknown", reason: "too_large" };
  const px = pixelBytes(ctx, stream, comps, bpc, width);
  if (!px.ok) return { kind: "unknown", reason: px.reason };
  const data = px.data;
  if (data.length < rowLen * height) return { kind: "unknown", reason: "broken" };

  // Decode 配列（反転など）
  const maxV = (1 << bpc) - 1;
  const decodeArr = d.lookup(PDFName.of("Decode"));
  const dec: number[] = [];
  if (decodeArr instanceof PDFArray) {
    for (const o of decodeArr.asArray()) {
      const v = ctx.lookup(o);
      dec.push(v instanceof PDFNumber ? v.asNumber() : 0);
    }
  }
  const decodeComp = (raw: number, c: number): number => {
    const lo = dec[c * 2];
    const hi = dec[c * 2 + 1];
    if (lo === undefined || hi === undefined) return model!.kind === "indexed" ? raw : raw / maxV;
    return lo + (raw * (hi - lo)) / maxV;
  };

  // やわらかい型抜き（SMask）：画素ごとの不透明さ。大きさが違えば近い点を使う
  let alphaAt: ((fx: number, fy: number) => number) | null = null;
  const smask = d.lookup(PDFName.of("SMask"));
  if (smask instanceof PDFStream) {
    const sw = Math.floor(numOf(smask.dict, "Width", 0));
    const sh = Math.floor(numOf(smask.dict, "Height", 0));
    const sbpc = Math.floor(numOf(smask.dict, "BitsPerComponent", 8));
    const sRow = Math.ceil((sw * sbpc) / 8);
    if (sw <= 0 || sh <= 0 || ![1, 2, 4, 8, 16].includes(sbpc) || sRow * sh > input.maxImageBytes) {
      return { kind: "unknown", reason: "broken" };
    }
    const sp = pixelBytes(ctx, smask, 1, sbpc, sw);
    if (!sp.ok) return { kind: "unknown", reason: sp.reason };
    if (sp.data.length < sRow * sh) return { kind: "unknown", reason: "broken" };
    const smax = (1 << sbpc) - 1;
    alphaAt = (fx, fy) => {
      const x = Math.min(sw - 1, Math.floor(fx * sw));
      const y = Math.min(sh - 1, Math.floor(fy * sh));
      return sampleAt(sp.data, y * sRow, x, sbpc) / smax;
    };
  }

  // 間引いて数える
  const stepX = Math.max(1, Math.ceil(width / Math.sqrt(MAX_SAMPLES)));
  const stepY = Math.max(1, Math.ceil(height / Math.sqrt(MAX_SAMPLES)));
  let total = 0;
  let dark = 0;
  const vals: number[] = new Array(4).fill(0);
  for (let y = 0; y < height; y += stepY) {
    const row = y * rowLen;
    for (let x = 0; x < width; x += stepX) {
      total++;
      if (alphaAt && alphaAt((x + 0.5) / width, (y + 0.5) / height) < input.opacityMin) continue;
      let lum: number | null;
      if (isMask) {
        // 型抜き：既定（Decode [0 1]）では 0 の点を塗る
        const raw = sampleAt(data, row, x, 1);
        const painted = dec.length >= 2 && dec[0] === 1 ? raw === 1 : raw === 0;
        lum = painted ? input.fillLuminance : null;
      } else if (model.kind === "indexed") {
        const idx = Math.min(model.hival, Math.max(0, Math.round(decodeComp(sampleAt(data, row, x, bpc), 0))));
        for (let c = 0; c < model.base; c++) vals[c] = (model.lookup[idx * model.base + c] ?? 0) / 255;
        lum = luminanceOf(vals.slice(0, model.base), model.base);
      } else {
        for (let c = 0; c < model.comps; c++) vals[c] = decodeComp(sampleAt(data, row, x * model.comps + c, bpc), c);
        lum = luminanceOf(vals.slice(0, model.comps), model.space);
      }
      if (lum !== null && lum <= input.darkLuminanceMax) dark++;
    }
  }
  return { kind: "measured", darkFraction: total ? dark / total : 0 };
}

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
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { decodeStream, isInflateLimitError } from "../shared/inflate-limit.ts";
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
      else if (lk instanceof PDFStream) lookup = decodeStream(lk);
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
  | { ok: false; reason: "unsupported_filter" | "too_large" | "broken" } {
  const filters = filterNames(ctx, stream.dict);
  if (filters.some((f) => !DECODABLE.has(f))) return { ok: false, reason: "unsupported_filter" };
  let data: Uint8Array;
  try {
    data = decodeStream(stream);
  } catch (e) {
    // 解くと大きすぎる（圧縮の爆弾など）：途中で止めた。「読み解けない形式」ではなく「大きすぎる」として数える
    return { ok: false, reason: isInflateLimitError(e) ? "too_large" : "broken" };
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
  /** 画素の数の上限（1.9.0 から。P6 だけが渡す）。超えた画像は解かずに too_large とする */
  maxImagePixels?: number;
};

/** 画素を1点ずつ読む道具（1.5.0 から。濃さの割合と、画像の層の画素のばらつきの両方に使う） */
export type PixelReader = {
  width: number;
  height: number;
  /**
   * x・y は画素の番号（y は上から）。lum は明るさ（0＝黒、1＝白。分からない・塗らない点は null）、alpha は不透明さ。
   * chroma は色の濃さ（RGB の最大と最小の差。0＝灰色、1＝いちばん濃い色。1.9.0 から。灰色の画像・分からないときは 0 か、なし）
   */
  at(x: number, y: number): { lum: number | null; alpha: number; chroma?: number };
};

/** 色の成分から、色の濃さ（RGB の最大と最小の差。0〜1）を出す。灰色・分からない色空間は 0（1.9.0 から） */
export function chromaOf(components: number[], space: number): number {
  const c = components.map((v) => Math.min(1, Math.max(0, v)));
  let r: number, g: number, b: number;
  if (space === 3 && c.length >= 3) [r, g, b] = c as [number, number, number];
  else if (space === 4 && c.length >= 4) {
    const [cy, m, y, k] = c as [number, number, number, number];
    r = (1 - cy) * (1 - k);
    g = (1 - m) * (1 - k);
    b = (1 - y) * (1 - k);
  } else return 0;
  return Math.max(r, g, b) - Math.min(r, g, b);
}

export type PixelRead = { kind: "pixels"; reader: PixelReader } | { kind: "unknown"; reason: "unsupported_filter" | "too_large" | "unsupported_color" | "broken" };

/**
 * 画素を解かずに、このルールで読めそうかだけを確かめる（1.9.0 から）。大きさ・色空間・圧縮の種類を見る。
 * 読めそうなら ok。解いてみて壊れていたときは、readImagePixels が broken を返す
 */
export function probeImagePixels(input: Omit<ImageInput, "darkLuminanceMax" | "opacityMin">): { kind: "ok" } | Extract<PixelRead, { kind: "unknown" }> {
  const { ctx, stream } = input;
  const d = stream.dict;
  const width = Math.floor(numOf(d, "Width", 0));
  const height = Math.floor(numOf(d, "Height", 0));
  if (width <= 0 || height <= 0) return { kind: "unknown", reason: "broken" };
  const maskFlag = d.lookup(PDFName.of("ImageMask"));
  const isMask = maskFlag instanceof PDFBool && maskFlag.asBoolean();
  const bpc = isMask ? 1 : Math.floor(numOf(d, "BitsPerComponent", 8));
  if (filterNames(ctx, d).some((f) => !DECODABLE.has(f))) return { kind: "unknown", reason: "unsupported_filter" };
  if (![1, 2, 4, 8, 16].includes(bpc)) return { kind: "unknown", reason: "broken" };
  const model = isMask ? ({ kind: "direct", comps: 1, space: 1 } as const) : spaceComponents(ctx, d.get(PDFName.of("ColorSpace")), input.colorSpaces);
  if (!model) return { kind: "unknown", reason: "unsupported_color" };
  const comps = model.kind === "direct" ? model.comps : 1;
  if (Math.ceil((width * comps * bpc) / 8) * height > input.maxImageBytes) return { kind: "unknown", reason: "too_large" };
  if (input.maxImagePixels !== undefined && width * height > input.maxImagePixels) return { kind: "unknown", reason: "too_large" };
  return { kind: "ok" };
}

/** 画像の画素を読む道具を作る。このルールで解けない圧縮（JPEG など）は unknown を返す */
export function readImagePixels(input: Omit<ImageInput, "darkLuminanceMax" | "opacityMin">): PixelRead {
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
  if (input.maxImagePixels !== undefined && width * height > input.maxImagePixels) return { kind: "unknown", reason: "too_large" };
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
  const m = model;
  const decodeComp = (raw: number, c: number): number => {
    const lo = dec[c * 2];
    const hi = dec[c * 2 + 1];
    if (lo === undefined || hi === undefined) return m.kind === "indexed" ? raw : raw / maxV;
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

  const vals: number[] = new Array(4).fill(0);
  const reader: PixelReader = {
    width,
    height,
    at(x, y) {
      const row = y * rowLen;
      const alpha = alphaAt ? alphaAt((x + 0.5) / width, (y + 0.5) / height) : 1;
      let lum: number | null;
      let chroma = 0;
      if (isMask) {
        // 型抜き：既定（Decode [0 1]）では 0 の点を塗る
        const raw = sampleAt(data, row, x, 1);
        const painted = dec.length >= 2 && dec[0] === 1 ? raw === 1 : raw === 0;
        lum = painted ? input.fillLuminance : null;
      } else if (m.kind === "indexed") {
        const idx = Math.min(m.hival, Math.max(0, Math.round(decodeComp(sampleAt(data, row, x, bpc), 0))));
        for (let c = 0; c < m.base; c++) vals[c] = (m.lookup[idx * m.base + c] ?? 0) / 255;
        lum = luminanceOf(vals.slice(0, m.base), m.base);
        chroma = chromaOf(vals.slice(0, m.base), m.base);
      } else {
        for (let c = 0; c < m.comps; c++) vals[c] = decodeComp(sampleAt(data, row, x * m.comps + c, bpc), c);
        lum = luminanceOf(vals.slice(0, m.comps), m.space);
        chroma = chromaOf(vals.slice(0, m.comps), m.space);
      }
      return { lum, alpha, chroma };
    },
  };
  return { kind: "pixels", reader };
}

/** 画素を読む道具で、濃い（明るさ darkLuminanceMax 以下で、不透明な）画素の割合を数える。縦横を間引いて最大 MAX_SAMPLES 点 */
export function darkFractionOf(reader: PixelReader, darkLuminanceMax: number, opacityMin: number): number {
  const { width, height } = reader;
  const stepX = Math.max(1, Math.ceil(width / Math.sqrt(MAX_SAMPLES)));
  const stepY = Math.max(1, Math.ceil(height / Math.sqrt(MAX_SAMPLES)));
  let total = 0;
  let dark = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      total++;
      const p = reader.at(x, y);
      if (p.alpha < opacityMin) continue;
      if (p.lum !== null && p.lum <= darkLuminanceMax) dark++;
    }
  }
  return total ? dark / total : 0;
}

/** 画像のうち、濃い（明るさ darkLuminanceMax 以下で、不透明な）画素の割合 */
export function measureImageDarkness(input: ImageInput): ImageDarkness {
  const r = readImagePixels(input);
  if (r.kind === "unknown") return r;
  return { kind: "measured", darkFraction: darkFractionOf(r.reader, input.darkLuminanceMax, input.opacityMin) };
}

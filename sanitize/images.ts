// SPDX-License-Identifier: AGPL-3.0-only
//
// 画像の画素を塗りつぶす（P6 の画像の層：スキャン画像の上に黒い四角を重ねただけの型）。
// 覆いの下に当たる画素を、意味のない値（いちばん濃い色。型抜きの画像では「塗らない」）に書き換えた、新しい画像を作る。
// 元の画像は書き換えない（ほかの所でも使われているかもしれないため）。使われなくなった元の画像は、最後の掃除で消える。
//
// 解けるのは、圧縮のない画像と、Flate・LZW・ASCIIHex・ASCII85・RunLength で圧縮した画像だけ。
// JPEG（DCTDecode）・JPEG 2000・JBIG2・CCITT は解けないので、塗れない（呼ぶ側で「片付けられなかった所」にする）。

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
import { apply, type Matrix } from "../rules/p6-text/geometry.ts";
import type { SanCover } from "./geometry.ts";
import { coverContains } from "./geometry.ts";

export type BurnResult =
  | { ok: true; stream: PDFRawStream; pixels: number }
  | { ok: false; reason: "unsupported_filter" | "unsupported_color" | "too_large" | "broken" };

const DECODABLE = new Set(["FlateDecode", "Fl", "LZWDecode", "LZW", "ASCIIHexDecode", "AHx", "ASCII85Decode", "A85", "RunLengthDecode", "RL"]);

function filterNames(ctx: PDFContext, dict: PDFDict): string[] {
  const f = dict.lookup(PDFName.of("Filter"));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((o) => ctx.lookup(o)).filter((o): o is PDFName => o instanceof PDFName).map((n) => n.decodeText());
  return [];
}

function numOf(dict: PDFDict, key: string, fallback: number): number {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
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

function undoPng(data: Uint8Array, colors: number, bpc: number, columns: number): Uint8Array {
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
      let v = x;
      if (type === 1) v = x + left;
      else if (type === 2) v = x + up;
      else if (type === 3) v = x + ((left + up) >> 1);
      else if (type === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

function undoTiff(data: Uint8Array, colors: number, bpc: number, columns: number): Uint8Array | null {
  if (bpc !== 8) return null;
  const rowLen = colors * columns;
  const out = data.slice();
  for (let r = 0; r + rowLen <= out.length; r += rowLen) {
    for (let i = colors; i < rowLen; i++) out[r + i] = (out[r + i]! + out[r + i - colors]!) & 0xff;
  }
  return out;
}

type Model = { kind: "direct"; comps: number; cmyk: boolean } | { kind: "indexed"; base: number; hival: number; lookup: Uint8Array; baseCmyk: boolean };

function colorModel(ctx: PDFContext, cs: PDFObject | undefined, spaces: PDFDict | undefined, depth = 0): Model | null {
  if (depth > 4) return null;
  const v = cs ? ctx.lookup(cs) : undefined;
  if (v instanceof PDFName) {
    const n = v.decodeText();
    if (n === "DeviceGray" || n === "G" || n === "CalGray") return { kind: "direct", comps: 1, cmyk: false };
    if (n === "DeviceRGB" || n === "RGB" || n === "CalRGB") return { kind: "direct", comps: 3, cmyk: false };
    if (n === "DeviceCMYK" || n === "CMYK") return { kind: "direct", comps: 4, cmyk: true };
    const named = spaces?.get(PDFName.of(n));
    return named ? colorModel(ctx, named, undefined, depth + 1) : null;
  }
  if (v instanceof PDFArray && v.size() >= 1) {
    const head = ctx.lookup(v.get(0));
    const k = head instanceof PDFName ? head.decodeText() : "";
    if (k === "CalGray") return { kind: "direct", comps: 1, cmyk: false };
    if (k === "CalRGB") return { kind: "direct", comps: 3, cmyk: false };
    if (k === "ICCBased") {
      const st = ctx.lookup(v.get(1));
      const n = st instanceof PDFStream ? st.dict.lookup(PDFName.of("N")) : undefined;
      const c = n instanceof PDFNumber ? n.asNumber() : 0;
      return c === 1 || c === 3 || c === 4 ? { kind: "direct", comps: c, cmyk: c === 4 } : null;
    }
    if (k === "Indexed" || k === "I") {
      const base = colorModel(ctx, v.get(1), spaces, depth + 1);
      const hv = ctx.lookup(v.get(2));
      const lk = ctx.lookup(v.get(3));
      if (!base || base.kind !== "direct" || !(hv instanceof PDFNumber)) return null;
      let lookup: Uint8Array | null = null;
      if (lk instanceof PDFString || lk instanceof PDFHexString) lookup = lk.asBytes();
      else if (lk instanceof PDFRawStream) lookup = decodePDFRawStream(lk).decode();
      else if (lk instanceof PDFStream) lookup = lk.getContents();
      if (!lookup) return null;
      return { kind: "indexed", base: base.comps, hival: Math.max(0, Math.min(255, Math.floor(hv.asNumber()))), lookup, baseCmyk: base.cmyk };
    }
  }
  return null;
}

function luminance(c: number[], cmyk: boolean): number {
  const v = (i: number) => Math.min(1, Math.max(0, c[i] ?? 0));
  if (cmyk) {
    const k = v(3);
    return 0.299 * (1 - v(0)) * (1 - k) + 0.587 * (1 - v(1)) * (1 - k) + 0.114 * (1 - v(2)) * (1 - k);
  }
  if (c.length >= 3) return 0.299 * v(0) + 0.587 * v(1) + 0.114 * v(2);
  return v(0);
}

function writeSample(data: Uint8Array, rowStart: number, index: number, bpc: number, value: number) {
  if (bpc === 8) {
    data[rowStart + index] = value;
    return;
  }
  if (bpc === 16) {
    data[rowStart + index * 2] = value >> 8;
    data[rowStart + index * 2 + 1] = value & 0xff;
    return;
  }
  const bit = index * bpc;
  const at = rowStart + (bit >> 3);
  const shift = 8 - bpc - (bit & 7);
  const mask = ((1 << bpc) - 1) << shift;
  data[at] = (data[at]! & ~mask) | ((value << shift) & mask);
}

/**
 * 画像を、置いた行列 ctm（単位の正方形 → ページの座標）で描いたとき、covers の中に中心が入る画素を塗りつぶした新しい画像を作る。
 * 塗った画素が 0 なら pixels: 0（新しい画像は作るが、呼ぶ側で使わなくてよい）。
 */
export function burnImage(ctx: PDFContext, stream: PDFStream, colorSpaces: PDFDict | undefined, ctm: Matrix, covers: SanCover[], maxBytes: number): BurnResult {
  const d = stream.dict;
  const width = Math.floor(numOf(d, "Width", 0));
  const height = Math.floor(numOf(d, "Height", 0));
  if (width <= 0 || height <= 0) return { ok: false, reason: "broken" };
  const maskFlag = d.lookup(PDFName.of("ImageMask"));
  const isMask = maskFlag instanceof PDFBool && maskFlag.asBoolean();
  const bpc = isMask ? 1 : Math.floor(numOf(d, "BitsPerComponent", 8));
  if (![1, 2, 4, 8, 16].includes(bpc)) return { ok: false, reason: "broken" };
  const model: Model | null = isMask ? { kind: "direct", comps: 1, cmyk: false } : colorModel(ctx, d.get(PDFName.of("ColorSpace")), colorSpaces);
  if (!model) return { ok: false, reason: "unsupported_color" };
  const comps = model.kind === "direct" ? model.comps : 1;
  const rowLen = Math.ceil((width * comps * bpc) / 8);
  if (rowLen * height > maxBytes) return { ok: false, reason: "too_large" };
  if (filterNames(ctx, d).some((f) => !DECODABLE.has(f))) return { ok: false, reason: "unsupported_filter" };

  let data: Uint8Array;
  try {
    data = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  } catch {
    return { ok: false, reason: "broken" };
  }
  const parms = decodeParms(ctx, d);
  if (parms) {
    const predictor = numOf(parms, "Predictor", 1);
    const colors = numOf(parms, "Colors", comps);
    const pbpc = numOf(parms, "BitsPerComponent", bpc);
    const columns = numOf(parms, "Columns", width);
    if (predictor >= 10) data = undoPng(data, colors, pbpc, columns);
    else if (predictor === 2) {
      const t = undoTiff(data, colors, pbpc, columns);
      if (!t) return { ok: false, reason: "unsupported_filter" };
      data = t;
    }
  }
  if (data.length < rowLen * height) return { ok: false, reason: "broken" };
  data = data.slice(0, rowLen * height);

  // Decode 配列（反転など）
  const maxV = (1 << bpc) - 1;
  const decArr = d.lookup(PDFName.of("Decode"));
  const dec: number[] = [];
  if (decArr instanceof PDFArray) for (const o of decArr.asArray()) {
    const v = ctx.lookup(o);
    dec.push(v instanceof PDFNumber ? v.asNumber() : 0);
  }
  /** 成分 c を、復号したあとの値 target（0 か 1）に近づける生の値 */
  const rawFor = (c: number, target: 0 | 1): number => {
    const lo = dec[c * 2] ?? 0;
    const hi = dec[c * 2 + 1] ?? 1;
    const atZero = lo, atMax = hi;
    return Math.abs(atZero - target) <= Math.abs(atMax - target) ? 0 : maxV;
  };

  // 塗りつぶす値（成分ごとの生の値）
  let fill: number[];
  if (isMask) {
    // 型抜き：塗らない点にする（既定の Decode [0 1] では 1 が「塗らない」）
    fill = [dec.length >= 2 && dec[0] === 1 ? 0 : 1];
  } else if (model.kind === "indexed") {
    let best = 0, bestLum = Infinity;
    for (let i = 0; i <= model.hival; i++) {
      const c: number[] = [];
      for (let k = 0; k < model.base; k++) c.push((model.lookup[i * model.base + k] ?? 0) / 255);
      const l = luminance(c, model.baseCmyk);
      if (l < bestLum) {
        bestLum = l;
        best = i;
      }
    }
    // Decode で引き直す（索引の画像の Decode は [0 hival] が既定）
    const lo = dec[0] ?? 0;
    const hi = dec[1] ?? maxV;
    fill = [hi === lo ? 0 : Math.max(0, Math.min(maxV, Math.round(((best - lo) * maxV) / (hi - lo))))];
  } else if (model.cmyk) {
    fill = [rawFor(0, 0), rawFor(1, 0), rawFor(2, 0), rawFor(3, 1)];
  } else {
    fill = Array.from({ length: model.comps }, (_, c) => rawFor(c, 0));
  }

  // 塗るのは、画素の中心が覆いの中にある画素（検証器と同じ数え方）。
  // ふちにまたがる画素も塗るので、黒い四角のふちが 1 画素ほど太って見えることがある（PR の「決めてほしいこと」）。
  // 捨てた案：四隅がすべて覆いの中にある画素だけを塗る。見た目は変わらないが、ふちの画素のインクが残り、
  // 合成 PDF（fixtures/p6）で検証器の残りが 5 件になった（2026-11-04 測定）。
  let pixels = 0;
  for (let y = 0; y < height; y++) {
    const v = 1 - (y + 0.5) / height; // 画像の1行目は、単位の正方形の上端
    const row = y * rowLen;
    for (let x = 0; x < width; x++) {
      const [px, py] = apply(ctm, (x + 0.5) / width, v);
      if (!covers.some((c) => coverContains(c, px, py))) continue;
      for (let c = 0; c < comps; c++) writeSample(data, row, x * comps + c, bpc, fill[c]!);
      pixels++;
    }
  }

  const entries: Record<string, PDFObject> = {};
  for (const [k, v] of d.entries()) {
    const key = k.decodeText();
    if (key === "Filter" || key === "DecodeParms" || key === "DP" || key === "Length" || key === "DL") continue;
    entries[key] = v;
  }
  const out = ctx.flateStream(data, {});
  for (const [k, v] of Object.entries(entries)) out.dict.set(PDFName.of(k), v);
  return { ok: true, stream: out, pixels };
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// 模様（Pattern）とシェーディング（sh）で塗ったものを、覆いとして見るための読み手（2026-11-05 から）。P6・P7 で同じものを使う。
//
// - シェーディングの模様（PatternType 2）・sh：塗った所をすき間なく塗る。明るさは、関数の両端の色（FunctionType 2 の C0・C1）の明るい方。
//   ほかの関数は、明るさが分からないので null（濃い覆いにはしないが、不透明な覆いにはする）。
// - タイルの模様（PatternType 1）：1つのタイルの中身を読み、四角の塗り（re と f）が、タイルの送り（XStep×YStep）を 9 割以上埋めるときだけ
//   覆いにする（細い斜線・網の模様は、下の字が透けるので覆いにしない）。明るさは、塗りの色の明るい方。色のない模様（PaintType 2）は scn の色。
//   四角でない道・画像・部品があれば、覆いにしない（読み切れないため）。
// - タイルの中に字を描く命令があれば、hasText を返す（呼ぶ側で、タイルを並べて字の箱を作る）。

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream, type PDFContext, type PDFObject } from "pdf-lib";
import { operations } from "./content-lexer.ts";

export type Matrix6 = [number, number, number, number, number, number];

export type TilingInfo = {
  stream: PDFStream;
  data: Uint8Array;
  resources: PDFDict | undefined;
  /** 模様の空間 → 模様を使った中身の、はじめの座標の行列 */
  matrix: Matrix6;
  xStep: number;
  yStep: number;
  bbox: [number, number, number, number];
};

export type PatternPaint = {
  /** 覆いになるか（すき間なく、不透明に塗るか） */
  covers: boolean;
  /** 塗りの明るさ（0＝黒、1＝白）。分からなければ null */
  luminance: number | null;
  /** タイルの模様で、中に字を描く命令があるとき */
  tiling?: TilingInfo & { hasText: boolean };
};

const MAX_PATTERN_BYTES = 4 * 1024 * 1024;
const MAX_PATTERN_OPS = 20_000;

function num(ctx: PDFContext, o: PDFObject | undefined): number | null {
  const v = o ? ctx.lookup(o) : undefined;
  return v instanceof PDFNumber ? v.asNumber() : null;
}
function nums(ctx: PDFContext, o: PDFObject | undefined): number[] | null {
  const v = o ? ctx.lookup(o) : undefined;
  if (!(v instanceof PDFArray)) return null;
  const out: number[] = [];
  for (const x of v.asArray()) {
    const n = num(ctx, x);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

/** 色の成分の数から明るさ（1＝灰、3＝RGB、4＝CMYK） */
export function lumOf(c: number[]): number | null {
  const v = c.map((x) => Math.min(1, Math.max(0, x)));
  if (v.length === 1) return v[0]!;
  if (v.length === 3) return 0.299 * v[0]! + 0.587 * v[1]! + 0.114 * v[2]!;
  if (v.length === 4) {
    const [cy, m, y, k] = v as [number, number, number, number];
    return 0.299 * (1 - cy) * (1 - k) + 0.587 * (1 - m) * (1 - k) + 0.114 * (1 - y) * (1 - k);
  }
  return null;
}

function spaceComponents(ctx: PDFContext, o: PDFObject | undefined): number {
  const v = o ? ctx.lookup(o) : undefined;
  if (v instanceof PDFName) {
    const n = v.decodeText();
    return n === "DeviceGray" || n === "CalGray" ? 1 : n === "DeviceRGB" || n === "CalRGB" ? 3 : n === "DeviceCMYK" ? 4 : 0;
  }
  if (v instanceof PDFArray && v.size() >= 2) {
    const k = ctx.lookup(v.get(0));
    const kn = k instanceof PDFName ? k.decodeText() : "";
    if (kn === "ICCBased") {
      const st = ctx.lookup(v.get(1));
      return st instanceof PDFStream ? (num(ctx, st.dict.get(PDFName.of("N"))) ?? 0) : 0;
    }
    if (kn === "CalGray") return 1;
    if (kn === "CalRGB") return 3;
  }
  return 0;
}

/** シェーディングの明るさ（関数の両端の明るい方）と、範囲の箱（/BBox。シェーディングの空間）。読めなければ luminance は null */
export function readShading(ctx: PDFContext, obj: PDFObject | undefined): { luminance: number | null; bbox: [number, number, number, number] | null } | null {
  const v = obj ? ctx.lookup(obj) : undefined;
  const d = v instanceof PDFStream ? v.dict : v instanceof PDFDict ? v : null;
  if (!d) return null;
  const n = spaceComponents(ctx, d.get(PDFName.of("ColorSpace")));
  const bb = nums(ctx, d.get(PDFName.of("BBox")));
  const bbox = bb && bb.length === 4 ? ([Math.min(bb[0]!, bb[2]!), Math.min(bb[1]!, bb[3]!), Math.max(bb[0]!, bb[2]!), Math.max(bb[1]!, bb[3]!)] as [number, number, number, number]) : null;
  const fnObj = ctx.lookup(d.get(PDFName.of("Function")));
  const fns = fnObj instanceof PDFArray ? fnObj.asArray().map((f) => ctx.lookup(f)) : fnObj ? [fnObj] : [];
  let luminance: number | null = null;
  if (n > 0 && fns.length === 1) {
    const f = fns[0];
    const fd = f instanceof PDFStream ? f.dict : f instanceof PDFDict ? f : null;
    if (fd && num(ctx, fd.get(PDFName.of("FunctionType"))) === 2) {
      const c0 = nums(ctx, fd.get(PDFName.of("C0"))) ?? new Array(n).fill(0);
      const c1 = nums(ctx, fd.get(PDFName.of("C1"))) ?? new Array(n).fill(1);
      const l0 = c0.length === n ? lumOf(c0) : null;
      const l1 = c1.length === n ? lumOf(c1) : null;
      if (l0 !== null && l1 !== null) luminance = Math.max(l0, l1);
    }
  }
  return { luminance, bbox };
}

function streamBytes(s: PDFStream): Uint8Array | null {
  try {
    if (s instanceof PDFRawStream) {
      if (s.contents.length > MAX_PATTERN_BYTES) return null;
      return decodePDFRawStream(s).decode();
    }
    return s.getContents();
  } catch {
    return null;
  }
}

/** 字を描く命令があるか */
function hasTextShow(data: Uint8Array): boolean {
  let ops = 0;
  try {
    for (const { op } of operations(data)) {
      if (++ops > MAX_PATTERN_OPS) return false;
      if (op === "Tj" || op === "TJ" || op === "'" || op === '"') return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * タイルの中身の四角の塗りが、タイルの送りを埋める割合と、塗りの色の明るい方。四角でない塗り・画像・部品があれば null
 */
function tileCoverage(data: Uint8Array, xStep: number, yStep: number, bbox: [number, number, number, number]): { fraction: number; luminance: number | null } | null {
  let fill: number | null = 0; // 塗りの色（g・rg・k）。分からない色は null
  let maxLum = 0;
  let unknownColor = false;
  let anyFill = false;
  const rects: Array<[number, number, number, number]> = [];
  let pending: Array<[number, number, number, number]> = [];
  let ops = 0;
  try {
    for (const { op, args } of operations(data)) {
      if (++ops > MAX_PATTERN_OPS) return null;
      const a = args.flatMap((t) => (t.t === "num" ? [t.v] : []));
      switch (op) {
        case "g": fill = lumOf(a.slice(0, 1)); break;
        case "rg": fill = lumOf(a.slice(0, 3)); break;
        case "k": fill = lumOf(a.slice(0, 4)); break;
        case "cs": case "sc": case "scn": fill = null; break;
        case "re":
          if (a.length >= 4) pending.push([Math.min(a[0]!, a[0]! + a[2]!), Math.min(a[1]!, a[1]! + a[3]!), Math.max(a[0]!, a[0]! + a[2]!), Math.max(a[1]!, a[1]! + a[3]!)]);
          break;
        case "f": case "F": case "f*": case "B": case "B*":
          if (!pending.length) break;
          rects.push(...pending);
          pending = [];
          anyFill = true;
          if (fill === null) unknownColor = true;
          else maxLum = Math.max(maxLum, fill);
          break;
        case "n": case "S": case "s": case "W": case "W*":
          pending = [];
          break;
        case "m": case "l": case "c": case "v": case "y": case "Do": case "BI": case "sh": case "cm":
          return null; // 四角でない道・画像・部品・行列の変更は読み切らない
        default:
          break;
      }
    }
  } catch {
    return null;
  }
  if (!anyFill) return { fraction: 0, luminance: null };
  // タイルの送りの箱（原点から XStep×YStep）を、四角の和でどれだけ埋めるか（格子に分けて数える）
  const W = Math.abs(xStep);
  const H = Math.abs(yStep);
  if (!(W > 0 && H > 0)) return null;
  const G = 32;
  let filled = 0;
  for (let i = 0; i < G; i++) {
    for (let j = 0; j < G; j++) {
      const x = bbox[0] + ((i + 0.5) / G) * W;
      const y = bbox[1] + ((j + 0.5) / G) * H;
      if (rects.some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3])) filled++;
    }
  }
  return { fraction: filled / (G * G), luminance: unknownColor ? null : maxLum };
}

/**
 * scn の模様の名前と色の成分から、塗りのあり方を返す。res：模様の名前を引く資源
 */
export function readPattern(ctx: PDFContext, res: PDFDict | undefined, name: string, comps: number[]): PatternPaint | null {
  const pats = res?.lookupMaybe(PDFName.of("Pattern"), PDFDict);
  const obj = pats ? ctx.lookup(pats.get(PDFName.of(name))) : undefined;
  const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
  if (!d) return null;
  const type = num(ctx, d.get(PDFName.of("PatternType")));
  const mArr = nums(ctx, d.get(PDFName.of("Matrix")));
  const matrix: Matrix6 = mArr && mArr.length === 6 ? (mArr as Matrix6) : [1, 0, 0, 1, 0, 0];
  if (type === 2) {
    const sh = readShading(ctx, d.get(PDFName.of("Shading")));
    if (!sh) return null;
    return { covers: true, luminance: sh.luminance };
  }
  if (type !== 1 || !(obj instanceof PDFStream)) return null;
  const paintType = num(ctx, d.get(PDFName.of("PaintType")));
  const xStep = num(ctx, d.get(PDFName.of("XStep")));
  const yStep = num(ctx, d.get(PDFName.of("YStep")));
  const bb = nums(ctx, d.get(PDFName.of("BBox")));
  if (xStep === null || yStep === null || !bb || bb.length !== 4) return null;
  const bbox: [number, number, number, number] = [Math.min(bb[0]!, bb[2]!), Math.min(bb[1]!, bb[3]!), Math.max(bb[0]!, bb[2]!), Math.max(bb[1]!, bb[3]!)];
  const data = streamBytes(obj);
  if (!data) return null;
  const resources = d.lookupMaybe(PDFName.of("Resources"), PDFDict);
  const out: PatternPaint = { covers: false, luminance: null };
  const cov = tileCoverage(data, xStep, yStep, bbox);
  if (cov && cov.fraction >= 0.9) {
    out.covers = true;
    out.luminance = paintType === 2 ? lumOf(comps) : cov.luminance;
  }
  if (hasTextShow(data)) out.tiling = { stream: obj, data, resources, matrix, xStep, yStep, bbox, hasText: true };
  return out;
}

/** 模様の空間の箱（タイル1つ分）を並べて、ページの箱 area を覆うタイルの番号の範囲（上限つき） */
export function tileRange(
  inv: Matrix6,
  area: [number, number, number, number],
  t: Pick<TilingInfo, "xStep" | "yStep" | "bbox">,
  maxTiles: number,
): Array<[number, number]> | null {
  const corners = [
    [area[0], area[1]], [area[2], area[1]], [area[2], area[3]], [area[0], area[3]],
  ].map(([x, y]) => [inv[0] * x! + inv[2] * y! + inv[4], inv[1] * x! + inv[3] * y! + inv[5]] as [number, number]);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const sx = Math.abs(t.xStep);
  const sy = Math.abs(t.yStep);
  if (!(sx > 0 && sy > 0)) return null;
  // タイルの箱が、塗った所と重なる（ふちが触れるだけは除く）タイルだけ
  const i0 = Math.floor((Math.min(...xs) - t.bbox[2]) / sx) + 1;
  const i1 = Math.ceil((Math.max(...xs) - t.bbox[0]) / sx) - 1;
  const j0 = Math.floor((Math.min(...ys) - t.bbox[3]) / sy) + 1;
  const j1 = Math.ceil((Math.max(...ys) - t.bbox[1]) / sy) - 1;
  if (i1 < i0 || j1 < j0) return [];
  if (!Number.isFinite(i0 + i1 + j0 + j1) || (i1 - i0 + 1) * (j1 - j0 + 1) > maxTiles) return null;
  const out: Array<[number, number]> = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push([i, j]);
  return out;
}

export function invert(m: Matrix6): Matrix6 | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

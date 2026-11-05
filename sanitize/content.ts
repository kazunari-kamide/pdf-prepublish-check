// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの中身（描く命令の列）の片付け：P6（覆いの下の字・画素）と P7（見えない字）。
//
// 1. 読む：命令を順に追い、字（1字ごとの箱と、どの命令の何文字目か）・覆い・塗り・画像を、描いた順番つきで集める。
//    部品（Form XObject）は、呼ばれた所ごとに別のものとして読む。
// 2. 決める：
//    - P6：字のあとに描いた濃い覆いが、字の箱の半分以上を隠していれば消す（検証器と同じ線。2026-11-03 人が決めた）。
//      見えない字（文字認識の層）でも、濃い覆いの下なら消す。
//      画像のあとに描いた濃い覆いの下の画素は、塗りつぶす（sanitize/images.ts）。
//    - P7：見えない字（表示しないレイヤー・ページの外・切り抜きの外・描き方 3 と 7・不透明さ 0.1 未満・高さ 1pt 未満・
//      薄い不透明な覆いの下・地と同じ色）を消す。画像と重なる見えない字（文字認識の層）は残す。
// 3. 書き直す：消す字は、同じ幅の送り（TJ の数）に置き換える。残す字の位置は変わらず、見た目も変わらない。
//    書き換えた部品・画像は新しいオブジェクトにし、元は書き換えない（ほかの所で使われているかもしれないため）。
//
// 判定の値は、検出ルール（rules/p6-text・rules/p7-hidden）と同じか、検証器より広い側にそろえる（SETTINGS の説明）。

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import { operations, type Op, type Tok } from "../rules/shared/content-lexer.ts";
import { readFont, type FontInfo } from "../rules/shared/fonts.ts";
import {
  IDENTITY,
  apply,
  area,
  boundsOf,
  flattenCubic,
  intersectionArea,
  isFiniteMatrix,
  multiply,
  scaleOf,
  signedPolygonArea,
  type Matrix,
  type Point,
  type Rect,
} from "../rules/p6-text/geometry.ts";
import { measureImageDarkness } from "../rules/p6-text/images.ts";
import { luminanceOf } from "../rules/p6-text/page.ts";
import { RectIndex, coveredFraction, type SanCover } from "./geometry.ts";
import { decodeLuma, sampleLuma } from "./image-sample.ts";
import { convertPageInlineImages } from "./inline-images.ts";
import { glyphBox, isRectGlyph, parseSfnt, trueTypeOf, type Sfnt } from "./font-prune.ts";
import { burnImage, type BurnFailure, type BurnLimits } from "./images.ts";
import { serializeOps } from "./serialize.ts";
import type { ImageCodec, NotDoneItem, NotDoneReason, RemovedItem, SanitizeTraceEvent } from "./types.ts";

export const SETTINGS = {
  /** 塗りを「濃い」とみなす明るさの上限。検出ルールの 0.35（検証器は 0.3 なので、それより広い） */
  darkLuminanceMax: 0.35,
  /** 覆いとみなす不透明さの下限（検出ルール・検証器と同じ） */
  opacityMin: 0.9,
  /** 太い線を覆いとみなす太さの下限（ポイント） */
  minStrokeWidth: 1,
  /** 字を消す、覆いに隠れた割合の下限（検証器と同じ 0.5。2026-11-03 人が決めた） */
  coveredFractionMin: 0.5,
  /** 画像を覆いとみなす濃い画素の割合の下限（検証器と同じ 0.95。検出ルールの 0.97 より広い） */
  darkImageFractionMin: 0.95,
  /** 丸ごと解く画像の大きさの上限（バイト）。超えた Flate の画像は、流して塗る（images.ts） */
  maxImageBytes: 64 * 1024 * 1024,
  /** 塗る画像の画素の数の上限。600dpi の A3（約 7,000 万画素）まで入る（検出ルール 1.9.0 と同じ。2026-11-04 人が決めた） */
  maxImagePixels: 72_000_000,
  /** 塗りを「明るい」とみなす明るさの下限（検出ルールの lightLuminanceMin と同じ 0.9）。明るい覆いは、画像の画素を塗るときだけ使う */
  lightLuminanceMin: 0.9,
  /** 明るい塗りで、覆いにはしないが「片付けられなかった所」にする不透明さの下限（これ未満は、下がはっきり見えるので何もしない） */
  uncertainAlphaMin: 0.5,
  /** JPEG に書き直すときの品質（0〜1） */
  jpegQuality: 0.92,
  maxOperationsPerPage: 3_000_000,
  maxFormDepth: 12,
  // P7（rules/p7-hidden の値と同じ）
  outsideFraction: 0.5,
  invisibleAlphaBelow: 0.1,
  tinyHeightBelowPt: 1.0,
  sameColorDeltaBelow: 0.1,
  coverAlphaMin: 0.9,
  rectangularFillMin: 0.9,
  /** 横の伸縮（Tz ÷ 100）がこれ未満なら、横につぶれて見えない字（rules/p7-hidden の squashedScaleBelow と同じ。0.7.0 から） */
  squashedScaleBelow: 0.1,
  /** 見える所（ページと切り抜きの重なり）が、画像の箱のこの割合未満なら、隠れた所の画素を白く塗る（0.7.0 から。字の outsideFraction と同じ 0.5） */
  hiddenImageVisibleBelow: 0.5,
  /** 違う字の重ね描きとみなす、2つの字の箱の重なりの割合の下限（どちらの箱から見ても。0.7.0 から） */
  overdrawnOverlapMin: 0.8,
  /** 地の色を読むために解く画像の画素の数の上限（0.7.0 から） */
  maxSamplePixels: 16_000_000,
};
export type ContentSettings = typeof SETTINGS;

export class TooManyOperations extends Error {}

/**
 * 白い不透明な塗りが、下を隠す重ね方（/BM）。白を重ねた結果が白になるもの（Screen・Lighten・ColorDodge・HardLight・Luminosity）。
 * Multiply・Darken などでは、白を重ねても下がそのまま見えるので、塗ると見た目が変わる（覆いにしない。片付けられなかった所にする）
 */
const LIGHT_HIDING_BLENDS = new Set(["Normal", "Compatible", "Screen", "Lighten", "ColorDodge", "HardLight", "Luminosity"]);

/** Type3 の字の描き方が「（d0・d1 のあと）四角 1 つを塗るだけ」なら、その四角を FontMatrix で字の空間に写したもの */
function rectProc(data: Uint8Array, m: Matrix): Rect | null {
  let rect: Rect | null = null;
  let painted = false;
  for (const { op, args } of operations(data)) {
    if (op === "d0" || op === "d1") continue;
    if (op === "re" && !rect) {
      const a = nums(args);
      if (a.length < 4) return null;
      rect = [Math.min(a[0]!, a[0]! + a[2]!), Math.min(a[1]!, a[1]! + a[3]!), Math.max(a[0]!, a[0]! + a[2]!), Math.max(a[1]!, a[1]! + a[3]!)];
      continue;
    }
    if ((op === "f" || op === "F" || op === "f*") && rect && !painted) {
      painted = true;
      continue;
    }
    if (op === "q" || op === "Q" || op === "g" || op === "rg" || op === "k") continue;
    return null;
  }
  if (!rect || !painted) return null;
  return boundsOf([apply(m, rect[0], rect[1]), apply(m, rect[2], rect[1]), apply(m, rect[0], rect[3]), apply(m, rect[2], rect[3])]);
}

/**
 * 埋め込んでいない標準の記号の書体で、黒い四角になる字の外枠（字の大きさ 1 に対して）。
 * ZapfDingbats の n（a71。黒い四角）：標準の寸法（AFM）の外枠 [35 0 724 691]
 */
const STANDARD_BLOCKS: Record<string, Record<number, Rect>> = {
  ZapfDingbats: { 0x6e: [0.035, 0, 0.724, 0.691] },
};

/**
 * 埋め込んでおらず /Widths もない標準の記号の書体で、黒い四角になる字の送りの幅（字の大きさ 1 に対して。標準の寸法）。
 * 書体の読み手（rules/shared/fonts.ts）は記号の書体の幅を持たず 0.5 にするので、覆いの帯の長さがずれないように、この字だけ直す
 */
const STANDARD_BLOCK_WIDTHS: Record<string, Record<number, number>> = {
  ZapfDingbats: { 0x6e: 0.761 },
};

/** 書体の読み手の結果のうち、標準の記号の書体の黒い四角の字の幅を直したもの（直すものがなければ、そのまま） */
function withStandardWidths(ctx: PDFContext, ref: PDFObject, fi: FontInfo): FontInfo {
  const fd = dictOf(ctx, ref);
  if (!fd || nameOf(ctx, fd.get(PDFName.of("Subtype"))) !== "Type1" || fd.has(PDFName.of("Widths"))) return fi;
  const base = (nameOf(ctx, fd.get(PDFName.of("BaseFont"))) ?? "").replace(/^[A-Z]{6}\+/, "");
  const widths = STANDARD_BLOCK_WIDTHS[base];
  if (!widths || !standardBlock(ctx, ref, 0x6e)) return fi;
  return { ...fi, decode: (bytes) => fi.decode(bytes).map((g) => (widths[g.code] !== undefined ? { ...g, width: widths[g.code]! } : g)) };
}

/** 書体が、埋め込んでいない標準の記号の書体なら、コードの黒い四角の外枠（なければ null） */
function standardBlock(ctx: PDFContext, ref: PDFObject, code: number): Rect | null {
  const fd = dictOf(ctx, ref);
  if (!fd || nameOf(ctx, fd.get(PDFName.of("Subtype"))) !== "Type1") return null;
  const base = (nameOf(ctx, fd.get(PDFName.of("BaseFont"))) ?? "").replace(/^[A-Z]{6}\+/, "");
  const table = STANDARD_BLOCKS[base];
  if (!table) return null;
  // 埋め込んだ書体は、字形の形が違うかもしれないので、ここでは見ない
  const desc = dictOf(ctx, fd.get(PDFName.of("FontDescriptor")));
  if (desc && (desc.has(PDFName.of("FontFile")) || desc.has(PDFName.of("FontFile2")) || desc.has(PDFName.of("FontFile3")))) return null;
  // 字の並べ替え（/Differences）があれば、コードの字が違うかもしれないので見ない
  const enc = dictOf(ctx, fd.get(PDFName.of("Encoding")));
  if (enc && enc.has(PDFName.of("Differences"))) return null;
  return table[code] ?? null;
}

/** 字形の形で黒い四角と見分けるときの、幅と高さの下限（字の大きさ 1 に対して） */
const BLOCK_MIN_EM = 0.3;

/** 覆いとして使う、黒い四角の形の字（全面・7/8・大小の黒い四角・縦長の黒い四角） */
const BLOCK_CHARS = new Set(["█", "▉", "▇", "■", "◼", "▮", "⬛"]);

/** 黒でない塗りの記録の上限（1ページ） */
const FILL_LOG_MAX = 5000;

/** 黒でない塗りの記録（trace 用）。decision は、覆いにしたか・しなかった理由 */
type FillLogEntry = {
  seq: number;
  rect: Rect;
  luminance: number | null;
  alpha: number;
  blend: string;
  hidden: boolean;
  annotation: boolean;
  decision: "light_cover" | "skip_blend" | "skip_hidden" | "skip_transparent" | "ignore_transparent" | "no_area" | "mid_tone" | "unknown_color";
};

type P7Reason = "hidden_layer" | "off_page" | "clipped" | "invisible" | "tiny" | "squashed" | "same_color" | "covered_light" | "covered_image";

const P7_LABEL: Record<P7Reason, string> = {
  hidden_layer: "表示しないレイヤーの中の字",
  off_page: "ページの外に置いた字",
  clipped: "切り抜きの外にある字",
  invisible: "見えない描き方・透明な字",
  tiny: "小さすぎて読めない字",
  squashed: "横につぶれて見えない字",
  same_color: "地と同じ色の字",
  covered_light: "白などの不透明な四角で隠した字",
  covered_image: "あとから重ねた画像で隠した字",
};

// ---------------------------------------------------------------- 集めるもの

/** 読んだ中身1つ（ページの中身、または部品を呼んだ所1つ） */
type CNode = {
  data: Uint8Array;
  res: PDFDict | undefined;
  hasInline: boolean;
  /** 部品：命令の番号 → 中身 */
  forms: Map<number, { node: CNode; stream: PDFStream }>;
  /** 字を描く命令：命令の番号 → 引数の何番目の字の並びに、どの字があるか */
  textOps: Map<number, TextOp>;
  /** 画像を描く命令（Do） */
  images: Map<number, ImageUse>;
  /** /ActualText を直接書いたマーク付きの中身（BDC）の命令の番号 */
  actualText: Set<number>;
  /** 黒一色で塗り直す、模様で塗った覆い：命令の番号 → 覆いの箱（ページの座標）・その時の行列・模様の名前（0.8.0 から） */
  repaints?: Map<number, { rect: Rect; ctm: Matrix; name: string }>;
};

type GlyphSlot = { g: Glyph; bytes: Uint8Array | null; adj: number | null };
type TextOp = { elems: Map<number, GlyphSlot[]> };

type Glyph = {
  seq: number;
  rect: Rect;
  height: number;
  isSpace: boolean;
  hidden: boolean;
  clip: Rect;
  mode: number;
  alpha: number;
  lum: number | null;
  /** 横の伸縮（Tz ÷ 100。縦書きは 1） */
  hScale: number;
  /** 黒い四角の形の字で、覆いとして使ったもの（ほかの黒い四角の字では消さない。0.8.0 から） */
  isCover: boolean;
  /** 覆いとして使った黒い四角の字の、覆いの箱（ページの座標） */
  coverRect?: Rect;
  /** 注釈の見た目の中の字（濃い覆いの下のものだけを消す。0.8.0 から） */
  inAnnot: boolean;
  /** 書体と字のコード（違う字の重ね描きを見分ける） */
  font: FontInfo;
  code: number;
  page: number;
  remove: null | { pattern: "P6"; cover: SanCover } | { pattern: "P7"; reason: P7Reason };
  node: CNode;
  op: number;
};

type Fill = { seq: number; box: Rect; polys: Point[][]; lum: number | null; alpha: number; normal: boolean; rectangular: boolean };
type ImageUse = {
  seq: number; box: Rect; ctm: Matrix; stream: PDFStream; res: PDFDict | undefined; node: CNode; op: number;
  /** 描いたときの切り抜きの箱 */
  clip: Rect;
  /** 下を隠す描き方か（不透明・ふつうの重ね方・表示するレイヤー・透明の型と型抜きなし） */
  opaque: boolean;
};

type GState = {
  ctm: Matrix;
  clip: Rect;
  fillN: number;
  strokeN: number;
  fill: number | null;
  stroke: number | null;
  ca: number;
  CA: number;
  normal: boolean;
  /** 重ね方（ExtGState の /BM の最初の名前。既定は Normal） */
  blend: string;
  lw: number;
  font: FontInfo | null;
  /** 書体の辞書への参照（黒い四角の字の形を読むため） */
  fontRef: PDFObject | null;
  /** 塗りの色が模様（パターン）のときの、模様の名前と中身（0.8.0 から） */
  fillPattern: { name: string; obj: PDFObject } | null;
  /** 縦書きの書体（WMode 1）のときの縦の寸法（字形の単位 1/1000）。横書きは null */
  vert: Vertical | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  mode: number;
};

const INF_RECT: Rect = [-Infinity, -Infinity, Infinity, Infinity];

/** 縦書きの寸法：vy は字の原点から字の上端までの縦のずれ、w1 は縦の送り（どちらも 1/1000。既定は DW2 の [880 -1000]） */
type Vertical = { vy: number; w1: number };

function intersect(a: Rect, b: Rect): Rect {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}
const inRect = (r: Rect, x: number, y: number) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
const union = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

function inShapeEvenOdd(polys: Point[][], x: number, y: number): boolean {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}
function nameOf(ctx: PDFContext, o: PDFObject | undefined): string | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFName ? v.decodeText() : undefined;
}
function numsOf(ctx: PDFContext, o: PDFObject | undefined): number[] | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (!(v instanceof PDFArray)) return null;
  const out: number[] = [];
  for (const x of v.asArray()) {
    const n = ctx.lookup(x);
    if (!(n instanceof PDFNumber)) return null;
    out.push(n.asNumber());
  }
  return out.every(Number.isFinite) ? out : null;
}
export function streamData(s: PDFStream): Uint8Array {
  return s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
}

export function contentData(ctx: PDFContext, contents: PDFObject | undefined): Uint8Array {
  const v = contents instanceof PDFRef ? ctx.lookup(contents) : contents;
  const parts: Uint8Array[] = [];
  const push = (o: PDFObject | undefined) => {
    const s = o instanceof PDFRef ? ctx.lookup(o) : o;
    if (s instanceof PDFStream) parts.push(streamData(s));
  };
  if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) push(v.get(i));
  else push(v);
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
    out[at++] = 0x0a;
  }
  return out;
}

/** 色空間の名前から成分の数（luminanceOf に渡す）。分からなければ 0 */
function componentsOf(ctx: PDFContext, res: PDFDict | undefined, name: string, depth = 0): number {
  if (name === "DeviceGray" || name === "G" || name === "CalGray") return 1;
  if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return 3;
  if (name === "DeviceCMYK" || name === "CMYK") return 4;
  if (depth > 2) return 0;
  const spaces = dictOf(ctx, res?.get(PDFName.of("ColorSpace")));
  const def = spaces ? ctx.lookup(spaces.get(PDFName.of(name))) : undefined;
  if (def instanceof PDFName) return componentsOf(ctx, undefined, def.decodeText(), depth + 1);
  if (def instanceof PDFArray) {
    const k = nameOf(ctx, def.get(0)) ?? "";
    if (k === "ICCBased") {
      const st = ctx.lookup(def.get(1));
      const n = st instanceof PDFStream ? st.dict.lookup(PDFName.of("N")) : undefined;
      return n instanceof PDFNumber ? n.asNumber() : 0;
    }
    if (k === "CalGray") return 1;
    if (k === "CalRGB") return 3;
  }
  return 0;
}

type Visibility = (oc: PDFObject | undefined) => boolean;

/** 表示しないレイヤーかを決める（/OCProperties の /D の /OFF・/ON・/BaseState。OCMD は /OCGs と /P） */
export function makeVisibility(ctx: PDFContext, catalog: PDFDict): Visibility {
  const props = dictOf(ctx, catalog.get(PDFName.of("OCProperties")));
  const d = props ? dictOf(ctx, props.get(PDFName.of("D"))) : undefined;
  const tag = (o: PDFObject | undefined) => (o instanceof PDFRef ? o.tag : null);
  const off = new Set<string>();
  const on = new Set<string>();
  const collect = (key: string, into: Set<string>) => {
    const arr = d ? ctx.lookup(d.get(PDFName.of(key))) : undefined;
    if (arr instanceof PDFArray) for (const o of arr.asArray()) {
      const t = tag(o);
      if (t) into.add(t);
    }
  };
  collect("OFF", off);
  collect("ON", on);
  const baseOff = d ? nameOf(ctx, d.get(PDFName.of("BaseState"))) === "OFF" : false;
  const ocgOn = (o: PDFObject | undefined): boolean => {
    const t = tag(o);
    if (!t) return true;
    if (off.has(t)) return false;
    if (baseOff) return on.has(t);
    return true;
  };
  return (oc) => {
    const dict = dictOf(ctx, oc);
    if (!dict) return true;
    if (nameOf(ctx, dict.get(PDFName.of("Type"))) === "OCMD") {
      const ocgs = dict.get(PDFName.of("OCGs"));
      const list = ctx.lookup(ocgs);
      const states = list instanceof PDFArray ? list.asArray().map((x) => ocgOn(x)) : [ocgOn(ocgs)];
      const p = nameOf(ctx, dict.get(PDFName.of("P"))) ?? "AnyOn";
      if (states.length === 0) return true;
      if (p === "AllOn") return states.every(Boolean);
      if (p === "AnyOff") return states.some((s) => !s);
      if (p === "AllOff") return states.every((s) => !s);
      return states.some(Boolean);
    }
    return ocgOn(oc);
  };
}

const num = (t: Tok | undefined) => (t && t.t === "num" ? t.v : 0);
const nums = (args: Tok[]) => args.flatMap((a) => (a.t === "num" ? [a.v] : []));

/** 線の1本を、太さの分だけ広げた四角にする */
function segmentQuad(p0: Point, p1: Point, half: number): Point[] | null {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len <= 0 || half <= 0) return null;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  return [[p0[0] + nx, p0[1] + ny], [p1[0] + nx, p1[1] + ny], [p1[0] - nx, p1[1] - ny], [p0[0] - nx, p0[1] - ny]];
}

const isAxisRect = (poly: Point[]) => {
  const b = boundsOf(poly);
  return poly.length === 4 && Math.abs(Math.abs(signedPolygonArea(poly)) - area(b)) <= 1e-6 * Math.max(1, area(b));
};

/**
 * 書体が縦書き（WMode 1）か。Type0 の書体で、/Encoding が「-V」で終わる名前（Identity-V など）か、CMap の /WMode が 1 のもの。
 * 縦の寸法は子の書体の /DW2 から読む（/W2 の字ごとの寸法は読まない。限界は README）
 */
function verticalOf(ctx: PDFContext, ref: PDFObject): Vertical | null {
  const font = dictOf(ctx, ref);
  if (!font || nameOf(ctx, font.get(PDFName.of("Subtype"))) !== "Type0") return null;
  const enc = ctx.lookup(font.get(PDFName.of("Encoding")));
  let wmode = 0;
  if (enc instanceof PDFName) wmode = /-V$/.test(enc.decodeText()) ? 1 : 0;
  else if (enc instanceof PDFStream) {
    const wm = enc.dict.lookup(PDFName.of("WMode"));
    wmode = wm instanceof PDFNumber ? wm.asNumber() : 0;
  }
  if (wmode !== 1) return null;
  const kids = ctx.lookup(font.get(PDFName.of("DescendantFonts")));
  const cid = kids instanceof PDFArray ? dictOf(ctx, kids.get(0)) : undefined;
  const dw2 = cid ? numsOf(ctx, cid.get(PDFName.of("DW2"))) : null;
  return dw2 && dw2.length >= 2 ? { vy: dw2[0]!, w1: dw2[1]! } : { vy: 880, w1: -1000 };
}

// ---------------------------------------------------------------- 読む

class Walker {
  seq = 0;
  ops = 0;
  readonly glyphs: Glyph[] = [];
  readonly covers: SanCover[] = [];
  /** 明るい色（白など）の不透明な覆い。画像の画素を塗るときだけ使う（字の消し方には使わない）。表示しないレイヤーのものは入れない */
  readonly lightCovers: SanCover[] = [];
  /** 明るい不透明な塗りのうち、覆いにしなかったもの（下を隠さない重ね方・表示しないレイヤー）。画像の上にあれば、片付けられなかった所にする */
  readonly lightSkipped: Array<SanCover & { why: "blend" | "hidden" | "transparent" | "unreadable" }> = [];
  /**
   * 黒でない塗りの記録（確かめの道具 trace のため。数・名前だけ。上限 FILL_LOG_MAX 件）。
   * 明るさが分からない色・中くらいの明るさの色も入れる（実物で「なぜ覆いにならなかったか」を見るため）
   */
  readonly fillLog: FillLogEntry[] = [];
  readonly fills: Fill[] = [];
  readonly images: Array<{ seq: number; box: Rect }> = [];
  readonly imageUses: ImageUse[] = [];
  readonly inlineImages: Array<{ seq: number; box: Rect }> = [];
  private readonly fontCache = new Map<PDFObject, FontInfo>();
  /** 注釈の見た目を読むときも、字を集めるか（0.8.0 から。あとの注釈の濃い覆いの下の字を消すため） */
  collectAp = false;
  private readonly patternCache = new Map<PDFObject, { opaque: boolean; hasText: boolean }>();
  /** 字の入った模様で塗った所（0.8.0 から） */
  readonly patternFills: Array<{ seq: number; rect: Rect; node: CNode; op: number; ctm: Matrix; name: string; stroke: boolean }> = [];

  /**
   * 模様が下を隠すか・中に字があるか。下を隠すとみなすのは：
   * - 色の移り変わり（PatternType 2）のうち、軸・円の移り変わり（ShadingType 2・3）で、両端を伸ばすもの（/Extend [true true]）
   * - 並べる模様（PatternType 1）のうち、すきまなく並び（/XStep・/YStep が /BBox 以下）、最初の塗りが模様の箱の 9 割以上を塗るもの
   */
  patternInfo(o: PDFObject): { opaque: boolean; hasText: boolean } {
    const hit = this.patternCache.get(o);
    if (hit) return hit;
    const ctx = this.ctx;
    let out = { opaque: false, hasText: false };
    try {
      const v = o instanceof PDFRef ? ctx.lookup(o) : o;
      const d = dictOf(ctx, v);
      const type = d?.lookup(PDFName.of("PatternType"));
      if (d && type instanceof PDFNumber && type.asNumber() === 2) {
        const sh = dictOf(ctx, d.get(PDFName.of("Shading")));
        const st = sh?.lookup(PDFName.of("ShadingType"));
        const ext = sh ? ctx.lookup(sh.get(PDFName.of("Extend"))) : undefined;
        const both = ext instanceof PDFArray && ext.size() >= 2 && ext.asArray().every((x) => { const b = ctx.lookup(x); return b instanceof PDFBool && b.asBoolean(); });
        out = { opaque: st instanceof PDFNumber && (st.asNumber() === 2 || st.asNumber() === 3) && both, hasText: false };
      } else if (v instanceof PDFStream && type instanceof PDFNumber && type.asNumber() === 1) {
        const bb = rectOf(numsOf(ctx, v.dict.get(PDFName.of("BBox"))));
        const xs = v.dict.lookup(PDFName.of("XStep"));
        const ys = v.dict.lookup(PDFName.of("YStep"));
        const data = streamData(v);
        const res = dictOf(ctx, v.dict.get(PDFName.of("Resources")));
        const hasText = apHasText(ctx, data, res, 0);
        let opaque = false;
        if (bb && xs instanceof PDFNumber && ys instanceof PDFNumber && Math.abs(xs.asNumber()) <= bb[2] - bb[0] + 1e-6 && Math.abs(ys.asNumber()) <= bb[3] - bb[1] + 1e-6) {
          // 最初に塗る命令が、模様の箱の 9 割以上の四角を塗るか（それまでに不透明さを変える命令などがないこと）
          let rect: Rect | null = null;
          for (const { op, args } of operations(data)) {
            if (op === "gs" || op === "Do" || op === "BI" || op === "sh" || op === "BT") break;
            if (op === "re") {
              const a = nums(args);
              if (a.length >= 4) rect = [Math.min(a[0]!, a[0]! + a[2]!), Math.min(a[1]!, a[1]! + a[3]!), Math.max(a[0]!, a[0]! + a[2]!), Math.max(a[1]!, a[1]! + a[3]!)];
              continue;
            }
            if (op === "f" || op === "F" || op === "f*" || op === "B" || op === "B*") {
              opaque = !!rect && intersectionArea(rect, bb) >= 0.9 * area(bb);
              break;
            }
            if (op === "S" || op === "s" || op === "n" || op === "cm") break;
          }
        }
        out = { opaque, hasText };
      }
    } catch {
      out = { opaque: false, hasText: false };
    }
    this.patternCache.set(o, out);
    return out;
  }
  private readonly ttCache = new Map<PDFObject, { s: Sfnt; gids: (code: number) => number[] | null } | null>();

  /**
   * 黒い四角の形の字の、覆いの箱（ページの座標）。埋め込んだ TrueType の書体なら、字形の本当の外枠を使う。
   * 埋め込んでいない書体では、字の箱いっぱいの形（█）だけを覆いにする（■ などは字の箱より小さいので、覆いにしない）
   */
  blockBox(ref: PDFObject | null, f: FontInfo, gl: { code: number; width: number; text: string }, trm: Matrix, x0: number, y0: number, rect: Rect): Rect | null {
    let tt: { s: Sfnt; gids: (code: number) => number[] | null } | null = null;
    if (ref) {
      if (!this.ttCache.has(ref)) {
        let v: { s: Sfnt; gids: (code: number) => number[] | null } | null = null;
        try {
          const fd = dictOf(this.ctx, ref);
          const t = fd ? trueTypeOf(this.ctx, fd, f) : null;
          const sf = t ? parseSfnt(streamData(t.file)) : null;
          v = t && sf ? { s: sf, gids: t.gids } : null;
        } catch {
          v = null;
        }
        this.ttCache.set(ref, v);
      }
      tt = this.ttCache.get(ref) ?? null;
    }
    if (tt) {
      const gid = tt.gids(gl.code)?.[0];
      const b = gid !== undefined ? glyphBox(tt.s, gid) : null;
      if (!b) return null;
      const u = tt.s.unitsPerEm;
      // 字の対応表で黒い四角と分からない字は、字形が四角 1 つで、幅も高さも字の大きさの 3 割以上のときだけ覆いにする（I・ハイフン・下線などは覆いにしない）
      if (!BLOCK_CHARS.has(gl.text) && !(gid !== undefined && isRectGlyph(tt.s, gid) && b[2] - b[0] >= BLOCK_MIN_EM * u && b[3] - b[1] >= BLOCK_MIN_EM * u)) return null;
      const pts: Point[] = [apply(trm, x0 + b[0] / u, y0 + b[1] / u), apply(trm, x0 + b[2] / u, y0 + b[1] / u), apply(trm, x0 + b[0] / u, y0 + b[3] / u), apply(trm, x0 + b[2] / u, y0 + b[3] / u)];
      return boundsOf(pts);
    }
    // Type3 の書体：字の描き方が四角 1 つの塗りなら、その四角を覆いにする
    if (ref) {
      const r3 = this.type3Rect(ref, gl.code);
      if (r3 && r3[2] - r3[0] >= BLOCK_MIN_EM && r3[3] - r3[1] >= BLOCK_MIN_EM) {
        const pts: Point[] = [apply(trm, r3[0], r3[1]), apply(trm, r3[2], r3[1]), apply(trm, r3[0], r3[3]), apply(trm, r3[2], r3[3])];
        return boundsOf(pts);
      }
    }
    // 埋め込んでいない標準の記号の書体（ZapfDingbats）の、黒い四角になる字：標準の寸法（字の外枠）で覆いにする（0.8.0 から）
    const std = ref ? standardBlock(this.ctx, ref, gl.code) : null;
    if (std) {
      const pts: Point[] = [apply(trm, x0 + std[0], y0 + std[1]), apply(trm, x0 + std[2], y0 + std[1]), apply(trm, x0 + std[0], y0 + std[3]), apply(trm, x0 + std[2], y0 + std[3])];
      return boundsOf(pts);
    }
    return gl.text === "█" && area(rect) > 0 ? rect : null;
  }

  private readonly t3Cache = new Map<PDFObject, Map<number, Rect | null> | null>();

  /** Type3 の書体で、コードの字の描き方が「四角 1 つを塗るだけ」なら、その四角（字の空間。FontMatrix をかけたもの） */
  type3Rect(ref: PDFObject, code: number): Rect | null {
    const ctx = this.ctx;
    if (!this.t3Cache.has(ref)) {
      let table: Map<number, Rect | null> | null = null;
      try {
        const fd = dictOf(ctx, ref);
        if (fd && nameOf(ctx, fd.get(PDFName.of("Subtype"))) === "Type3") {
          const fm = numsOf(ctx, fd.get(PDFName.of("FontMatrix")));
          const m: Matrix = fm && fm.length === 6 ? (fm as Matrix) : [0.001, 0, 0, 0.001, 0, 0];
          const procs = dictOf(ctx, fd.get(PDFName.of("CharProcs")));
          const enc = dictOf(ctx, fd.get(PDFName.of("Encoding")));
          const diffs = enc ? ctx.lookup(enc.get(PDFName.of("Differences"))) : undefined;
          table = new Map();
          if (procs && diffs instanceof PDFArray) {
            let c = 0;
            for (const o of diffs.asArray()) {
              const v = ctx.lookup(o);
              if (v instanceof PDFNumber) c = v.asNumber();
              else if (v instanceof PDFName) {
                const st = ctx.lookup(procs.get(v));
                table.set(c, st instanceof PDFStream ? rectProc(streamData(st), m) : null);
                c++;
              }
            }
          }
        }
      } catch {
        table = null;
      }
      this.t3Cache.set(ref, table);
    }
    return this.t3Cache.get(ref)?.get(code) ?? null;
  }
  private readonly vertCache = new Map<PDFObject, Vertical | null>();
  private readonly ctx: PDFContext;
  private readonly visible: Visibility;
  private readonly s: ContentSettings;
  private readonly pageNo: number;

  constructor(ctx: PDFContext, visible: Visibility, s: ContentSettings, pageNo: number) {
    this.ctx = ctx;
    this.visible = visible;
    this.s = s;
    this.pageNo = pageNo;
  }

  logFill(seq: number, rect: Rect, g: GState, hidden: boolean, annotation: boolean, decision: FillLogEntry["decision"]) {
    if (this.fillLog.length >= FILL_LOG_MAX) return;
    this.fillLog.push({ seq, rect, luminance: g.fill, alpha: g.ca, blend: g.blend, hidden, annotation, decision });
  }

  initial(ctm: Matrix): GState {
    return {
      ctm, clip: INF_RECT, fillN: 1, strokeN: 1, fill: 0, stroke: 0, ca: 1, CA: 1, normal: true, blend: "Normal", lw: 1,
      font: null, fontRef: null, fillPattern: null, vert: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, mode: 0,
    };
  }

  /** 中身を読む。annotation のときは覆いだけを集める（字・塗り・画像は集めない） */
  run(node: CNode, start: GState, hidden: boolean, depth: number, seen: Set<PDFObject>, annotation: boolean) {
    const ctx = this.ctx;
    const s = this.s;
    const res = node.res;
    let g: GState = { ...start };
    const stack: GState[] = [];
    const marks: boolean[] = [];
    const isHidden = () => hidden || marks.some(Boolean);
    let path: Array<{ pts: Point[]; closed: boolean; curved: boolean }> = [];
    let cur: { pts: Point[]; closed: boolean; curved: boolean } | null = null;
    let pendingClip = false;
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    let opIndex = -1;

    const resOf = (cat: string, name: string): PDFObject | undefined => {
      const d = dictOf(ctx, res?.get(PDFName.of(cat)));
      return d ? d.get(PDFName.of(name)) : undefined;
    };
    const pt = (x: number, y: number): Point => apply(g.ctm, x, y);
    const startSub = (p: Point) => {
      cur = { pts: [p], closed: false, curved: false };
      path.push(cur);
    };
    const lineTo = (p: Point) => {
      if (!cur) startSub(p);
      else cur.pts.push(p);
    };
    const endPath = () => {
      path = [];
      cur = null;
      pendingClip = false;
    };

    const paint = (doFill: boolean, doStroke: boolean, rule: "nonzero" | "evenodd") => {
      const polys = path.filter((p) => p.pts.length >= 2);
      if (pendingClip && polys.length) g.clip = intersect(g.clip, boundsOf(polys.flatMap((p) => p.pts)));
      if (!polys.length || !isFiniteMatrix(g.ctm)) {
        endPath();
        return;
      }
      const seq = ++this.seq;
      const box = boundsOf(polys.flatMap((p) => p.pts));
      if (doFill) {
        const parts = polys.map((p) => p.pts);
        // 字の入った模様で塗った所（0.8.0 から）：あとの濃い覆い・選んだ場所の下にあれば、黒一色で塗り直して模様の中の字を消す
        if (g.fill === null && g.fillPattern && !annotation) {
          const pinfo = this.patternInfo(g.fillPattern.obj);
          if (pinfo.hasText) this.patternFills.push({ seq, rect: box, node, op: opIndex, ctm: g.ctm, name: g.fillPattern.name, stroke: doStroke });
        }
        if (!annotation) {
          const filled = parts.reduce((sum, p) => sum + Math.abs(signedPolygonArea(p)), 0);
          this.fills.push({
            seq, box, polys: parts, lum: g.fill, alpha: g.ca, normal: g.normal,
            rectangular: area(box) > 0 && filled / area(box) >= s.rectangularFillMin,
          });
        }
        if (g.fill !== null && g.fill <= s.darkLuminanceMax && g.ca >= s.opacityMin) {
          const shapeParts = parts.filter((p) => p.length >= 3 && area(boundsOf(p)) > 0);
          if (shapeParts.length) {
            const plain = shapeParts.length === 1 && isAxisRect(shapeParts[0]!);
            this.covers.push({
              seq, rect: boundsOf(shapeParts.flat()), kind: annotation ? "annotation" : "fill",
              ...(plain ? {} : { shape: { parts: shapeParts, rule } }),
            });
          }
        } else if (g.fill !== null && g.fill >= s.lightLuminanceMin && g.ca >= s.uncertainAlphaMin) {
          // 白などの不透明な塗り：画像の上にあれば、下の画素を塗る（ページの中の白い四角も入れる。消しすぎの側。2026-11-04 人が決めた）。
          // 下を隠さない重ね方（Multiply など）・表示しないレイヤー・半透明（不透明さ 0.5 以上 0.9 未満）のものは、
          // 塗ると見た目が変わるので塗らず、画像の上にあれば片付けられなかった所にする（黙って残さない）
          const shapeParts = parts.filter((p) => p.length >= 3 && area(boundsOf(p)) > 0);
          const hidden = isHidden();
          if (shapeParts.length) {
            const plain = shapeParts.length === 1 && isAxisRect(shapeParts[0]!);
            const cover: SanCover = {
              seq, rect: boundsOf(shapeParts.flat()), kind: annotation ? "annotation" : "fill", tone: "light",
              ...(plain ? {} : { shape: { parts: shapeParts, rule } }),
            };
            const why = hidden ? "hidden" : !LIGHT_HIDING_BLENDS.has(g.blend) ? "blend" : g.ca < s.opacityMin ? "transparent" : null;
            if (why === null) this.lightCovers.push(cover);
            else this.lightSkipped.push({ ...cover, why });
            this.logFill(seq, cover.rect, g, hidden, annotation, why === null ? "light_cover" : `skip_${why}`);
          } else this.logFill(seq, box, g, hidden, annotation, "no_area");
        } else if (g.fill === null && g.fillPattern && g.ca >= s.opacityMin && g.normal && !isHidden()) {
          // 模様（パターン）で塗った、四角に近い不透明な塗り：下を隠す模様なら覆いにする。中に字のある模様は、黒一色で塗り直す（0.8.0 から）
          const filled = parts.reduce((sum, p) => sum + Math.abs(signedPolygonArea(p)), 0);
          const info = this.patternInfo(g.fillPattern.obj);
          if (info.opaque && area(box) > 0 && filled / area(box) >= s.rectangularFillMin) {
            this.covers.push({ seq, rect: box, kind: annotation ? "annotation" : "fill" });
            if (info.hasText && !annotation && !doStroke) (node.repaints ??= new Map()).set(opIndex, { rect: box, ctm: g.ctm, name: g.fillPattern.name });
          }
          this.logFill(seq, box, g, isHidden(), annotation, "unknown_color");
        } else if (g.fill === null || g.fill > s.darkLuminanceMax) {
          // 記録だけ（明るさが分からない色・中くらいの明るさ・ほとんど透明な白）
          const decision = g.fill === null ? "unknown_color" : g.fill >= s.lightLuminanceMin ? "ignore_transparent" : "mid_tone";
          this.logFill(seq, box, g, isHidden(), annotation, decision);
        }
      }
      if (doStroke && g.stroke !== null && g.stroke <= s.darkLuminanceMax && g.CA >= s.opacityMin) {
        const half = (g.lw * scaleOf(g.ctm)) / 2;
        if (half * 2 >= s.minStrokeWidth) {
          for (const sp of polys) {
            const pts = sp.closed ? [...sp.pts, sp.pts[0]!] : sp.pts;
            const quads: Point[][] = [];
            for (let k = 0; k + 1 < pts.length; k++) {
              const q = segmentQuad(pts[k]!, pts[k + 1]!, half);
              if (q) quads.push(q);
            }
            for (const q of quads) {
              this.covers.push({
                seq, rect: boundsOf(q), kind: annotation ? "annotation" : "stroke",
                ...(isAxisRect(q) ? {} : { shape: { parts: [q], rule: "nonzero" as const } }),
              });
            }
          }
        }
      }
      endPath();
    };

    const showText = (bytes: Uint8Array, elem: number) => {
      const f = g.font;
      if (!f) return;
      const glyphs = f.decode(bytes);
      const width = f.twoByte ? 2 : 1;
      const sliceable = glyphs.length * width === bytes.length;
      const collect = !annotation || this.collectAp;
      const textOp = !collect ? null : (node.textOps.get(opIndex) ?? node.textOps.set(opIndex, { elems: new Map() }).get(opIndex)!);
      const slots: GlyphSlot[] = [];
      glyphs.forEach((gl, k) => {
        const seq = ++this.seq;
        const trm = multiply([g.size * g.th, 0, 0, g.size, 0, g.rise], multiply(tm, g.ctm));
        const ws = gl.isWordSpace ? g.tw : 0;
        const vert = g.vert;
        // 縦書き：字の原点は字の上の真ん中。字形は (-幅/2, -vy) から横書きと同じ形で描く。送りは下へ（w1。横の拡大はかけない）
        const step = vert ? (vert.w1 / 1000) * g.size + g.tc + ws : gl.width * g.size + g.tc + ws;
        const adv = vert ? step : step * g.th;
        if (collect && isFiniteMatrix(trm)) {
          const x0 = vert ? -gl.width / 2 : 0;
          const y0 = vert ? -vert.vy / 1000 : 0;
          const corners: Point[] = [
            apply(trm, x0, y0 + f.descent), apply(trm, x0 + gl.width, y0 + f.descent), apply(trm, x0, y0 + f.ascent), apply(trm, x0 + gl.width, y0 + f.ascent),
          ];
          const [bx, by] = apply(trm, x0, y0 + f.descent);
          const [tx, ty] = apply(trm, x0, y0 + f.ascent);
          const strokeMode = g.mode === 1 || g.mode === 5;
          const glyph: Glyph = {
            seq, rect: boundsOf(corners), height: Math.hypot(tx - bx, ty - by), isSpace: gl.isSpace,
            hidden: isHidden(), clip: g.clip, mode: g.mode, alpha: strokeMode ? g.CA : g.ca, lum: strokeMode ? g.stroke : g.fill,
            hScale: vert ? 1 : g.th, font: f, code: gl.code, isCover: false, inAnnot: annotation,
            page: this.pageNo, remove: null, node, op: opIndex,
          };
          this.glyphs.push(glyph);
          // 黒い四角の形の字（記号の書体を詰めて並べたもの）は、濃い覆いにする（0.8.0 から）
          const fillMode = g.mode === 0 || g.mode === 2 || g.mode === 4 || g.mode === 6;
          if (fillMode && g.fill !== null && g.fill <= s.darkLuminanceMax && g.ca >= s.opacityMin && g.normal && !isHidden()) {
            const box = this.blockBox(g.fontRef, f, gl, trm, x0, y0, glyph.rect);
            if (box) {
              this.covers.push({ seq, rect: box, kind: annotation ? "annotation" : "glyph" });
              glyph.isCover = true;
              glyph.coverRect = box;
            }
          }
          slots.push({
            g: glyph,
            bytes: sliceable ? bytes.subarray(k * width, (k + 1) * width) : null,
            adj: g.size !== 0 ? (-step * 1000) / g.size : null,
          });
        }
        tm = multiply(vert ? [1, 0, 0, 1, 0, adv] : [1, 0, 0, 1, adv, 0], tm);
      });
      if (textOp) textOp.elems.set(elem, slots);
    };

    for (const { op, args } of operations(node.data)) {
      opIndex++;
      if (++this.ops > s.maxOperationsPerPage) throw new TooManyOperations();
      const a = nums(args);
      switch (op) {
        case "q":
          stack.push({ ...g });
          if (stack.length > 1000) stack.shift();
          break;
        case "Q":
          if (stack.length) g = stack.pop()!;
          break;
        case "cm":
          if (a.length >= 6) g.ctm = multiply(a.slice(0, 6) as Matrix, g.ctm);
          break;
        case "w":
          if (a.length >= 1) g.lw = Math.abs(a[0]!);
          break;
        case "gs": {
          const egs = dictOf(ctx, resOf("ExtGState", args[0]?.t === "name" ? args[0].v : ""));
          if (egs) {
            const ca = egs.lookup(PDFName.of("ca"));
            const CA = egs.lookup(PDFName.of("CA"));
            const lw = egs.lookup(PDFName.of("LW"));
            if (ca instanceof PDFNumber) g.ca = ca.asNumber();
            if (CA instanceof PDFNumber) g.CA = CA.asNumber();
            if (lw instanceof PDFNumber) g.lw = Math.abs(lw.asNumber());
            const bm = egs.get(PDFName.of("BM"));
            if (bm) {
              const arr = ctx.lookup(bm);
              const first = arr instanceof PDFArray ? nameOf(ctx, arr.get(0)) : nameOf(ctx, bm);
              g.normal = first === "Normal" || first === "Compatible";
              g.blend = first ?? "Normal";
            }
          }
          break;
        }
        case "g": g.fillN = 1; g.fill = luminanceOf(a, 1); g.fillPattern = null; break;
        case "G": g.strokeN = 1; g.stroke = luminanceOf(a, 1); break;
        case "rg": g.fillN = 3; g.fill = luminanceOf(a, 3); g.fillPattern = null; break;
        case "RG": g.strokeN = 3; g.stroke = luminanceOf(a, 3); break;
        case "k": g.fillN = 4; g.fill = luminanceOf(a, 4); g.fillPattern = null; break;
        case "K": g.strokeN = 4; g.stroke = luminanceOf(a, 4); break;
        case "cs":
        case "CS": {
          const n = componentsOf(ctx, res, args[0]?.t === "name" ? args[0].v : "");
          const init = n === 4 ? [0, 0, 0, 1] : new Array(n).fill(0);
          if (op === "cs") { g.fillN = n; g.fill = luminanceOf(init, n); g.fillPattern = null; }
          else { g.strokeN = n; g.stroke = luminanceOf(init, n); }
          break;
        }
        case "sc":
        case "scn": {
          const pn = args.find((x) => x.t === "name");
          g.fill = pn ? null : luminanceOf(a, g.fillN);
          const pat = pn && pn.t === "name" ? resOf("Pattern", pn.v) : undefined;
          g.fillPattern = pn && pn.t === "name" && pat ? { name: pn.v, obj: pat } : null;
          break;
        }
        case "SC":
        case "SCN":
          g.stroke = args.some((x) => x.t === "name") ? null : luminanceOf(a, g.strokeN);
          break;
        // 道
        case "m":
          if (a.length >= 2) startSub(pt(a[0]!, a[1]!));
          break;
        case "l":
          if (a.length >= 2) lineTo(pt(a[0]!, a[1]!));
          break;
        case "c":
        case "v":
        case "y": {
          if ((op === "c" && a.length < 6) || (op !== "c" && a.length < 4)) break;
          const sub = cur as { pts: Point[]; curved: boolean } | null;
          const p0 = sub?.pts[sub.pts.length - 1];
          const p3 = pt(a[a.length - 2]!, a[a.length - 1]!);
          if (!sub || !p0) {
            startSub(p3);
            break;
          }
          const p1 = op === "v" ? p0 : pt(a[0]!, a[1]!);
          const p2 = op === "c" ? pt(a[2]!, a[3]!) : op === "v" ? pt(a[0]!, a[1]!) : p3;
          sub.curved = true;
          sub.pts.push(...flattenCubic(p0, p1, p2, p3, 8));
          break;
        }
        case "re": {
          if (a.length < 4) break;
          const [x, y, w, h] = a as [number, number, number, number];
          path.push({ pts: [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)], closed: true, curved: false });
          cur = null;
          break;
        }
        case "h":
          if (cur) (cur as { closed: boolean }).closed = true;
          cur = null;
          break;
        case "W":
        case "W*":
          pendingClip = true;
          break;
        case "f":
        case "F":
          paint(true, false, "nonzero");
          break;
        case "f*":
          paint(true, false, "evenodd");
          break;
        case "S":
          paint(false, true, "nonzero");
          break;
        case "s":
          if (cur) (cur as { closed: boolean }).closed = true;
          paint(false, true, "nonzero");
          break;
        case "B":
          paint(true, true, "nonzero");
          break;
        case "B*":
          paint(true, true, "evenodd");
          break;
        case "b":
        case "b*":
          if (cur) (cur as { closed: boolean }).closed = true;
          paint(true, true, op === "b*" ? "evenodd" : "nonzero");
          break;
        case "n":
          if (pendingClip) {
            const polys = path.filter((p) => p.pts.length >= 1);
            if (polys.length) g.clip = intersect(g.clip, boundsOf(polys.flatMap((p) => p.pts)));
          }
          endPath();
          break;
        // 字
        case "BT":
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case "Tf": {
          const ref = resOf("Font", args[0]?.t === "name" ? args[0].v : "");
          if (ref) {
            let fi = this.fontCache.get(ref);
            if (!fi) {
              fi = withStandardWidths(ctx, ref, readFont(ctx, ref));
              this.fontCache.set(ref, fi);
            }
            g.font = fi;
            g.fontRef = ref;
            let v = this.vertCache.get(ref);
            if (v === undefined) {
              v = verticalOf(ctx, ref);
              this.vertCache.set(ref, v);
            }
            g.vert = v;
          } else {
            g.font = null;
            g.fontRef = null;
            g.vert = null;
          }
          g.size = num(args[1]);
          break;
        }
        case "Tc": g.tc = num(args[0]); break;
        case "Tw": g.tw = num(args[0]); break;
        case "Tz": g.th = num(args[0]) / 100; break;
        case "TL": g.tl = num(args[0]); break;
        case "Ts": g.rise = num(args[0]); break;
        case "Tr": g.mode = num(args[0]); break;
        case "Td":
          tlm = multiply([1, 0, 0, 1, num(args[0]), num(args[1])], tlm);
          tm = tlm;
          break;
        case "TD":
          g.tl = -num(args[1]);
          tlm = multiply([1, 0, 0, 1, num(args[0]), num(args[1])], tlm);
          tm = tlm;
          break;
        case "Tm":
          if (a.length >= 6) {
            tlm = a.slice(0, 6) as Matrix;
            tm = tlm;
          }
          break;
        case "T*":
          tlm = multiply([1, 0, 0, 1, 0, -g.tl], tlm);
          tm = tlm;
          break;
        case "Tj":
          if (args[0]?.t === "str") showText(args[0].v, 0);
          break;
        case "'":
          tlm = multiply([1, 0, 0, 1, 0, -g.tl], tlm);
          tm = tlm;
          if (args[0]?.t === "str") showText(args[0].v, 0);
          break;
        case '"':
          g.tw = num(args[0]);
          g.tc = num(args[1]);
          tlm = multiply([1, 0, 0, 1, 0, -g.tl], tlm);
          tm = tlm;
          if (args[2]?.t === "str") showText(args[2].v, 2);
          break;
        case "TJ": {
          const arr = args[0]?.t === "arr" ? args[0].v : [];
          arr.forEach((el, k) => {
            if (el.t === "str") showText(el.v, k);
            else if (el.t === "num") tm = multiply(g.vert ? [1, 0, 0, 1, 0, (-el.v / 1000) * g.size] : [1, 0, 0, 1, (-el.v / 1000) * g.size * g.th, 0], tm);
          });
          break;
        }
        // 画像と部品
        case "BI": {
          node.hasInline = true;
          const seq = ++this.seq;
          const box = boundsOf([pt(0, 0), pt(1, 0), pt(0, 1), pt(1, 1)]);
          if (!annotation) {
            this.images.push({ seq, box });
            this.inlineImages.push({ seq, box });
          }
          break;
        }
        case "Do": {
          const name = args[0]?.t === "name" ? args[0].v : "";
          const ref = resOf("XObject", name);
          const xo = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
          if (!(xo instanceof PDFStream)) break;
          const st = nameOf(ctx, xo.dict.get(PDFName.of("Subtype")));
          if (st === "Image") {
            if (!isFiniteMatrix(g.ctm)) break;
            const seq = ++this.seq;
            const corners = [pt(0, 0), pt(1, 0), pt(1, 1), pt(0, 1)];
            const box = boundsOf(corners);
            if (!annotation) {
              this.images.push({ seq, box });
              const d = xo.dict;
              const imMask = d.lookup(PDFName.of("ImageMask"));
              // 下の字を隠すとみなす画像：不透明・ふつうの重ね方・表示するレイヤー・透明の型と型抜きなし・縦横に置いたもの（箱で隠れた割合を測るため）
              const opaque = g.ca >= s.opacityMin && g.normal && !isHidden() && this.visible(d.get(PDFName.of("OC"))) &&
                !d.has(PDFName.of("SMask")) && !d.has(PDFName.of("Mask")) && !(imMask instanceof PDFBool && imMask.asBoolean()) && isAxisRect(corners);
              const use: ImageUse = { seq, box, ctm: g.ctm, stream: xo, res, node, op: opIndex, clip: g.clip, opaque };
              this.imageUses.push(use);
              node.images.set(opIndex, use);
            }
            if (g.ca >= s.opacityMin && area(box) > 0) {
              const m = measureImageDarkness({
                ctx, stream: xo, colorSpaces: dictOf(ctx, res?.get(PDFName.of("ColorSpace"))), fillLuminance: g.fill,
                darkLuminanceMax: s.darkLuminanceMax, opacityMin: s.opacityMin, maxImageBytes: s.maxImageBytes,
              });
              if (m.kind === "measured" && m.darkFraction >= s.darkImageFractionMin) {
                this.covers.push({
                  seq, rect: box, kind: annotation ? "annotation" : "image",
                  ...(isAxisRect(corners) ? {} : { shape: { parts: [corners], rule: "nonzero" as const } }),
                });
              }
            }
          } else if (st === "Form") {
            if (depth >= s.maxFormDepth || seen.has(xo)) break;
            const fm = numsOf(ctx, xo.dict.get(PDFName.of("Matrix")));
            const m: Matrix = fm && fm.length === 6 ? (fm as Matrix) : IDENTITY;
            const inner: GState = { ...g, ctm: multiply(m, g.ctm) };
            const bb = numsOf(ctx, xo.dict.get(PDFName.of("BBox")));
            if (bb && bb.length === 4) {
              inner.clip = intersect(g.clip, boundsOf([apply(inner.ctm, bb[0]!, bb[1]!), apply(inner.ctm, bb[2]!, bb[1]!), apply(inner.ctm, bb[0]!, bb[3]!), apply(inner.ctm, bb[2]!, bb[3]!)]));
            }
            const formHidden = isHidden() || !this.visible(xo.dict.get(PDFName.of("OC")));
            let data: Uint8Array;
            try {
              data = streamData(xo);
            } catch {
              break;
            }
            const child: CNode = {
              data, res: dictOf(ctx, xo.dict.get(PDFName.of("Resources"))) ?? res, hasInline: false,
              forms: new Map(), textOps: new Map(), images: new Map(), actualText: new Set(),
            };
            if (!annotation || this.collectAp) node.forms.set(opIndex, { node: child, stream: xo });
            const nextSeen = new Set(seen);
            nextSeen.add(xo);
            this.run(child, inner, formHidden, depth + 1, nextSeen, annotation);
          }
          break;
        }
        // マーク付きの中身（レイヤー）
        case "BMC":
          marks.push(false);
          break;
        case "BDC": {
          let hide = false;
          if (args[0]?.t === "name" && args[0].v === "OC" && args[1]?.t === "name") hide = !this.visible(resOf("Properties", args[1].v));
          if (args[1]?.t === "dict" && args[1].v.has("ActualText")) node.actualText.add(opIndex);
          marks.push(hide);
          break;
        }
        case "EMC":
          marks.pop();
          break;
        default:
          break;
      }
    }
  }
}

// ---------------------------------------------------------------- 注釈を覆いとして読む

const FLAG_HIDDEN = 2;
const FLAG_NOVIEW = 32;

function rectOf(a: number[] | null): Rect | null {
  if (!a || a.length < 4) return null;
  return [Math.min(a[0]!, a[2]!), Math.min(a[1]!, a[3]!), Math.max(a[0]!, a[2]!), Math.max(a[1]!, a[3]!)];
}

function appearance(ctx: PDFContext, annot: PDFDict): PDFStream | null {
  const ap = dictOf(ctx, annot.get(PDFName.of("AP")));
  const n = ap ? ctx.lookup(ap.get(PDFName.of("N"))) : undefined;
  if (n instanceof PDFStream) return n;
  if (n instanceof PDFDict) {
    const as = annot.lookup(PDFName.of("AS"));
    const chosen = as instanceof PDFName ? ctx.lookup(n.get(as)) : undefined;
    if (chosen instanceof PDFStream) return chosen;
  }
  return null;
}

/** 注釈の見た目（/AP の /N。状態つきなら /AS の状態）を、新しいストリームに差し替える */
function setAppearance(ctx: PDFContext, annot: PDFDict, old: PDFStream, ref: PDFRef) {
  const ap0 = dictOf(ctx, annot.get(PDFName.of("AP")));
  if (!ap0) return;
  // 見た目の辞書は、ほかの注釈と共有かもしれないので、写してから差し替える
  const ap = ap0.clone(ctx);
  const n = ctx.lookup(ap.get(PDFName.of("N")));
  if (n === old) ap.set(PDFName.of("N"), ref);
  else if (n instanceof PDFDict) {
    const nn = n.clone(ctx);
    for (const [k, v] of nn.entries()) if (ctx.lookup(v) === old) nn.set(k, ref);
    ap.set(PDFName.of("N"), nn);
  } else return;
  annot.set(PDFName.of("AP"), ap);
}

function appearanceMatrix(ctx: PDFContext, ap: PDFStream, rect: Rect): Matrix | null {
  const bbox = rectOf(numsOf(ctx, ap.dict.get(PDFName.of("BBox"))));
  const mArr = numsOf(ctx, ap.dict.get(PDFName.of("Matrix")));
  const m: Matrix = mArr && mArr.length === 6 ? (mArr as Matrix) : IDENTITY;
  if (!bbox) return null;
  const t = boundsOf([apply(m, bbox[0], bbox[1]), apply(m, bbox[2], bbox[1]), apply(m, bbox[2], bbox[3]), apply(m, bbox[0], bbox[3])]);
  const tw = t[2] - t[0];
  const th = t[3] - t[1];
  if (tw <= 0 || th <= 0) return null;
  const sx = (rect[2] - rect[0]) / tw;
  const sy = (rect[3] - rect[1]) / th;
  const out = multiply(m, [sx, 0, 0, sy, rect[0] - t[0] * sx, rect[1] - t[1] * sy]);
  return isFiniteMatrix(out) ? out : null;
}

/** ページの注釈を覆いとして足す。適用する墨消し注釈の箱を返す */
type ApNode = { annot: PDFDict; stream: PDFStream; node: CNode };

function scanAnnotations(ctx: PDFContext, page: PDFPage, w: Walker, visible: Visibility, s: ContentSettings): { redactRects: Rect[]; redactAnnots: PDFObject[]; apTextRects: Rect[]; apNodes: ApNode[] } {
  const redactRects: Rect[] = [];
  const redactAnnots: PDFObject[] = [];
  const apTextRects: Rect[] = [];
  const apNodes: ApNode[] = [];
  const annots = ctx.lookup(page.node.get(PDFName.of("Annots")));
  if (!(annots instanceof PDFArray)) return { redactRects, redactAnnots, apTextRects, apNodes };
  for (const ref of annots.asArray()) {
    const annot = dictOf(ctx, ref);
    if (!annot) continue;
    const subtype = nameOf(ctx, annot.get(PDFName.of("Subtype"))) ?? "";
    const rect = rectOf(numsOf(ctx, annot.get(PDFName.of("Rect"))));
    if (!rect) continue;
    if (subtype === "Redact") {
      const q = numsOf(ctx, annot.get(PDFName.of("QuadPoints")));
      const boxes: Rect[] = [];
      if (q && q.length >= 8) {
        for (let i = 0; i + 8 <= q.length; i += 8) boxes.push(boundsOf([[q[i]!, q[i + 1]!], [q[i + 2]!, q[i + 3]!], [q[i + 4]!, q[i + 5]!], [q[i + 6]!, q[i + 7]!]]));
      } else boxes.push(rect);
      for (const b of boxes) {
        w.covers.push({ seq: ++w.seq, rect: b, kind: "redact" });
        redactRects.push(b);
      }
      redactAnnots.push(ref);
      continue;
    }
    if (subtype === "Popup") continue;
    const flags = annot.lookup(PDFName.of("F"));
    if (flags instanceof PDFNumber && flags.asNumber() & (FLAG_HIDDEN | FLAG_NOVIEW)) continue;
    // 注釈全体の不透明さ（/CA）。0.5 未満は、下がはっきり見えるので覆いにも notDone にもしない。
    // 0.5 以上 0.9 未満は、見た目の中の塗りに引き継ぎ、白い塗りなら notDone の側にする（半透明）
    const ca = annot.lookup(PDFName.of("CA"));
    const alpha = ca instanceof PDFNumber ? ca.asNumber() : 1;
    if (alpha < s.uncertainAlphaMin) continue;
    // 見た目を読めない注釈は、覆いかどうか分からない。画像の上にあれば notDone にする（黙って残さない）
    const unreadable = () => w.lightSkipped.push({ seq: ++w.seq, rect, kind: "annotation", tone: "light", why: "unreadable" });
    const ap = appearance(ctx, annot);
    if (ap) {
      const m = appearanceMatrix(ctx, ap, rect);
      if (!m) {
        unreadable();
        continue;
      }
      let data: Uint8Array;
      try {
        data = streamData(ap);
      } catch {
        unreadable();
        continue;
      }
      const node: CNode = { data, res: dictOf(ctx, ap.dict.get(PDFName.of("Resources"))), hasInline: false, forms: new Map(), textOps: new Map(), images: new Map(), actualText: new Set() };
      try {
        // 見た目の中の字も集める（あとの注釈の濃い覆いの下の字を消すため。0.8.0 から）
        w.collectAp = true;
        w.run(node, { ...w.initial(m), ca: Math.min(1, alpha), CA: Math.min(1, alpha) }, false, 0, new Set(), true);
        apNodes.push({ annot, stream: ap, node });
      } catch (e) {
        if (e instanceof TooManyOperations) throw e;
        unreadable();
      } finally {
        w.collectAp = false;
      }
      // 見た目の中だけに字があり、コメント（/Contents）のない注釈（スタンプなど）：ページに見えている字なので消さず、notDone にする
      if (!NO_TEXT_CHECK.has(subtype) && !hasText(ctx, annot.get(PDFName.of("Contents"))) && apHasText(ctx, data, dictOf(ctx, ap.dict.get(PDFName.of("Resources"))), 0)) {
        apTextRects.push(rect);
      }
      continue;
    }
    if (subtype === "Highlight") {
      // 見た目のない蛍光ペン：読み手は下の色に掛け合わせて描く。色が濃ければ、下の字は黒く塗りつぶされて見えない（濃い覆い）
      const c = numsOf(ctx, annot.get(PDFName.of("C")));
      const lum = c && c.length > 0 ? luminanceOf(c, c.length) : null;
      if (lum !== null && lum <= s.darkLuminanceMax && alpha >= s.opacityMin) {
        const q = numsOf(ctx, annot.get(PDFName.of("QuadPoints")));
        if (q && q.length >= 8) {
          for (let i = 0; i + 8 <= q.length; i += 8) w.covers.push({ seq: ++w.seq, rect: boundsOf([[q[i]!, q[i + 1]!], [q[i + 2]!, q[i + 3]!], [q[i + 4]!, q[i + 5]!], [q[i + 6]!, q[i + 7]!]]), kind: "annotation" });
        } else w.covers.push({ seq: ++w.seq, rect, kind: "annotation" });
      }
      continue;
    }
    if (subtype === "Square") {
      const ic = numsOf(ctx, annot.get(PDFName.of("IC")));
      const lum = ic && ic.length > 0 ? luminanceOf(ic, ic.length) : null;
      if (lum !== null && lum <= s.darkLuminanceMax) {
        if (alpha >= s.opacityMin) w.covers.push({ seq: ++w.seq, rect, kind: "annotation" });
      } else if (lum !== null && lum >= s.lightLuminanceMin) {
        if (alpha >= s.opacityMin) w.lightCovers.push({ seq: ++w.seq, rect, kind: "annotation", tone: "light" });
        else w.lightSkipped.push({ seq: ++w.seq, rect, kind: "annotation", tone: "light", why: "transparent" });
      }
    }
  }
  void visible;
  return { redactRects, redactAnnots, apTextRects, apNodes };
}

/** 見た目の中の字を調べない注釈（フォームの欄の値は leftovers.ts、リンク・吹き出しは字を描かない、付箋は外す） */
const NO_TEXT_CHECK = new Set(["Widget", "Link", "Popup", "Text", "Redact"]);

function hasText(ctx: PDFContext, o: PDFObject | undefined): boolean {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return (v instanceof PDFString || v instanceof PDFHexString) && v.decodeText().trim().length > 0;
}

/** 見た目（と、その中の部品）に字を描く命令があるか */
function apHasText(ctx: PDFContext, data: Uint8Array, res: PDFDict | undefined, depth: number): boolean {
  for (const { op, args } of operations(data)) {
    if (op === "Tj" || op === "TJ" || op === "'" || op === '"') return true;
    if (op === "Do" && depth < 4 && args[0]?.t === "name") {
      const xo = ctx.lookup(dictOf(ctx, res?.get(PDFName.of("XObject")))?.get(PDFName.of(args[0].v)));
      if (xo instanceof PDFStream && nameOf(ctx, xo.dict.get(PDFName.of("Subtype"))) === "Form") {
        try {
          if (apHasText(ctx, streamData(xo), dictOf(ctx, xo.dict.get(PDFName.of("Resources"))) ?? res, depth + 1)) return true;
        } catch {
          // 読めない部品は数えない
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- 決める（P7）

function judgeP7(gl: Glyph, view: Rect, fills: Fill[], images: Array<{ seq: number; box: Rect }>, s: ContentSettings): P7Reason | null {
  const a = area(gl.rect);
  const outside = (box: Rect) => (a > 0 ? 1 - intersectionArea(gl.rect, box) / a : inRect(box, gl.rect[0], gl.rect[1]) ? 0 : 1);
  if (gl.hidden) return "hidden_layer";
  if (outside(view) >= s.outsideFraction) return "off_page";
  if (outside(gl.clip) >= s.outsideFraction) return "clipped";
  const cx = (gl.rect[0] + gl.rect[2]) / 2;
  const cy = (gl.rect[1] + gl.rect[3]) / 2;
  if (gl.mode === 3 || gl.mode === 7 || gl.alpha < s.invisibleAlphaBelow) {
    // 画像と重なる見えない字は、文字認識の層として残す（濃い覆いの下のものは、P6 で先に消している）
    if (images.some((im) => inRect(im.box, cx, cy))) return null;
    return "invisible";
  }
  if (gl.height < s.tinyHeightBelowPt) return "tiny";
  if (Math.abs(gl.hScale) < s.squashedScaleBelow) return "squashed";
  if (a > 0) {
    for (const f of fills) {
      if (f.seq < gl.seq || !f.normal || f.alpha < s.coverAlphaMin || !f.rectangular || f.lum === null) continue;
      if (intersectionArea(gl.rect, f.box) / a < s.coveredFractionMin) continue;
      return "covered_light"; // 濃い覆いのものは、P6 で先に消している
    }
  }
  if (gl.lum === null) return null;
  let under: { seq: number; lum: number | null } = { seq: -1, lum: 1 };
  for (const f of fills) {
    if (f.seq > gl.seq || f.seq < under.seq || !f.normal || f.alpha < s.coverAlphaMin) continue;
    if (!inRect(f.box, cx, cy) || !inShapeEvenOdd(f.polys, cx, cy)) continue;
    under = { seq: f.seq, lum: f.lum };
  }
  for (const im of images) {
    if (im.seq > gl.seq || im.seq < under.seq || !inRect(im.box, cx, cy)) continue;
    under = { seq: im.seq, lum: null };
  }
  if (under.lum === null) return null;
  return Math.abs(gl.lum - under.lum) < s.sameColorDeltaBelow ? "same_color" : null;
}

/**
 * いくつかの覆いを合わせて、箱 r のどれだけが隠れるか（0〜1）。箱の中に 12 × 8 の点を置き、どれかの覆いに入る点の割合で測る。
 * 形のある覆いは、形の中の点だけを数える
 */
function unionCovered(covers: SanCover[], r: Rect): number {
  const nx = 12;
  const ny = 8;
  let inside = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = r[0] + ((i + 0.5) / nx) * (r[2] - r[0]);
      const y = r[1] + ((j + 0.5) / ny) * (r[3] - r[1]);
      if (covers.some((c) => inRect(c.rect, x, y) && (!c.shape || (c.shape.rule === "evenodd" ? inShapeEvenOdd(c.shape.parts, x, y) : inShapeNonzero(c.shape.parts, x, y))))) inside++;
    }
  }
  return inside / (nx * ny);
}

/** 点が形の中か（nonzero の決まり） */
function inShapeNonzero(polys: Point[][], x: number, y: number): boolean {
  let wn = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yj <= y) {
        if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) wn++;
      } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) wn--;
    }
  }
  return wn !== 0;
}

/** 見える描き方の字か（描き方 3・7 と、ほとんど透明な字は、ほかの決まりで見る） */
const drawnVisibly = (gl: Glyph, s: ContentSettings) => gl.mode !== 3 && gl.mode !== 7 && gl.alpha >= s.invisibleAlphaBelow && !gl.hidden;

/**
 * P7 の続き（0.7.0 から）。judgeP7 で決まらなかった字について：
 * - 白など明るい不透明な注釈の見た目（Square など）に、字の箱の半分以上が隠れた字（covered_light）
 * - 字のあとに描いた不透明な画像に、字の箱の半分以上が隠れた字（covered_image）。描き方 3・7 の字（文字認識の層）は残す
 * - 字のすぐ下が画像で、字の箱の下の画素がほぼ一色、その明るさが字の色と同じ字（same_color。字の色と地の色の差は P7 と同じ 0.1 未満）
 */
async function judgeP7More(ctx: PDFContext, w: Walker, fillIndex: RectIndex<{ rect: Rect; seq: number; f: Fill }>, s: ContentSettings, codec: ImageCodec | undefined) {
  const annLight = w.lightCovers.filter((c) => c.kind === "annotation");
  const opaqueImages = w.imageUses.filter((u) => u.opaque && area(u.box) > 0);
  const sameColor: Array<{ gl: Glyph; u: ImageUse }> = [];
  for (const gl of w.glyphs) {
    if (gl.remove || gl.isSpace || gl.inAnnot || gl.isCover) continue;
    const a = area(gl.rect);
    if (!(a > 0) || !Number.isFinite(a)) continue;
    if (annLight.some((c) => coveredFraction(c, gl.rect) >= s.coveredFractionMin)) {
      gl.remove = { pattern: "P7", reason: "covered_light" };
      continue;
    }
    if (!drawnVisibly(gl, s)) continue;
    if (opaqueImages.some((u) => u.seq > gl.seq && intersectionArea(gl.rect, u.box) / a >= s.coveredFractionMin)) {
      gl.remove = { pattern: "P7", reason: "covered_image" };
      continue;
    }
    if (gl.lum === null) continue;
    // 字の中心のすぐ下にあるもの：いちばんあとに描いた（字より前の）塗りと画像を比べる
    const cx = (gl.rect[0] + gl.rect[2]) / 2;
    const cy = (gl.rect[1] + gl.rect[3]) / 2;
    let fillSeq = -1;
    for (const { f } of fillIndex.query(gl.rect, (x, y) => x.seq - y.seq)) {
      if (f.seq > gl.seq || !f.normal || f.alpha < s.coverAlphaMin || !inRect(f.box, cx, cy) || !inShapeEvenOdd(f.polys, cx, cy)) continue;
      fillSeq = Math.max(fillSeq, f.seq);
    }
    let under: ImageUse | null = null;
    for (const u of w.imageUses) if (u.seq < gl.seq && u.seq > fillSeq && inRect(u.box, cx, cy) && (!under || u.seq > under.seq)) under = u;
    // 下の画像は、字より前に描いた画像のうち、いちばんあとのもの。透明の型などがある画像は、地の色が分からないので見ない
    if (under && under.opaque) sameColor.push({ gl, u: under });
  }
  if (!sameColor.length) return;
  const decoded = new Map<ImageUse, Awaited<ReturnType<typeof decodeLuma>>>();
  for (const { gl, u } of sameColor) {
    if (!decoded.has(u)) decoded.set(u, await decodeLuma(ctx, u.stream, dictOf(ctx, u.res?.get(PDFName.of("ColorSpace"))), codec, s.maxSamplePixels));
    const img = decoded.get(u);
    if (!img) continue;
    const st = sampleLuma(img, u.ctm, gl.rect);
    if (!st || st.max - st.min >= s.sameColorDeltaBelow) continue;
    if (Math.abs(gl.lum! - st.mean) < s.sameColorDeltaBelow) gl.remove = { pattern: "P7", reason: "same_color" };
  }
}

/**
 * 同じ所に違う字が重ねて描かれている所（0.7.0 から。どちらが見える字か決められないので、消さずに notDone にする）。
 * 2つの字の箱の重なりが、どちらの箱から見ても overdrawnOverlapMin 以上で、書体か字のコードが違うもの（同じ字の重ね描き＝太字の代わり、は数えない）
 */
function findOverdrawn(w: Walker, s: ContentSettings): { count: number; rect: Rect | null } {
  const shown = w.glyphs.filter((g) => !g.remove && !g.isSpace && !g.inAnnot && drawnVisibly(g, s) && area(g.rect) > 0 && Number.isFinite(area(g.rect)));
  const index = new RectIndex(shown);
  let count = 0;
  let rect: Rect | null = null;
  for (const a of shown) {
    const aa = area(a.rect);
    for (const b of index.query(a.rect, (x, y) => x.seq - y.seq)) {
      if (b.seq <= a.seq || (b.font === a.font && b.code === a.code)) continue;
      const ov = intersectionArea(a.rect, b.rect);
      if (ov / aa < s.overdrawnOverlapMin || ov / area(b.rect) < s.overdrawnOverlapMin) continue;
      count++;
      rect = rect ? union(rect, union(a.rect, b.rect)) : union(a.rect, b.rect);
      break;
    }
  }
  return { count, rect };
}

/**
 * 中身（data）と、その資源（res）のうち、中身から描かれない部品・画像の名前。外せないとき（資源を持たない Type3 の書体があるなど）は null。
 * 資源を持たない部品（この資源を使う部品）の中で描くものも、使っているとみなす
 */
function unusedXObjectNames(ctx: PDFContext, data: Uint8Array, res: PDFDict, s: ContentSettings): PDFName[] | null {
  const xo = dictOf(ctx, res.get(PDFName.of("XObject")));
  if (!xo || xo.entries().length === 0) return null;
  const fonts = dictOf(ctx, res.get(PDFName.of("Font")));
  if (fonts) for (const [, f] of fonts.entries()) {
    const fd = dictOf(ctx, f);
    if (fd && nameOf(ctx, fd.get(PDFName.of("Subtype"))) === "Type3" && !fd.has(PDFName.of("Resources"))) return null;
  }
  const used = new Set<string>();
  const seen = new Set<PDFObject>();
  const scan = (d: Uint8Array, depth: number) => {
    let n = 0;
    for (const { op, args } of operations(d)) {
      if (++n > s.maxOperationsPerPage) throw new TooManyOperations();
      if (op !== "Do" || args[0]?.t !== "name") continue;
      const name = args[0].v;
      used.add(name);
      const x = ctx.lookup(xo.get(PDFName.of(name)));
      if (x instanceof PDFStream && depth < s.maxFormDepth && !seen.has(x) && nameOf(ctx, x.dict.get(PDFName.of("Subtype"))) === "Form" && !x.dict.has(PDFName.of("Resources"))) {
        seen.add(x);
        try {
          scan(streamData(x), depth + 1);
        } catch (e) {
          if (e instanceof TooManyOperations) throw e;
        }
      }
    }
  };
  scan(data, 0);
  return xo.entries().map(([k]) => k).filter((k) => !used.has(k.decodeText()));
}

/** 資源の辞書を写し、名前を /XObject から外したものを返す（元の辞書は、ほかの所と共有かもしれないので変えない） */
function withoutXObjects(ctx: PDFContext, res: PDFDict, names: PDFName[]): PDFDict {
  const newRes = res.clone(ctx);
  const newXo = (dictOf(ctx, res.get(PDFName.of("XObject"))) as PDFDict).clone(ctx);
  for (const k of names) newXo.delete(k);
  newRes.set(PDFName.of("XObject"), newXo);
  return newRes;
}

/**
 * ページの資源（/XObject）のうち、ページの中身から描かれない部品・画像を外す（0.7.0 から。描かれない部品の中の字・画像が、取り出せてしまうため）。
 * ページから描く部品（自分の資源を持つもの）の資源も、その部品の中身から描かれない部品・画像を外す（0.8.0 から）。
 * 部品の中身はどこで描いても同じなので、部品の中で描かれない名前は、どこでも描かれない。部品の資源の辞書は写してから差し替える。
 * 字の書体に、資源を持たない Type3 の書体がある所は、書体の中で描くかもしれないので外さない。外した数を返す
 */
function removeUnusedXObjects(ctx: PDFContext, page: PDFPage, s: ContentSettings): number {
  const res = dictOf(ctx, page.node.get(PDFName.of("Resources"))) ?? page.node.Resources();
  if (!res) return 0;
  let count = 0;
  const pageUnused = unusedXObjectNames(ctx, contentData(ctx, page.node.get(PDFName.of("Contents"))), res, s);
  let pageRes = res;
  if (pageUnused?.length) {
    pageRes = withoutXObjects(ctx, res, pageUnused);
    page.node.set(PDFName.of("Resources"), pageRes);
    count += pageUnused.length;
  }
  // 描く部品の中の資源（部品の中の部品も、たどる）
  const seen = new Set<PDFStream>();
  const visit = (r: PDFDict, depth: number) => {
    const xo = dictOf(ctx, r.get(PDFName.of("XObject")));
    if (!xo || depth > s.maxFormDepth) return;
    for (const [, v] of xo.entries()) {
      const f = ctx.lookup(v);
      if (!(f instanceof PDFStream) || seen.has(f) || nameOf(ctx, f.dict.get(PDFName.of("Subtype"))) !== "Form") continue;
      seen.add(f);
      const fr = dictOf(ctx, f.dict.get(PDFName.of("Resources")));
      if (!fr) continue; // ページの資源を使う部品は、ページの側で数えた
      let data: Uint8Array;
      try {
        data = streamData(f);
      } catch {
        continue;
      }
      const names = unusedXObjectNames(ctx, data, fr, s);
      let next = fr;
      if (names?.length) {
        next = withoutXObjects(ctx, fr, names);
        f.dict.set(PDFName.of("Resources"), next);
        count += names.length;
      }
      visit(next, depth + 1);
    }
  };
  visit(pageRes, 0);
  return count;
}

/** 画像の箱のうち、見える所（v）の外の部分を、縦横の四角（最大 4 つ）で返す */
function outsideParts(box: Rect, v: Rect): Rect[] {
  const out: Rect[] = [
    [box[0], box[1], box[2], Math.min(box[3], v[1])],
    [box[0], Math.max(box[1], v[3]), box[2], box[3]],
    [box[0], Math.max(box[1], v[1]), Math.min(box[2], v[0]), Math.min(box[3], v[3])],
    [Math.max(box[0], v[2]), Math.max(box[1], v[1]), box[2], Math.min(box[3], v[3])],
  ];
  return out.filter((r) => r[2] - r[0] > 0 && r[3] - r[1] > 0);
}

// ---------------------------------------------------------------- 書き直す

/** 辞書にまだない名前（San1、San2…の空いている最初のもの）。前に片付けたファイルに左右されず、同じ入力から同じ出力になる */
function freshName(dict: PDFDict, prefix: string): PDFName {
  for (let k = 1; ; k++) {
    const n = PDFName.of(`${prefix}${k}`);
    if (!dict.has(n)) return n;
  }
}

/** 字を描く命令を、消す字を送りに置き換えた命令に書き直す */
function rewriteTextOp(op: Op, info: TextOp): Op[] {
  const out: Op[] = [];
  let strings: Array<{ k: number; tok: Tok }>;
  if (op.op === "TJ") {
    const arr = op.args[0]?.t === "arr" ? op.args[0].v : [];
    strings = arr.map((tok, k) => ({ k, tok }));
  } else if (op.op === '"') {
    strings = op.args[2] ? [{ k: 2, tok: op.args[2] }] : [];
    out.push({ op: "Tw", args: [op.args[0] ?? { t: "num", v: 0 }] });
    out.push({ op: "Tc", args: [op.args[1] ?? { t: "num", v: 0 }] });
    out.push({ op: "T*", args: [] });
  } else {
    strings = op.args[0] ? [{ k: 0, tok: op.args[0] }] : [];
    if (op.op === "'") out.push({ op: "T*", args: [] });
  }
  const arr: Tok[] = [];
  const pushNum = (v: number) => {
    const last = arr[arr.length - 1];
    if (last && last.t === "num") last.v += v;
    else arr.push({ t: "num", v });
  };
  const pushBytes = (b: number[]) => {
    if (b.length) arr.push({ t: "str", v: Uint8Array.from(b) });
  };
  for (const { k, tok } of strings) {
    if (tok.t === "num") {
      pushNum(tok.v);
      continue;
    }
    if (tok.t !== "str") continue;
    const slots = info.elems.get(k);
    if (!slots || !slots.some((sl) => sl.g.remove)) {
      arr.push(tok);
      continue;
    }
    if (slots.some((sl) => sl.bytes === null)) {
      // 字の区切りが分からない並びは、まるごと送りに置き換える（残す字も消える。消しすぎの側）
      for (const sl of slots) if (sl.adj !== null) pushNum(sl.adj);
      continue;
    }
    let keep: number[] = [];
    for (const sl of slots) {
      if (sl.g.remove) {
        pushBytes(keep);
        keep = [];
        if (sl.adj !== null) pushNum(sl.adj);
      } else keep.push(...sl.bytes!);
    }
    pushBytes(keep);
  }
  out.push({ op: "TJ", args: [{ t: "arr", v: arr }] });
  return out;
}

type Rewritten = { data: Uint8Array; res: PDFDict | undefined } | null;

/** 画像ごとの書き直し：塗った画像（新しい参照）か、描く命令を外す（"drop"。ページの外に置いた画像） */
type ImageEdits = Map<ImageUse, PDFRef | "drop">;

function needsRewrite(node: CNode, burned: ImageEdits, memo: Map<CNode, boolean>): boolean {
  const m = memo.get(node);
  if (m !== undefined) return m;
  let v = false;
  for (const t of node.textOps.values()) for (const slots of t.elems.values()) if (slots.some((sl) => sl.g.remove)) v = true;
  for (const u of node.images.values()) if (burned.has(u)) v = true;
  if (node.actualText.size) v = true;
  if (node.repaints?.size) v = true;
  for (const f of node.forms.values()) if (needsRewrite(f.node, burned, memo)) v = true;
  memo.set(node, v);
  return v;
}

/** 逆の行列（逆にできなければ null） */
function invertMatrix(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** 塗り直した模様の数（rewriteNode が数える。ページごとに 0 に戻す） */
const repainted = { count: 0 };

function rewriteNode(ctx: PDFContext, node: CNode, burned: ImageEdits, memo: Map<CNode, boolean>, blocked: CNode[], actual: { count: number }): Rewritten {
  if (!needsRewrite(node, burned, memo)) return null;
  if (node.hasInline) {
    blocked.push(node);
    return null;
  }
  const renames = new Map<number, PDFRef>();
  for (const [opNo, f] of node.forms) {
    const r = rewriteNode(ctx, f.node, burned, memo, blocked, actual);
    if (!r) continue;
    const ns = ctx.flateStream(r.data, {});
    for (const [k, v] of f.stream.dict.entries()) {
      const key = k.decodeText();
      if (key === "Filter" || key === "DecodeParms" || key === "DP" || key === "Length" || key === "Resources") continue;
      ns.dict.set(k, v);
    }
    if (r.res) ns.dict.set(PDFName.of("Resources"), r.res);
    renames.set(opNo, ctx.register(ns));
  }
  const drops = new Set<number>();
  for (const [opNo, u] of node.images) {
    const ref = burned.get(u);
    if (ref === "drop") drops.add(opNo);
    else if (ref) renames.set(opNo, ref);
  }

  let res = node.res;
  let xobjects: PDFDict | undefined;
  const repaints = node.repaints ?? new Map<number, { rect: Rect; ctm: Matrix; name: string }>();
  if (repaints.size && node.res) res = node.res.clone(ctx);
  if (renames.size || drops.size) {
    res = res && res !== node.res ? res : node.res ? node.res.clone(ctx) : ctx.obj({});
    const old = dictOf(ctx, res.get(PDFName.of("XObject")));
    xobjects = old ? old.clone(ctx) : ctx.obj({});
    res.set(PDFName.of("XObject"), xobjects);
  }
  const ops: Op[] = [];
  const replacedNames = new Set<string>();
  let i = -1;
  for (const o of operations(node.data)) {
    i++;
    if (drops.has(i)) {
      if (o.args[0]?.t === "name") replacedNames.add(o.args[0].v);
      continue;
    }
    const rp = repaints.get(i);
    const inv = rp ? invertMatrix(rp.ctm) : null;
    if (rp && inv) {
      // 模様の塗りをやめ（道は捨てる）、ページの座標で黒一色の四角を描く
      const nm = (v: number): Tok => ({ t: "num", v });
      ops.push({ op: "n", args: [] }, { op: "q", args: [] }, { op: "cm", args: inv.map(nm) }, { op: "g", args: [nm(0)] });
      ops.push({ op: "re", args: [nm(rp.rect[0]), nm(rp.rect[1]), nm(rp.rect[2] - rp.rect[0]), nm(rp.rect[3] - rp.rect[1])] }, { op: "f", args: [] }, { op: "Q", args: [] });
      repainted.count++;
      continue;
    }
    const rn = renames.get(i);
    if (rn && xobjects) {
      const name = freshName(xobjects, "San");
      xobjects.set(name, rn);
      if (o.args[0]?.t === "name") replacedNames.add(o.args[0].v);
      ops.push({ op: "Do", args: [{ t: "name", v: name.decodeText() }] });
      continue;
    }
    if (node.actualText.has(i) && o.args[1]?.t === "dict") {
      const m = new Map(o.args[1].v);
      m.delete("ActualText");
      actual.count++;
      ops.push({ op: o.op, args: [o.args[0]!, { t: "dict", v: m }] });
      continue;
    }
    const t = node.textOps.get(i);
    if (t && [...t.elems.values()].some((sl) => sl.some((x) => x.g.remove))) {
      ops.push(...rewriteTextOp(o, t));
      continue;
    }
    ops.push(o);
  }
  // 差し替えた元の部品・画像を、写したリソースから外す（残すと、描かれないのにファイルに残り、取り出せてしまう）。
  // 同じ名前を、書き換えなかった命令がまだ使っていれば残す。元のリソースの辞書（ほかのページと共有かもしれない）は変えない。
  if (xobjects && replacedNames.size) {
    const stillUsed = new Set(ops.filter((o) => o.op === "Do" && o.args[0]?.t === "name").map((o) => (o.args[0] as { v: string }).v));
    for (const n of replacedNames) if (!stillUsed.has(n)) xobjects.delete(PDFName.of(n));
  }
  // 塗り直した模様のうち、もう使わないものを、写したリソースから外す（中の字がファイルに残らないように）
  if (repaints.size && res && res !== node.res) {
    // 塗り直したあとの中身で、まだ模様で塗る命令（塗り・線・字・部品）があるものだけを「使っている」とする
    const used = new Set<string>();
    let fillPat: string | null = null;
    let strokePat: string | null = null;
    const stack: Array<[string | null, string | null]> = [];
    for (const o of ops) {
      const name = o.args.find((a) => a.t === "name");
      if (o.op === "scn") fillPat = name && name.t === "name" ? name.v : null;
      else if (o.op === "SCN") strokePat = name && name.t === "name" ? name.v : null;
      else if (["g", "rg", "k", "cs", "sc"].includes(o.op)) fillPat = null;
      else if (["G", "RG", "K", "CS", "SC"].includes(o.op)) strokePat = null;
      else if (o.op === "q") stack.push([fillPat, strokePat]);
      else if (o.op === "Q") [fillPat, strokePat] = stack.pop() ?? [null, null];
      else if (["f", "F", "f*", "B", "B*", "b", "b*", "Tj", "TJ", "'", '"', "Do"].includes(o.op)) {
        if (fillPat) used.add(fillPat);
        if (strokePat && o.op !== "f" && o.op !== "F" && o.op !== "f*") used.add(strokePat);
      } else if (o.op === "S" || o.op === "s") {
        if (strokePat) used.add(strokePat);
      }
    }
    const pats = dictOf(ctx, res.get(PDFName.of("Pattern")));
    if (pats) {
      const np = pats.clone(ctx);
      for (const r of repaints.values()) if (!used.has(r.name)) np.delete(PDFName.of(r.name));
      res.set(PDFName.of("Pattern"), np);
    }
  }
  return { data: serializeOps(ops), res };
}

// ---------------------------------------------------------------- 本体

/**
 * 覆い c で、画素の中心が必ず入るはずの画素のだいたいの数。塗れた画素が 0 なのにこれが 2 以上なら、塗り損ねとして片付けられなかった所にする。
 * 重なりの面積は、覆いの形で測る（形のある覆いの箱で測ると多めに出るため）。
 * 縦横に置いた画像では、重なりが縦横とも 1.5 画素以上あるときだけ数える（それより細い覆いは、画素の中心が入らないことがあるため）
 */
function expectedPixels(c: SanCover, u: ImageUse): number {
  const d = u.stream.dict;
  const W = d.lookup(PDFName.of("Width"));
  const H = d.lookup(PDFName.of("Height"));
  const w = W instanceof PDFNumber ? W.asNumber() : 0;
  const h = H instanceof PDFNumber ? H.asNumber() : 0;
  const det = Math.abs(u.ctm[0] * u.ctm[3] - u.ctm[1] * u.ctm[2]);
  if (!(w > 0 && h > 0) || !(det > 0)) return 0;
  const overlap = coveredFraction(c, u.box) * area(u.box);
  if (u.ctm[1] === 0 && u.ctm[2] === 0) {
    const ix = intersect(c.rect, u.box);
    const pxW = Math.abs(u.ctm[0]) / w;
    const pxH = Math.abs(u.ctm[3]) / h;
    if ((ix[2] - ix[0]) / pxW < 1.5 || (ix[3] - ix[1]) / pxH < 1.5) return 0;
  }
  // 1 画素の面積 ＝ 単位の正方形を ctm で写した平行四辺形の面積 ÷ 画素の数。傾いた画像では、箱のうち画像そのものの割合をかける
  return (overlap * Math.min(1, det / Math.max(area(u.box), 1e-9))) / (det / (w * h));
}

/** 画像を塗れなかったときの説明（画面にそのまま出す） */
function notBurnedLabel(reason: BurnFailure, light: boolean): string {
  const what = light ? "白い四角・注釈の下の画像" : "黒い四角の下の画像";
  if (reason === "too_large") return `${what}が大きすぎるため、塗りつぶせませんでした。画像の中身が残っています`;
  if (reason === "no_codec") return `${what}（JPEG・FAX 形式などの画像）を塗りつぶせませんでした。画像の中身が残っています`;
  if (reason === "unsupported_filter") return `${what}（JPEG 2000 などの形式）を塗りつぶせませんでした。画像の中身が残っています`;
  if (reason === "unsupported_color") return `${what}（読めない色の形式）を塗りつぶせませんでした。画像の中身が残っています`;
  return `${what}を読めなかったため、塗りつぶせませんでした。画像の中身が残っているかもしれません`;
}

export type PageOutcome = { removed: RemovedItem[]; notDone: NotDoneItem[]; redactAnnots: PDFObject[] };

const RECT_ROUND = (r: Rect): Rect => r.map((v) => Math.round(v * 100) / 100) as Rect;

/** 1ページを片付ける。書き換えたときは、ページの /Contents・/Resources を差し替える */
export async function sanitizePageContent(
  ctx: PDFContext, page: PDFPage, pageNo: number, visible: Visibility, s: ContentSettings, codec?: ImageCodec, trace?: (e: SanitizeTraceEvent) => void,
  userAreas: Rect[] = [],
): Promise<PageOutcome> {
  const removed: RemovedItem[] = [];
  const notDone: NotDoneItem[] = [];
  const mb = page.getMediaBox();
  const cb = page.getCropBox();
  const view = intersect([mb.x, mb.y, mb.x + mb.width, mb.y + mb.height], [cb.x, cb.y, cb.x + cb.width, cb.y + cb.height]);

  // 埋め込んだ画像（BI … EI）を、同じ見た目の画像の部品に移し替える（0.8.0 から。中身を書き直せるようにするため）
  convertPageInlineImages(ctx, page, (c) => contentData(ctx, c), streamData, s.maxOperationsPerPage, s.maxFormDepth);
  const root: CNode = {
    data: contentData(ctx, page.node.get(PDFName.of("Contents"))),
    res: dictOf(ctx, page.node.get(PDFName.of("Resources"))) ?? page.node.Resources(),
    hasInline: false, forms: new Map(), textOps: new Map(), images: new Map(), actualText: new Set(),
  };
  const w = new Walker(ctx, visible, s, pageNo);
  w.run(root, w.initial(IDENTITY), false, 0, new Set(), false);
  const { redactRects, redactAnnots, apTextRects, apNodes } = scanAnnotations(ctx, page, w, visible, s);
  // 利用者が選んだ場所（redact.ts）：ページのいちばん上に描いた濃い覆いとして入れる（下の字・画素を消し、最後に黒い四角を描く）
  const userCovers: SanCover[] = userAreas.map((rect) => ({ seq: ++w.seq, rect, kind: "user" }));
  w.covers.push(...userCovers);

  const bySeq = (a: { seq: number }, b: { seq: number }) => a.seq - b.seq;
  const coverIndex = new RectIndex(w.covers);
  for (const pf of w.patternFills) {
    if (pf.stroke || area(pf.rect) <= 0) continue;
    const picked = userCovers.some((c) => intersectionArea(c.rect, pf.rect) > 0);
    const hidden = coverIndex.query(pf.rect, bySeq).some((c) => c.seq > pf.seq && coveredFraction(c, pf.rect) >= s.coveredFractionMin);
    if (picked || hidden) (pf.node.repaints ??= new Map()).set(pf.op, { rect: pf.rect, ctm: pf.ctm, name: pf.name });
  }
  const fillIndex = new RectIndex(w.fills.map((f) => ({ rect: f.box, seq: f.seq, f })));
  // P6：字
  for (const gl of w.glyphs) {
    if (area(gl.rect) <= 0) continue;
    // 選んだ場所は、字の箱が少しでも掛かれば消す（字の一部だけを残す切り方はしない）
    const user = userCovers.find((c) => intersectionArea(gl.rect, c.rect) > 0);
    if (user) {
      gl.remove = { pattern: "P6", cover: user };
      continue;
    }
    const later: SanCover[] = [];
    for (const c of coverIndex.query(gl.rect, bySeq)) {
      if (c.seq <= gl.seq || intersectionArea(gl.rect, c.rect) <= 0) continue;
      // 黒い四角の字どうしは消さない（並べた黒い四角の帯が欠けて、見た目が変わるため）
      if (gl.isCover && c.kind === "glyph") continue;
      later.push(c);
      if (coveredFraction(c, gl.rect) >= s.coveredFractionMin) {
        gl.remove = { pattern: "P6", cover: c };
        break;
      }
    }
    // 隣り合う覆いにまたがる字（どの覆いも 1 つでは半分に届かない）：あとの覆いを合わせて隠れた割合を測る（0.8.0 から）
    if (!gl.remove && later.length >= 2 && unionCovered(later, gl.rect) >= s.coveredFractionMin) gl.remove = { pattern: "P6", cover: later[0]! };
  }
  // P7（塗りは、字の箱に重なりうるものだけを、描いた順に渡す。地の色は字の中心で見るので、これで足りる）
  for (const gl of w.glyphs) {
    if (gl.remove || gl.inAnnot) continue;
    if (gl.isCover) {
      if (gl.coverRect && !gl.inAnnot && Math.abs(gl.hScale) < s.squashedScaleBelow) gl.remove = { pattern: "P7", reason: "squashed" };
      continue;
    }
    const near = Number.isFinite(area(gl.rect)) ? fillIndex.query(gl.rect, bySeq).map((x) => x.f) : w.fills;
    const r = judgeP7(gl, view, near, w.images, s);
    if (r) gl.remove = { pattern: "P7", reason: r };
  }
  // P7（0.7.0 から）：白い不透明な注釈・あとから重ねた不透明な画像で隠した字、画像と同じ色の字
  await judgeP7More(ctx, w, fillIndex, s, codec);
  if (trace) {
    trace({
      type: "page", page: pageNo, operations: w.ops, images: w.imageUses.length, inlineImages: w.inlineImages.length,
      darkCovers: w.covers.length, lightCovers: w.lightCovers.length, lightSkipped: w.lightSkipped.length, fillLog: w.fillLog.length,
    });
    for (const u of w.imageUses) {
      const d = u.stream.dict;
      const num = (k: string) => { const v = d.lookup(PDFName.of(k)); return v instanceof PDFNumber ? v.asNumber() : null; };
      const filter = d.lookup(PDFName.of("Filter"));
      trace({
        type: "image", page: pageNo, seq: u.seq, box: RECT_ROUND(u.box), ctm: u.ctm.map((v) => Math.round(v * 1000) / 1000),
        width: num("Width"), height: num("Height"), bpc: num("BitsPerComponent"),
        filter: filter instanceof PDFName ? filter.decodeText() : filter instanceof PDFArray ? filter.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : "?")).join(",") : null,
        inForm: u.node !== root,
      });
    }
    for (const e of w.fillLog) trace({ type: "fill", page: pageNo, ...e, rect: RECT_ROUND(e.rect), overImages: w.imageUses.filter((u) => u.seq < e.seq && intersectionArea(e.rect, u.box) > 0).map((u) => u.seq) });
  }
  // P6：画像の画素（黒い覆いと、白などの明るい覆い）
  const burned: ImageEdits = new Map();
  const burnedReport: Array<{ rect: Rect; pixels: number; tone: "dark" | "light"; user: boolean; hidden: boolean }> = [];
  let droppedImages = 0;
  const lightIndex = new RectIndex(w.lightCovers);
  const limits: BurnLimits = { maxBytes: s.maxImageBytes, maxPixels: s.maxImagePixels, jpegQuality: s.jpegQuality, ...(codec ? { codec } : {}) };
  for (const u of w.imageUses) {
    // P7（0.7.0 から）：見える所（ページと、描いたときの切り抜きの重なり）に全く掛からない画像は、描く命令を外す。
    // 見える所が画像の箱の半分未満なら、隠れた所の画素を白く塗る（見た目は変わらない）
    const boxA = area(u.box);
    const vis = intersect(intersect(view, u.clip), u.box);
    const visA = vis[2] > vis[0] && vis[3] > vis[1] ? area(vis) : 0;
    const measurable = boxA > 0 && Number.isFinite(boxA);
    if (measurable && visA === 0) {
      burned.set(u, "drop");
      droppedImages++;
      continue;
    }
    const hiddenCovers: SanCover[] = measurable && visA / boxA < s.hiddenImageVisibleBelow
      ? outsideParts(u.box, vis).map((rect) => ({ seq: ++w.seq, rect, kind: "hidden" as const, tone: "light" as const }))
      : [];
    const after = (c: SanCover) => c.seq > u.seq && intersectionArea(c.rect, u.box) > 0;
    const over = [...coverIndex.query(u.box, bySeq).filter(after), ...lightIndex.query(u.box, bySeq).filter(after), ...hiddenCovers].sort(bySeq);
    if (!over.length) continue;
    const r = await burnImage(ctx, u.stream, dictOf(ctx, u.res?.get(PDFName.of("ColorSpace"))), u.ctm, over, limits);
    const expected = over.map((c) => expectedPixels(c, u));
    trace?.({
      type: "burn", page: pageNo, imageSeq: u.seq, ok: r.ok, ...(r.ok ? { via: r.via, pixels: r.pixels } : { reason: r.reason }),
      covers: over.map((c, k) => ({ seq: c.seq, tone: c.tone ?? "dark", kind: c.kind, rect: RECT_ROUND(c.rect), painted: r.ok ? (r.perCover[k] ?? 0) : 0, reached: r.ok ? (r.reached[k] ?? false) : false, expected: Math.round(expected[k]!) })),
    });
    if (r.ok) {
      // 安全網：画素の中心が入るはずの覆いで、1 画素も塗れなかったら、黙って残さず片付けられなかった所にする
      over.forEach((c, k) => {
        // 上に重なったあとの覆いの色で塗られた画素も「届いた」と数える（reached）。どの画素にも届かなかったときだけ出す
        if (!r.reached[k] && expected[k]! >= 2) {
          notDone.push({
            pattern: c.kind === "hidden" ? "P7" : "P6", reason: "unsupported_image", page: pageNo, rect: RECT_ROUND(intersect(c.rect, u.box)),
            label: `${c.kind === "hidden" ? "ページの外・切り抜きの外に隠れた画像の部分" : c.tone === "light" ? "白い四角・注釈の下の画像" : "黒い四角の下の画像"}を塗りつぶせませんでした（画像の置き方を読み取れませんでした）。画像の中身が残っているかもしれません`,
          });
        }
      });
    }
    if (!r.ok) {
      // 塗れない：覆いごとに「片付けられなかった所」にする（注釈は外さない。画面で「全部消えた」と言わせない）
      const reason: NotDoneReason = r.reason === "too_large" ? "image_too_large" : "unsupported_image";
      for (const c of over) {
        const hidden = c.kind === "hidden";
        notDone.push({
          pattern: hidden ? "P7" : "P6", reason, page: pageNo, rect: RECT_ROUND(intersect(c.rect, u.box)),
          label: hidden ? "ページの外・切り抜きの外に隠れた画像の部分を、塗りつぶせませんでした。隠れた所の中身が残っています" : notBurnedLabel(r.reason, c.tone === "light"),
        });
      }
      continue;
    }
    if (r.pixels === 0) continue;
    // 選んだ場所の下の画像に透明の型（/SMask）があれば、その所を不透明にする（型そのものに、字や署名の形が残るため）
    const userOver = over.filter((c) => c.kind === "user");
    if (userOver.length) {
      const sm = r.stream.dict.get(PDFName.of("SMask"));
      const smask = sm instanceof PDFRef ? ctx.lookup(sm) : sm;
      if (smask instanceof PDFStream) {
        const m = await burnImage(ctx, smask, undefined, u.ctm, userOver.map((c) => ({ ...c, tone: "light" as const })), limits);
        if (m.ok && m.pixels > 0) r.stream.dict.set(PDFName.of("SMask"), ctx.register(m.stream));
        else if (!m.ok) {
          for (const c of userOver) {
            notDone.push({
              pattern: "P6", reason: "unsupported_image", page: pageNo, rect: RECT_ROUND(intersect(c.rect, u.box)),
              label: "選んだ所の画像の透明の型（形の情報）を塗りつぶせませんでした。形が残っているかもしれません",
            });
          }
        }
      }
    }
    burned.set(u, ctx.register(r.stream));
    // 報告の箱は、覆いごとに「覆いの箱と画像の箱の重なり」（ページの座標）。画面で、塗った所に枠を描けるようにする。
    // 覆いが複数あるときに全部を1つの箱にまとめると、画像全体の箱に近くなり、塗っていない所まで枠に入るため
    over.forEach((c, k) => {
      const n = r.perCover[k] ?? 0;
      if (n > 0) burnedReport.push({ rect: RECT_ROUND(intersect(c.rect, u.box)), pixels: n, tone: c.tone === "light" ? "light" : "dark", user: c.kind === "user", hidden: c.kind === "hidden" });
    });
  }
  // 画像の上の明るい不透明な塗りのうち、覆いにしなかったもの：塗らないが、黙って残さない（片付けられなかった所にする）
  for (const c of w.lightSkipped) {
    const under = [...w.imageUses, ...w.inlineImages].filter((u) => u.seq < c.seq && intersectionArea(c.rect, u.box) > 0);
    if (!under.length) continue;
    notDone.push({
      pattern: "P6", reason: "uncertain_cover", page: pageNo, rect: RECT_ROUND(under.map((u) => intersect(c.rect, u.box)).reduce(union)),
      label: c.why === "blend"
        ? "画像の上の白い四角が特別な重ね方（乗算など）で描かれているため、下の画像を塗りませんでした。下の画像の中身が残っています。見えている内容を確かめてください"
        : c.why === "transparent"
          ? "画像の上の白い四角が半透明のため、下の画像を塗りませんでした（塗ると見た目が変わるため）。下の画像の中身が残っています。見えている内容を確かめてください"
          : c.why === "unreadable"
            ? "画像の上の注釈の見た目を読めなかったため、下の画像を塗りませんでした。下の画像の中身が残っているかもしれません"
            : "表示しないレイヤーの中の白い四角の下の画像は、塗りませんでした（塗ると見た目が変わるため）。下の画像の中身が残っています",
    });
  }
  for (const im of w.inlineImages) {
    const after = (c: SanCover) => c.seq > im.seq && intersectionArea(c.rect, im.box) > 0;
    const over = [...w.covers.filter(after), ...w.lightCovers.filter(after)];
    if (!over.length) continue;
    const light = over.every((c) => c.tone === "light");
    notDone.push({
      pattern: "P6", reason: "inline_image", page: pageNo, rect: RECT_ROUND(over.map((c) => intersect(c.rect, im.box)).reduce(union)),
      label: light ? "白い四角・注釈の下の画像（ページに直接埋め込んだ形）を塗りつぶせませんでした" : "黒い四角の下の画像（ページに直接埋め込んだ形）を塗りつぶせませんでした",
    });
  }

  // 書き直す
  repainted.count = 0;
  const memo = new Map<CNode, boolean>();
  const blocked: CNode[] = [];
  const actual = { count: 0 };
  const r = rewriteNode(ctx, root, burned, memo, blocked, actual);
  const blockedSet = new Set(blocked);
  const isBlocked = (node: CNode) => blockedSet.has(node);
  if (r) {
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(r.data, {})));
    if (r.res) page.node.set(PDFName.of("Resources"), r.res);
  }
  // 注釈の見た目のうち、消す字のあるものを書き直す（新しいストリームにし、注釈の /AP を差し替える。0.8.0 から）
  for (const a of apNodes) {
    const ar = rewriteNode(ctx, a.node, burned, memo, blocked, actual);
    if (!ar) continue;
    const ns = ctx.flateStream(ar.data, {});
    for (const [k, v] of a.stream.dict.entries()) {
      const key = k.decodeText();
      if (key === "Filter" || key === "DecodeParms" || key === "DP" || key === "Length" || key === "Resources") continue;
      ns.dict.set(k, v);
    }
    if (ar.res) ns.dict.set(PDFName.of("Resources"), ar.res);
    setAppearance(ctx, a.annot, a.stream, ctx.register(ns));
  }

  // 消した字の一覧（書き換えられなかった中身の字は、片付けられなかった所に入れる）
  const p6 = new Map<SanCover, { chars: number }>();
  const p7 = new Map<string, { reason: P7Reason; rect: Rect; chars: number }>();
  /** 字を消して、黒い四角に描き直す覆いの字の箱 */
  const redrawn: Rect[] = [];
  let blockedChars = 0;
  for (const gl of w.glyphs) {
    if (!gl.remove) continue;
    if (isBlocked(gl.node)) {
      if (!gl.isSpace) blockedChars++;
      gl.remove = null;
      continue;
    }
    if (gl.isSpace) continue;
    if (gl.isCover && gl.coverRect && gl.remove.pattern === "P7") {
      redrawn.push(gl.coverRect);
      continue;
    }
    if (gl.remove.pattern === "P6") {
      const e = p6.get(gl.remove.cover) ?? { chars: 0 };
      e.chars++;
      p6.set(gl.remove.cover, e);
    } else {
      const key = `${gl.remove.reason}`;
      const e = p7.get(key);
      if (e) {
        e.chars++;
        e.rect = union(e.rect, gl.rect);
      } else p7.set(key, { reason: gl.remove.reason, rect: gl.rect, chars: 1 });
    }
  }
  if (blockedChars > 0) {
    notDone.push({
      pattern: "P6", reason: "inline_image", page: pageNo,
      label: `ページに直接埋め込んだ画像があるため、隠れた字 ${blockedChars} 字を消せませんでした`,
    });
  }
  for (const [c, e] of p6) {
    if (c.kind === "user") {
      removed.push({ pattern: "P6", kind: "redacted_text", page: pageNo, rect: RECT_ROUND(c.rect), count: e.chars, label: `選んだ所の字（${e.chars} 字）を消しました` });
      continue;
    }
    removed.push({ pattern: "P6", kind: "covered_text", page: pageNo, rect: RECT_ROUND(c.rect), count: e.chars, label: `黒い四角の下に残っていた字（${e.chars} 字）` });
  }
  for (const b of burnedReport) {
    if (b.hidden) {
      removed.push({ pattern: "P7", kind: "hidden_image", page: pageNo, rect: b.rect, count: b.pixels, label: `ページの外・切り抜きの外に隠れていた画像の部分（${b.pixels} 画素を白く塗りました。見た目は変わりません）` });
      continue;
    }
    if (b.user) {
      removed.push({ pattern: "P6", kind: "redacted_pixels", page: pageNo, rect: b.rect, count: b.pixels, label: `選んだ所の画像の中身（${b.pixels} 画素を黒く塗りました）` });
      continue;
    }
    removed.push({
      pattern: "P6", kind: "covered_pixels", page: pageNo, rect: b.rect, count: b.pixels,
      label: b.tone === "light" ? `白い四角の下に残っていた画像の中身（${b.pixels} 画素を白く塗りました）` : `黒い四角の下に残っていた画像の中身（${b.pixels} 画素を黒く塗りました）`,
    });
  }
  for (const e of p7.values()) {
    removed.push({ pattern: "P7", kind: "hidden_text", reason: e.reason, page: pageNo, rect: RECT_ROUND(e.rect), count: e.chars, label: `${P7_LABEL[e.reason]}（${e.chars} 字）` });
  }
  for (const rr of redactRects) {
    removed.push({ pattern: "P6", kind: "redaction_applied", page: pageNo, rect: RECT_ROUND(rr), count: 1, label: "まだ適用されていなかった墨消しを適用し、黒い四角を描き込みました" });
  }
  if (actual.count) {
    removed.push({ pattern: "P7", kind: "actual_text", page: pageNo, count: actual.count, label: `字の読み替え（/ActualText）を ${actual.count} か所消しました（コピー・検索で、見た目と違う字が取れないように）` });
  }
  if (blocked.some((n) => n.actualText.size)) {
    notDone.push({ pattern: "P7", reason: "inline_image", page: pageNo, label: "ページに直接埋め込んだ画像があるため、ページの中に書かれた字の読み替え（/ActualText）を消せませんでした" });
  }
  if (repainted.count) {
    removed.push({ pattern: "P6", kind: "pattern_repainted", page: pageNo, count: repainted.count, label: `模様で塗った覆い（${repainted.count} か所）を、黒一色で塗り直しました（模様の中の字を消すため。覆いの見た目が一色になります）` });
  }
  if (droppedImages) {
    removed.push({ pattern: "P7", kind: "hidden_image", page: pageNo, count: droppedImages, label: `ページの外・切り抜きの外に置いて見えない画像（${droppedImages} か所）を、描かないようにしました` });
  }
  // P5（0.7.0 から）：資源にあるが描かれない部品・画像
  const unused = removeUnusedXObjects(ctx, page, s);
  if (unused) {
    removed.push({ pattern: "P5", kind: "unused_xobject", page: pageNo, count: unused, label: `ページの資源にあるが描かれない部品・画像（${unused} 個）を外しました（中の字・画像を取り出せないように）` });
  }
  // P7（0.7.0 から）：違う字の重ね描きは、どちらが見える字か決められないので、消さずに知らせる
  const over = findOverdrawn(w, s);
  if (over.count && over.rect) {
    notDone.push({
      pattern: "P7", reason: "overdrawn_text", page: pageNo, rect: RECT_ROUND(over.rect),
      label: `同じ所に違う字が重ねて描かれています（${over.count} か所）。どちらが見える字か決められないため、消していません。見えている内容を確かめてください`,
    });
  }
  // P8（0.7.0 から）：注釈の見た目の中だけにある字は、ページに見えている字なので消さずに知らせる
  if (apTextRects.length) {
    notDone.push({
      pattern: "P8", reason: "annotation_text", page: pageNo, rect: RECT_ROUND(apTextRects.reduce(union)),
      label: `注釈（スタンプなど ${apTextRects.length} 個）の見た目の中に字があります。ページに見えている字なので消していません。見えている字を確かめてください`,
    });
  }
  if (redrawn.length) {
    removed.push({
      pattern: "P7", kind: "glyph_cover_box", page: pageNo, rect: RECT_ROUND(redrawn.reduce(union)), count: redrawn.length,
      label: `横につぶして並べた黒い四角の形の字（${redrawn.length} 字）を、同じ所の黒い四角に描き直しました（見た目は変わりません）`,
    });
  }
  const boxes = [...redactRects, ...userAreas, ...redrawn];
  if (boxes.length) applyRedactionBoxes(ctx, page, boxes);
  return { removed, notDone, redactAnnots };
}

/** 読み直しの確かめ（redact-check.ts）に使う、ページの字の箱と画像。片付けと同じ読み方で、片付けた PDF を最初から読む */
export type PageForCheck = {
  glyphs: Array<{ rect: Rect; isSpace: boolean }>;
  images: Array<{ box: Rect; ctm: Matrix; stream: PDFStream; res: PDFDict | undefined }>;
  inlineImages: Rect[];
  /** 字の入った模様で塗った所（0.8.0 から） */
  patternText: Rect[];
};

export function readPageForCheck(ctx: PDFContext, page: PDFPage, visible: Visibility, s: ContentSettings): PageForCheck {
  const root: CNode = {
    data: contentData(ctx, page.node.get(PDFName.of("Contents"))),
    res: dictOf(ctx, page.node.get(PDFName.of("Resources"))) ?? page.node.Resources(),
    hasInline: false, forms: new Map(), textOps: new Map(), images: new Map(), actualText: new Set(),
  };
  const w = new Walker(ctx, visible, s, 0);
  w.run(root, w.initial(IDENTITY), false, 0, new Set(), false);
  return {
    glyphs: w.glyphs.map((g) => ({ rect: g.rect, isSpace: g.isSpace })),
    images: w.imageUses.map((u) => ({ box: u.box, ctm: u.ctm, stream: u.stream, res: u.res })),
    inlineImages: w.inlineImages.map((i) => i.box),
    patternText: w.patternFills.map((f) => f.rect),
  };
}

/** 墨消しの箱を、ページの中身の最後に黒い四角として描き込む（元の中身は q … Q で包み、行列などの影響を切る） */
function applyRedactionBoxes(ctx: PDFContext, page: PDFPage, rects: Rect[]) {
  const data = contentData(ctx, page.node.get(PDFName.of("Contents")));
  const fmt = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const boxes = rects.map((r) => `${fmt(r[0])} ${fmt(r[1])} ${fmt(r[2] - r[0])} ${fmt(r[3] - r[1])} re`).join("\n");
  const head = new TextEncoder().encode("q\n");
  const tail = new TextEncoder().encode(`\nQ\nq\n0 g\n${boxes}\nf\nQ\n`);
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head, 0);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(out, {})));
}

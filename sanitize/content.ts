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
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
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
import { burnImage } from "./images.ts";
import { serializeOps } from "./serialize.ts";
import type { NotDoneItem, RemovedItem } from "./types.ts";

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
  maxImageBytes: 64 * 1024 * 1024,
  maxOperationsPerPage: 3_000_000,
  maxFormDepth: 12,
  // P7（rules/p7-hidden の値と同じ）
  outsideFraction: 0.5,
  invisibleAlphaBelow: 0.1,
  tinyHeightBelowPt: 1.0,
  sameColorDeltaBelow: 0.1,
  coverAlphaMin: 0.9,
  rectangularFillMin: 0.9,
};
export type ContentSettings = typeof SETTINGS;

export class TooManyOperations extends Error {}

type P7Reason = "hidden_layer" | "off_page" | "clipped" | "invisible" | "tiny" | "same_color" | "covered_light";

const P7_LABEL: Record<P7Reason, string> = {
  hidden_layer: "表示しないレイヤーの中の字",
  off_page: "ページの外に置いた字",
  clipped: "切り抜きの外にある字",
  invisible: "見えない描き方・透明な字",
  tiny: "小さすぎて読めない字",
  same_color: "地と同じ色の字",
  covered_light: "白などの不透明な四角で隠した字",
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
  page: number;
  remove: null | { pattern: "P6"; cover: SanCover } | { pattern: "P7"; reason: P7Reason };
  node: CNode;
  op: number;
};

type Fill = { seq: number; box: Rect; polys: Point[][]; lum: number | null; alpha: number; normal: boolean; rectangular: boolean };
type ImageUse = { seq: number; box: Rect; ctm: Matrix; stream: PDFStream; res: PDFDict | undefined; node: CNode; op: number };

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
  lw: number;
  font: FontInfo | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  mode: number;
};

const INF_RECT: Rect = [-Infinity, -Infinity, Infinity, Infinity];

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

// ---------------------------------------------------------------- 読む

class Walker {
  seq = 0;
  ops = 0;
  readonly glyphs: Glyph[] = [];
  readonly covers: SanCover[] = [];
  readonly fills: Fill[] = [];
  readonly images: Array<{ seq: number; box: Rect }> = [];
  readonly imageUses: ImageUse[] = [];
  readonly inlineImages: Array<{ seq: number; box: Rect }> = [];
  private readonly fontCache = new Map<PDFObject, FontInfo>();
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

  initial(ctm: Matrix): GState {
    return {
      ctm, clip: INF_RECT, fillN: 1, strokeN: 1, fill: 0, stroke: 0, ca: 1, CA: 1, normal: true, lw: 1,
      font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, mode: 0,
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
      const textOp = annotation ? null : (node.textOps.get(opIndex) ?? node.textOps.set(opIndex, { elems: new Map() }).get(opIndex)!);
      const slots: GlyphSlot[] = [];
      glyphs.forEach((gl, k) => {
        const seq = ++this.seq;
        const trm = multiply([g.size * g.th, 0, 0, g.size, 0, g.rise], multiply(tm, g.ctm));
        const ws = gl.isWordSpace ? g.tw : 0;
        const adv = (gl.width * g.size + g.tc + ws) * g.th;
        if (!annotation && isFiniteMatrix(trm)) {
          const corners: Point[] = [apply(trm, 0, f.descent), apply(trm, gl.width, f.descent), apply(trm, 0, f.ascent), apply(trm, gl.width, f.ascent)];
          const [bx, by] = apply(trm, 0, f.descent);
          const [tx, ty] = apply(trm, 0, f.ascent);
          const strokeMode = g.mode === 1 || g.mode === 5;
          const glyph: Glyph = {
            seq, rect: boundsOf(corners), height: Math.hypot(tx - bx, ty - by), isSpace: gl.isSpace,
            hidden: isHidden(), clip: g.clip, mode: g.mode, alpha: strokeMode ? g.CA : g.ca, lum: strokeMode ? g.stroke : g.fill,
            page: this.pageNo, remove: null, node, op: opIndex,
          };
          this.glyphs.push(glyph);
          slots.push({
            g: glyph,
            bytes: sliceable ? bytes.subarray(k * width, (k + 1) * width) : null,
            adj: g.size !== 0 ? (-(gl.width * g.size + g.tc + ws) * 1000) / g.size : null,
          });
        }
        tm = multiply([1, 0, 0, 1, adv, 0], tm);
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
            }
          }
          break;
        }
        case "g": g.fillN = 1; g.fill = luminanceOf(a, 1); break;
        case "G": g.strokeN = 1; g.stroke = luminanceOf(a, 1); break;
        case "rg": g.fillN = 3; g.fill = luminanceOf(a, 3); break;
        case "RG": g.strokeN = 3; g.stroke = luminanceOf(a, 3); break;
        case "k": g.fillN = 4; g.fill = luminanceOf(a, 4); break;
        case "K": g.strokeN = 4; g.stroke = luminanceOf(a, 4); break;
        case "cs":
        case "CS": {
          const n = componentsOf(ctx, res, args[0]?.t === "name" ? args[0].v : "");
          const init = n === 4 ? [0, 0, 0, 1] : new Array(n).fill(0);
          if (op === "cs") { g.fillN = n; g.fill = luminanceOf(init, n); }
          else { g.strokeN = n; g.stroke = luminanceOf(init, n); }
          break;
        }
        case "sc":
        case "scn":
          g.fill = args.some((x) => x.t === "name") ? null : luminanceOf(a, g.fillN);
          break;
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
              fi = readFont(ctx, ref);
              this.fontCache.set(ref, fi);
            }
            g.font = fi;
          } else g.font = null;
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
            else if (el.t === "num") tm = multiply([1, 0, 0, 1, (-el.v / 1000) * g.size * g.th, 0], tm);
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
              const use: ImageUse = { seq, box, ctm: g.ctm, stream: xo, res, node, op: opIndex };
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
            if (!annotation) node.forms.set(opIndex, { node: child, stream: xo });
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
function scanAnnotations(ctx: PDFContext, page: PDFPage, w: Walker, visible: Visibility, s: ContentSettings): { redactRects: Rect[]; redactAnnots: PDFObject[] } {
  const redactRects: Rect[] = [];
  const redactAnnots: PDFObject[] = [];
  const annots = ctx.lookup(page.node.get(PDFName.of("Annots")));
  if (!(annots instanceof PDFArray)) return { redactRects, redactAnnots };
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
    const ca = annot.lookup(PDFName.of("CA"));
    if (ca instanceof PDFNumber && ca.asNumber() < s.opacityMin) continue;
    const ap = appearance(ctx, annot);
    if (ap) {
      const m = appearanceMatrix(ctx, ap, rect);
      if (!m) continue;
      let data: Uint8Array;
      try {
        data = streamData(ap);
      } catch {
        continue;
      }
      const node: CNode = { data, res: dictOf(ctx, ap.dict.get(PDFName.of("Resources"))), hasInline: false, forms: new Map(), textOps: new Map(), images: new Map(), actualText: new Set() };
      try {
        w.run(node, w.initial(m), false, 0, new Set(), true);
      } catch (e) {
        if (e instanceof TooManyOperations) throw e;
      }
      continue;
    }
    if (subtype === "Square") {
      const ic = numsOf(ctx, annot.get(PDFName.of("IC")));
      const lum = ic && ic.length > 0 ? luminanceOf(ic, ic.length) : null;
      if (lum !== null && lum <= s.darkLuminanceMax) w.covers.push({ seq: ++w.seq, rect, kind: "annotation" });
    }
  }
  void visible;
  return { redactRects, redactAnnots };
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

function needsRewrite(node: CNode, burned: Map<ImageUse, PDFRef>, memo: Map<CNode, boolean>): boolean {
  const m = memo.get(node);
  if (m !== undefined) return m;
  let v = false;
  for (const t of node.textOps.values()) for (const slots of t.elems.values()) if (slots.some((sl) => sl.g.remove)) v = true;
  for (const u of node.images.values()) if (burned.has(u)) v = true;
  if (node.actualText.size) v = true;
  for (const f of node.forms.values()) if (needsRewrite(f.node, burned, memo)) v = true;
  memo.set(node, v);
  return v;
}

function rewriteNode(ctx: PDFContext, node: CNode, burned: Map<ImageUse, PDFRef>, memo: Map<CNode, boolean>, blocked: CNode[], actual: { count: number }): Rewritten {
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
  for (const [opNo, u] of node.images) {
    const ref = burned.get(u);
    if (ref) renames.set(opNo, ref);
  }

  let res = node.res;
  let xobjects: PDFDict | undefined;
  if (renames.size) {
    res = node.res ? node.res.clone(ctx) : ctx.obj({});
    const old = dictOf(ctx, res.get(PDFName.of("XObject")));
    xobjects = old ? old.clone(ctx) : ctx.obj({});
    res.set(PDFName.of("XObject"), xobjects);
  }
  const ops: Op[] = [];
  const replacedNames = new Set<string>();
  let i = -1;
  for (const o of operations(node.data)) {
    i++;
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
  return { data: serializeOps(ops), res };
}

// ---------------------------------------------------------------- 本体

export type PageOutcome = { removed: RemovedItem[]; notDone: NotDoneItem[]; redactAnnots: PDFObject[] };

const RECT_ROUND = (r: Rect): Rect => r.map((v) => Math.round(v * 100) / 100) as Rect;

/** 1ページを片付ける。書き換えたときは、ページの /Contents・/Resources を差し替える */
export function sanitizePageContent(ctx: PDFContext, page: PDFPage, pageNo: number, visible: Visibility, s: ContentSettings): PageOutcome {
  const removed: RemovedItem[] = [];
  const notDone: NotDoneItem[] = [];
  const mb = page.getMediaBox();
  const cb = page.getCropBox();
  const view = intersect([mb.x, mb.y, mb.x + mb.width, mb.y + mb.height], [cb.x, cb.y, cb.x + cb.width, cb.y + cb.height]);

  const root: CNode = {
    data: contentData(ctx, page.node.get(PDFName.of("Contents"))),
    res: dictOf(ctx, page.node.get(PDFName.of("Resources"))) ?? page.node.Resources(),
    hasInline: false, forms: new Map(), textOps: new Map(), images: new Map(), actualText: new Set(),
  };
  const w = new Walker(ctx, visible, s, pageNo);
  w.run(root, w.initial(IDENTITY), false, 0, new Set(), false);
  const { redactRects, redactAnnots } = scanAnnotations(ctx, page, w, visible, s);

  const bySeq = (a: { seq: number }, b: { seq: number }) => a.seq - b.seq;
  const coverIndex = new RectIndex(w.covers);
  const fillIndex = new RectIndex(w.fills.map((f) => ({ rect: f.box, seq: f.seq, f })));
  // P6：字
  for (const gl of w.glyphs) {
    if (area(gl.rect) <= 0) continue;
    for (const c of coverIndex.query(gl.rect, bySeq)) {
      if (c.seq <= gl.seq || intersectionArea(gl.rect, c.rect) <= 0) continue;
      if (coveredFraction(c, gl.rect) >= s.coveredFractionMin) {
        gl.remove = { pattern: "P6", cover: c };
        break;
      }
    }
  }
  // P7（塗りは、字の箱に重なりうるものだけを、描いた順に渡す。地の色は字の中心で見るので、これで足りる）
  for (const gl of w.glyphs) {
    if (gl.remove) continue;
    const near = Number.isFinite(area(gl.rect)) ? fillIndex.query(gl.rect, bySeq).map((x) => x.f) : w.fills;
    const r = judgeP7(gl, view, near, w.images, s);
    if (r) gl.remove = { pattern: "P7", reason: r };
  }
  // P6：画像の画素
  const burned = new Map<ImageUse, PDFRef>();
  const burnedReport: Array<{ rect: Rect; pixels: number }> = [];
  for (const u of w.imageUses) {
    const over = coverIndex.query(u.box, bySeq).filter((c) => c.seq > u.seq && intersectionArea(c.rect, u.box) > 0);
    if (!over.length) continue;
    const r = burnImage(ctx, u.stream, dictOf(ctx, u.res?.get(PDFName.of("ColorSpace"))), u.ctm, over, s.maxImageBytes);
    const rect = over.map((c) => intersect(c.rect, u.box)).reduce(union);
    if (!r.ok) {
      notDone.push({
        pattern: "P6", reason: "unsupported_image", page: pageNo, rect: RECT_ROUND(rect),
        label: "黒い四角の下の画像（JPEG などの形式）を塗りつぶせませんでした。画像の中身が残っているかもしれません",
      });
      continue;
    }
    if (r.pixels === 0) continue;
    burned.set(u, ctx.register(r.stream));
    burnedReport.push({ rect: RECT_ROUND(rect), pixels: r.pixels });
  }
  for (const im of w.inlineImages) {
    const over = w.covers.filter((c) => c.seq > im.seq && intersectionArea(c.rect, im.box) > 0);
    if (!over.length) continue;
    notDone.push({
      pattern: "P6", reason: "inline_image", page: pageNo, rect: RECT_ROUND(over.map((c) => intersect(c.rect, im.box)).reduce(union)),
      label: "黒い四角の下の画像（ページに直接埋め込んだ形）を塗りつぶせませんでした",
    });
  }

  // 書き直す
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

  // 消した字の一覧（書き換えられなかった中身の字は、片付けられなかった所に入れる）
  const p6 = new Map<SanCover, { chars: number }>();
  const p7 = new Map<string, { reason: P7Reason; rect: Rect; chars: number }>();
  let blockedChars = 0;
  for (const gl of w.glyphs) {
    if (!gl.remove) continue;
    if (isBlocked(gl.node)) {
      if (!gl.isSpace) blockedChars++;
      gl.remove = null;
      continue;
    }
    if (gl.isSpace) continue;
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
    removed.push({ pattern: "P6", kind: "covered_text", page: pageNo, rect: RECT_ROUND(c.rect), count: e.chars, label: `黒い四角の下に残っていた字（${e.chars} 字）` });
  }
  for (const b of burnedReport) {
    removed.push({ pattern: "P6", kind: "covered_pixels", page: pageNo, rect: b.rect, count: b.pixels, label: `黒い四角の下に残っていた画像の中身（${b.pixels} 画素を黒く塗りました）` });
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
  if (redactRects.length) applyRedactionBoxes(ctx, page, redactRects);
  return { removed, notDone, redactAnnots };
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

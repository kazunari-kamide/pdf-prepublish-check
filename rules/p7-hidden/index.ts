// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P7（隠れたテキスト）。
// 取り出せるのに、画面では見えない字を見つける（rubric/p7.md §2）。
// 1件 ＝ 1回の字を描く命令（Tj・TJ・'・"）の中で、同じ理由で続く見えない字のまとまり。字そのものは返さない（字数と箱だけ）。
//
// 読み方：pdf-lib でページの中身を取り出し、描く命令を順に読みながら、次のものを描いた順番つきで集める。
//   字（1字ごとの箱・色・描き方・不透明さ・レイヤー・切り抜き）、塗り（形・色・不透明さ・重ね方）、画像（置いた箱）。
// 集め終わってから、1字ごとに理由を決める（画像と重なる見えない字は、描く順番に関係なく文字認識の層とするため。PR #22 の返事の 4）。
// 注釈は描かない（注釈の中の字は P8 の範囲）。

import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  } from "pdf-lib";
import { decodeStream, isInflateLimitError, rethrowIfInflateLimit } from "../shared/inflate-limit.ts";
import { operations, type Op, type Tok } from "../shared/content-lexer.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { readFont, type FontInfo } from "../shared/fonts.ts";
import { expectedTextOf } from "./remap.ts";
import { loadPdf } from "../shared/load.ts";
import { darkFractionOf, readImagePixels, type PixelRead } from "../p6-text/images.ts";
import { DEFAULT_SETTINGS as P6_SETTINGS } from "../p6-text/settings.ts";
import { inlineImageStream } from "../shared/inline-image.ts";
import { readPattern, readShading, tileRange, type PatternPaint } from "../shared/patterns.ts";

/** 模様のタイルを並べる数の上限（1回の塗りごと。中に字のあるタイルの模様だけ）（1.3.0 から） */
const MAX_PATTERN_TILES = 64;

export const RULE_ID = "p7-hidden";
// 1.4.1：解くと大きすぎる中身（圧縮の爆弾）のページは、stream_too_large として省く（rules/shared/inflate-limit.ts）
export const RULE_VERSION = "1.4.1";

export type P7Reason =
  | "hidden_layer"
  | "off_page"
  | "clipped"
  | "invisible"
  | "tiny"
  | "squashed"
  | "same_color"
  | "same_color_image"
  | "covered_light"
  | "covered_image"
  | "hidden_codepoint"
  | "remapped"
  | "overdrawn"
  | "image_off_page"
  | "image_clipped";

/** 判定の値。rubric/p7.json の thresholds と同じ値（rubric は採点する側なので読まず、ここに持つ） */
export const DEFAULT_SETTINGS = {
  outsideFraction: 0.5,
  invisibleAlphaBelow: 0.1,
  tinyHeightBelowPt: 1.0,
  sameColorDeltaBelow: 0.1,
  coverAlphaMin: 0.9,
  darkLuminanceMaxForP6: 0.3,
  /** 塗りを「四角に近い」とみなす割合（外枠の箱を埋める割合） */
  rectangularFillMin: 0.9,
  /** 覆いが字の箱を隠す割合の下限 */
  coveredFractionMin: 0.5,
  /** 1ページの命令の数の上限。超えたページは省く（1.0.2 から P6 と同じ 300 万。画面の上限と同じ） */
  maxOperations: 3_000_000,
  /** 部品（Form XObject）の入れ子の上限 */
  maxFormDepth: 12,
  /** 横の伸縮（字の横の長さ ÷ 縦の長さ）がこれ未満なら、横につぶれて見えない字（1.1.0 から。Tz 10 未満にあたる） */
  squashedScaleBelow: 0.1,
  /** 画像と同じ色の字（1.1.0 から）：字の箱の中の画素のうち、字の色との明るさの差が sameColorDeltaBelow 未満の点の割合の下限 */
  sameColorImageFractionMin: 0.9,
  /** 1行にまとめる字の間のすき間の上限（字の高さに対する割合。1.1.0 から） */
  mergeGapMax: 1.0,
  /**
   * 見えない所に置いた画像（1.2.0 から）：見える範囲（ページの箱と切り抜き）に入る面積の割合がこれ以下なら「大部分を切り抜いた画像」。
   * 0 ならページの外の画像。写真のふちを落とすだけの切り抜き（9 割ほど見える）は出さない。
   * 1.4.0 で 0.25 → 0.5（見つける段の3回目：ページの外に 69% はみ出した画像を見逃していた。2026-11-05、人の決定）
   */
  imageVisibleFractionMax: 0.5,
  /**
   * 見える割合がこれより大きく imageVisibleFractionMax 以下の画像（1.4.0 で広げた幅）は、見えない所の画素を読み、
   * 明るさのばらつき（標準偏差）が imageHiddenUniformStdMax 未満なら出さない（一色の余白・背景がはみ出しただけ）。
   * 読めない画像は出す。これ以下の画像は 1.3.0 までと同じく、画素を見ずに出す
   */
  imageUniformCheckAbove: 0.25,
  imageHiddenUniformStdMax: 0.05,
  /** 見えない所に置いた画像として調べる、画像の画素の数の下限（小さな飾り・線の画像は見ない）【仮の値】 */
  imageMinPixels: 1024,
};
export type P7Settings = typeof DEFAULT_SETTINGS;

export type Rect = [number, number, number, number];

export type P7Finding = {
  pattern: "P7";
  page: number;
  reason: P7Reason;
  /** 見えない字の箱。ページの既定の座標（ポイント、左下が原点、/Rotate はかけない） */
  rect: Rect;
  /** 見えない字の数（空白を除く） */
  chars: number;
  /** includeText のときだけ。字そのもの（1バイトの書体は latin1 で読む目安）。記録やログには使わない */
  text?: string;
};

export type P7Report = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: { code: "empty" | "unreadable" | "encrypted"; message: string };
  pages: number | null;
  findings: P7Finding[];
  skippedPages: Array<{ page: number; reason: "too_many_operations" | "unreadable_page" | "stream_too_large" }>;
  /** 見えないが P7 では数えなかった字の数。p6＝濃い覆いの下（P6 で数える）、ocrLayer＝画像と重なる見えない字（文字認識の層） */
  excluded: { p6: number; ocrLayer: number };
  /** 文字認識の層（スキャン画像の上の見えない字）があるページ（1.1.0 から）。危険の発見には数えず、お知らせに使う */
  ocrLayerPages: number[];
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { settings?: Partial<P7Settings>; includeText?: boolean };

// ---------------------------------------------------------------- 幾何

type M = [number, number, number, number, number, number];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];
/** a を先に、b をあとにかける */
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function boxOf(points: Array<[number, number]>): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
function intersect(a: Rect, b: Rect): Rect {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}
const interArea = (a: Rect, b: Rect) => {
  const r = intersect(a, b);
  return r[2] > r[0] && r[3] > r[1] ? area(r) : 0;
};
const union = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const inRect = (r: Rect, x: number, y: number) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

function polygonArea(poly: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

/** 点が形の中にあるか（偶奇の決まり。部分の道すべてで数える） */
function inShape(polys: Array<Array<[number, number]>>, x: number, y: number): boolean {
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

// ---------------------------------------------------------------- 色

type Space = { kind: "gray" | "rgb" | "cmyk"; n: 1 | 3 | 4 } | { kind: "unknown" };

/** 明るさ（0〜1）。分からない色は null */
function luminance(space: Space, comps: number[]): number | null {
  const c = (i: number) => Math.min(1, Math.max(0, comps[i] ?? 0));
  if (space.kind === "gray") return c(0);
  if (space.kind === "rgb") return 0.299 * c(0) + 0.587 * c(1) + 0.114 * c(2);
  if (space.kind === "cmyk") {
    const k = c(3);
    const r = (1 - c(0)) * (1 - k), g = (1 - c(1)) * (1 - k), b = (1 - c(2)) * (1 - k);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return null;
}

// ---------------------------------------------------------------- 辞書を引く道具
// 書体の寸法は、P6 と同じ rules/shared/fonts.ts で読む（PR #25 の返事の 1）

function numOf(ctx: PDFContext, o: PDFObject | undefined): number | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFNumber ? v.asNumber() : null;
}
function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return null;
}
function arrOf(ctx: PDFContext, o: PDFObject | undefined): PDFArray | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFArray ? v : null;
}
function nameOf(ctx: PDFContext, o: PDFObject | undefined): string | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFName ? v.decodeText() : null;
}

// ---------------------------------------------------------------- 集めるもの

type Glyph = {
  seq: number;
  op: number; // 字を描く命令の通し番号（まとめる単位）
  rect: Rect;
  height: number;
  isSpace: boolean;
  text: string;
  hidden: boolean;
  clip: Rect;
  mode: number;
  /** 描く色ごとの不透明さと明るさ。描き方 0・4＝塗り、1・5＝輪郭、2・6＝塗りと輪郭、3・7＝なし（1.1.0 から） */
  paints: Array<{ alpha: number; lum: number | null }>;
  /** 横の伸縮（字の横の長さ ÷ 縦の長さ。1.1.0 から） */
  hScale: number;
  /** 字の始まりの点と、字の進む向き（1行にまとめるため。1.1.0 から） */
  origin: [number, number];
  dir: [number, number];
  /** 見た目の字（字形の名前から引けたときだけ。1.1.0 から） */
  expected: string | null;
};
type Fill = { seq: number; box: Rect; polys: Array<Array<[number, number]>>; lum: number | null; alpha: number; normal: boolean; rectangular: boolean };
type Img = {
  seq: number;
  box: Rect;
  /** 画像の単位正方形をページに移す行列 */
  m: M;
  stream: PDFStream | null;
  colorSpaces: PDFDict | undefined;
  /** 型抜き（ImageMask）・やわらかい型抜き（SMask）・型抜き（Mask）を持つ画像。覆いにしない */
  masked: boolean;
  /** 置いたときの不透明さと重ね方 */
  alpha: number;
  normal: boolean;
  fillLum: number | null;
  /** 置いたときの切り抜きの箱と、表示しない層の中か（1.2.0 から。見えない所に置いた画像を見るため） */
  clip?: Rect;
  hidden?: boolean;
};

type GState = {
  ctm: M;
  clip: Rect;
  fillSpace: Space;
  strokeSpace: Space;
  fill: number | null;
  stroke: number | null;
  ca: number;
  CA: number;
  normal: boolean;
  font: FontInfo | null;
  /** 文字コード → 見た目の字（字の対応表の書き換えを見るため。比べられない書体は null。1.1.0 から） */
  expect: ((code: number) => string | null) | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  mode: number;
  /** 塗りの色が、中に字を描くタイルの模様のとき（1.3.0 から） */
  fillTiling?: NonNullable<PatternPaint["tiling"]>;
  /** この中身の流れの、はじめの行列（模様の空間の基準。1.3.0 から） */
  base?: M;
};

class TooManyOperations extends Error {}

type Visibility = (oc: PDFObject | undefined) => boolean;

/** 表示しないレイヤーかを決める（/OCProperties の /D の /OFF・/ON・/BaseState。OCMD は /OCGs と /P） */
function makeVisibility(ctx: PDFContext, catalog: PDFDict): Visibility {
  const props = dictOf(ctx, catalog.get(PDFName.of("OCProperties")));
  const d = props ? dictOf(ctx, props.get(PDFName.of("D"))) : null;
  const tag = (o: PDFObject | undefined) => (o instanceof PDFRef ? o.tag : null);
  const off = new Set<string>();
  const on = new Set<string>();
  const offArr = d ? arrOf(ctx, d.get(PDFName.of("OFF"))) : null;
  const onArr = d ? arrOf(ctx, d.get(PDFName.of("ON"))) : null;
  for (let i = 0; offArr && i < offArr.size(); i++) {
    const t = tag(offArr.get(i));
    if (t) off.add(t);
  }
  for (let i = 0; onArr && i < onArr.size(); i++) {
    const t = tag(onArr.get(i));
    if (t) on.add(t);
  }
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
      const list = arrOf(ctx, ocgs);
      const states = list ? Array.from({ length: list.size() }, (_, i) => ocgOn(list.get(i))) : [ocgOn(ocgs)];
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

function contentBytes(ctx: PDFContext, contents: PDFObject | undefined): Uint8Array {
  const v = contents instanceof PDFRef ? ctx.lookup(contents) : contents;
  const parts: Uint8Array[] = [];
  const push = (o: PDFObject | undefined) => {
    const s = o instanceof PDFRef ? ctx.lookup(o) : o;
    if (s instanceof PDFRawStream) parts.push(decodeStream(s));
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

const num = (t: Tok | undefined) => (t && t.t === "num" ? t.v : 0);

class PageScanner {
  readonly glyphs: Glyph[] = [];
  readonly fills: Fill[] = [];
  readonly images: Img[] = [];
  private seq = 0;
  private ops = 0;
  private textOps = 0;
  private readonly ctx: PDFContext;
  private readonly visible: Visibility;
  private readonly settings: P7Settings;
  private readonly fontCache = new Map<PDFDict, FontInfo>();
  private readonly expectCache = new Map<PDFDict, ((code: number) => string | null) | null>();

  constructor(ctx: PDFContext, visible: Visibility, settings: P7Settings) {
    this.ctx = ctx;
    this.visible = visible;
    this.settings = settings;
  }

  run(data: Uint8Array, resources: PDFDict | null, gs: GState, hiddenDepth: boolean, depth: number, forms: Set<PDFObject>) {
    const ctx = this.ctx;
    const stack: GState[] = [];
    let g: GState = { ...gs, base: gs.ctm };
    // マーク付きの中身の入れ子：それぞれ「表示しないレイヤーか」
    const marks: boolean[] = [];
    const isHidden = () => hiddenDepth || marks.some(Boolean);
    let path: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> | null = null;
    let pendingClip = false;
    let tm: M = IDENTITY;
    let tlm: M = IDENTITY;

    const res = (cat: string, name: string): PDFObject | undefined => {
      const d = resources ? dictOf(ctx, resources.get(PDFName.of(cat))) : null;
      return d ? d.get(PDFName.of(name)) : undefined;
    };
    const pt = (x: number, y: number) => apply(g.ctm, x, y);
    const startSub = (p: [number, number]) => {
      cur = [p];
      path.push(cur);
    };
    const lineTo = (p: [number, number]) => {
      if (!cur) startSub(p);
      else cur.push(p);
    };
    const endPath = () => {
      path = [];
      cur = null;
      pendingClip = false;
    };
    const paintFill = () => {
      const polys = path.filter((p) => p.length >= 2);
      if (pendingClip && polys.length) g.clip = intersect(g.clip, boxOf(polys.flat()));
      if (polys.length) {
        const box = boxOf(polys.flat());
        const filled = polys.reduce((s, p) => s + polygonArea(p), 0);
        this.fills.push({
          seq: this.seq++,
          box,
          polys,
          lum: g.fill,
          alpha: g.ca,
          normal: g.normal,
          rectangular: area(box) > 0 && filled / area(box) >= this.settings.rectangularFillMin,
        });
        // 字を描くタイルの模様で塗ったとき（1.3.0 から）：塗った所にタイルを並べ、タイルの中の字も字として見る
        const t = g.fillTiling;
        if (t && depth < this.settings.maxFormDepth && !forms.has(t.stream)) {
          const toDevice = mul(t.matrix, g.base ?? IDENTITY);
          const inv = invert(toDevice);
          const tiles = inv ? tileRange(inv, box, t, MAX_PATTERN_TILES) : null;
          if (tiles) {
            forms.add(t.stream);
            const saved = g;
            for (const [i, j] of tiles) {
              const inner: GState = {
                ...saved, ctm: mul([1, 0, 0, 1, i * t.xStep, j * t.yStep], toDevice), clip: intersect(saved.clip, box),
                fillSpace: { kind: "gray", n: 1 }, strokeSpace: { kind: "gray", n: 1 }, fill: 0, stroke: 0, fillTiling: undefined, font: null, expect: null,
              };
              this.run(t.data, t.resources ?? resources, inner, isHidden(), depth + 1, forms);
            }
            forms.delete(t.stream);
          }
        }
      }
      endPath();
    };
    const setSpace = (name: string): Space => {
      if (name === "DeviceGray" || name === "G" || name === "CalGray") return { kind: "gray", n: 1 };
      if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return { kind: "rgb", n: 3 };
      if (name === "DeviceCMYK" || name === "CMYK") return { kind: "cmyk", n: 4 };
      const o = res("ColorSpace", name);
      const v = o instanceof PDFRef ? ctx.lookup(o) : o;
      if (v instanceof PDFName) return setSpace(v.decodeText());
      if (v instanceof PDFArray && v.size() >= 1) {
        const fam = nameOf(ctx, v.get(0));
        if (fam === "ICCBased") {
          const st = ctx.lookup(v.get(1));
          const n = st instanceof PDFStream ? numOf(ctx, st.dict.get(PDFName.of("N"))) : null;
          if (n === 1) return { kind: "gray", n: 1 };
          if (n === 3) return { kind: "rgb", n: 3 };
          if (n === 4) return { kind: "cmyk", n: 4 };
        }
        if (fam === "CalGray") return { kind: "gray", n: 1 };
        if (fam === "CalRGB") return { kind: "rgb", n: 3 };
      }
      return { kind: "unknown" };
    };
    const initialColor = (s: Space): number | null => (s.kind === "unknown" ? null : luminance(s, s.kind === "cmyk" ? [0, 0, 0, 1] : [0, 0, 0]));

    const showText = (bytes: Uint8Array, opNo: number) => {
      const f = g.font;
      if (!f) return;
      for (const gl of f.decode(bytes)) {
        const w0 = gl.width;
        const trm = mul([g.size * g.th, 0, 0, g.size, 0, g.rise], mul(tm, g.ctm));
        const corners: Array<[number, number]> = [
          apply(trm, 0, f.descent),
          apply(trm, w0, f.descent),
          apply(trm, 0, f.ascent),
          apply(trm, w0, f.ascent),
        ];
        const rect = boxOf(corners);
        const [bx, by] = apply(trm, 0, f.descent);
        const [tx, ty] = apply(trm, 0, f.ascent);
        const height = Math.hypot(tx - bx, ty - by);
        const isSpace = gl.isSpace;
        const fillPaint = { alpha: g.ca, lum: g.fill };
        const strokePaint = { alpha: g.CA, lum: g.stroke };
        const m = g.mode;
        const paints = m === 0 || m === 4 ? [fillPaint] : m === 1 || m === 5 ? [strokePaint] : m === 2 || m === 6 ? [fillPaint, strokePaint] : [];
        const xLen = Math.hypot(trm[0], trm[1]);
        const yLen = Math.hypot(trm[2], trm[3]);
        const origin = apply(trm, 0, 0);
        this.glyphs.push({
          seq: this.seq++,
          op: opNo,
          rect,
          height,
          isSpace,
          text: gl.text,
          expected: g.expect ? g.expect(gl.code) : null,
          hidden: isHidden(),
          clip: g.clip,
          mode: g.mode,
          paints,
          hScale: yLen > 0 ? xLen / yLen : 1,
          origin,
          dir: xLen > 0 ? [trm[0] / xLen, trm[1] / xLen] : [1, 0],
        });
        const adv = (w0 * g.size + g.tc + (gl.isWordSpace ? g.tw : 0)) * g.th;
        tm = mul([1, 0, 0, 1, adv, 0], tm);
      }
    };

    for (const { op, args } of operations(data)) {
      if (++this.ops > this.settings.maxOperations) throw new TooManyOperations();
      switch (op) {
        case "q":
          stack.push({ ...g });
          break;
        case "Q":
          if (stack.length) g = stack.pop()!;
          break;
        case "cm":
          g.ctm = mul(args.map(num) as M, g.ctm);
          break;
        case "gs": {
          const name = args[0]?.t === "name" ? args[0].v : "";
          const egs = dictOf(ctx, res("ExtGState", name));
          if (egs) {
            const ca = numOf(ctx, egs.get(PDFName.of("ca")));
            const CA = numOf(ctx, egs.get(PDFName.of("CA")));
            if (ca !== null) g.ca = ca;
            if (CA !== null) g.CA = CA;
            const bm = egs.get(PDFName.of("BM"));
            if (bm) {
              const arr = arrOf(ctx, bm);
              const first = arr ? nameOf(ctx, arr.get(0)) : nameOf(ctx, bm);
              g.normal = first === "Normal" || first === "Compatible";
            }
          }
          break;
        }
        // 色
        case "g": g.fillSpace = { kind: "gray", n: 1 }; g.fill = luminance(g.fillSpace, args.map(num)); break;
        case "G": g.strokeSpace = { kind: "gray", n: 1 }; g.stroke = luminance(g.strokeSpace, args.map(num)); break;
        case "rg": g.fillSpace = { kind: "rgb", n: 3 }; g.fill = luminance(g.fillSpace, args.map(num)); break;
        case "RG": g.strokeSpace = { kind: "rgb", n: 3 }; g.stroke = luminance(g.strokeSpace, args.map(num)); break;
        case "k": g.fillSpace = { kind: "cmyk", n: 4 }; g.fill = luminance(g.fillSpace, args.map(num)); break;
        case "K": g.strokeSpace = { kind: "cmyk", n: 4 }; g.stroke = luminance(g.strokeSpace, args.map(num)); break;
        case "cs": g.fillSpace = setSpace(args[0]?.t === "name" ? args[0].v : ""); g.fill = initialColor(g.fillSpace); break;
        case "CS": g.strokeSpace = setSpace(args[0]?.t === "name" ? args[0].v : ""); g.stroke = initialColor(g.strokeSpace); break;
        case "sc":
        case "scn": {
          const pname = args.find((a) => a.t === "name");
          if (pname?.t === "name") {
            // 模様（1.3.0 から）：すき間なく不透明に塗る模様で、明るさの分かるものだけを色にする
            const p = readPattern(ctx, resources ?? undefined, pname.v, args.flatMap((a) => (a.t === "num" ? [a.v] : [])));
            g.fill = p && p.covers ? p.luminance : null;
            g.fillTiling = p?.tiling;
          } else {
            g.fill = luminance(g.fillSpace, args.map(num));
            g.fillTiling = undefined;
          }
          break;
        }
        case "SC":
        case "SCN": {
          const pname = args.find((a) => a.t === "name");
          if (pname?.t === "name") {
            const p = readPattern(ctx, resources ?? undefined, pname.v, args.flatMap((a) => (a.t === "num" ? [a.v] : [])));
            g.stroke = p && p.covers ? p.luminance : null;
          } else g.stroke = luminance(g.strokeSpace, args.map(num));
          break;
        }
        // シェーディング（sh。1.3.0 から）：いまの切り抜きの中（/BBox があれば、その中）を塗る
        case "sh": {
          const sname = args[0]?.t === "name" ? args[0].v : "";
          const sh = readShading(ctx, res("Shading", sname));
          if (!sh) break;
          let box: Rect = g.clip;
          if (sh.bbox) {
            const b = sh.bbox;
            box = intersect(box, boxOf([pt(b[0], b[1]), pt(b[2], b[1]), pt(b[0], b[3]), pt(b[2], b[3])]));
          }
          if (!box.every(Number.isFinite) || area(box) <= 0) break;
          const poly: Array<[number, number]> = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]];
          this.fills.push({ seq: this.seq++, box, polys: [poly], lum: sh.luminance, alpha: g.ca, normal: g.normal, rectangular: true });
          break;
        }
        // 道
        case "m": startSub(pt(num(args[0]), num(args[1]))); break;
        case "l": lineTo(pt(num(args[0]), num(args[1]))); break;
        case "c":
        case "v":
        case "y": {
          // cur は startSub・lineTo の中でも書き換わる。型の上では null に絞られてしまうので、型を戻して読む
          const sub = cur as Array<[number, number]> | null;
          const last = sub?.[sub.length - 1];
          if (!last) break;
          const inv = args.map(num);
          // 曲線は4つの直線に分ける（目安）
          const p0 = last;
          let p1: [number, number], p2: [number, number], p3: [number, number];
          if (op === "c") { p1 = pt(inv[0]!, inv[1]!); p2 = pt(inv[2]!, inv[3]!); p3 = pt(inv[4]!, inv[5]!); }
          else if (op === "v") { p1 = p0; p2 = pt(inv[0]!, inv[1]!); p3 = pt(inv[2]!, inv[3]!); }
          else { p1 = pt(inv[0]!, inv[1]!); p2 = pt(inv[2]!, inv[3]!); p3 = p2; }
          for (const t of [0.25, 0.5, 0.75, 1]) {
            const u = 1 - t;
            lineTo([
              u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
              u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
            ]);
          }
          break;
        }
        case "re": {
          const [x, y, w, h] = args.map(num) as [number, number, number, number];
          startSub(pt(x, y));
          lineTo(pt(x + w, y));
          lineTo(pt(x + w, y + h));
          lineTo(pt(x, y + h));
          cur = null;
          break;
        }
        case "h": cur = null; break;
        case "W":
        case "W*": pendingClip = true; break;
        case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*":
          paintFill();
          break;
        case "S": case "s": case "n": {
          if (pendingClip) {
            const polys = path.filter((p) => p.length >= 1);
            if (polys.length) g.clip = intersect(g.clip, boxOf(polys.flat()));
          }
          endPath();
          break;
        }
        // 字
        case "BT": tm = IDENTITY; tlm = IDENTITY; break;
        case "ET": break;
        case "Tf": {
          const name = args[0]?.t === "name" ? args[0].v : "";
          const fd = dictOf(ctx, res("Font", name));
          if (fd) {
            let fi = this.fontCache.get(fd);
            if (!fi) {
              fi = readFont(ctx, fd);
              this.fontCache.set(fd, fi);
            }
            g.font = fi;
            let ex = this.expectCache.get(fd);
            if (ex === undefined) {
              ex = expectedTextOf(ctx, fd);
              this.expectCache.set(fd, ex);
            }
            g.expect = ex;
          } else {
            g.font = null;
            g.expect = null;
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
        case "Td": tlm = mul([1, 0, 0, 1, num(args[0]), num(args[1])], tlm); tm = tlm; break;
        case "TD": g.tl = -num(args[1]); tlm = mul([1, 0, 0, 1, num(args[0]), num(args[1])], tlm); tm = tlm; break;
        case "Tm": tlm = args.map(num) as M; tm = tlm; break;
        case "T*": tlm = mul([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm; break;
        case "Tj": if (args[0]?.t === "str") showText(args[0].v, this.textOps++); break;
        case "'":
          tlm = mul([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm;
          if (args[0]?.t === "str") showText(args[0].v, this.textOps++);
          break;
        case '"':
          g.tw = num(args[0]); g.tc = num(args[1]);
          tlm = mul([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm;
          if (args[2]?.t === "str") showText(args[2].v, this.textOps++);
          break;
        case "TJ": {
          // TJ 全体を1つの命令として数える（まとめる単位）
          const arr = args[0]?.t === "arr" ? args[0].v : [];
          const opNo = this.textOps++;
          for (const el of arr) {
            if (el.t === "str") showText(el.v, opNo);
            else if (el.t === "num") tm = mul([1, 0, 0, 1, (-el.v / 1000) * g.size * g.th, 0], tm);
          }
          break;
        }
        // 画像と部品
        case "BI": {
          // 埋め込みの画像（1.3.0 から）：外の画像と同じに、画素を読んで覆い・色の比べに使う
          const xo = inlineImageStream(ctx, args);
          const isMask = xo?.dict.lookup(PDFName.of("ImageMask"));
          const masked = !xo || (isMask instanceof PDFBool && isMask.asBoolean()) || xo.dict.has(PDFName.of("SMask")) || xo.dict.has(PDFName.of("Mask"));
          const colorSpaces = resources ? (dictOf(ctx, resources.get(PDFName.of("ColorSpace"))) ?? undefined) : undefined;
          this.images.push({ seq: this.seq++, box: boxOf([pt(0, 0), pt(1, 0), pt(0, 1), pt(1, 1)]), m: g.ctm, stream: xo, colorSpaces, masked, alpha: g.ca, normal: g.normal, fillLum: g.fill, clip: g.clip, hidden: isHidden() });
          break;
        }
        case "Do": {
          const name = args[0]?.t === "name" ? args[0].v : "";
          const raw = res("XObject", name);
          const xo = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
          if (!(xo instanceof PDFStream)) break;
          const st = nameOf(ctx, xo.dict.get(PDFName.of("Subtype")));
          if (st === "Image") {
            const isMask = xo.dict.lookup(PDFName.of("ImageMask"));
            const masked = (isMask instanceof PDFBool && isMask.asBoolean()) || xo.dict.has(PDFName.of("SMask")) || xo.dict.has(PDFName.of("Mask"));
            const colorSpaces = resources ? (dictOf(ctx, resources.get(PDFName.of("ColorSpace"))) ?? undefined) : undefined;
            this.images.push({ seq: this.seq++, box: boxOf([pt(0, 0), pt(1, 0), pt(0, 1), pt(1, 1)]), m: g.ctm, stream: xo, colorSpaces, masked, alpha: g.ca, normal: g.normal, fillLum: g.fill, clip: g.clip, hidden: isHidden() });
          } else if (st === "Form" && xo instanceof PDFRawStream) {
            if (depth >= this.settings.maxFormDepth || forms.has(xo)) break;
            const fm = arrOf(ctx, xo.dict.get(PDFName.of("Matrix")));
            const m: M = fm && fm.size() === 6 ? (Array.from({ length: 6 }, (_, i) => numOf(ctx, fm.get(i)) ?? 0) as M) : IDENTITY;
            const inner: GState = { ...g, ctm: mul(m, g.ctm) };
            const bb = arrOf(ctx, xo.dict.get(PDFName.of("BBox")));
            if (bb && bb.size() === 4) {
              const [x0, y0, x1, y1] = Array.from({ length: 4 }, (_, i) => numOf(ctx, bb.get(i)) ?? 0) as [number, number, number, number];
              inner.clip = intersect(g.clip, boxOf([apply(inner.ctm, x0, y0), apply(inner.ctm, x1, y0), apply(inner.ctm, x0, y1), apply(inner.ctm, x1, y1)]));
            }
            const formHidden = isHidden() || !this.visible(xo.dict.get(PDFName.of("OC")));
            const fres = dictOf(ctx, xo.dict.get(PDFName.of("Resources"))) ?? resources;
            let data2: Uint8Array;
            try {
              data2 = decodeStream(xo);
            } catch (e) {
              rethrowIfInflateLimit(e);
              break;
            }
            forms.add(xo);
            this.run(data2, fres, inner, formHidden, depth + 1, forms);
            forms.delete(xo);
          }
          break;
        }
        // マーク付きの中身（レイヤー）
        case "BMC":
          marks.push(false);
          break;
        case "BDC": {
          let hide = false;
          if (args[0]?.t === "name" && args[0].v === "OC") {
            const p = args[1];
            if (p?.t === "name") hide = !this.visible(res("Properties", p.v));
          }
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

// ---------------------------------------------------------------- 画像の画素（1.1.0 から）

function invert(m: M): M | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** 1辺に並べる点の数（字の箱の中を見る） */
const SAMPLE_GRID = 7;

/**
 * 画像の画素を読む道具。同じ画像は1回だけ解く。解けない画像（JPEG など、このルールで解けない圧縮）は null。
 * 解き方は P6 と同じ（rules/p6-text/images.ts）。上限も P6 と同じ値を使う
 */
class ImagePixels {
  private readonly cache = new Map<PDFStream, PixelRead>();
  private readonly ctx: PDFContext;
  constructor(ctx: PDFContext) {
    this.ctx = ctx;
  }
  private read(im: Img): Extract<PixelRead, { kind: "pixels" }> | null {
    if (!im.stream) return null;
    let r = this.cache.get(im.stream);
    if (!r) {
      try {
        r = readImagePixels({
          ctx: this.ctx,
          stream: im.stream,
          colorSpaces: im.colorSpaces,
          fillLuminance: im.fillLum,
          maxImageBytes: P6_SETTINGS.maxImageBytes,
          maxImagePixels: P6_SETTINGS.maxImagePixels,
        });
      } catch {
        r = { kind: "unknown", reason: "broken" };
      }
      this.cache.set(im.stream, r);
    }
    return r.kind === "pixels" ? r : null;
  }
  /** 字の箱の中に点を並べ、画像の上の点の明るさを返す。読めない画像は null */
  lumsIn(im: Img, rect: Rect): number[] | null {
    const r = this.read(im);
    const inv = invert(im.m);
    if (!r || !inv) return null;
    const { reader } = r;
    const out: number[] = [];
    for (let i = 0; i < SAMPLE_GRID; i++) {
      for (let j = 0; j < SAMPLE_GRID; j++) {
        const x = rect[0] + ((i + 0.5) / SAMPLE_GRID) * (rect[2] - rect[0]);
        const y = rect[1] + ((j + 0.5) / SAMPLE_GRID) * (rect[3] - rect[1]);
        const [u, v] = apply(inv, x, y);
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        const px = Math.min(reader.width - 1, Math.floor(u * reader.width));
        const py = Math.min(reader.height - 1, Math.floor((1 - v) * reader.height));
        const p = reader.at(px, py);
        if (p.lum !== null && p.alpha >= 0.5) out.push(p.lum);
      }
    }
    return out;
  }
  /**
   * 画像の見えない所（visible の外）の明るさの標準偏差（1.4.0 から）。画像の上に 24×24 の点を置いて測る。
   * 読めない画像・見えない所の点が 8 つより少ないときは null
   */
  hiddenStd(im: Img, visible: Rect): number | null {
    const r = this.read(im);
    if (!r) return null;
    const { reader } = r;
    const n = 24;
    const lums: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const u = (i + 0.5) / n;
        const v = (j + 0.5) / n;
        const [x, y] = apply(im.m, u, v);
        if (x >= visible[0] && x <= visible[2] && y >= visible[1] && y <= visible[3]) continue;
        const px = Math.min(reader.width - 1, Math.floor(u * reader.width));
        const py = Math.min(reader.height - 1, Math.floor((1 - v) * reader.height));
        const p = reader.at(px, py);
        if (p.lum !== null && p.alpha >= 0.5) lums.push(p.lum);
      }
    }
    if (lums.length < 8) return null;
    const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
    return Math.sqrt(lums.reduce((a, b) => a + (b - mean) ** 2, 0) / lums.length);
  }
  /** 画像全体のうち濃い画素の割合（P6 と同じ数え方）。読めない画像は null */
  darkFraction(im: Img): number | null {
    const r = this.read(im);
    return r ? darkFractionOf(r.reader, P6_SETTINGS.darkLuminanceMax, P6_SETTINGS.opacityMin) : null;
  }
}

// ---------------------------------------------------------------- 判定

type Judged = { reason: P7Reason } | { excluded: "p6" | "ocr" } | null;

/** 見えない所に置いた画像か（1.2.0 から）。表示しない層の中・型抜き・小さな画像・ふつうでない置き方は見ない */
function hiddenImage(im: Img, view: Rect, s: P7Settings, pixels: ImagePixels): "image_off_page" | "image_clipped" | null {
  if (!im.stream || im.hidden || im.alpha < s.coverAlphaMin) return null;
  const isMask = im.stream.dict.lookup(PDFName.of("ImageMask"));
  if (isMask instanceof PDFBool && isMask.asBoolean()) return null;
  const w = im.stream.dict.lookup(PDFName.of("Width"));
  const h = im.stream.dict.lookup(PDFName.of("Height"));
  if (!(w instanceof PDFNumber) || !(h instanceof PDFNumber) || w.asNumber() * h.asNumber() < s.imageMinPixels) return null;
  const whole = area(im.box);
  if (!(whole > 0) || !Number.isFinite(whole)) return null;
  const vis = intersect(intersect(im.box, view), im.clip ?? im.box);
  const frac = area(vis) / whole;
  if (frac <= 0) return area(intersect(im.box, view)) <= 0 ? "image_off_page" : "image_clipped";
  if (frac > s.imageVisibleFractionMax) return null;
  if (frac > s.imageUniformCheckAbove) {
    // 1.4.0 で広げた幅：見えない所が一色なら、余白・背景がはみ出しただけとみて出さない
    const std = pixels.hiddenStd(im, vis);
    if (std !== null && std < s.imageHiddenUniformStdMax) return null;
  }
  // ページの箱だけで大部分が隠れるなら、ページの外にはみ出した画像（1.4.0 から。切り抜きより先に、こちらの名前にする）
  return area(intersect(im.box, view)) / whole <= s.imageVisibleFractionMax ? "image_off_page" : "image_clipped";
}

function judge(gl: Glyph, view: Rect, fills: Fill[], images: Img[], pixels: ImagePixels, s: P7Settings): Judged {
  const a = area(gl.rect);
  const outside = (box: Rect) => (a > 0 ? 1 - interArea(gl.rect, box) / a : inRect(box, gl.rect[0], gl.rect[1]) ? 0 : 1);
  if (gl.hidden) return { reason: "hidden_layer" };
  if (outside(view) >= s.outsideFraction) return { reason: "off_page" };
  if (outside(gl.clip) >= s.outsideFraction) return { reason: "clipped" };
  const cx = (gl.rect[0] + gl.rect[2]) / 2;
  const cy = (gl.rect[1] + gl.rect[3]) / 2;
  // 描く色のうち、見えるもの（不透明さが下限以上）。描き方 2・6 は、塗りと輪郭のどちらかが見えれば見える字（1.1.0 から）
  const shown = gl.paints.filter((p) => p.alpha >= s.invisibleAlphaBelow);
  if (shown.length === 0) {
    // 画像と重なる見えない字は、描く順番に関係なく文字認識の層（PR #22 の返事の 4）
    if (images.some((im) => inRect(im.box, cx, cy))) return { excluded: "ocr" };
    return { reason: "invisible" };
  }
  if (gl.height < s.tinyHeightBelowPt) return { reason: "tiny" };
  if (gl.hScale < s.squashedScaleBelow) return { reason: "squashed" };
  // 字のあとに重ねた、不透明で四角に近い塗り
  if (a > 0) {
    for (const f of fills) {
      if (f.seq < gl.seq || !f.normal || f.alpha < s.coverAlphaMin || !f.rectangular || f.lum === null) continue;
      if (interArea(gl.rect, f.box) / a < s.coveredFractionMin) continue;
      return f.lum <= s.darkLuminanceMaxForP6 ? { excluded: "p6" } : { reason: "covered_light" };
    }
    // 字のあとに重ねた、型抜きのない不透明な画像（1.1.0 から）。ほぼ全部が濃い画像は P6 で数える
    for (const im of images) {
      if (im.seq < gl.seq || im.masked || !im.normal || im.alpha < s.coverAlphaMin) continue;
      if (interArea(gl.rect, im.box) / a < s.coveredFractionMin) continue;
      const dark = pixels.darkFraction(im);
      return dark !== null && dark >= P6_SETTINGS.darkImageFractionMin ? { excluded: "p6" } : { reason: "covered_image" };
    }
  }
  // 下の色：字より前に描いた、いちばん上の不透明な塗りか画像。なければページの白
  if (shown.some((p) => p.lum === null)) return null;
  let under: { seq: number; lum: number | null; image?: Img } = { seq: -1, lum: 1 };
  for (const f of fills) {
    if (f.seq > gl.seq || f.seq < under.seq || !f.normal || f.alpha < s.coverAlphaMin) continue;
    if (!inRect(f.box, cx, cy) || !inShape(f.polys, cx, cy)) continue;
    under = { seq: f.seq, lum: f.lum };
  }
  for (const im of images) {
    if (im.seq > gl.seq || im.seq < under.seq || !inRect(im.box, cx, cy)) continue;
    under = { seq: im.seq, lum: null, image: im };
  }
  const close = (lum: number) => shown.every((p) => Math.abs(p.lum! - lum) < s.sameColorDeltaBelow);
  if (under.image) {
    // 画像の上の字：字の箱の中の画素を見る（1.1.0 から）。ほとんどの点が字の色と同じなら、画像と同じ色の字。
    // 写真の上の白い説明文のように、字の色と違う点が多ければ読める字として返さない。読めない画像は判定しない
    const im = under.image;
    if (im.masked || !im.normal || im.alpha < s.coverAlphaMin) return null;
    const lums = pixels.lumsIn(im, gl.rect);
    if (!lums || lums.length < (SAMPLE_GRID * SAMPLE_GRID) / 2) return null;
    const same = lums.filter((l) => close(l)).length;
    return same / lums.length >= s.sameColorImageFractionMin ? { reason: "same_color_image" } : null;
  }
  if (under.lum === null) return null;
  return close(under.lum) ? { reason: "same_color" } : null;
}

/** 前の字のすぐあとに、同じ行で続く字か（命令をまたいで1件にまとめるため。1.1.0 から） */
function continuesLine(prev: Glyph, gl: Glyph, gapMax: number): boolean {
  const h = Math.max(prev.height, gl.height);
  if (!(h > 0)) return false;
  if (prev.dir[0] * gl.dir[0] + prev.dir[1] * gl.dir[1] < 0.99) return false; // 同じ向き
  const dx = gl.origin[0] - prev.origin[0];
  const dy = gl.origin[1] - prev.origin[1];
  const along = dx * prev.dir[0] + dy * prev.dir[1]; // 行の向きに沿った進み
  const across = -dx * prev.dir[1] + dy * prev.dir[0]; // 行に直交するずれ
  if (Math.abs(across) > h * 0.3) return false;
  const pw = Math.abs((prev.rect[2] - prev.rect[0]) * prev.dir[0]) + Math.abs((prev.rect[3] - prev.rect[1]) * prev.dir[1]);
  return along >= -h * 0.1 && along - pw <= h * gapMax;
}

// ---------------------------------------------------------------- 見える字の中の隠し（1.1.0 から。取りこぼし 26 項目の 15〜17）

/**
 * 見えない文字コード：幅 0 の字（U+200B〜200D・2060〜2064・FEFF・180E）、向きの制御（U+200E・200F・202A〜202E・2066〜2069・061C）、
 * 書式の制御（U+206A〜206F）、タグ文字（U+E0000〜E007F）、C1 制御文字（U+0080〜009F）。
 * 取り出される字は ToUnicode から来る（rules/shared/fonts.ts）。ToUnicode のない1バイトの字は ASCII だけなので、ここには当たらない。
 * やわらかいハイフン（U+00AD）は、ふつうの組版でも入るので数えない
 */
const HIDDEN_CODEPOINT = /[\u0080-\u009F؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]|[\u{E0000}-\u{E007F}]/gu;

function hiddenCodepoints(text: string): number {
  if (text === "") return 0;
  return text.match(HIDDEN_CODEPOINT)?.length ?? 0;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * 字の対応表の書き換え：見た目の字（字形の名前から引いたもの）と、取り出される字（ToUnicode）が違う。
 * 取り出される字に字か数字が入っているときだけ数える（対応表が空白や記号にずれただけのものは数えない）。
 * 合字（fi など）・異体字（a.sc など）は、見た目の字を引く所で同じ字にそろえる（remap.ts）
 */
function isRemapped(gl: Glyph): boolean {
  if (gl.expected === null || gl.text === "") return false;
  const shown = gl.expected.normalize("NFKC");
  const taken = gl.text.normalize("NFKC");
  if (shown === taken) return false;
  return LETTER_OR_DIGIT.test(taken);
}

/** 1字だけの字か数字（記号・アクセント・空白は重ね描きの比べに使わない） */
const SINGLE_LETTER = /^[\p{L}\p{N}]$/u;

/**
 * 違う字の重ね描き：同じ所（始まりの点が字の高さの 15% 以内）に、同じ大きさ・同じ向きで、違う字（字か数字）が重なって描かれている。
 * 先に描いた字を overdrawn にする（あとから描いた字が上に重なり、先の字は読みにくい）。
 * 太字のための同じ字の2度描きは、同じ字なので数えない。ふりがなは大きさが違うので数えない。見えない字（ほかの理由が付いた字）は比べない
 */
function markOverdrawn(glyphs: Glyph[], judged: Judged[]): void {
  const CELL = 2;
  const buckets = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.round(x / CELL)},${Math.round(y / CELL)}`;
  const letters: number[] = [];
  glyphs.forEach((gl, i) => {
    if (judged[i] !== null || gl.isSpace || !(gl.height > 0)) return;
    const t = gl.text.normalize("NFKC");
    if (!SINGLE_LETTER.test(t)) return;
    letters.push(i);
    const k = key(gl.origin[0], gl.origin[1]);
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  });
  const hit = new Set<number>();
  for (const i of letters) {
    const a = glyphs[i]!;
    const ta = a.text.normalize("NFKC");
    const bx = Math.round(a.origin[0] / CELL);
    const by = Math.round(a.origin[1] / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
          if (j <= i) continue; // j はあとから描いた字
          const b = glyphs[j]!;
          if (b.text.normalize("NFKC") === ta) continue;
          const h = Math.max(a.height, b.height);
          if (Math.min(a.height, b.height) / h < 0.9) continue;
          if (a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] < 0.99) continue;
          if (Math.hypot(b.origin[0] - a.origin[0], b.origin[1] - a.origin[1]) > h * 0.15) continue;
          hit.add(i);
        }
      }
    }
  }
  for (const i of hit) judged[i] = { reason: "overdrawn" };
}

/** 箱が細すぎる（幅や高さが 1 ポイント未満）なら、画面で見えるように 1 ポイントまで広げる（1.1.0 から） */
function padRect(r: Rect): Rect {
  const out: Rect = [...r];
  if (out[2] - out[0] < 1) {
    const c = (out[0] + out[2]) / 2;
    out[0] = c - 0.5;
    out[2] = c + 0.5;
  }
  if (out[3] - out[1] < 1) {
    const c = (out[1] + out[3]) / 2;
    out[1] = c - 0.5;
    out[3] = c + 0.5;
  }
  return out;
}

// ---------------------------------------------------------------- 本体

export async function detectP7Hidden(bytes: Uint8Array, options: DetectOptions = {}): Promise<P7Report> {
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const base: P7Report = {
    rule: { id: RULE_ID, version: RULE_VERSION },
    status: "ok",
    pages: null,
    findings: [],
    skippedPages: [],
    excluded: { p6: 0, ocrLayer: 0 },
    ocrLayerPages: [],
  };
  if (bytes.length === 0) return { ...base, status: "error", error: { code: "empty", message: "ファイルが空です。" } };
  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") {
    if (loaded.code === "encrypted") {
      const message = loaded.reason === "password_required" ? "パスワードが要る PDF は、調べられません。" : "この形の暗号化は、いまは調べられません。";
      return { ...base, status: "error", error: { code: "encrypted", message } };
    }
    return { ...base, status: "error", error: { code: "unreadable", message: "PDF として読めませんでした。" } };
  }
  const doc = loaded.doc;
  const ctx = doc.context;
  let pages;
  try {
    pages = doc.getPages();
  } catch {
    return { ...base, status: "error", error: { code: "unreadable", message: "ページの並びを読めませんでした。" } };
  }
  const report: P7Report = { ...base, pages: pages.length, findings: [], skippedPages: [], excluded: { p6: 0, ocrLayer: 0 }, ocrLayerPages: [] };
  if (loaded.decrypted) report.decrypted = loaded.decrypted;
  const visible = makeVisibility(ctx, doc.catalog);

  pages.forEach((page, index) => {
    const pageNo = index + 1;
    try {
      const mb = page.getMediaBox();
      const cb = page.getCropBox();
      const view = intersect([mb.x, mb.y, mb.x + mb.width, mb.y + mb.height], [cb.x, cb.y, cb.x + cb.width, cb.y + cb.height]);
      const scanner = new PageScanner(ctx, visible, settings);
      const gs: GState = {
        ctm: IDENTITY, clip: [-Infinity, -Infinity, Infinity, Infinity], fillSpace: { kind: "gray", n: 1 }, strokeSpace: { kind: "gray", n: 1 },
        fill: 0, stroke: 0, ca: 1, CA: 1, normal: true, font: null, expect: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, mode: 0,
      };
      scanner.run(contentBytes(ctx, page.node.get(PDFName.of("Contents"))), page.node.Resources() ?? null, gs, false, 0, new Set());

      // 1字ごとに理由を決め、同じ理由で続く字を1件にまとめる。
      // 同じ命令の中か、命令をまたいでも同じ行ですぐ隣に続く字（1.1.0 から。1字ずつ別の命令で置いた字を1件にする）
      type Group = { op: number; reason: P7Reason; rect: Rect; chars: number; text: string; last: Glyph };
      let group: Group | null = null;
      const pixels = new ImagePixels(ctx);
      const flush = () => {
        if (group && group.chars > 0) {
          const f: P7Finding = { pattern: "P7", page: pageNo, reason: group.reason, rect: padRect(group.rect), chars: group.chars };
          if (options.includeText) f.text = group.text;
          report.findings.push(f);
        }
        group = null;
      };
      // 見える字だけに当てる理由（1.1.0 から）：字の対応表の書き換え、見えない文字コード、違う字の重ね描き
      const judged: Judged[] = scanner.glyphs.map((gl) => {
        const j = judge(gl, view, scanner.fills, scanner.images, pixels, settings);
        if (j !== null) return j;
        if (isRemapped(gl)) return { reason: "remapped" };
        if (hiddenCodepoints(gl.text) > 0) return { reason: "hidden_codepoint" };
        return null;
      });
      markOverdrawn(scanner.glyphs, judged);

      let ocrChars = 0;
      scanner.glyphs.forEach((gl, i) => {
        const j = judged[i]!;
        if (j === null || "excluded" in j) {
          if (j && !gl.isSpace) {
            if (j.excluded === "p6") report.excluded.p6++;
            else {
              report.excluded.ocrLayer++;
              ocrChars++;
            }
          }
          flush();
          return;
        }
        // 数える字の数：見えない文字コードは、その文字コードの数（全角の空白と同じに扱われる字もあるため）。ほかは空白を除いた字
        const n = j.reason === "hidden_codepoint" ? hiddenCodepoints(gl.text) : gl.isSpace ? 0 : 1;
        const g0 = group as Group | null;
        if (g0 && g0.reason === j.reason && (g0.op === gl.op || continuesLine(g0.last, gl, settings.mergeGapMax))) {
          g0.rect = union(g0.rect, gl.rect);
          g0.text += gl.text;
          g0.op = gl.op;
          g0.last = gl;
          g0.chars += n;
        } else {
          flush();
          group = { op: gl.op, reason: j.reason, rect: gl.rect, chars: n, text: gl.text, last: gl };
        }
      });
      flush();
      if (ocrChars > 0) report.ocrLayerPages.push(pageNo);
      // 見えない所に置いた画像（1.2.0 から）：ページの外、または切り抜きで大部分を隠した画像。字の模様などが残っていても、見た目では分からない
      for (const im of scanner.images) {
        const f = hiddenImage(im, view, settings, pixels);
        if (f) report.findings.push({ pattern: "P7", page: pageNo, reason: f, rect: padRect(im.box), chars: 0 });
      }
    } catch (e) {
      report.skippedPages.push({
        page: pageNo,
        reason: e instanceof TooManyOperations ? "too_many_operations" : isInflateLimitError(e) ? "stream_too_large" : "unreadable_page",
      });
    }
  });
  return report;
}

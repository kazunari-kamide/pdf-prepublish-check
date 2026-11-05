// SPDX-License-Identifier: AGPL-3.0-only
//
// 1ページの命令を順に追い、次の3つを集める（docs/prd.md §3）。
// - 覆い：濃い色の塗り・濃い色の太い線・濃い画像。画像の上なら白い不透明な塗りも（1.5.0 から）。描いた順番つき
// - 字：1字ごとの箱。描いた順番つき
// - 画像を置いた所（1.5.0 から。画像の層を調べるため）。描いた順番つき
// 図形を全部組み立てない。必要なものだけを拾う（CLAUDE.md §5）。

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { decodeStream } from "../shared/inflate-limit.ts";
import {
  IDENTITY,
  apply,
  area,
  boundsOf,
  clipPolygonToRect,
  isFiniteMatrix,
  multiply,
  flattenCubic,
  intersectionArea,
  rectsOverlap,
  signedPolygonArea,
  scaleOf,
  type Matrix,
  type Point,
  type Rect,
} from "./geometry.ts";
import { readFont, type FontInfo } from "../shared/fonts.ts";
import { arrArg, bytesArg, nameArg, numArg, operations, type Tok } from "../shared/content-lexer.ts";
import type { P6TextSettings } from "./settings.ts";
import { measureImageDarkness, probeImagePixels } from "./images.ts";
import { inlineImageStream } from "../shared/inline-image.ts";
import { invert, readPattern, readShading, tileRange, type PatternPaint } from "../shared/patterns.ts";

/** 模様のタイルを並べる数の上限（1回の塗りごと。中に字のあるタイルの模様だけ）（1.12.0 から） */
const MAX_PATTERN_TILES = 64;

/** 覆っているものの種類（rubric/p6.md §1 の内訳の「覆っているもの」） */
export type CoverKind = "fill" | "image" | "annotation";
export type Cover = {
  seq: number;
  rect: Rect;
  kind: CoverKind;
  how: "fill" | "stroke" | "image" | "redact";
  /**
   * 覆いの色の向き（1.5.0 から）。dark＝濃い（明るさ darkLuminanceMax 以下）、light＝白っぽい（lightLuminanceMin 以上）。
   * 字の層は dark だけを覆いとする。light は、画像の上に置いたものだけを集め、画像の層でだけ使う。
   * opaque（1.11.0 から）＝濃くない色の、不透明でふつうの重ね方の塗り・画像。字の層でだけ使う（覆いの下の字は、色によらず P6）
   */
  tone: "dark" | "light" | "opaque";
  /** 塗りの明るさ。画像は濃い画素の割合ではなく、1 − 割合（小さいほど濃い）。墨消しの注釈は 0 */
  luminance: number;
  /**
   * 覆いの形（ページの座標の多角形。曲線は直線に分けたもの）。ないときは rect の箱そのものが形（1.3.0 から）。
   * parts の面積を足し合わせて、字の箱が隠れる割合を出す（coverageOf）。
   */
  shape?: CoverShape;
  /** 切り抜き（W）の外枠の箱（ページの座標）。この外は見えない。ないときは切り抜きなし（1.6.0 から） */
  clip?: Rect;
};
export type CoverShape = { parts: Point[][]; rule: "nonzero" | "evenodd" };

/** 曲線1本を分ける直線の数 */
const CURVE_SEGMENTS = 8;

/** 覆いの形が、箱 r をどれだけ隠すか（面積。0〜箱の面積） */
export function coverageOf(cover: Pick<Cover, "rect" | "shape">, r: Rect): number {
  const boxArea = area(r);
  if (boxArea <= 0) return 0;
  if (!cover.shape) {
    const w = Math.min(r[2], cover.rect[2]) - Math.max(r[0], cover.rect[0]);
    const h = Math.min(r[3], cover.rect[3]) - Math.max(r[1], cover.rect[1]);
    return w > 0 && h > 0 ? w * h : 0;
  }
  const { parts, rule } = cover.shape;
  let sum = 0;
  if (rule === "nonzero") {
    // 向きつきの面積を足す。逆向きの内側（枠の穴）は引かれる。同じ向きで重なった分は、箱の面積で頭打ちにする
    for (const part of parts) sum += signedPolygonArea(clipPolygonToRect(part, r));
    sum = Math.abs(sum);
  } else {
    // 偶奇の決まり：ほかの部分の外枠の箱の中にいくつ入っているか（入れ子の深さ）で、足すか引くかを決める（目安）
    const boxes = parts.map((pt) => boundsOf(pt));
    parts.forEach((part, i) => {
      const b = boxes[i]!;
      let depth = 0;
      boxes.forEach((o, j) => {
        if (j !== i && o[0] <= b[0] && o[1] <= b[1] && o[2] >= b[2] && o[3] >= b[3] && area(o) > area(b)) depth++;
      });
      sum += (depth % 2 === 0 ? 1 : -1) * Math.abs(signedPolygonArea(clipPolygonToRect(part, r)));
    });
  }
  return Math.min(boxArea, Math.max(0, sum));
}

/** 外枠の箱が重なり合う部分どうしを、1つのまとまりにする（離れた四角は別の覆いにするため） */
function groupOverlapping(parts: Point[][]): Point[][][] {
  const boxes = parts.map((p) => boundsOf(p));
  const parent = parts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (rectsOverlap(boxes[i]!, boxes[j]!)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Point[][]>();
  parts.forEach((p, i) => {
    const g = find(i);
    groups.set(g, [...(groups.get(g) ?? []), p]);
  });
  return [...groups.values()];
}

/** 線の1本（p0→p1）を、太さ w の四角（向きは線のまま）にする */
function segmentQuad(p0: Point, p1: Point, half: number): Point[] | null {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len <= 0 || half <= 0) return null;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  return [
    [p0[0] + nx, p0[1] + ny],
    [p1[0] + nx, p1[1] + ny],
    [p1[0] - nx, p1[1] - ny],
    [p0[0] - nx, p0[1] - ny],
  ];
}
export type UncheckedImage = { reason: "unsupported_filter" | "too_large" | "unsupported_color" | "broken" };
export type GlyphBox = {
  seq: number;
  rect: Rect;
  isSpace: boolean;
  text: string;
  clip?: Rect;
  /** フォントの番号（ページの中で、読んだ順）と字の番号（1.7.0 から。中身の読めない字を比べるため） */
  fontId?: number;
  code?: number;
  /** 回したり傾けたりして描いた字か（1.8.0 から。測るときだけ使う） */
  rotated?: boolean;
  /** 描き方 3・7（塗りも輪郭もしない）の字（1.11.0 から）。濃くない覆い（opaque）の下では数えない（文字認識の層など） */
  invisible?: boolean;
};
/**
 * 濃い覆いのあとに、その上に描いた字の形の塗り（曲線を含む、濃くない色の塗り）の真ん中（1.8.0 から）。
 * アウトライン化した白抜きの字を見分けるため。濃い覆いに重なるものだけを持つ
 */
export type LaterMark = { seq: number; cx: number; cy: number };
/** 画像を置いた所（1.5.0 から）。ctm は単位の正方形を、ページの座標に移す行列 */
export type ImagePlacement = {
  seq: number;
  rect: Rect;
  ctm: Matrix;
  stream: PDFStream;
  colorSpaces: PDFDict | undefined;
  /** 型抜き（ImageMask）のときに塗る色の明るさ */
  fillLuminance: number | null;
  /** 置いた形（回した画像など）。ないときは rect の箱そのもの */
  shape?: CoverShape;
  /** このルールで解けない圧縮の画像なら、uncheckedImages の何番目か（あとで PDF.js で確かめるため） */
  pendingUnchecked?: number;
  /**
   * 濃い画像（字の上に貼った黒い画像など）かを確かめる必要があるか（1.9.0 から）。
   * 先に描いた字か画像に重なるときだけ true。false の画像は、画像の層で覆いの下になったときにだけ解く
   */
  needDark: boolean;
  /** 濃い画像だったときに、覆いとして数える種類（注釈の見た目の中なら annotation） */
  coverKind: CoverKind;
  /** 切り抜き（W）の外枠の箱（1.6.0 から） */
  clip?: Rect;
};
export type PageScan = {
  covers: Cover[];
  glyphs: GlyphBox[];
  operations: number;
  uncheckedImages: UncheckedImage[];
  /** 画像を置いた所（1.5.0 から） */
  images: ImagePlacement[];
  /** 濃い覆いの上に描いた、字の形の塗り（1.8.0 から） */
  marks: LaterMark[];
  /**
   * 白い覆いの上に、あとから不透明に描いた塗り・線の形（1.10.0 から）。色・太さを問わない。
   * 集めた数が上限（maxOverPaintPerPage）を超えたページは null（使わず、1.9.0 までの測り方に戻す）
   */
  overPaint: OverPaint[] | null;
  /**
   * 図形の層（1.13.0 から）：createPageScanner に渡した箱（白い四角の注釈の箱）ごとの、下にあるページの中身の道の数と線分の数。
   * 箱を渡さなかったときは空
   */
  vectorCounts: VectorCount[];
};
/** 図形の層の、1つの箱の下の道（塗り・線を描いた命令1つ）の数と、その線分の数（1.13.0 から） */
export type VectorCount = { paths: number; segments: number };
/** 白い覆いの上に描いたものの形。after 以下の順番（seq）の覆いより、あとに描いた */
export type OverPaint = { after: number; rect: Rect; parts: Point[][]; clip?: Rect };

export class TooManyOperations extends Error {}
/** 先に描いた字に重なる濃い塗りが多すぎる（1.3.0 から） */
export class TooManyCovers extends Error {}

type Color = { luminance: number | null };

type GState = {
  ctm: Matrix;
  fill: Color;
  stroke: Color;
  fillAlpha: number;
  strokeAlpha: number;
  lineWidth: number;
  fillSpace: number; // 色の成分の数（0 は分からない色空間）
  strokeSpace: number;
  font: FontInfo | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  /** 切り抜き（W・部品の BBox）の外枠の箱（ページの座標）。null は切り抜きなし（1.6.0 から）。形は持たず、箱で近似する */
  clip: Rect | null;
  /** 重ね方（/BM）がふつう（Normal・Compatible）か（1.11.0 から）。乗算などは、濃くない色では下が透ける */
  blendNormal: boolean;
  /** 字の描き方（Tr）（1.11.0 から） */
  textMode: number;
  /** やわらかい型抜き（ExtGState の /SMask）がかかっているか（1.11.0 から） */
  softMask: boolean;
  /** 塗りの色がタイルの模様で、中に字を描く命令があるとき（1.12.0 から。塗った所にタイルを並べて字の箱を作る） */
  fillTiling?: NonNullable<PatternPaint["tiling"]>;
  /** この中身の流れの、はじめの行列（模様の空間の基準。1.12.0 から） */
  base: Matrix;
};

const MAX_FORM_DEPTH = 12;

/** 型抜き（ImageMask・/Mask・/SMask）のない画像か（1.11.0 から）。型抜きがあると、下が透ける所がある */
function isOpaqueImage(ctx: PDFContext, img: PDFStream): boolean {
  const d = img.dict;
  const flag = d.lookup(PDFName.of("ImageMask"));
  if (flag && flag.toString() === "true") return false;
  if (d.get(PDFName.of("Mask")) !== undefined) return false;
  const sm = d.get(PDFName.of("SMask"));
  if (sm !== undefined && !(ctx.lookup(sm) instanceof PDFName)) return false;
  return true;
}

/** 切り抜きを、箱 r でさらに狭める。重ならなければ、何も見えない（幅 0 の箱） */
function narrowClip(clip: Rect | null, r: Rect): Rect {
  if (!clip) return r;
  const out: Rect = [Math.max(clip[0], r[0]), Math.max(clip[1], r[1]), Math.min(clip[2], r[2]), Math.min(clip[3], r[3])];
  return out[0] < out[2] && out[1] < out[3] ? out : [out[0], out[1], out[0], out[1]];
}

function cloneState(s: GState): GState {
  return { ...s, fill: { ...s.fill }, stroke: { ...s.stroke } };
}

/** 色の成分から明るさ（0＝黒、1＝白）を出す。分からない色空間なら null */
export function luminanceOf(components: number[], space: number): number | null {
  const c = components.map((v) => Math.min(1, Math.max(0, v)));
  if (space === 1 && c.length >= 1) return c[0]!;
  if (space === 3 && c.length >= 3) return 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]!;
  if (space === 4 && c.length >= 4) {
    const [cy, m, y, k] = c as [number, number, number, number];
    const r = (1 - cy) * (1 - k);
    const g = (1 - m) * (1 - k);
    const b = (1 - y) * (1 - k);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return null;
}

function nums(args: Tok[]): number[] {
  return args.flatMap((a) => (a.t === "num" ? [a.v] : []));
}

export function contentBytes(ctx: PDFContext, obj: PDFObject | undefined): Uint8Array {
  const v = obj ? ctx.lookup(obj) : undefined;
  const one = (s: PDFObject | undefined): Uint8Array => {
    const x = s ? ctx.lookup(s) : undefined;
    if (x instanceof PDFStream) return decodeStream(x);
    return new Uint8Array(0);
  };
  if (v instanceof PDFArray) {
    const parts = v.asArray().map(one);
    const total = parts.reduce((s, p) => s + p.length + 1, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
      out[at++] = 0x0a; // 区切り（命令が2つのストリームにまたがらないように）
    }
    return out;
  }
  return one(obj);
}

/** 色空間の名前（または配列）から、成分の数を出す */
function componentsOfSpace(ctx: PDFContext, resources: PDFDict | undefined, name: string): number {
  if (name === "DeviceGray" || name === "G" || name === "CalGray") return 1;
  if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return 3;
  if (name === "DeviceCMYK" || name === "CMYK") return 4;
  const spaces = resources?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  const def = spaces ? ctx.lookup(spaces.get(PDFName.of(name))) : undefined;
  if (def instanceof PDFName) return componentsOfSpace(ctx, undefined, def.decodeText());
  if (def instanceof PDFArray) {
    const kind = ctx.lookup(def.get(0));
    const k = kind instanceof PDFName ? kind.decodeText() : "";
    if (k === "ICCBased") {
      const st = ctx.lookup(def.get(1));
      const n = st instanceof PDFStream ? st.dict.lookup(PDFName.of("N")) : undefined;
      return n instanceof PDFNumber ? n.asNumber() : 0;
    }
    if (k === "CalGray") return 1;
    if (k === "CalRGB") return 3;
  }
  return 0; // Pattern・Separation・Indexed・Lab などは、いまは見分けない
}

export type PageScanner = {
  /** ページの命令の列（または注釈の見た目）を読む。coverKind は、そこで見つけた塗りを何の覆いとして数えるか */
  run(data: Uint8Array, res: PDFDict | undefined, ctm: Matrix, coverKind: CoverKind): void;
  /** 命令を読まずに覆いを足す（未適用の墨消し注釈など）。いま読んだものより上に重なる。濃くも白っぽくもない色なら足さない */
  addCover(rect: Rect, kind: CoverKind, how: Cover["how"], luminance: number): void;
  /** 描いた順番（seq）の決まった覆いを、あとから足す（PDF.js で解いた画像が濃かったとき。1.5.0 から） */
  addLateCover(cover: Cover): void;
  result(): PageScan;
};

export function createPageScanner(ctx: PDFContext, settings: P6TextSettings, vectorTargets: Rect[] = []): PageScanner {
  const covers: Cover[] = [];
  // 図形の層（1.13.0 から）：白い四角の注釈の箱ごとに、下にある道を数える。道そのものは持たない（重いページでメモリを使わないため）
  const vectorCounts: VectorCount[] = vectorTargets.map(() => ({ paths: 0, segments: 0 }));
  const glyphs: GlyphBox[] = [];
  // 字の位置の索引（マス目）。覆いになりうるのは、先に描いた字に重なる塗りだけなので、
  // 重ならない塗りは覆いの一覧に入れずに捨てる（図形の多い重いページで、メモリと時間を抑えるため。1.3.0 から）
  const CELL = 32;
  const MAX_CELLS = 4096;
  const grid = new Map<number, GlyphBox[]>();
  const wide: GlyphBox[] = []; // マス目に入れきれない大きな字
  const cellKey = (cx: number, cy: number) => cx * 100_003 + cy;
  const cellsOf = (r: Rect) => {
    const x0 = Math.floor(r[0] / CELL);
    const x1 = Math.floor(r[2] / CELL);
    const y0 = Math.floor(r[1] / CELL);
    const y1 = Math.floor(r[3] / CELL);
    return { x0, x1, y0, y1, n: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };
  const addGlyph = (g: GlyphBox) => {
    glyphs.push(g);
    const c = cellsOf(g.rect);
    if (!Number.isFinite(c.n) || c.n > 16) {
      wide.push(g);
      return;
    }
    for (let cx = c.x0; cx <= c.x1; cx++) {
      for (let cy = c.y0; cy <= c.y1; cy++) {
        const k = cellKey(cx, cy);
        const list = grid.get(k);
        if (list) list.push(g);
        else grid.set(k, [g]);
      }
    }
  };
  const overlapsAnyGlyph = (r: Rect): boolean => {
    const hit = (g: GlyphBox) => !g.isSpace && g.rect[0] < r[2] && r[0] < g.rect[2] && g.rect[1] < r[3] && r[1] < g.rect[3];
    if (wide.some(hit)) return true;
    const c = cellsOf(r);
    if (!Number.isFinite(c.n) || c.n > MAX_CELLS) return glyphs.some(hit); // 大きな覆いは、字を全部見る
    for (let cx = c.x0; cx <= c.x1; cx++) {
      for (let cy = c.y0; cy <= c.y1; cy++) {
        const list = grid.get(cellKey(cx, cy));
        if (list && list.some(hit)) return true;
      }
    }
    return false;
  };
  // 画像を置いた所。覆いの下に画像があるかを見るため（1.5.0 から）
  const images: ImagePlacement[] = [];
  const overlapsEarlierImage = (r: Rect): boolean => images.some((im) => rectsOverlap(im.rect, r));
  // 濃い覆いは、先に描いた字か画像に重なるものだけ。白っぽい覆いは、先に描いた画像に重なるものだけ（字の層では使わない）
  // 濃い覆いの位置の索引（マス目）。覆いの上に描いた字の形の塗りを探すため（1.8.0 から）
  const darkGrid = new Map<number, Rect[]>();
  const darkWide: Rect[] = [];
  const indexDark = (r: Rect) => {
    const c = cellsOf(r);
    if (!Number.isFinite(c.n) || c.n > 256) {
      darkWide.push(r);
      return;
    }
    for (let cx = c.x0; cx <= c.x1; cx++) {
      for (let cy = c.y0; cy <= c.y1; cy++) {
        const k = cellKey(cx, cy);
        const list = darkGrid.get(k);
        if (list) list.push(r);
        else darkGrid.set(k, [r]);
      }
    }
  };
  const onDarkCover = (x: number, y: number): boolean => {
    const inside = (r: Rect) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
    if (darkWide.some(inside)) return true;
    return (darkGrid.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))) ?? []).some(inside);
  };
  const marks: LaterMark[] = [];
  const MAX_MARKS = 200_000;
  // 白い覆いの箱と、その上にあとから描いたものの形（1.10.0 から）
  const lightRects: Rect[] = [];
  const overPaint: OverPaint[] = [];
  let overPaintOverflow = false;
  const addOverPaint = (after: number, parts: Point[][], clip: Rect | null) => {
    if (overPaintOverflow) return;
    const rect = boundsOf(parts.flat());
    if (!lightRects.some((l) => rectsOverlap(l, rect))) return;
    if (overPaint.length >= settings.maxOverPaintPerPage) {
      overPaintOverflow = true;
      overPaint.length = 0;
      return;
    }
    overPaint.push({ after, rect, parts, ...(clip ? { clip } : {}) });
  };
  const pushCover = (c: Cover) => {
    if (c.tone === "opaque") {
      // 濃くない覆い（1.11.0 から）：先に描いた字に重なるものだけ。字の層でだけ使う
      if (!overlapsAnyGlyph(c.rect)) return;
      if (covers.length >= settings.maxCoversPerPage) throw new TooManyCovers();
      covers.push(c);
      return;
    }
    if (c.tone === "dark" ? !overlapsAnyGlyph(c.rect) && !overlapsEarlierImage(c.rect) : !overlapsEarlierImage(c.rect)) return;
    if (covers.length >= settings.maxCoversPerPage) throw new TooManyCovers();
    covers.push(c);
    if (c.tone === "dark") indexDark(c.rect);
    else lightRects.push(c.rect);
  };
  const uncheckedImages: UncheckedImage[] = [];
  let seq = 0;
  let opCount = 0;
  const fontCache = new Map<PDFObject, FontInfo>();
  const fontIds = new Map<FontInfo, number>();
  const fontIdOf = (f: FontInfo) => {
    let id = fontIds.get(f);
    if (id === undefined) fontIds.set(f, (id = fontIds.size + 1));
    return id;
  };

  const run = (
    data: Uint8Array,
    res: PDFDict | undefined,
    start: GState,
    depth: number,
    seen: Set<PDFObject>,
    coverKind: CoverKind,
  ) => {
    let gs = cloneState(start);
    gs.base = gs.ctm; // 模様の空間は、この流れのはじめの座標を基準にする（PDF 1.7 §8.7.2）
    const stack: GState[] = [];
    // 道（パス）：いまの行列にかける前の点を、部分ごとに持つ
    let subpaths: { points: Point[]; curved: boolean; closed: boolean }[] = [];
    let current: { points: Point[]; curved: boolean; closed: boolean } | null = null;
    // 字の行列
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    // 次に道を閉じる命令（塗り・線・n）で、切り抜きにする（W・W*）
    let pendingClip = false;
    const clipOpt = (): { clip?: Rect } => (gs.clip ? { clip: gs.clip } : {});
    const takeClip = () => {
      if (!pendingClip) return;
      pendingClip = false;
      if (!isFiniteMatrix(gs.ctm)) return;
      const pts = subpaths.flatMap((sp) => sp.points.map(([x, y]) => apply(gs.ctm, x, y)));
      if (pts.length === 0) return;
      gs.clip = narrowClip(gs.clip, boundsOf(pts));
    };

    const startSub = (x: number, y: number) => {
      current = { points: [[x, y]], curved: false, closed: false };
      subpaths.push(current);
    };

    // 1.3.0 から：四角らしさで選ばず、塗った形そのもの（曲線は直線に分けたもの）を覆いとして持つ。
    // 字が隠れる割合は、形と字の箱の重なった面積で測る（coverageOf）。
    const paint = (doFill: boolean, doStroke: boolean, rule: "nonzero" | "evenodd" = "nonzero") => {
      if (!isFiniteMatrix(gs.ctm)) {
        pendingClip = false;
        subpaths = [];
        current = null;
        return;
      }
      const devs = subpaths.filter((sp) => sp.points.length >= 2).map((sp) => ({ sp, dev: sp.points.map(([x, y]) => apply(gs.ctm, x, y)) }));
      // 図形の層（1.13.0 から）：ページの中身（注釈の見た目は除く）で、白くない色で不透明に描いた道を、白い四角の注釈の箱ごとに数える。
      // 道の外枠の箱の半分以上が注釈の箱に入れば「下にある」とする（面積のない縦横の線は、真ん中で見る）
      if (vectorTargets.length > 0 && coverKind !== "annotation" && devs.length > 0) {
        const seen = (c: Color, alpha: number) => c.luminance !== null && c.luminance < settings.lightLuminanceMin && alpha >= settings.opacityMin;
        if ((doFill && seen(gs.fill, gs.fillAlpha)) || (doStroke && seen(gs.stroke, gs.strokeAlpha))) {
          const box = boundsOf(devs.flatMap((d) => d.dev));
          const a = area(box);
          let segments = 0;
          for (const { sp } of devs) segments += sp.points.length - 1 + (sp.closed ? 1 : 0);
          vectorTargets.forEach((t, i) => {
            const under =
              a > 0
                ? intersectionArea(box, t) >= 0.5 * a
                : (box[0] + box[2]) / 2 >= t[0] && (box[0] + box[2]) / 2 <= t[2] && (box[1] + box[3]) / 2 >= t[1] && (box[1] + box[3]) / 2 <= t[3];
            if (under) {
              vectorCounts[i]!.paths++;
              vectorCounts[i]!.segments += segments;
            }
          });
        }
      }
      // 白い覆いの上に不透明に描いたものの形（1.10.0 から。色・太さを問わない）。この塗り自身の覆いより前の覆いだけに効くよう、
      // いまの順番（paintStart）を持たせる。線は、端の丸み・角を含めるよう、両端を太さの半分だけ延ばす
      const paintStart = seq;
      if (lightRects.length > 0 && !overPaintOverflow) {
        const clip = gs.clip;
        if (doFill && gs.fill.luminance !== null && gs.fillAlpha >= settings.opacityMin) {
          for (const { dev } of devs) if (dev.length >= 3 && area(boundsOf(dev)) > 0) addOverPaint(paintStart, [dev], clip);
        }
        if (doStroke && gs.stroke.luminance !== null && gs.strokeAlpha >= settings.opacityMin) {
          const half = (gs.lineWidth * scaleOf(gs.ctm)) / 2;
          if (half > 0) {
            for (const { sp, dev } of devs) {
              const pts = sp.closed ? [...dev, dev[0]!] : dev;
              for (let k = 0; k + 1 < pts.length; k++) {
                const a = pts[k]!;
                const b = pts[k + 1]!;
                const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
                if (!(len > 0)) continue;
                const ex = ((b[0] - a[0]) / len) * half;
                const ey = ((b[1] - a[1]) / len) * half;
                const q = segmentQuad([a[0] - ex, a[1] - ey], [b[0] + ex, b[1] + ey], half);
                if (q) addOverPaint(paintStart, [q], clip);
              }
            }
          }
        }
      }
      if (doFill) {
        const lum = gs.fill.luminance;
        // 濃い塗り（字の層・画像の層）と、白っぽい不透明な塗り（画像の層だけ。1.5.0 から）
        const tone: Cover["tone"] | null =
          lum === null ? null : lum <= settings.darkLuminanceMax ? "dark" : lum >= settings.lightLuminanceMin && images.length > 0 ? "light" : null;
        if (lum !== null && tone && gs.fillAlpha >= settings.opacityMin) {
          const parts = devs.map((d) => d.dev).filter((d) => d.length >= 3 && area(boundsOf(d)) > 0);
          for (const group of groupOverlapping(parts)) {
            const box = boundsOf(group.flat());
            // 縦横の四角1つなら、形を持たずに箱で測る（これまでと同じ結果になる）
            const plainRect = group.length === 1 && group[0]!.length === 4 && Math.abs(Math.abs(signedPolygonArea(group[0]!)) - area(box)) <= 1e-6 * Math.max(1, area(box));
            pushCover({ seq: ++seq, rect: box, kind: coverKind, how: "fill", tone, luminance: lum, ...(plainRect ? {} : { shape: { parts: group, rule } }), ...clipOpt() });
          }
        }
      }
      // 濃くない色の、不透明でふつうの重ね方の塗り（1.11.0 から）。字の層の覆いにする（覆いの下の字は、色によらず P6）
      if (doFill && gs.fill.luminance !== null && gs.fill.luminance > settings.darkLuminanceMax && gs.fillAlpha >= settings.opacityMin && gs.blendNormal && !gs.softMask) {
        const lum = gs.fill.luminance;
        const parts = devs.map((d) => d.dev).filter((d) => d.length >= 3 && area(boundsOf(d)) > 0);
        for (const group of groupOverlapping(parts)) {
          const box = boundsOf(group.flat());
          if (!overlapsAnyGlyph(box)) continue;
          const plainRect = group.length === 1 && group[0]!.length === 4 && Math.abs(Math.abs(signedPolygonArea(group[0]!)) - area(box)) <= 1e-6 * Math.max(1, area(box));
          pushCover({ seq: ++seq, rect: box, kind: coverKind, how: "fill", tone: "opaque", luminance: lum, ...(plainRect ? {} : { shape: { parts: group, rule } }), ...clipOpt() });
        }
      }
      // 濃い覆いの上の、字の形の塗り（白抜きの字をアウトライン化したもの）の真ん中を持つ（1.8.0 から）
      if (doFill && (darkWide.length > 0 || darkGrid.size > 0) && marks.length < MAX_MARKS) {
        const lum = gs.fill.luminance;
        if (lum !== null && lum > settings.darkLuminanceMax && gs.fillAlpha >= settings.opacityMin) {
          for (const { sp, dev } of devs) {
            if (!sp.curved || dev.length < 3 || marks.length >= MAX_MARKS) continue;
            const b = boundsOf(dev);
            const cx = (b[0] + b[2]) / 2;
            const cy = (b[1] + b[3]) / 2;
            if (onDarkCover(cx, cy)) marks.push({ seq: seq + 1, cx, cy });
          }
          if (marks.length > 0) seq++; // 覆いより後に描いたことが分かるよう、順番を進める
        }
      }
      if (doStroke) {
        const lum = gs.stroke.luminance;
        const half = (gs.lineWidth * scaleOf(gs.ctm)) / 2;
        // 細い線（太さが minStrokeWidth より細い）は、字を半分も隠せないので覆いにしない
        if (lum !== null && lum <= settings.darkLuminanceMax && gs.strokeAlpha >= settings.opacityMin && half * 2 >= settings.minStrokeWidth) {
          for (const { sp, dev } of devs) {
            const pts = sp.closed ? [...dev, dev[0]!] : dev;
            const quads: Point[][] = [];
            for (let k = 0; k + 1 < pts.length; k++) {
              const q = segmentQuad(pts[k]!, pts[k + 1]!, half);
              if (q) quads.push(q);
            }
            if (sp.curved) {
              // 曲線は、分けた直線をまとめて1つの覆いにする
              if (quads.length) pushCover({ seq: ++seq, rect: boundsOf(quads.flat()), kind: coverKind, how: "stroke", tone: "dark", luminance: lum, shape: { parts: quads, rule: "nonzero" }, ...clipOpt() });
            } else {
              // 直線は、1本ずつ別の覆いにする（これまでと同じ。縦横の線は箱そのもの）
              for (const q of quads) {
                const box = boundsOf(q);
                const axis = Math.abs(Math.abs(signedPolygonArea(q)) - area(box)) <= 1e-6 * Math.max(1, area(box));
                pushCover({ seq: ++seq, rect: box, kind: coverKind, how: "stroke", tone: "dark", luminance: lum, ...(axis ? {} : { shape: { parts: [q], rule: "nonzero" } }), ...clipOpt() });
              }
            }
          }
        }
      }
      // 字を描くタイルの模様で塗ったとき（1.12.0 から）：塗った所にタイルを並べ、タイルの中の字も字として持つ
      const tiling = gs.fillTiling;
      if (doFill && tiling && depth < MAX_FORM_DEPTH && !seen.has(tiling.stream) && devs.length) {
        const painted = boundsOf(devs.flatMap((d) => d.dev));
        const toDevice = multiply(tiling.matrix, gs.base);
        const inv = invert(toDevice);
        const tiles = inv && isFiniteMatrix(toDevice) ? tileRange(inv, painted, tiling, MAX_PATTERN_TILES) : null;
        if (tiles) {
          const nextSeen = new Set(seen);
          nextSeen.add(tiling.stream);
          for (const [i, j] of tiles) {
            const inner = cloneState(initial);
            inner.ctm = multiply([1, 0, 0, 1, i * tiling.xStep, j * tiling.yStep], toDevice);
            inner.clip = narrowClip(gs.clip, painted);
            run(tiling.data, tiling.resources ?? res, inner, depth + 1, nextSeen, coverKind);
          }
        }
      }
      takeClip(); // 切り抜きは、塗ったあとに効く
      subpaths = [];
      current = null;
    };

    // 画像：単位の正方形を、いまの行列で置いた所に描く。ほぼ全部が濃い画像なら覆いとする
    const paintImage = (img: PDFStream, imgRes: PDFDict | undefined) => {
      if (!isFiniteMatrix(gs.ctm)) return;
      if (gs.fillAlpha < settings.opacityMin) return;
      const dev = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 1, 1), apply(gs.ctm, 0, 1)];
      const box = boundsOf(dev);
      const boxArea = area(box);
      if (boxArea <= 0) return;
      // 回したり傾けたりして置いた画像は、置いた形（平行四辺形）を覆いの形にする（1.3.0 から）
      const imageShape: CoverShape | undefined =
        Math.abs(Math.abs(signedPolygonArea(dev)) - boxArea) <= 1e-6 * Math.max(1, boxArea) ? undefined : { parts: [dev], rule: "nonzero" };
      const colorSpaces = imgRes?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
      const input = {
        ctx,
        stream: img,
        colorSpaces,
        fillLuminance: gs.fill.luminance,
        darkLuminanceMax: settings.darkLuminanceMax,
        opacityMin: settings.opacityMin,
        maxImageBytes: settings.maxImageBytes,
        maxImagePixels: settings.maxImagePixels,
      };
      // 1.9.0 から：濃い画像かを確かめるのは、先に描いた字か画像に重なるときだけ（覆いになりうるのは、それだけ）。
      // ほかの画像は、ここでは解かない（読めそうかだけを、解かずに確かめる）。スキャンした PDF の多くのページで、画像を解かずに済む
      const needDark = overlapsAnyGlyph(box) || overlapsEarlierImage(box);
      const probe = probeImagePixels(input);
      const m = probe.kind === "unknown" ? probe : needDark ? measureImageDarkness(input) : null;
      const mySeq = ++seq;
      const kind: CoverKind = coverKind === "annotation" ? "annotation" : "image";
      if (m && m.kind === "measured" && m.darkFraction >= settings.darkImageFractionMin) {
        pushCover({ seq: mySeq, rect: box, kind, how: "image", tone: "dark", luminance: 1 - m.darkFraction, ...(imageShape ? { shape: imageShape } : {}), ...clipOpt() });
      } else if (gs.blendNormal && !gs.softMask && isOpaqueImage(ctx, img) && overlapsAnyGlyph(box)) {
        // 型抜きのない不透明な画像（1.11.0 から）：色や、解けるかどうかにかかわらず、下の字を隠す
        pushCover({ seq: mySeq, rect: box, kind, how: "image", tone: "opaque", luminance: m && m.kind === "measured" ? 1 - m.darkFraction : 1, ...(imageShape ? { shape: imageShape } : {}), ...clipOpt() });
      }
      if (images.length >= settings.maxImagesPerPage) throw new TooManyCovers();
      const placement: ImagePlacement = {
        seq: mySeq,
        rect: box,
        ctm: gs.ctm,
        stream: img,
        colorSpaces,
        fillLuminance: gs.fill.luminance,
        coverKind: kind,
        needDark,
        ...(imageShape ? { shape: imageShape } : {}),
        ...clipOpt(),
      };
      if (m && m.kind === "unknown") {
        uncheckedImages.push({ reason: m.reason });
        if (m.reason === "unsupported_filter") placement.pendingUnchecked = uncheckedImages.length - 1;
      }
      images.push(placement);
    };

    const showText = (bytes: Uint8Array) => {
      const font = gs.font;
      if (!font) return;
      for (const g of font.decode(bytes)) {
        const trm = multiply(
          [gs.fontSize * gs.hScale, 0, 0, gs.fontSize, 0, gs.rise],
          multiply(tm, gs.ctm),
        );
        // 縦書き（2026-11-05 から）：字は縦の原点から、横は幅の半分ずつ左右に、縦は原点から 1em 下へ広がる（PDF 1.7 §9.7.4.3）
        const v = font.vertical;
        if (isFiniteMatrix(trm) && g.width > 0) {
          const x0 = v ? -g.width / 2 : 0;
          const x1 = v ? g.width / 2 : g.width;
          const y0 = v ? font.descent - v.vy : font.descent;
          const y1 = v ? font.ascent - v.vy : font.ascent;
          const corners: Point[] = [apply(trm, x0, y0), apply(trm, x1, y0), apply(trm, x1, y1), apply(trm, x0, y1)];
          addGlyph({
            seq: ++seq,
            rect: boundsOf(corners),
            isSpace: g.isSpace,
            text: g.text,
            fontId: fontIdOf(font),
            code: g.code,
            ...(Math.abs(trm[1]) > 1e-9 || Math.abs(trm[2]) > 1e-9 ? { rotated: true } : {}),
            ...(gs.textMode === 3 || gs.textMode === 7 ? { invisible: true } : {}),
            ...clipOpt(),
          });
        }
        if (v) {
          const ty = v.w1 * gs.fontSize - gs.charSpacing;
          tm = multiply([1, 0, 0, 1, 0, ty], tm);
          continue;
        }
        const tx = (g.width * gs.fontSize + gs.charSpacing + (g.isWordSpace ? gs.wordSpacing : 0)) * gs.hScale;
        tm = multiply([1, 0, 0, 1, tx, 0], tm);
      }
    };

    const setColor = (target: "fill" | "stroke", comps: number[], space: number) => {
      const lum = luminanceOf(comps, space);
      if (target === "fill") {
        gs.fill = { luminance: lum };
        delete gs.fillTiling;
      } else gs.stroke = { luminance: lum };
    };
    // 模様の色（1.12.0 から）：すき間なく不透明に塗る模様は覆いの色にする。明るさが分からなければ、濃くない覆い（0.5）として扱う
    const setPattern = (target: "fill" | "stroke", args: Tok[]) => {
      const name = args.map(nameArg).find((x) => x !== undefined) ?? "";
      const p = readPattern(ctx, res, name, nums(args));
      const lum = p && p.covers ? (p.luminance ?? 0.5) : null;
      if (target === "fill") {
        gs.fill = { luminance: lum };
        if (p?.tiling) gs.fillTiling = p.tiling;
        else delete gs.fillTiling;
      } else gs.stroke = { luminance: lum };
    };

    for (const { op, args } of operations(data)) {
      if (++opCount > settings.maxOperationsPerPage) throw new TooManyOperations();
      const a = nums(args);
      switch (op) {
        // 状態
        case "q":
          stack.push(cloneState(gs));
          if (stack.length > 1000) stack.shift();
          break;
        case "Q":
          gs = stack.pop() ?? gs;
          break;
        case "cm":
          if (a.length >= 6) gs.ctm = multiply(a.slice(0, 6) as Matrix, gs.ctm);
          break;
        case "w":
          if (a.length >= 1) gs.lineWidth = Math.abs(a[0]!);
          break;
        case "gs": {
          const name = nameArg(args[0]);
          const ext = res?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
          const d = name && ext ? ctx.lookup(ext.get(PDFName.of(name))) : undefined;
          if (d instanceof PDFDict) {
            const ca = d.lookup(PDFName.of("ca"));
            const CA = d.lookup(PDFName.of("CA"));
            const lw = d.lookup(PDFName.of("LW"));
            if (ca instanceof PDFNumber) gs.fillAlpha = ca.asNumber();
            if (CA instanceof PDFNumber) gs.strokeAlpha = CA.asNumber();
            if (lw instanceof PDFNumber) gs.lineWidth = Math.abs(lw.asNumber());
            const bm = d.lookup(PDFName.of("BM"));
            const bmName = bm instanceof PDFName ? bm : bm instanceof PDFArray ? bm.lookup(0) : undefined;
            if (bmName instanceof PDFName) gs.blendNormal = ["Normal", "Compatible"].includes(bmName.decodeText());
            // やわらかい型抜き（/SMask）のある状態も、下が透けうるので、ふつうの重ね方とみなさない
            const smk = d.lookup(PDFName.of("SMask"));
            if (smk instanceof PDFDict) gs.softMask = true;
            else if (smk instanceof PDFName) gs.softMask = false;
          }
          break;
        }
        // 色
        case "g":
          gs.fillSpace = 1;
          setColor("fill", a, 1);
          break;
        case "G":
          gs.strokeSpace = 1;
          setColor("stroke", a, 1);
          break;
        case "rg":
          gs.fillSpace = 3;
          setColor("fill", a, 3);
          break;
        case "RG":
          gs.strokeSpace = 3;
          setColor("stroke", a, 3);
          break;
        case "k":
          gs.fillSpace = 4;
          setColor("fill", a, 4);
          break;
        case "K":
          gs.strokeSpace = 4;
          setColor("stroke", a, 4);
          break;
        case "cs":
        case "CS": {
          const n = componentsOfSpace(ctx, res, nameArg(args[0]) ?? "");
          // 色空間を決めると、色は「黒」（成分がすべて 0。CMYK は K=1）に戻る
          const init = n === 4 ? [0, 0, 0, 1] : new Array(n).fill(0);
          if (op === "cs") {
            gs.fillSpace = n;
            setColor("fill", init, n);
          } else {
            gs.strokeSpace = n;
            setColor("stroke", init, n);
          }
          break;
        }
        case "sc":
        case "scn":
          if (args.some((x) => nameArg(x) !== undefined)) setPattern("fill", args); // 模様（Pattern。1.12.0 から読む）
          else setColor("fill", a, gs.fillSpace);
          break;
        case "SC":
        case "SCN":
          if (args.some((x) => nameArg(x) !== undefined)) setPattern("stroke", args);
          else setColor("stroke", a, gs.strokeSpace);
          break;
        // シェーディング（sh。1.12.0 から）：いまの切り抜きの中（シェーディングの /BBox があれば、その中）を塗る
        case "sh": {
          const shName = nameArg(args[0]);
          const shObj = shName ? res?.lookupMaybe(PDFName.of("Shading"), PDFDict)?.get(PDFName.of(shName)) : undefined;
          const sh = readShading(ctx, shObj);
          if (!sh || !isFiniteMatrix(gs.ctm) || gs.fillAlpha < settings.opacityMin || !gs.blendNormal || gs.softMask) break;
          let rect: Rect | null = gs.clip;
          if (sh.bbox) {
            const b = sh.bbox;
            const box = boundsOf([apply(gs.ctm, b[0], b[1]), apply(gs.ctm, b[2], b[1]), apply(gs.ctm, b[2], b[3]), apply(gs.ctm, b[0], b[3])]);
            rect = rect ? narrowClip(rect, box) : box;
          }
          if (!rect || area(rect) <= 0) break; // 切り抜きも範囲もない sh（ページ全体）は、覆いの形が決まらないので見ない
          const lum = sh.luminance ?? 0.5;
          pushCover({ seq: ++seq, rect, kind: coverKind, how: "fill", tone: lum <= settings.darkLuminanceMax ? "dark" : "opaque", luminance: lum });
          break;
        }
        // 埋め込みの画像（1.12.0 から）：外の画像と同じに、濃さを測って覆いにする
        case "BI": {
          const img = inlineImageStream(ctx, args);
          if (img) paintImage(img, res);
          break;
        }
        // 道
        case "m":
          if (a.length >= 2) startSub(a[0]!, a[1]!);
          break;
        case "l":
          if (a.length >= 2) {
            if (!current) startSub(a[0]!, a[1]!);
            else (current as { points: Point[] }).points.push([a[0]!, a[1]!]);
          }
          break;
        case "c":
        case "v":
        case "y":
          if ((op === "c" && a.length >= 6) || (op !== "c" && a.length >= 4)) {
            if (!current) startSub(a[a.length - 2]!, a[a.length - 1]!);
            const cur = current as unknown as { points: Point[]; curved: boolean };
            const p0 = cur.points[cur.points.length - 1]!;
            const p3: Point = [a[a.length - 2]!, a[a.length - 1]!];
            // v：1つめの制御点が今の点。y：2つめの制御点が終点
            const p1: Point = op === "v" ? p0 : [a[0]!, a[1]!];
            const p2: Point = op === "c" ? [a[2]!, a[3]!] : op === "v" ? [a[0]!, a[1]!] : p3;
            cur.curved = true;
            cur.points.push(...flattenCubic(p0, p1, p2, p3, CURVE_SEGMENTS));
          }
          break;
        case "h":
          if (current) (current as { closed: boolean }).closed = true;
          break;
        case "re":
          if (a.length >= 4) {
            const [x, y, w, h] = a as [number, number, number, number];
            subpaths.push({ points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], curved: false, closed: true });
            current = null;
          }
          break;
        case "f":
        case "F":
          paint(true, false);
          break;
        case "f*":
          paint(true, false, "evenodd");
          break;
        case "S":
          paint(false, true);
          break;
        case "s":
          if (current) (current as { closed: boolean }).closed = true;
          paint(false, true);
          break;
        case "B":
          paint(true, true);
          break;
        case "B*":
          paint(true, true, "evenodd");
          break;
        case "b":
        case "b*":
          if (current) (current as { closed: boolean }).closed = true;
          paint(true, true, op === "b*" ? "evenodd" : "nonzero");
          break;
        case "W":
        case "W*":
          pendingClip = true;
          break;
        case "n":
          takeClip();
          subpaths = [];
          current = null;
          break;
        // 字
        case "BT":
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case "Tf": {
          const name = nameArg(args[0]);
          const size = numArg(args[1]);
          if (size !== undefined) gs.fontSize = size;
          const fonts = res?.lookupMaybe(PDFName.of("Font"), PDFDict);
          const ref = name && fonts ? fonts.get(PDFName.of(name)) : undefined;
          if (ref) {
            let f = fontCache.get(ref);
            if (!f) {
              f = readFont(ctx, ref);
              fontCache.set(ref, f);
            }
            gs.font = f;
          } else gs.font = null;
          break;
        }
        case "Tc":
          if (a.length >= 1) gs.charSpacing = a[0]!;
          break;
        case "Tw":
          if (a.length >= 1) gs.wordSpacing = a[0]!;
          break;
        case "Tz":
          if (a.length >= 1) gs.hScale = a[0]! / 100;
          break;
        case "TL":
          if (a.length >= 1) gs.leading = a[0]!;
          break;
        case "Ts":
          if (a.length >= 1) gs.rise = a[0]!;
          break;
        case "Tr":
          if (a.length >= 1) gs.textMode = a[0]!;
          break;
        case "Td":
          if (a.length >= 2) {
            tlm = multiply([1, 0, 0, 1, a[0]!, a[1]!], tlm);
            tm = tlm;
          }
          break;
        case "TD":
          if (a.length >= 2) {
            gs.leading = -a[1]!;
            tlm = multiply([1, 0, 0, 1, a[0]!, a[1]!], tlm);
            tm = tlm;
          }
          break;
        case "Tm":
          if (a.length >= 6) {
            tlm = a.slice(0, 6) as Matrix;
            tm = tlm;
          }
          break;
        case "T*":
          tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
          tm = tlm;
          break;
        case "Tj": {
          const b = bytesArg(args[0]);
          if (b) showText(b);
          break;
        }
        case "'": {
          tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
          tm = tlm;
          const b = bytesArg(args[0]);
          if (b) showText(b);
          break;
        }
        case '"': {
          const aw = numArg(args[0]);
          const ac = numArg(args[1]);
          if (aw !== undefined) gs.wordSpacing = aw;
          if (ac !== undefined) gs.charSpacing = ac;
          tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
          tm = tlm;
          const b = bytesArg(args[2]);
          if (b) showText(b);
          break;
        }
        case "TJ": {
          const arr = arrArg(args[0]) ?? [];
          for (const item of arr) {
            if (item.t === "num") {
              if (gs.font?.vertical) {
                tm = multiply([1, 0, 0, 1, 0, (-item.v / 1000) * gs.fontSize], tm); // 縦書きは、下へ詰める・空ける
              } else {
                const tx = (-item.v / 1000) * gs.fontSize * gs.hScale;
                tm = multiply([1, 0, 0, 1, tx, 0], tm);
              }
            } else {
              const b = bytesArg(item);
              if (b) showText(b);
            }
          }
          break;
        }
        // 部品（Form XObject）
        case "Do": {
          if (depth >= MAX_FORM_DEPTH) break;
          const name = nameArg(args[0]);
          const xo = res?.lookupMaybe(PDFName.of("XObject"), PDFDict);
          const ref = name && xo ? xo.get(PDFName.of(name)) : undefined;
          const obj = ref ? ctx.lookup(ref) : undefined;
          if (!(obj instanceof PDFStream) || !ref || seen.has(ref)) break;
          const sub = obj.dict.lookup(PDFName.of("Subtype"));
          if (sub instanceof PDFName && sub.decodeText() === "Image") {
            paintImage(obj, res);
            break;
          }
          if (!(sub instanceof PDFName) || sub.decodeText() !== "Form") break;
          const mObj = obj.dict.lookup(PDFName.of("Matrix"));
          let m: Matrix = IDENTITY;
          if (mObj instanceof PDFArray && mObj.size() === 6) {
            const vals = mObj.asArray().map((o) => ctx.lookup(o));
            if (vals.every((v) => v instanceof PDFNumber)) m = vals.map((v) => (v as PDFNumber).asNumber()) as Matrix;
          }
          const subRes = obj.dict.lookupMaybe(PDFName.of("Resources"), PDFDict) ?? res;
          const data2 = decodeStream(obj);
          const inner = cloneState(gs);
          inner.ctm = multiply(m, gs.ctm);
          // 部品の BBox の外は描かれない（1.6.0 から。切り抜きとして扱う）
          const bboxObj = obj.dict.lookup(PDFName.of("BBox"));
          if (bboxObj instanceof PDFArray && bboxObj.size() === 4 && isFiniteMatrix(inner.ctm)) {
            const b = bboxObj.asArray().map((o) => ctx.lookup(o));
            if (b.every((v) => v instanceof PDFNumber)) {
              const [bx0, by0, bx1, by1] = b.map((v) => (v as PDFNumber).asNumber()) as [number, number, number, number];
              if ([bx0, by0, bx1, by1].every(Number.isFinite)) {
                const corners: Point[] = [apply(inner.ctm, bx0, by0), apply(inner.ctm, bx1, by0), apply(inner.ctm, bx1, by1), apply(inner.ctm, bx0, by1)];
                inner.clip = narrowClip(inner.clip, boundsOf(corners));
              }
            }
          }
          const nextSeen = new Set(seen);
          nextSeen.add(ref);
          run(data2, subRes, inner, depth + 1, nextSeen, coverKind);
          break;
        }
        default:
          break;
      }
    }
  };

  const initial: GState = {
    ctm: IDENTITY,
    fill: { luminance: 0 },
    stroke: { luminance: 0 },
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    fillSpace: 1,
    strokeSpace: 1,
    font: null,
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    clip: null,
    blendNormal: true,
    textMode: 0,
    softMask: false,
    base: IDENTITY,
  };
  return {
    run(data, res, ctm, coverKind) {
      run(data, res, { ...cloneState(initial), ctm }, 0, new Set(), coverKind);
    },
    addCover(rect, kind, how, luminance) {
      const tone = luminance <= settings.darkLuminanceMax ? "dark" : luminance >= settings.lightLuminanceMin ? "light" : null;
      if (tone) pushCover({ seq: ++seq, rect, kind, how, tone, luminance });
      // 濃くない色の注釈（白い四角の注釈など）は、字の層の覆いにもする（1.11.0 から）
      if (tone !== "dark") pushCover({ seq: ++seq, rect, kind, how, tone: "opaque", luminance });
    },
    addLateCover(cover) {
      pushCover(cover);
    },
    result() {
      return { covers, glyphs, operations: opCount, uncheckedImages, images, marks, overPaint: overPaintOverflow ? null : overPaint, vectorCounts };
    },
  };
}

/** ページの命令の列だけを読む（注釈は読まない） */
export function scanPage(
  ctx: PDFContext,
  content: Uint8Array,
  resources: PDFDict | undefined,
  settings: P6TextSettings,
): PageScan {
  const scanner = createPageScanner(ctx, settings);
  scanner.run(content, resources, IDENTITY, "fill");
  return scanner.result();
}

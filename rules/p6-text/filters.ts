// SPDX-License-Identifier: AGPL-3.0-only
//
// P6 の「数えない条件」（1.6.0 から）。実物の公開 PDF で、隠したものではないのに反応した型を除く。
// 種類と件数の一覧は、見つける段から受け取った（実物・団体名は受け取っていない）。
// - 見える範囲の外：ページの箱（CropBox ∩ MediaBox）と切り抜き（W）の外にある所は、何も隠していない
// - 形の詰まり具合：アウトライン化した字・記号の形の塗りは、黒塗りではない
// - 細い塗り（画像の層）：字の行を隠せない
// - くり返しの模様（画像の層）：写真の上の装飾の格子
// - 上に同じ字（文字の層）：覆いのあとに、同じ字をほぼ同じ所に描き直していれば、その字は見えている

import { area, boundsOf, convexHull, insideParts, intersectRect, intersectionArea, type Rect } from "./geometry.ts";
import type { Cover, GlyphBox } from "./page.ts";
import type { P6TextSettings } from "./settings.ts";

/** 数えなかった理由（測るときだけ、報告の excluded に件数を出す） */
export type ExcludeReason =
  /** 1.10.0 から：画像の層で、白い覆いの点の大半が、あとから描いた濃い覆い（それ自身が測られる）の下にあるもの */
  | "under_later_cover"
  | "outside_view"
  | "not_solid"
  | "too_small"
  | "repeated"
  | "text_on_top"
  | "same_text_on_top"
  /** 1.7.0 から：画像の層で、縦横の四角でないページの中身の塗り */
  | "not_rect"
  /** 1.7.0 から：画像の層で、まわりの地に溶け込まない白い塗り（写真の上の白い札・タイル） */
  | "not_blending"
  /** 1.7.0 から：文字の層で、字1つ分の大きさの形のある塗り（アウトライン化した同じ字） */
  | "glyph_sized"
  /** 1.8.0 から：文字の層で、下の字がすべて、覆いの上に描いた字の中にあるもの */
  | "same_chars_on_top"
  /** 1.13.0 から：図形の層で、白い四角の注釈の下の道が少ないもの（罫線1本など） */
  | "few_paths"
  /** 1.13.0 から：図形の層で、同じ注釈の下の字を、文字の層ですでに出したもの */
  | "text_layer_found";
export type ExcludeCounter = (layer: "text" | "image" | "vector", reason: ExcludeReason) => void;

/** 詰まり具合を測る点の数（縦横それぞれ） */
const SOLIDITY_GRID = 10;

/** 見える範囲：ページの箱と、切り抜きの外枠の箱の重なり。どちらもなければ null（どこでも見える） */
export function viewOf(page: Rect | null, clip: Rect | undefined): Rect | null | "none" {
  if (!page && !clip) return null;
  if (!page) return clip!;
  if (!clip) return page;
  return intersectRect(page, clip) ?? "none";
}

/** 箱のうち、見える部分。見えなければ null */
export function visiblePart(r: Rect, page: Rect | null, clip: Rect | undefined): Rect | null {
  const v = viewOf(page, clip);
  if (v === "none") return null;
  return v ? intersectRect(r, v) : r;
}

/** 点が見える範囲の中か */
export function isVisiblePoint(x: number, y: number, page: Rect | null, clip: Rect | undefined): boolean {
  const v = viewOf(page, clip);
  if (v === "none") return false;
  return !v || (x >= v[0] && x <= v[2] && y >= v[1] && y <= v[3]);
}

const solidityCache = new WeakMap<Cover, number>();

/**
 * 塗りの形の詰まり具合（形の面積 ÷ 凸包の面積。0〜1）。形を持たない覆い（縦横の四角）は 1。
 * 凸包の中に並べた点のうち、形の中にある点の割合で測る（面積を正しく足すより軽く、重なった部分も二重に数えない）
 */
export function solidityOf(cover: Cover): number {
  if (!cover.shape) return 1;
  const cached = solidityCache.get(cover);
  if (cached !== undefined) return cached;
  const hull = convexHull(cover.shape.parts.flat());
  let value = 1;
  if (hull.length >= 3) {
    const [x0, y0, x1, y1] = boundsOf(hull);
    let inHull = 0;
    let inShape = 0;
    for (let j = 0; j < SOLIDITY_GRID; j++) {
      const y = y0 + ((j + 0.5) * (y1 - y0)) / SOLIDITY_GRID;
      for (let i = 0; i < SOLIDITY_GRID; i++) {
        const x = x0 + ((i + 0.5) * (x1 - x0)) / SOLIDITY_GRID;
        if (!insideParts([hull], "nonzero", x, y)) continue;
        inHull++;
        if (insideParts(cover.shape.parts, cover.shape.rule, x, y)) inShape++;
      }
    }
    value = inHull > 0 ? inShape / inHull : 1;
  }
  solidityCache.set(cover, value);
  return value;
}

/** 形の詰まり具合で除く塗りか（ページの中身の塗りだけ。注釈・画像・線は除かない） */
export function isNotSolidFill(cover: Cover, settings: P6TextSettings): boolean {
  return cover.kind === "fill" && cover.how === "fill" && solidityOf(cover) < settings.minSolidity;
}

/** 縦横の四角でない、ページの中身の塗りか（画像の層。1.7.0 から。形を持つ覆いは、縦横の四角でない） */
export function isNotRectFill(cover: Cover): boolean {
  return cover.kind === "fill" && cover.how === "fill" && cover.shape !== undefined;
}

/**
 * 字1つ分の大きさの、形のある塗りか（文字の層。1.7.0 から）。覆った字が1つだけで、
 * 覆いの箱が、その字の箱を縦横 ratio 倍に広げた箱（真ん中は同じ）に収まるもの。縦横の四角・線・注釈は除かない
 */
export function isGlyphSizedShape(cover: Cover, glyph: GlyphBox, ratio: number): boolean {
  if (cover.kind !== "fill" || cover.how !== "fill" || !cover.shape) return false;
  const [gx0, gy0, gx1, gy1] = glyph.rect;
  const mx = ((ratio - 1) / 2) * (gx1 - gx0);
  const my = ((ratio - 1) / 2) * (gy1 - gy0);
  const [x0, y0, x1, y1] = cover.rect;
  return x0 >= gx0 - mx && y0 >= gy0 - my && x1 <= gx1 + mx && y1 <= gy1 + my;
}

/**
 * 字1つ分の大きさの、ページの中身の黒い画像か（文字の層。1.9.0 から）。字の形の型抜きの画像を、同じ字の上に重ねたもの。
 * 数えなくはせず、呼ぶ側で「確かめてください」にする
 */
export function isGlyphSizedImage(cover: Cover, glyph: GlyphBox, ratio: number): boolean {
  if (cover.kind !== "image" || cover.how !== "image") return false;
  const [gx0, gy0, gx1, gy1] = glyph.rect;
  const mx = ((ratio - 1) / 2) * (gx1 - gx0);
  const my = ((ratio - 1) / 2) * (gy1 - gy0);
  const [x0, y0, x1, y1] = cover.rect;
  return x0 >= gx0 - mx && y0 >= gy0 - my && x1 <= gx1 + mx && y1 <= gy1 + my;
}

/** 細すぎる塗りか（画像の層。ページの中身の塗りだけ） */
export function isTooSmallFill(cover: Cover, settings: P6TextSettings): boolean {
  if (cover.kind !== "fill" || cover.how !== "fill") return false;
  const [x0, y0, x1, y1] = cover.rect;
  return Math.min(x1 - x0, y1 - y0) < settings.imageCoverMinSide;
}

/**
 * くり返しの模様の塗り（画像の層）：ほぼ同じ大きさで正方形に近い塗りが、1ページに repeatMinCount 個以上あるもの。
 * 大きさは repeatSizeTolerance ごとの升に分け、隣の升まで合わせて数える（差が tolerance の 1.5 倍までなら同じ大きさ、の目安）
 */
export function repeatedFills(covers: Cover[], settings: P6TextSettings): Set<Cover> {
  const t = settings.repeatSizeTolerance > 0 ? settings.repeatSizeTolerance : 0.25;
  const keyOf = (i: number, j: number) => `${i},${j}`;
  const buckets = new Map<string, Cover[]>();
  const cells = new Map<Cover, [number, number]>();
  for (const c of covers) {
    if (c.kind !== "fill" || c.how !== "fill") continue;
    const w = c.rect[2] - c.rect[0];
    const h = c.rect[3] - c.rect[1];
    if (!(w > 0 && h > 0)) continue;
    const ratio = w / h;
    if (ratio < settings.repeatAspectMin || ratio > 1 / settings.repeatAspectMin) continue;
    const cell: [number, number] = [Math.round(w / t), Math.round(h / t)];
    cells.set(c, cell);
    const k = keyOf(cell[0], cell[1]);
    buckets.set(k, [...(buckets.get(k) ?? []), c]);
  }
  const out = new Set<Cover>();
  for (const [c, [i, j]] of cells) {
    let n = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) n += buckets.get(keyOf(i + di, j + dj))?.length ?? 0;
    if (n >= settings.repeatMinCount) out.add(c);
  }
  return out;
}

/**
 * 字の中身をそろえる（1.8.0 から）。NFKC で正規化し（康熙部首の「⾏」とふつうの「行」、全角と半角など）、前後の空白を除く。
 * 印字できない字（制御・書式・私用領域・幅のない空白など）だけなら、中身の分からない字として空を返す
 */
export function normalizeGlyphText(text: string): string {
  const t = text.normalize("NFKC").trim();
  return /^[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Z}]*$/u.test(t) ? "" : t;
}

/**
 * 字を比べる鍵：字の中身。中身が読めない字（字の形を読めないフォントなど）は、フォントと字の番号（1.7.0 から）。
 * 同じフォントの同じ番号なら、同じ形の字が描かれている
 */
export function glyphKey(g: GlyphBox): string {
  const t = normalizeGlyphText(g.text);
  if (t) return `t:${t}`;
  return g.code !== undefined && g.fontId !== undefined ? `c:${g.fontId}:${g.code}` : "";
}

/** 字の索引（字ごと）。上に同じ字を描き直したかを探すため */
export function indexGlyphsByText(glyphs: GlyphBox[]): Map<string, GlyphBox[]> {
  const m = new Map<string, GlyphBox[]>();
  for (const g of glyphs) {
    const t = glyphKey(g);
    if (!t || g.isSpace) continue;
    const list = m.get(t);
    if (list) list.push(g);
    else m.set(t, [g]);
  }
  return m;
}

/** 覆いのあとに、同じ字をほぼ同じ所（小さい方の箱の 50% 以上が重なる）に描き直しているか */
export function redrawnOnTop(g: GlyphBox, cover: Cover, byText: Map<string, GlyphBox[]>): boolean {
  const t = glyphKey(g);
  if (!t) return false;
  const list = byText.get(t);
  if (!list) return false;
  const a = area(g.rect);
  for (const o of list) {
    if (o.seq <= cover.seq) continue;
    const small = Math.min(a, area(o.rect));
    if (small > 0 && intersectionArea(g.rect, o.rect) / small >= 0.5) return true;
  }
  return false;
}

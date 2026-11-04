// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付けで使う覆いの形と、点・箱がその中にあるかの判定。
// 箱の計算は検出ルールの部品（rules/p6-text/geometry.ts・page.ts の coverageOf）を使う。同じ形の覆いを同じように測るため。

import { coverageOf } from "../rules/p6-text/page.ts";
import { area, type Point, type Rect } from "../rules/p6-text/geometry.ts";

export type SanCover = {
  seq: number;
  rect: Rect;
  /** 形（ページの座標の多角形）。ないときは rect の箱そのもの */
  shape?: { parts: Point[][]; rule: "nonzero" | "evenodd" };
  /** 何で覆っているか（画面に出す説明のため） */
  /** user は、利用者が選んで消す場所（redact.ts）。字の箱が少しでも掛かれば消す（ほかの覆いは半分以上） */
  kind: "fill" | "stroke" | "image" | "annotation" | "redact" | "user";
  /**
   * 覆いの色の向き。ないときは dark（黒など濃い色）。light（白など明るい色）の覆いは、画像の画素を塗るときだけ使い、
   * 下の画素をその色（白）で塗る。字の消し方（P6 の字の層）には使わない（白い覆いの下の字は P7 の範囲）
   */
  tone?: "light";
};

/** 点 (x, y) が覆いの中にあるか */
export function coverContains(c: SanCover, x: number, y: number): boolean {
  const r = c.rect;
  if (x < r[0] || x > r[2] || y < r[1] || y > r[3]) return false;
  if (!c.shape) return true;
  let winding = 0;
  let crossings = 0;
  for (const poly of c.shape.parts) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yj <= y !== yi <= y) {
        const xc = xj + ((y - yj) * (xi - xj)) / (yi - yj);
        if (x < xc) {
          crossings++;
          winding += yi > yj ? 1 : -1;
        }
      }
    }
  }
  return c.shape.rule === "evenodd" ? crossings % 2 === 1 : winding !== 0;
}

/**
 * 箱の索引（ページを 32pt のマス目に分ける）。字の近くの覆い・塗りだけを比べるために使う。
 * 図形の多いページ（濃い四角 8 万個・字 1 万字）で、総当たりだと 24 秒かかったため（2026-11-04 測定）。
 * マス目に入れきれない大きな箱は、別の一覧に入れて毎回見る。
 */
export class RectIndex<T extends { rect: Rect }> {
  private static readonly CELL = 32;
  private static readonly MAX_CELLS = 256;
  private readonly cells = new Map<number, T[]>();
  private readonly wide: T[] = [];
  private static key(cx: number, cy: number) {
    return cx * 1_000_003 + cy;
  }
  private static span(r: Rect) {
    const c = RectIndex.CELL;
    const x0 = Math.floor(r[0] / c), x1 = Math.floor(r[2] / c), y0 = Math.floor(r[1] / c), y1 = Math.floor(r[3] / c);
    return { x0, x1, y0, y1, n: (x1 - x0 + 1) * (y1 - y0 + 1) };
  }
  constructor(items: T[]) {
    for (const it of items) {
      const s = RectIndex.span(it.rect);
      if (!Number.isFinite(s.n) || s.n > RectIndex.MAX_CELLS) {
        this.wide.push(it);
        continue;
      }
      for (let cx = s.x0; cx <= s.x1; cx++) for (let cy = s.y0; cy <= s.y1; cy++) {
        const k = RectIndex.key(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push(it);
        else this.cells.set(k, [it]);
      }
    }
  }
  /** 箱 r と重なりうるもの（重ならないものも少し混ざる。呼ぶ側で確かめる）。入れた順に並べて返す */
  query(r: Rect, order: (a: T, b: T) => number): T[] {
    const s = RectIndex.span(r);
    const out = new Set<T>(this.wide);
    if (!Number.isFinite(s.n) || s.n > RectIndex.MAX_CELLS) {
      for (const list of this.cells.values()) for (const it of list) out.add(it);
    } else {
      for (let cx = s.x0; cx <= s.x1; cx++) for (let cy = s.y0; cy <= s.y1; cy++) {
        const list = this.cells.get(RectIndex.key(cx, cy));
        if (list) for (const it of list) out.add(it);
      }
    }
    return [...out].sort(order);
  }
}

/** 箱 r のうち、覆いに隠れる割合（0〜1） */
export function coveredFraction(c: SanCover, r: Rect): number {
  const a = area(r);
  if (a <= 0) return 0;
  return coverageOf({ rect: c.rect, shape: c.shape }, r) / a;
}

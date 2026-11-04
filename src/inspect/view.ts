// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの座標の箱を、画面に描くページの中の割合（左上が原点、0〜1）に直す。/Rotate もかける。
// 画面の部品に頼らない計算だけを置き、テストで確かめる。

import type { PageBox, Rect } from "./report";

/** 画面での見た目の大きさ（ポイント）。90・270 度のときは幅と高さが入れ替わる */
export function viewSize(box: PageBox): { width: number; height: number } {
  const w = box.view[2] - box.view[0];
  const h = box.view[3] - box.view[1];
  return box.rotate === 90 || box.rotate === 270 ? { width: h, height: w } : { width: w, height: h };
}

/** 割合で表した箱。left・top・width・height はどれも 0〜1 */
export type Fraction = { left: number; top: number; width: number; height: number };

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** 箱が見える範囲の外にすっかり出ているときは null */
export function toFraction(box: PageBox, rect: Rect): Fraction | null {
  const [vx0, vy0, vx1, vy1] = box.view;
  const w = vx1 - vx0;
  const h = vy1 - vy0;
  if (!(w > 0 && h > 0)) return null;
  // 回す前：左上が原点の割合（x は右へ、y は下へ）
  const x0 = clamp((rect[0] - vx0) / w);
  const x1 = clamp((rect[2] - vx0) / w);
  const y0 = clamp((vy1 - rect[3]) / h);
  const y1 = clamp((vy1 - rect[1]) / h);
  if (x1 <= x0 || y1 <= y0) return null;
  // /Rotate は時計回り
  switch (box.rotate) {
    case 0:
      return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
    case 90:
      return { left: 1 - y1, top: x0, width: y1 - y0, height: x1 - x0 };
    case 180:
      return { left: 1 - x1, top: 1 - y1, width: x1 - x0, height: y1 - y0 };
    case 270:
      return { left: y0, top: 1 - x1, width: y1 - y0, height: x1 - x0 };
  }
}

/** toFraction の逆：画面での割合の箱を、ページの既定の座標の箱に戻す（自分で黒塗りする所を決めるため。11/5 B の 9） */
export function fromFraction(box: PageBox, f: Fraction): Rect {
  const [vx0, vy0, vx1, vy1] = box.view;
  const w = vx1 - vx0;
  const h = vy1 - vy0;
  const c = (n: number) => Math.min(1, Math.max(0, n));
  const l = c(f.left);
  const t = c(f.top);
  const r = c(f.left + f.width);
  const b = c(f.top + f.height);
  // 回す前の割合（x0・x1 は左から、y0・y1 は上から）に戻す
  let x0: number, x1: number, y0: number, y1: number;
  switch (box.rotate) {
    case 0:
      [x0, x1, y0, y1] = [l, r, t, b];
      break;
    case 90:
      [x0, x1, y0, y1] = [t, b, 1 - r, 1 - l];
      break;
    case 180:
      [x0, x1, y0, y1] = [1 - r, 1 - l, 1 - b, 1 - t];
      break;
    case 270:
      [x0, x1, y0, y1] = [1 - b, 1 - t, l, r];
      break;
  }
  return [vx0 + x0 * w, vy1 - y1 * h, vx0 + x1 * w, vy1 - y0 * h];
}

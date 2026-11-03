// SPDX-License-Identifier: AGPL-3.0-only
//
// 行列と箱の計算。PDF の行列は [a b c d e f]（x' = a*x + c*y + e, y' = b*x + d*y + f）。

export type Matrix = [number, number, number, number, number, number];
export type Rect = [number, number, number, number]; // [x0, y0, x1, y1]、x0 <= x1, y0 <= y1
export type Point = [number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 をかけてから m2 をかけた行列（PDF の「m1 × m2」） */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export function apply(m: Matrix, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function boundsOf(points: Point[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function area(r: Rect): number {
  return Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
}

export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 多角形の面積（頂点の順に、符号なし） */
export function polygonArea(points: Point[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

/** 行列が長さをどれだけ伸ばすか（線の太さの換算に使う。縦横で違うときは平均をとる） */
export function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export function isFiniteMatrix(m: Matrix): boolean {
  return m.every((v) => Number.isFinite(v));
}

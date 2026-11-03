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

/** 多角形の符号つきの面積（反時計回りが正） */
export function signedPolygonArea(points: Point[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

/** 3次ベジエ曲線を、n 本の直線に分けた点（始点は含まない） */
export function flattenCubic(p0: Point, p1: Point, p2: Point, p3: Point, n: number): Point[] {
  const out: Point[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
}

/**
 * 多角形を、縦横の箱で切り取る（Sutherland–Hodgman。切り取る側の箱は凸なので、どんな多角形でも面積は正しく出る）。
 * 向き（符号）はもとの多角形のまま。
 */
export function clipPolygonToRect(points: Point[], r: Rect): Point[] {
  let out = points;
  const edges: Array<[(p: Point) => boolean, (a: Point, b: Point) => Point]> = [
    [(p) => p[0] >= r[0], (a, b) => [r[0], a[1] + ((b[1] - a[1]) * (r[0] - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= r[2], (a, b) => [r[2], a[1] + ((b[1] - a[1]) * (r[2] - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= r[1], (a, b) => [a[0] + ((b[0] - a[0]) * (r[1] - a[1])) / (b[1] - a[1]), r[1]]],
    [(p) => p[1] <= r[3], (a, b) => [a[0] + ((b[0] - a[0]) * (r[3] - a[1])) / (b[1] - a[1]), r[3]]],
  ];
  for (const [inside, cross] of edges) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!;
      const prev = input[(i + input.length - 1) % input.length]!;
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cross(prev, cur));
        out.push(cur);
      } else if (pi) out.push(cross(prev, cur));
    }
  }
  return out;
}

/** 箱と箱が重なるか */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

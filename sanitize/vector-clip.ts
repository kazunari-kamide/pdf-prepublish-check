// SPDX-License-Identifier: AGPL-3.0-only
//
// 道（塗り・線）を、箱の外の部分だけに切り詰める（0.10.0 から。白い不透明な注釈の下の図形を消すため）。
// 座標はページの座標。曲線は扱わない（呼ぶ側で、曲線のある道は切らずに片付けられなかった所にする）。
//
// 塗り：多角形を、箱の外の 4 つの帯（左・右・下・上）で切り分ける（Sutherland–Hodgman。帯はどれも凸なので、
// へこみのある多角形でも、帯の中の塗りは元と同じになる）。帯ごとに 1 つの塗りにすると、帯どうしは重ならないので、
// 穴のある字（複数の部分道）でも、帯の中の重なり方（nonzero・evenodd）は元のまま。
// 線：線分を、箱の境で切り、箱の外の部分だけを残す。

import type { Point, Rect } from "../rules/p6-text/geometry.ts";

type HalfPlane = { axis: 0 | 1; keepBelow: boolean; at: number };

function clipHalf(poly: Point[], h: HalfPlane): Point[] {
  const out: Point[] = [];
  const inside = (p: Point) => (h.keepBelow ? p[h.axis] <= h.at : p[h.axis] >= h.at);
  const cross = (a: Point, b: Point): Point => {
    const t = (h.at - a[h.axis]) / (b[h.axis] - a[h.axis]);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const prev = poly[(i + poly.length - 1) % poly.length]!;
    const ci = inside(cur);
    const pi = inside(prev);
    if (ci) {
      if (!pi) out.push(cross(prev, cur));
      out.push(cur);
    } else if (pi) out.push(cross(prev, cur));
  }
  return out;
}

function clipRegion(poly: Point[], planes: HalfPlane[]): Point[] {
  let p = poly;
  for (const h of planes) {
    if (p.length < 3) return [];
    p = clipHalf(p, h);
  }
  return p.length >= 3 ? p : [];
}

/** 箱の外の 4 つの帯（左・右・下・上。下と上は箱の幅の中だけ） */
function outsideRegions(box: Rect): HalfPlane[][] {
  const [x0, y0, x1, y1] = box;
  return [
    [{ axis: 0, keepBelow: true, at: x0 }],
    [{ axis: 0, keepBelow: false, at: x1 }],
    [{ axis: 0, keepBelow: false, at: x0 }, { axis: 0, keepBelow: true, at: x1 }, { axis: 1, keepBelow: true, at: y0 }],
    [{ axis: 0, keepBelow: false, at: x0 }, { axis: 0, keepBelow: true, at: x1 }, { axis: 1, keepBelow: false, at: y1 }],
  ];
}

/**
 * 塗りの部分道の集まり（1 つの塗りの命令）を、箱の外の部分だけに切る。
 * 返すのは塗りの命令ごとの部分道の集まり（帯ごと。空の帯は返さない）
 */
export function clipFillOutside(group: Point[][], box: Rect): Point[][][] {
  const out: Point[][][] = [];
  for (const planes of outsideRegions(box)) {
    const g = group.map((poly) => clipRegion(poly, planes)).filter((p) => p.length >= 3);
    if (g.length) out.push(g);
  }
  return out;
}

/** 線分 a→b のうち、箱の中にある t の範囲（Liang–Barsky）。掛からなければ null */
function insideSpan(a: Point, b: Point, box: Rect): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: Array<[number, number]> = [
    [-dx, a[0] - box[0]],
    [dx, box[2] - a[0]],
    [-dy, a[1] - box[1]],
    [dy, box[3] - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/** 折れ線を、箱の外の部分だけの折れ線（いくつか）に切る */
export function clipPolylineOutside(line: Point[], box: Rect): Point[][] {
  const out: Point[][] = [];
  let cur: Point[] = [];
  const at = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const flush = () => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const span = insideSpan(a, b, box);
    if (!span) {
      if (!cur.length) cur.push(a);
      cur.push(b);
      continue;
    }
    const [t0, t1] = span;
    if (t0 > 0) {
      if (!cur.length) cur.push(a);
      cur.push(at(a, b, t0));
    }
    flush();
    if (t1 < 1) cur.push(at(a, b, t1), b);
  }
  flush();
  return out;
}

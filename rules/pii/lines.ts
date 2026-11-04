// SPDX-License-Identifier: AGPL-3.0-only
//
// 集めた字を、行（縦書きは列）にまとめる（rules/pii）。
// - 同じ向きで、行を横切る向きの位置がそろう字を1行にし、進む向きに並べる。
// - 字の間があいていれば空白、大きくあいていれば区切り（\t。表の別の欄）を入れる。
// - 同じ字を同じ所に2度描いたもの（太字の2度描き）は1つにする。
// 行の字の並びの k 番目の字が、どの字（Glyph）から来たかを map に持つ（空白・区切りは −1）。

import type { Direction, Glyph, Rect } from "./text.ts";

export type Line = {
  dir: Direction;
  /** 行の字の並び（字の中身は判定にだけ使い、外へは返さない） */
  text: string;
  /** text の k 番目の字が来た字の番号（glyphs の添字）。空白・区切りは −1 */
  map: number[];
  glyphs: Glyph[];
  /** 行の箱 */
  rect: Rect;
  /** 字の大きさの中ほどの値 */
  size: number;
};

export type LineSettings = {
  /** 行を横切る向きのずれが、字の大きさのこの割合までなら同じ行 */
  sameLineFraction: number;
  /** 字の間が、字の大きさのこの割合より大きければ空白を入れる */
  spaceGapFraction: number;
  /** 字の間が、字の大きさのこの割合より大きければ区切り（別の欄）にする */
  cellGapFraction: number;
};

export const DEFAULT_LINE_SETTINGS: LineSettings = { sameLineFraction: 0.35, spaceGapFraction: 0.3, cellGapFraction: 1.8 };

/** 進む向きの位置（along）と、行を横切る向きの位置（across）。どちらも「読む順に増える」向きにそろえる */
function axes(g: Glyph): { along0: number; along1: number; across: number } {
  const [x0, y0, x1, y1] = g.rect;
  switch (g.dir) {
    case "h":
      return { along0: x0, along1: x1, across: -(y0 + y1) / 2 };
    case "hl":
      return { along0: -x1, along1: -x0, across: (y0 + y1) / 2 };
    case "v":
      return { along0: -y1, along1: -y0, across: -(x0 + x1) / 2 };
    case "vu":
      return { along0: y0, along1: y1, across: (x0 + x1) / 2 };
  }
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export function buildLines(glyphs: Glyph[], settings: LineSettings = DEFAULT_LINE_SETTINGS): Line[] {
  const lines: Line[] = [];
  const byDir = new Map<Direction, Array<{ g: Glyph; a: ReturnType<typeof axes> }>>();
  for (const g of glyphs) {
    const list = byDir.get(g.dir) ?? [];
    list.push({ g, a: axes(g) });
    byDir.set(g.dir, list);
  }
  for (const [dir, list] of byDir) {
    list.sort((p, q) => p.a.across - q.a.across || p.a.along0 - q.a.along0);
    // 行を横切る向きに近いものをまとめる（並べた順に、直前の行の位置と比べる）
    const groups: Array<typeof list> = [];
    let cur: typeof list = [];
    let curAcross = NaN;
    for (const item of list) {
      const tol = Math.max(item.g.size, 1) * settings.sameLineFraction;
      if (cur.length && Math.abs(item.a.across - curAcross) <= tol) {
        cur.push(item);
      } else {
        if (cur.length) groups.push(cur);
        cur = [item];
        curAcross = item.a.across;
      }
    }
    if (cur.length) groups.push(cur);

    for (const group of groups) {
      group.sort((p, q) => p.a.along0 - q.a.along0);
      const size = median(group.map((p) => p.g.size)) || 1;
      let text = "";
      const map: number[] = [];
      const kept: Glyph[] = [];
      let prevEnd = -Infinity;
      let prev: (typeof group)[number] | null = null;
      for (const item of group) {
        // 太字の2度描き：同じ字が、ほとんど同じ所にある
        if (prev && prev.g.text === item.g.text && Math.abs(prev.a.along0 - item.a.along0) < size * 0.15) continue;
        const gap = item.a.along0 - prevEnd;
        if (kept.length) {
          if (gap > size * settings.cellGapFraction) {
            text += "\t";
            map.push(-1);
          } else if (gap > size * settings.spaceGapFraction) {
            text += " ";
            map.push(-1);
          }
        }
        const idx = kept.length;
        kept.push(item.g);
        for (const ch of item.g.text) {
          text += ch;
          map.push(idx);
        }
        prevEnd = Math.max(prevEnd, item.a.along1);
        prev = item;
      }
      const xs0 = kept.map((g) => g.rect[0]);
      const ys0 = kept.map((g) => g.rect[1]);
      const xs1 = kept.map((g) => g.rect[2]);
      const ys1 = kept.map((g) => g.rect[3]);
      lines.push({
        dir,
        text,
        map,
        glyphs: kept,
        rect: [Math.min(...xs0), Math.min(...ys0), Math.max(...xs1), Math.max(...ys1)],
        size,
      });
    }
  }
  return lines;
}

/** 行の字の並びの [start, end) の範囲の箱（空白・区切りは除く） */
export function rectOfRange(line: Line, start: number, end: number): Rect | null {
  let r: Rect | null = null;
  const seen = new Set<number>();
  for (let k = start; k < end; k++) {
    const gi = line.map[k];
    if (gi === undefined || gi < 0 || seen.has(gi)) continue;
    seen.add(gi);
    const g = line.glyphs[gi]!.rect;
    r = r ? [Math.min(r[0], g[0]), Math.min(r[1], g[1]), Math.max(r[2], g[2]), Math.max(r[3], g[3])] : [...g];
  }
  return r;
}

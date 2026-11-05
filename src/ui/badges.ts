// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの絵の上の番号の札（.mark-no）を、重ならないように横へずらす（2026-11-05 夜のレビュー 1）。
// 画面の部品に頼らない計算だけを置き、テストで確かめる。札の矩形（px）を受け取り、横にずらす量を返す。

export type BadgeBox = { x: number; y: number; w: number; h: number };

const overlaps = (a: BadgeBox, b: BadgeBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 札を、渡した順（先の札ほど動かさない）に置いていく。前に置いた札と重なる札は、重なった札の右へ gap px あけて移す。
 * 移した先でまた重なれば、さらに右へ（札の数だけ試す）。返すのは、札ごとの横にずらす量（px）
 */
export function spreadBadges(boxes: readonly BadgeBox[], gap = 2): number[] {
  const placed: BadgeBox[] = [];
  return boxes.map((b) => {
    let dx = 0;
    for (let tries = 0; tries <= boxes.length; tries++) {
      const cur = { ...b, x: b.x + dx };
      const hit = placed.find((p) => overlaps(p, cur));
      if (!hit) break;
      dx = hit.x + hit.w + gap - b.x;
    }
    placed.push({ ...b, x: b.x + dx });
    return dx;
  });
}

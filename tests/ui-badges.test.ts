// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの絵の上の番号の札を、重ならないように横へずらす計算（src/ui/badges.ts）。

import { describe, expect, it } from "vitest";
import { spreadBadges, type BadgeBox } from "../src/ui/badges";

const overlaps = (a: BadgeBox, b: BadgeBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("番号の札を重ねない", () => {
  it("重ならない札は動かさない", () => {
    expect(spreadBadges([{ x: 0, y: 0, w: 20, h: 20 }, { x: 100, y: 0, w: 20, h: 20 }])).toEqual([0, 0]);
  });
  it("左上がほぼ同じ札（入れ子の枠など）は、先の札を動かさず、後の札を右へ 2px あけて移す", () => {
    expect(spreadBadges([{ x: 297, y: 50, w: 20, h: 20 }, { x: 305, y: 52, w: 20, h: 20 }])).toEqual([0, 14]);
  });
  it("3 つ以上が重なっても、移したあとの札どうしは重ならない", () => {
    const boxes = Array.from({ length: 5 }, (_, i) => ({ x: 100 + i, y: 40, w: 20, h: 20 }));
    const dx = spreadBadges(boxes);
    const moved = boxes.map((b, i) => ({ ...b, x: b.x + dx[i]! }));
    for (let i = 0; i < moved.length; i++) for (let j = i + 1; j < moved.length; j++) expect(overlaps(moved[i]!, moved[j]!)).toBe(false);
    expect(dx[0]).toBe(0);
  });
  it("縦に離れていれば、横に近くても動かさない", () => {
    expect(spreadBadges([{ x: 0, y: 0, w: 20, h: 20 }, { x: 5, y: 30, w: 20, h: 20 }])).toEqual([0, 0]);
  });
});

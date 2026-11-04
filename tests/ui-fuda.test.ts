// SPDX-License-Identifier: AGPL-3.0-only
//
// 種類ごとの結果の札の短い名前（src/ui/fuda.ts）。いまある検出ルールは全部、4 字までの名前を持つことを確かめる。

import { describe, expect, it } from "vitest";
import { RULES } from "../src/inspect/rules";
import { FUDA_MAX, fudaLabel } from "../src/ui/fuda";

describe("札の短い名前", () => {
  it.each(RULES.map((r) => [r.label, r.pattern] as const))("%s（%s）は、P の番号ではない短い名前を持つ", (label, pattern) => {
    const short = fudaLabel(label, pattern);
    expect(short).not.toBe(pattern);
    expect([...short].length).toBeLessThanOrEqual(FUDA_MAX);
  });

  it("知らない種類は、P の番号を出す（札が空にならない）", () => {
    expect(fudaLabel("まだない種類", "P3")).toBe("P3");
  });
});

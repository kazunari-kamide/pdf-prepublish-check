// SPDX-License-Identifier: AGPL-3.0-only
//
// /check の結果の欄で、検出の行の題に黄のマーカーを引かないことを確かめる（2026-11-06 朝）。
// 題は折り返す箱なので、帯を引くと 2 行目だけに出てしまう。選んだ・乗ったことは、行の紅の枠と地の色で示す。

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(import.meta.dirname, "..", "src", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("検出の行の題のマーカー", () => {
  it("題（.item-title）に当たる指定に、マーカーの帯がない", () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.includes(".item-title"));
    expect(rules.length).toBeGreaterThan(0);
    for (const m of rules) expect(m[2]).not.toMatch(/--marker-ki|linear-gradient/);
  });

  it("選んだ行は、今のとおり紅の枠で示す", () => {
    expect(css).toMatch(/\.items > li:has\(> \.item\.is-selected\) \{[^}]*box-shadow: inset 0 0 0 var\(--bw-2\) var\(--danger\)/);
  });

  it("本文のリンクのマーカーは残す", () => {
    expect(css).toMatch(/\.origin-text a \{[^}]*--marker-ki/);
  });
});

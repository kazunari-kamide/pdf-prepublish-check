// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの絵の上の番号の札で、選んだ札の字と丸の色の差を十分に取ることを確かめる（2026-11-06 朝）。
// 前は、見えている候補（墨の札）を選ぶと墨の地が残り、黒い丸に紅の字（1.90:1）になっていた。

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const css = readFileSync(path.join(root, "src", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = readFileSync(path.join(root, "design", "tokens.css"), "utf8");

const token = (name: string) => tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))![1]!;
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const body = (selector: string) => {
  const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.split(",").some((s) => s.trim() === selector)).map((m) => m[2]!);
  if (found.length === 0) throw new Error(`指定が見つからない: ${selector}`);
  return found.join("\n");
};

describe("選んだ番号の札の色", () => {
  it("紅の枠を選んだ札は、白い丸に紅の字（4.5:1 以上）", () => {
    const b = body(".mark.is-selected .mark-no");
    expect(b).toMatch(/background: var\(--color-surface\)/);
    expect(b).toMatch(/color: var\(--color-accent\)/);
    expect(ratio(token("--color-accent"), token("--color-surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it("候補・自分で選んだ所の札を選んでも、墨の地が残らず、白い丸に墨の字（4.5:1 以上）", () => {
    for (const s of [".mark.is-selected.mark-candidate .mark-no", ".mark.is-selected.mark-pick .mark-no"]) {
      const b = body(s);
      expect(b).toMatch(/background: var\(--color-surface\)/);
      expect(b).toMatch(/color: var\(--color-base\)/);
    }
    expect(ratio(token("--color-base"), token("--color-surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it("選んでいない札は、今のとおり塗った丸（選んだ札と形で見分ける）", () => {
    expect(body(".mark-no")).toMatch(/background: var\(--color-accent\)/);
    expect(body(".mark.mark-candidate .mark-no")).toMatch(/background: var\(--line-strong\)/);
    expect(body(".mark.mark-pick .mark-no")).toMatch(/background: var\(--color-base\)/);
  });
});

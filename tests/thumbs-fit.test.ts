// SPDX-License-Identifier: AGPL-3.0-only
//
// /check の縮小したページの列が、開いた直後（列が窓の上に貼り付く前）も、窓の下の端からはみ出さないことの決まりを確かめる（2026-11-06）。
// 前は、列の高さが「貼り付いたあとの位置」で決めてあり、開いた直後は列の下の数枚が窓の外（当時は「整える」の帯の下）に入っていた。
// 2026-11-07 の案 A で、下の端に固定していた帯をやめたので、帯の高さは引かない。

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const css = readFileSync(path.join(ROOT, "src", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const main = readFileSync(path.join(ROOT, "src", "main.ts"), "utf8");

const FIT = /\.workspace\[data-state="result"\] \.thumbs \{\s*max-height: calc\(100dvh - max\(var\(--thumbs-top, var\(--sp-4\)\), var\(--sp-4\)\) - var\(--sp-4\)\);\s*\}/;

describe("縮小したページの列の高さ", () => {
  it("列の高さは、今の列の上の端（--thumbs-top）から窓の下の端までに収める", () => {
    expect(css).toMatch(FIT);
  });

  it("ページの絵の欄と共通の決まりより後にあり、狭い画面の「高さの上限なし」より前にある", () => {
    const fit = css.search(FIT);
    const shared = css.search(/\.workspace\[data-state="result"\] \.stage,\r?\n\.workspace\[data-state="result"\] \.thumbs \{/);
    const narrow = css.indexOf("@container page (max-width: 50rem)");
    expect(shared).toBeGreaterThan(0);
    expect(fit).toBeGreaterThan(shared);
    expect(narrow).toBeGreaterThan(fit);
    expect(css.slice(narrow)).toMatch(/\.workspace\[data-state="result"\] \.thumbs \{\s*position: static;\s*max-height: none;/);
  });

  it("下の端に固定していた「整える」の帯の高さ（--band-space）は、もう使わない（案 A）", () => {
    expect(css).not.toContain("--band-space");
  });

  it("ページの絵の欄（.stage）には、送るたびに変わる高さを使わない（変わるたびにページを描き直してしまうため）", () => {
    expect(css).not.toMatch(/\.stage[^{]*\{[^}]*--thumbs-top/);
  });

  it("画面のスクリプトは、列を作ったとき・送ったとき・窓や中身の大きさが変わったときに、列の上の端を測って渡す", () => {
    expect(main).toMatch(/ui\.thumbs\.style\.setProperty\("--thumbs-top", `\$\{Math\.round\(ui\.thumbs\.getBoundingClientRect\(\)\.top\)\}px`\)/);
    expect(main).toMatch(/ui\.thumbs\.hidden = false;\r?\n\s*fitThumbsToWindow\(\);/);
    expect(main).toContain('window.addEventListener("scroll", fitThumbsSoon, { passive: true });');
    expect(main).toContain('window.addEventListener("resize", fitThumbsSoon);');
    expect(main).toContain("new ResizeObserver(fitThumbsSoon).observe(document.body);");
  });
});

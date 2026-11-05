// SPDX-License-Identifier: AGPL-3.0-only
//
// 関係する記事の一覧の行で、型の番号の札と黄のマーカーが重ならないことを確かめる（2026-11-05 夜。design/sheet.md「案 C」の強調・リンク）。
// - 行のリンクにはクラスが付き、本文のリンクの決まり（リンク全体にマーカー）から外れる
// - マーカーは題の字（.site-list-title の中の span）だけに引き、札（.site-tag）は帯の外に置く
// - 指を置いたときに、下線とマーカーを二重にしない

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARTICLES } from "../src/site/articles.ts";
import { renderArticle } from "../src/site/render.ts";

const css = readFileSync(path.resolve(import.meta.dirname, "..", "src", "site", "site.css"), "utf8");

describe("関係する記事の一覧の札とマーカー", () => {
  it("行のリンクは、札のあとに題の箱があり、札は題の箱の外にある", () => {
    const a = ARTICLES.find((x) => x.slug === "p5-thumbnail")!;
    const html = renderArticle(a, { origin: "https://example.invalid", csp: "", cssHref: "/a.css" });
    const rows = [...html.matchAll(/<li><a class="site-list-link" href="[^"]+">([\s\S]*?)<\/a><\/li>/g)].map((m) => m[1]!);
    expect(rows.length).toBe(a.related.length);
    for (const r of rows) {
      expect(r).toMatch(/^(<span class="site-tag">P\d+<\/span>)?<span class="site-list-title"><span>[^<]+<\/span><\/span>$/);
    }
    // 本文のリンクの決まり（a:not([class])）に当たらない
    expect(html).not.toMatch(/<ul class="site-list">\s*<li><a href=/);
  });

  it("マーカーは題の字だけ。指を置いたときに下線を足さない", () => {
    expect(css).toMatch(/\.site-list-title > span \{[^}]*--marker-ki/);
    expect(css).not.toMatch(/\.site-list-link \{[^}]*linear-gradient/);
    const hover = css.match(/\.site-main :is\(p, dd\) a:not\(\[class\]\):hover,[\s\S]*?\{([^}]*)\}/)![1]!;
    expect(hover).not.toMatch(/text-decoration:\s*underline/);
  });
});

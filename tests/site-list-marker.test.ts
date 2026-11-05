// SPDX-License-Identifier: AGPL-3.0-only
//
// 関係する記事の一覧の行と、本文のリンクの形を確かめる（D166：黄のマーカーをやめ、リンクは下線にそろえる。2026-11-06）。
// - 行のリンクにはクラスが付き、本文のリンクの決まり（下線）から外れる
// - 行にはマーカーも下線も引かず、指を置いたら行の地の色を変える
// - 本文のリンクは下線。指を置いたら下線を太くする

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

  it("マーカーはどこにも引かない。行は指を置いたら地の色を変え、本文のリンクは下線を太くする", () => {
    expect(css).not.toMatch(/--marker-ki/);
    expect(css).toMatch(/\.site \.site-list-link:is\(:hover, :focus-visible\) \{[^}]*background: var\(--surface-sunken\)/);
    expect(css).toMatch(/\.site-main :is\(p, dd\) a:not\(\[class\]\),[\s\S]*?\{[^}]*text-decoration-line: underline/);
    const hover = css.match(/\.site-main :is\(p, dd\) a:not\(\[class\]\):is\(:hover, :focus-visible\),[\s\S]*?\{([^}]*)\}/)![1]!;
    expect(hover).toMatch(/text-decoration-thickness: 3px/);
  });
});

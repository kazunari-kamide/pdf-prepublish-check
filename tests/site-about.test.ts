// SPDX-License-Identifier: AGPL-3.0-only
//
// サービスの紹介のページ（/about。src/site/about.ts・about.css）を確かめる。
// - 言い方の決まり：件数は「18万件以上」。言い切り・誇張（seo.ts の BANNED_WORDS と、「通信ゼロ」など）を使わない。「見張り」「監視」と言わない
// - 測っていない数字の空欄（【 】）を、ページに残さない（埋まらない文は外す）
// - スクリプト・直接書いた style がなく、読み込むのは同じサイトの CSS 2 つだけ
// - 中のリンクが、あるページ・あるページの中の場所を指す。見本のボタンは /?sample=1
// - sitemap に入り、どのサイトのページの上の帯からも来られる

import { describe, expect, it } from "vitest";
import { renderSitemap, siteFiles } from "../site.ts";
import { ABOUT_META, PATTERNS, REMAINS, SAMPLE_HREF } from "../src/site/about.ts";
import { ARTICLES } from "../src/site/articles.ts";
import { ABOUT_PATH, aboutFile, fileFor } from "../src/site/render.ts";
import { BANNED_WORDS } from "../src/site/seo.ts";

const files = siteFiles();
const page = files.get(aboutFile())!;
const main = page.split("<main")[1]!.split("</main>")[0]!;
const text = main.replace(/<[^>]+>/g, " ");

describe("サービスの紹介のページ", () => {
  it("ページがあり、sitemap に入る", () => {
    expect(page).toBeDefined();
    expect(renderSitemap()).toContain(`${ABOUT_PATH}</loc>`);
    expect(page).toContain(`<title>`);
  });

  it("言い方の決まり：18万件以上。言い切り・誇張・見張りの言い方を使わない", () => {
    expect(text).toContain("18万件以上");
    for (const w of [...BANNED_WORDS, "通信ゼロ", "通信0", "見張", "監視", "推薦", "導入されて"]) expect(text, w).not.toContain(w);
    expect(text).toContain("どこにも送信しません");
  });

  it("測っていない数字の空欄（【 】）を残さない", () => {
    expect(text).not.toMatch(/[【】]/);
    expect(ABOUT_META.description).not.toMatch(/[【】]/);
  });

  it("スクリプト・直接書いた style がない。読み込む CSS は、同じサイトの 2 つだけ", () => {
    expect(page).not.toMatch(/<script\b/);
    expect(page).not.toMatch(/<style\b|\sstyle="/);
    const css = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    expect(css).toHaveLength(2);
    for (const c of css) expect(c).toMatch(/^\/assets\/(site|about)-[0-9a-f]{10}\.css$/);
  });

  it("中のリンクは、あるページか、このページの中の場所を指す。見本のボタンは /?sample=1", () => {
    const hrefs = [...main.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
    const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const h of hrefs) {
      if (h.startsWith("https://github.com/")) continue; // ソースの場所（ビルドの時に決まる）
      if (h.startsWith("#")) expect(ids.has(h.slice(1)), h).toBe(true);
      else if (h === "/" || h === SAMPLE_HREF) continue;
      else expect(files.has(fileFor(h.split("#")[0]!)), h).toBe(true);
    }
    expect(hrefs).toContain(SAMPLE_HREF);
    expect(SAMPLE_HREF).toBe("/?sample=1");
  });

  it("残り方のカードと型の札は、記事のある型を指し、型は P1〜P12 を 1 回ずつ並べる", () => {
    for (const r of [...REMAINS, ...PATTERNS]) expect(ARTICLES.some((a) => a.slug === r.slug), r.slug).toBe(true);
    expect(PATTERNS.map((p) => p.no)).toEqual(Array.from({ length: 12 }, (_, i) => `P${i + 1}`));
  });

  it("記事の本数は、記事の一覧から数える", () => {
    const types = ARTICLES.filter((a) => a.pattern).length;
    const guides = ARTICLES.filter((a) => !a.pattern).length;
    expect(text).toContain(`型の解説 ${types} 本・手順 ${guides} 本`);
  });

  it("どのサイトのページの上の帯にも、このページへのリンクがある", () => {
    for (const [name, html] of files) {
      if (!name.endsWith(".html") || name === aboutFile()) continue;
      const band = html.split('<nav class="site-nav"')[1]?.split("</nav>")[0] ?? "";
      expect(band, name).toContain(`href="${ABOUT_PATH}"`);
    }
  });
});

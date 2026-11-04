// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページ（記事・プライバシーの説明。src/site/ と site.ts）を確かめる。
// - 記事は 15 本（P1〜P12 を1本ずつ、手順 3 本）。どのページにも題・説明・canonical・同じ CSP があり、検査のページへつながる
// - スクリプトを入れない。字は HTML として解釈させない
// - 使わない言い方（断定・「初めて」など）と、外の URL を書かない

import { describe, expect, it } from "vitest";
import { cspForMeta } from "../csp.ts";
import { OFFICIAL_ORIGIN } from "../htaccess.ts";
import { renderRobots, renderSitemap, siteFiles, verificationMeta } from "../site.ts";
import { ARTICLES } from "../src/site/articles.ts";
import { PRIVACY_DESCRIPTION, PRIVACY_SECTIONS } from "../src/site/privacy.ts";
import { escapeHtml, renderArticle, sitePaths } from "../src/site/render.ts";
import type { Section } from "../src/site/types.ts";

const files = siteFiles();
const html = [...files].filter(([name]) => name.endsWith(".html"));

/** 記事とプライバシーの字を、全部1つの並びにする */
function texts(): string[] {
  const sec = (s: Section) => [s.heading, ...(s.paragraphs ?? []), ...(s.list ?? []), ...(s.steps ?? []), s.note ?? ""];
  return [
    ...ARTICLES.flatMap((a) => [a.title, a.description, ...a.sections.flatMap(sec)]),
    PRIVACY_DESCRIPTION,
    ...PRIVACY_SECTIONS.flatMap(sec),
  ];
}

describe("記事の数と形", () => {
  it("型の解説が P1〜P12 の1本ずつ、手順が3本", () => {
    const patterns = ARTICLES.map((a) => a.pattern).filter((p) => p !== null);
    expect(patterns).toEqual(Array.from({ length: 12 }, (_, i) => `P${i + 1}`));
    expect(ARTICLES.filter((a) => a.pattern === null).map((a) => a.slug)).toEqual(["guide-word", "guide-acrobat-redaction", "guide-scan"]);
  });

  it("名前が重ならず、URL に使える字だけ", () => {
    const slugs = ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
  });

  it("型の解説は、何が起きるか・なぜ起きるか・見分け方・正しい直し方の4つ", () => {
    for (const a of ARTICLES.filter((x) => x.pattern)) {
      expect(a.sections.map((s) => s.heading), a.slug).toEqual(["何が起きるか", "なぜ起きるか", "見分け方", "正しい直し方"]);
    }
  });

  it("手順の記事は、アプリの版によって画面が違うことを書く", () => {
    for (const a of ARTICLES.filter((x) => x.slug === "guide-word" || x.slug === "guide-acrobat-redaction")) {
      expect(a.sections.some((s) => s.note?.includes("版によって")), a.slug).toBe(true);
    }
  });

  it("検索の説明（meta description）は 40〜160 字", () => {
    for (const a of ARTICLES) {
      expect(a.description.length, a.slug).toBeGreaterThanOrEqual(40);
      expect(a.description.length, a.slug).toBeLessThanOrEqual(160);
    }
  });
});

describe("ページの HTML", () => {
  it("記事 15 本・一覧・プライバシーの 17 枚", () => {
    expect(html.map(([n]) => n).sort()).toEqual(
      ["articles/index.html", "privacy.html", ...ARTICLES.map((a) => `articles/${a.slug}.html`)].sort(),
    );
  });

  for (const [name, page] of html) {
    it(`${name}：題・説明・canonical・CSP があり、スクリプトがない`, () => {
      expect(page).toMatch(/<title>[^<]+｜お守りPDF<\/title>/);
      expect(page).toMatch(/<meta name="description" content="[^"]{20,}" \/>/);
      expect(page).toContain(`<link rel="canonical" href="${OFFICIAL_ORIGIN}/`);
      expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="${escapeHtml(cspForMeta)}" />`);
      expect(page).not.toMatch(/<script\b/);
      expect(page).not.toMatch(/\sstyle=/);
      expect(page).not.toMatch(/\son[a-z]+=/);
      // 外を指すのは canonical だけ
      expect(page.replace(/<link rel="canonical" href="[^"]+" \/>/, "")).not.toMatch(/(src|href)="(https?:)?\/\//);
      // 検査のページ（/）へつながる
      expect(page).toContain('href="/"');
    });
  }

  it("記事の最後に、検査のページへのつなぎがある", () => {
    for (const a of ARTICLES) expect(files.get(`articles/${a.slug}.html`)).toContain("検査のページで確かめる");
  });

  it("字は HTML として解釈させない", () => {
    const page = renderArticle(
      { slug: "x", pattern: null, title: "<script>alert(1)</script>", description: "\"><img src=x>", sections: [{ heading: "a&b", paragraphs: ["<b>'"] }] },
      { origin: OFFICIAL_ORIGIN, csp: cspForMeta, cssHref: "/assets/site.css" },
    );
    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("<img src=x>");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("a&amp;b");
    expect(page).toContain("&lt;b&gt;&#39;");
  });

  it("CSS は中身のハッシュの名前で1つだけ置き、どのページもそれを読む", () => {
    const css = [...files.keys()].filter((n) => n.endsWith(".css"));
    expect(css).toHaveLength(1);
    expect(css[0]).toMatch(/^assets\/site-[0-9a-f]{10}\.css$/);
    for (const [, page] of html) expect(page).toContain(`href="/${css[0]}"`);
    expect(files.get(css[0]!)).toContain("--color-base");
  });
});

describe("書き方の決まり", () => {
  const all = texts();
  const NG: Array<[string, RegExp]> = [
    ["安全です", /安全です/],
    ["問題なし", /問題(なし|ありません)/],
    ["初めて", /初めて/],
    ["唯一", /唯一/],
    ["上位互換", /上位互換/],
    ["導入", /導入/],
    ["黒塗りミス", /黒塗りミス|黒塗りの不備/],
    ["外の URL", /https?:\/\/|www\./],
    ["見張り・監視", /見張|監視/],
  ];
  for (const [label, re] of NG) {
    it(`「${label}」を使わない`, () => {
      expect(all.filter((t) => re.test(t))).toEqual([]);
    });
  }
});

describe("sitemap.xml・robots.txt", () => {
  it("トップ・記事の一覧・各記事・プライバシーを、公式の URL で並べる", () => {
    const xml = renderSitemap();
    for (const p of sitePaths()) expect(xml).toContain(`<loc>${OFFICIAL_ORIGIN}${p}</loc>`);
    expect(sitePaths()).toHaveLength(18);
    expect(files.get("sitemap.xml")).toBe(xml);
  });

  it("robots.txt は sitemap の場所を示す", () => {
    expect(renderRobots()).toContain(`Sitemap: ${OFFICIAL_ORIGIN}/sitemap.xml`);
    expect(files.get("robots.txt")).toBe(renderRobots());
  });
});

describe("検索エンジンの確認の印", () => {
  it("コードが空なら、何も入れない", () => {
    expect(verificationMeta("")).toBeNull();
  });

  it("コードがあれば、google-site-verification の <meta> にする", () => {
    expect(verificationMeta("abcDEF012_-xyz")).toEqual({ name: "google-site-verification", content: "abcDEF012_-xyz" });
  });

  it("使えない字が入っていたら止める", () => {
    expect(() => verificationMeta('abc" onload="x')).toThrow();
    expect(() => verificationMeta("<meta>abcdefghij")).toThrow();
  });
});

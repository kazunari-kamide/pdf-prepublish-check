// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページ（記事・プライバシーの説明。src/site/ と site.ts）を確かめる。
// - 記事は、P1〜P12 のどの型にも解説が1本以上あり、手順の記事もある（本数は決めない）。どのページにも題・説明・canonical・同じ CSP があり、検査のページと関係する記事へつながる
// - スクリプトを入れない。字は HTML として解釈させない
// - 使わない言い方（断定・「初めて」など）と、外の URL を書かない

import { describe, expect, it } from "vitest";
import { cspForContactMeta, cspForMeta } from "../csp.ts";
import { OFFICIAL_ORIGIN } from "../htaccess.ts";
import { heroScripts, renderRobots, renderSitemap, searchScript, siteFiles, verificationMeta } from "../site.ts";
import { usedTags } from "../src/site/article-index.ts";
import { ARTICLES } from "../src/site/articles.ts";
import { GUIDE_PATHS } from "../src/site/pages.ts";
import { tagPath } from "../src/site/tags.ts";
import { PRIVACY_DESCRIPTION, PRIVACY_SECTIONS } from "../src/site/privacy.ts";
import { escapeHtml, fileFor, renderArticle, sitePaths } from "../src/site/render.ts";
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
  it("P1〜P12 のどの型にも解説が1本以上あり、型の番号は P1〜P12 だけ", () => {
    const all = Array.from({ length: 12 }, (_, i) => `P${i + 1}`);
    const patterns = ARTICLES.map((a) => a.pattern).filter((p) => p !== null);
    for (const p of all) expect(patterns, p).toContain(p);
    for (const p of patterns) expect(all, p).toContain(p);
  });

  it("手順の記事がある（Word・Acrobat の墨消し・スキャンの書類を含む）", () => {
    const guides = ARTICLES.filter((a) => a.pattern === null).map((a) => a.slug);
    for (const s of ["guide-word", "guide-acrobat-redaction", "guide-scan"]) expect(guides).toContain(s);
    for (const s of guides) expect(s).toMatch(/^guide-/);
  });

  it("同じ型の解説は並べて置く（記事の一覧で型ごとにまとまる）", () => {
    const patterns = ARTICLES.map((a) => a.pattern).filter((p) => p !== null);
    const runs = patterns.filter((p, i) => i === 0 || patterns[i - 1] !== p);
    expect(new Set(runs).size).toBe(runs.length);
  });

  it("関係する記事は1つ以上あり、どれも記事の一覧にあって、自分自身・重なりがない", () => {
    const slugs = new Set(ARTICLES.map((a) => a.slug));
    for (const a of ARTICLES) {
      expect(a.related.length, a.slug).toBeGreaterThan(0);
      expect(new Set(a.related).size, a.slug).toBe(a.related.length);
      expect(a.related, a.slug).not.toContain(a.slug);
      for (const r of a.related) expect(slugs.has(r), `${a.slug} → ${r}`).toBe(true);
    }
  });

  it("どの記事も、ほかの記事の「関係する記事」から1つ以上つながっている", () => {
    const linked = new Set(ARTICLES.flatMap((a) => a.related));
    for (const a of ARTICLES) expect(linked.has(a.slug), a.slug).toBe(true);
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
    const apps = ["guide-word", "guide-excel", "guide-ichitaro", "guide-acrobat-redaction", "guide-photo"];
    for (const a of ARTICLES.filter((x) => apps.includes(x.slug))) {
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
  it("記事のすべてと、一覧・プライバシー・サイトの案内のページ（tests/site-pages.test.ts）がある", () => {
    const names = html.map(([n]) => n);
    expect(names).toEqual(expect.arrayContaining(["articles/index.html", "privacy.html", ...ARTICLES.map((a) => `articles/${a.slug}.html`), ...GUIDE_PATHS.map((p) => fileFor(p))]));
    // 記事の場所にある HTML は、記事の一覧と記事と、タグごとの一覧のページ（tests/article-index.test.ts）だけ
    expect(names.filter((n) => n.startsWith("articles/")).sort()).toEqual(
      ["articles/index.html", ...ARTICLES.map((a) => `articles/${a.slug}.html`), ...usedTags().map((t) => fileFor(tagPath(t)))].sort(),
    );
  });

  for (const [name, page] of html) {
    it(`${name}：題・説明・canonical・CSP があり、スクリプトがない`, () => {
      expect(page).toMatch(/<title>[^<]+｜お守りPDF<\/title>/);
      expect(page).toMatch(/<meta name="description" content="[^"]{20,}" \/>/);
      expect(page).toContain(`<link rel="canonical" href="${OFFICIAL_ORIGIN}/`);
      // お問い合わせのページだけ、form-action 'self'（同じサイトへのフォームの送信）だけが違う CSP（docs/contact.md）
      expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="${escapeHtml(name === "contact.html" ? cspForContactMeta : cspForMeta)}" />`);
      // スクリプトを持たない。例外は記事の一覧のページだけ：検索のスクリプト（2026-11-05 本人が決定）と、3D の飾りの読み込み役（2026-11-05 本人が承認）
      const scripts = page.match(/<script\b[^>]*>/g) ?? [];
      if (name === "articles/index.html")
        expect(scripts).toEqual([`<script type="module" src="/${searchScript().file}">`, `<script type="module" src="/${heroScripts().loader.file}">`]);
      else expect(scripts).toEqual([]);
      expect(page).not.toMatch(/\sstyle=/);
      expect(page).not.toMatch(/\son[a-z]+=/);
      // 外を指すのは canonical と、GitHub へ移る <a> のリンクだけ
      expect(page.replace(/<link rel="canonical" href="[^"]+" \/>/, "").replace(/<a href="https:\/\/github\.com\/[^"]*"/g, "<a")).not.toMatch(/(src|href)="(https?:)?\/\//);
      // 検査のページ（/）へつながる
      expect(page).toContain('href="/"');
    });
  }

  it("記事の最後に、検査のページへのつなぎがある", () => {
    for (const a of ARTICLES) expect(files.get(`articles/${a.slug}.html`)).toContain("検査のページで確かめる");
  });

  it("記事の最後に、関係する記事へのリンクがある", () => {
    for (const a of ARTICLES) {
      const page = files.get(`articles/${a.slug}.html`)!;
      expect(page, a.slug).toContain('aria-label="関係する記事"');
      for (const r of a.related) expect(page, `${a.slug} → ${r}`).toContain(`href="/articles/${r}"`);
    }
  });

  it("字は HTML として解釈させない", () => {
    const page = renderArticle(
      { slug: "x", pattern: null, title: "<script>alert(1)</script>", description: "\"><img src=x>", sections: [{ heading: "a&b", paragraphs: ["<b>'"] }], related: [] },
      { origin: OFFICIAL_ORIGIN, csp: cspForMeta, cssHref: "/assets/site.css" },
    );
    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("<img src=x>");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("a&amp;b");
    expect(page).toContain("&lt;b&gt;&#39;");
  });

  it("CSS は中身のハッシュの名前で1つだけ置き、どのページもそれを読む（サービスの紹介のページだけ、その後にもう1つ読む）", () => {
    const css = [...files.keys()].filter((n) => n.endsWith(".css"));
    const site = css.filter((n) => /^assets\/site-[0-9a-f]{10}\.css$/.test(n));
    const about = css.filter((n) => /^assets\/about-[0-9a-f]{10}\.css$/.test(n));
    expect(site).toHaveLength(1);
    expect(about).toHaveLength(1);
    expect(css).toHaveLength(2);
    for (const [, page] of html) expect(page).toContain(`href="/${site[0]}"`);
    expect(files.get(site[0]!)).toContain("--color-base");
    for (const [name, page] of html) expect(page.includes(`href="/${about[0]}"`), name).toBe(name === "about.html");
    const aboutPage = files.get("about.html")!;
    expect(aboutPage.indexOf(`href="/${site[0]}"`)).toBeLessThan(aboutPage.indexOf(`href="/${about[0]}"`));
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
    // 記事の場所は、記事の一覧と記事の本数だけ（ほかのページが増えても、この数は変わらない）
    expect(sitePaths().filter((p) => p.startsWith("/articles/"))).toHaveLength(ARTICLES.length + 1);
    expect(new Set(sitePaths()).size).toBe(sitePaths().length);
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

// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧・タグの絞り込み・検索・記事の図（src/site/article-index.ts・tags.ts・article-search.js、site-figures.ts）を確かめる。
// - タグの絞り込みは、タグごとのページなので、スクリプトなしで使える
// - 検索は、記事の一覧のページだけで、ページの中の題・説明・タグだけを探す。動かないときは欄が隠れたまま
// - 図は SVG と PNG だけで、大きさを書く。図がない記事には、図の場所を出さない

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICIAL_ORIGIN } from "../htaccess.ts";
import { buildFigures, pngSize, svgSize } from "../site-figures.ts";
import { searchScript, siteFiles } from "../site.ts";
import { renderIndexPages, searchText, usedTags } from "../src/site/article-index.ts";
// @ts-expect-error 型のない JavaScript のファイル（ブラウザでそのまま読む）
import { init, matches, normalize } from "../src/site/article-search.js";
import { ARTICLES } from "../src/site/articles.ts";
import { figureHtml, renderArticle } from "../src/site/render.ts";
import { TAGS, articleTags, tagPath } from "../src/site/tags.ts";
import type { Article } from "../src/site/types.ts";

const files = siteFiles();
const index = files.get("articles/index.html")!;

describe("タグ", () => {
  it("どの記事にも、種類のタグ（型の解説・手順）と、話題のタグが付く", () => {
    for (const a of ARTICLES) {
      const tags = articleTags(a);
      expect(tags.filter((t) => t.group === "kind").map((t) => t.label), a.slug).toEqual([a.pattern ? "型の解説" : "手順"]);
      expect(tags.some((t) => t.group === "topic"), a.slug).toBe(true);
    }
  });

  it("タグの名前とページの名前は重ならず、ページの名前は英小文字・数字・- だけ", () => {
    expect(new Set(TAGS.map((t) => t.label)).size).toBe(TAGS.length);
    expect(new Set(TAGS.map((t) => t.slug)).size).toBe(TAGS.length);
    for (const t of TAGS) expect(t.slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("記事の側で足せるのは TAGS にあるタグだけ（知らないタグは止める）", () => {
    const a = { ...ARTICLES[0]!, tags: ["知らないタグ"] };
    expect(() => articleTags(a)).toThrow(/TAGS にありません/);
  });

  it("使われているタグごとに、スクリプトなしの一覧のページがあり、そのタグの記事だけを並べる", () => {
    for (const t of usedTags()) {
      const page = files.get(tagPath(t).slice(1));
      expect(page, t.slug).toBeDefined();
      expect(page).not.toMatch(/<script\b/);
      expect(page).toContain(`<link rel="canonical" href="${OFFICIAL_ORIGIN}${tagPath(t)}" />`);
      const hrefs = [...page!.matchAll(/<a class="card-head" href="([^"]+)"/g)].map((m) => m[1]);
      const want = ARTICLES.filter((a) => articleTags(a).includes(t)).map((a) => `/articles/${a.slug}.html`);
      expect(hrefs.sort()).toEqual(want.sort());
      // いま見ているタグは、リンクにしない
      expect(page).toContain(`<span class="tag site-tag" aria-current="page">${t.label}（${want.length}）</span>`);
    }
  });

  it("記事が1本もないタグのページは作らない。作ったタグのページは、検索に載せるページとして sitemap に入れる（#78 の決まり）", () => {
    for (const t of TAGS.filter((x) => !usedTags().includes(x))) {
      expect(files.has(tagPath(t).slice(1))).toBe(false);
      expect(files.get("sitemap.xml")).not.toContain(tagPath(t));
    }
    for (const t of usedTags()) expect(files.get("sitemap.xml")).toContain(`<loc>${OFFICIAL_ORIGIN}${tagPath(t)}</loc>`);
  });

  it("タグのページの head：題は 20〜40 字・説明は 80〜120 字で、タグごとに違い、OGP の題・説明と同じ", () => {
    const titles = new Set<string>();
    for (const t of usedTags()) {
      const head = files.get(tagPath(t).slice(1))!.split("</head>")[0]!;
      const title = head.match(/<title>([^<]+)<\/title>/)![1]!;
      const desc = head.match(/<meta name="description" content="([^"]+)"/)![1]!;
      expect([...title].length, title).toBeGreaterThanOrEqual(20);
      expect([...title].length, title).toBeLessThanOrEqual(40);
      expect([...desc].length, desc).toBeGreaterThanOrEqual(80);
      expect([...desc].length, desc).toBeLessThanOrEqual(120);
      expect(head).toContain(`<meta property="og:title" content="${title}"`);
      expect(head).toContain(`<meta property="og:url" content="${OFFICIAL_ORIGIN}${tagPath(t)}"`);
      expect(head).not.toContain("noindex");
      titles.add(title);
    }
    expect(titles.size).toBe(usedTags().length);
  });
});

describe("記事の一覧のページ", () => {
  it("すべての記事をカードで並べ、それぞれに検索の字（題・説明・型の番号・タグ）を持つ", () => {
    const cards = [...index.matchAll(/<li class="card" data-search="([^"]*)">/g)];
    expect(cards).toHaveLength(ARTICLES.length);
    expect(searchText(ARTICLES[0]!)).toContain(ARTICLES[0]!.title);
  });

  it("検索の欄は、はじめは隠しておき（hidden）、検索のスクリプトを1つだけ読み込む", () => {
    expect(index).toMatch(/<div id="article-search" class="site-search" role="search" hidden>/);
    expect(index).toContain(`<script type="module" src="/${searchScript().file}"></script>`);
    expect(files.get(searchScript().file)).toBe(searchScript().source);
    expect(searchScript().file).toMatch(/^assets\/article-search-[0-9a-f]{10}\.js$/);
  });

  it("タグで絞り込むリンクがあり、スクリプトなしで使える（タグのページへのふつうのリンク）", () => {
    for (const t of usedTags()) expect(index).toContain(`<a class="tag site-tag" href="${tagPath(t)}">`);
  });

  it("検索のスクリプトがないときは、検索の欄も script も出さない", () => {
    const page = renderIndexPages({ origin: OFFICIAL_ORIGIN, csp: "x", cssHref: "/a.css" }).get("articles/index.html")!;
    expect(page).not.toContain("article-search");
    expect(page).not.toMatch(/<script\b/);
  });
});

describe("検索のスクリプト", () => {
  it("全角・半角と大文字・小文字をそろえて、空白で区切った語がすべて入っているかで探す", () => {
    expect(normalize("ＰＤＦ　の　Ｐ６")).toBe("pdf の p6");
    expect(matches("p6 黒塗り", "見せかけの黒塗り P6 黒塗り")).toBe(true);
    expect(matches("p6 写真", "見せかけの黒塗り P6")).toBe(false);
    expect(matches("   ", "なんでも")).toBe(true);
  });

  it("通信と、字を HTML として解釈させる書き方を使わない", () => {
    const src = searchScript().source;
    expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/);
    expect(src).not.toMatch(/\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function/);
  });

  it("ページの欄を出し、当たらない記事と、当たる記事のない節を隠し、件数を字で知らせる", () => {
    const listeners: Array<() => void> = [];
    const el = (attrs: Record<string, string> = {}) => ({ hidden: true, textContent: "", value: "", getAttribute: (k: string) => attrs[k] ?? null, addEventListener: (_: string, f: () => void) => listeners.push(f) });
    const box = el();
    const input = el();
    const count = el();
    const items = [el({ "data-search": "見せかけの黒塗り P6 黒塗り" }), el({ "data-search": "写真の撮影場所 P10 写真の情報" })];
    for (const it of items) it.hidden = false;
    const sec = { hidden: false, querySelector: () => items.find((x) => !x.hidden) ?? null };
    const doc = {
      getElementById: (id: string) => ({ "article-search": box, "article-search-input": input, "article-search-count": count })[id] ?? null,
      querySelectorAll: (sel: string) => (sel === "[data-search]" ? items : [sec]),
    };
    init(doc);
    expect(box.hidden).toBe(false);
    expect(count.textContent).toBe("2 本の記事");
    input.value = "黒塗り";
    listeners.forEach((f) => f());
    expect(items.map((x) => x.hidden)).toEqual([false, true]);
    expect(count.textContent).toBe("2 本のうち 1 本");
    input.value = "見つからない語";
    listeners.forEach((f) => f());
    expect(sec.hidden).toBe(true);
    expect(count.textContent).toBe("当てはまる記事はありませんでした");
  });
});

describe("記事の図", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const article = (figure: Article["figure"]): Article => ({ ...ARTICLES[0]!, slug: "x", figure });
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };

  it("図がない記事には、図の場所を出さない", () => {
    expect(figureHtml(undefined)).toEqual([]);
    const a = ARTICLES.find((x) => !x.figure)!;
    expect(files.get(`articles/${a.slug}.html`)).not.toContain("<figure");
  });

  it("SVG と PNG は、大きさを読み、名前にハッシュを付けて assets/figures/ に置く", () => {
    dir = mkdtempSync(path.join(tmpdir(), "omamori-fig-"));
    writeFileSync(path.join(dir, "a.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="10" height="10" fill="#2b2a28"/></svg>');
    writeFileSync(path.join(dir, "b.png"), png(1200, 800));
    const built = buildFigures([article({ file: "a.svg", alt: "図の説明", caption: "下の説明" }), { ...article({ file: "b.png", alt: "画面" }), slug: "y" }], dir);
    const a = built.assets.get("x")!;
    expect(a).toMatchObject({ alt: "図の説明", caption: "下の説明", width: 640, height: 360 });
    expect(a.href).toMatch(/^\/assets\/figures\/a-[0-9a-f]{10}\.svg$/);
    expect(built.assets.get("y")).toMatchObject({ width: 1200, height: 800 });
    expect([...built.files.keys()].sort()).toEqual([a.href.slice(1), built.assets.get("y")!.href.slice(1)].sort());
    const html = figureHtml(a).join("\n");
    expect(html).toContain(`<img src="${a.href}" alt="図の説明" width="640" height="360" />`);
    expect(html).toContain("<figcaption>下の説明</figcaption>");
    // 記事のページでは、説明の下に図を置く
    const page = renderArticle({ ...ARTICLES[0]! }, { origin: OFFICIAL_ORIGIN, csp: "x", cssHref: "/a.css", figures: new Map([[ARTICLES[0]!.slug, a]]) });
    expect(page.indexOf('<figure class="site-figure">')).toBeGreaterThan(page.indexOf('<p class="site-lead">'));
  });

  it("スクリプト・style・外を指すリンクの入った SVG、代わりの文のない図、ない・使えない名前のファイルは止める", () => {
    dir = mkdtempSync(path.join(tmpdir(), "omamori-fig-"));
    const bad = {
      "s.svg": '<svg viewBox="0 0 1 1"><script>x</script></svg>',
      "t.svg": '<svg viewBox="0 0 1 1" style="fill:red"></svg>',
      "h.svg": '<svg viewBox="0 0 1 1"><a href="https://example.invalid/">x</a></svg>',
      "n.svg": "<svg><rect/></svg>",
    };
    for (const [n, t] of Object.entries(bad)) {
      writeFileSync(path.join(dir, n), t);
      expect(() => buildFigures([article({ file: n, alt: "x" })], dir), n).toThrow();
    }
    writeFileSync(path.join(dir, "ok.svg"), '<svg viewBox="0 0 2 1"><use href="#a"/></svg>');
    expect(() => buildFigures([article({ file: "ok.svg", alt: " " })], dir)).toThrow(/alt/);
    expect(() => buildFigures([article({ file: "none.svg", alt: "x" })], dir)).toThrow(/ありません/);
    expect(() => buildFigures([article({ file: "Bad Name.jpg", alt: "x" })], dir)).toThrow(/名前/);
    expect(svgSize('<svg width="20px" height="10" viewBox="0 0 1 1"></svg>')).toEqual({ width: 20, height: 10 });
    expect(() => pngSize(Buffer.from("not a png file at all, really"))).toThrow();
  });
});

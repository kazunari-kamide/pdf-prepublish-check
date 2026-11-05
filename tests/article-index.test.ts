// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧・タグの絞り込み・検索・記事の図（src/site/article-index.ts・tags.ts・article-search.js、site-figures.ts）を確かめる。
// - タグの絞り込みは、タグごとのページなので、スクリプトなしで使える
// - 検索は、記事の一覧のページだけで、ページの中の題・説明・タグだけを探す。動かないときは欄が隠れたまま
// - 記事の一覧のページでは、タグを押すとその場で絞り込み、アドレスを #slug にする。スクリプトなしでは、タグのページへ移る
// - ページの移り変わりの動き（motion.css・motion.ts）は、動きを減らす設定の人には出さない
// - 図は SVG と PNG だけで、大きさを書く。図がない記事には、図の場所を出さない

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICIAL_ORIGIN } from "../htaccess.ts";
import { buildFigures, pngSize, svgSize } from "../site-figures.ts";
import { searchScript, siteCss, siteFiles } from "../site.ts";
import { renderIndexPages, searchText, usedTags } from "../src/site/article-index.ts";
// @ts-expect-error 型のない JavaScript のファイル（ブラウザでそのまま読む）
import { countText, hasTag, init, matches, normalize, tagFromHash } from "../src/site/article-search.js";
import { ARTICLES } from "../src/site/articles.ts";
import { articleTransitionNames } from "../src/site/motion.ts";
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
    const cards = [...index.matchAll(/<li class="card" data-article="([a-z0-9-]+)" data-tags="([a-z0-9 -]+)" data-search="([^"]*)">/g)];
    expect(cards).toHaveLength(ARTICLES.length);
    // data-tags は、その記事のタグの slug（その場の絞り込みに使う）
    for (const [, slug, tags] of cards) expect(tags!.split(" ")).toEqual(articleTags(ARTICLES.find((a) => a.slug === slug)!).map((t) => t.slug));
    expect(searchText(ARTICLES[0]!)).toContain(ARTICLES[0]!.title);
  });

  it("検索の欄は、はじめは隠しておき（hidden）、検索のスクリプトを1つだけ読み込む", () => {
    expect(index).toMatch(/<div id="article-search" class="site-search" role="search" hidden>/);
    expect(index).toContain(`<script type="module" src="/${searchScript().file}"></script>`);
    expect(files.get(searchScript().file)).toBe(searchScript().source);
    expect(searchScript().file).toMatch(/^assets\/article-search-[0-9a-f]{10}\.js$/);
  });

  it("タグで絞り込むリンクがあり、スクリプトなしで使える（タグのページへのふつうのリンク。その場で絞り込むための data-tag も持つ）", () => {
    for (const t of usedTags()) expect(index).toContain(`<a class="tag site-tag" href="${tagPath(t)}" data-tag="${t.slug}" data-tag-label="${t.label}">`);
    expect(index).toMatch(/<a href="\/articles\/" data-tag="" aria-current="page">すべての記事（\d+）<\/a>/);
  });

  it("タグのページのリンクには data-tag を付けない（スクリプトのないページ）", () => {
    for (const t of usedTags()) expect(files.get(tagPath(t).slice(1))).not.toContain("data-tag=");
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
      querySelectorAll: (sel: string) => (sel === "[data-search]" ? items : sel === "[data-search-section]" ? [sec] : []),
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

describe("タグの絞り込み（記事の一覧のページの中）", () => {
  it("札のタグで絞り込む。タグが空なら、すべて当たる", () => {
    expect(hasTag("patterns redaction", "redaction")).toBe(true);
    expect(hasTag("patterns redaction", "red")).toBe(false);
    expect(hasTag("patterns", "")).toBe(true);
    expect(hasTag(null, "patterns")).toBe(false);
  });

  it("アドレスの #… から、知っているタグだけを取る（slug でも、タグの名前でもよい）", () => {
    const labels = new Map([
      ["redaction", "黒塗り"],
      ["photos", "写真の情報"],
    ]);
    expect(tagFromHash("#redaction", labels)).toBe("redaction");
    expect(tagFromHash(`#${encodeURIComponent("黒塗り")}`, labels)).toBe("redaction");
    expect(tagFromHash("#unknown", labels)).toBe("");
    expect(tagFromHash("", labels)).toBe("");
    expect(tagFromHash("#%E0%A4%A", labels)).toBe("");
  });

  it("件数の字は、タグと検索の語に合わせて変わる", () => {
    expect(countText({ total: 32, inTag: 32, shown: 32, query: "", label: "" })).toBe("32 本の記事");
    expect(countText({ total: 32, inTag: 5, shown: 5, query: "", label: "黒塗り" })).toBe("「黒塗り」の記事 5 本（32 本のうち）");
    expect(countText({ total: 32, inTag: 5, shown: 2, query: "p6", label: "黒塗り" })).toBe("「黒塗り」の記事 5 本のうち 2 本");
    expect(countText({ total: 32, inTag: 5, shown: 0, query: "zzz", label: "黒塗り" })).toBe("「黒塗り」の記事に、当てはまる記事はありませんでした");
  });

  const fakeEl = (attrs: Record<string, string> = {}, on: (type: string, f: (ev?: unknown) => void) => void = () => {}) => ({
    hidden: false,
    textContent: "",
    value: "",
    attrs,
    getAttribute: (k: string) => attrs[k] ?? null,
    setAttribute: (k: string, v: string) => void (attrs[k] = v),
    removeAttribute: (k: string) => void delete attrs[k],
    addEventListener: on,
  });

  it("タグを押すと、その場で絞り込み、アドレスを #slug にし、選んだタグに aria-current を付ける（動きを減らす設定では、動かさない）", () => {
    const handlers: Record<string, Array<(ev?: unknown) => void>> = {};
    const on = (key: string) => (type: string, f: (ev?: unknown) => void) => void (handlers[`${key}:${type}`] ??= []).push(f);
    const box = fakeEl();
    const input = fakeEl({}, on("input"));
    const count = fakeEl();
    const items = [fakeEl({ "data-search": "見せかけの黒塗り", "data-tags": "patterns redaction" }), fakeEl({ "data-search": "写真の撮影場所", "data-tags": "patterns photos" })];
    const all = fakeEl({ "data-tag": "", "aria-current": "page" }, on("all"));
    const red = fakeEl({ "data-tag": "redaction", "data-tag-label": "黒塗り" }, on("red"));
    const sec = { hidden: false, querySelector: () => items.find((x) => !x.hidden) ?? null };
    const pushed: string[] = [];
    let transitions = 0;
    const win = {
      location: { pathname: "/articles/", search: "", hash: "#photos" },
      history: { pushState: (_s: unknown, _t: string, url: string) => void pushed.push(url) },
      matchMedia: () => ({ matches: false }),
      addEventListener: on("win"),
    };
    const doc = {
      getElementById: (id: string) => ({ "article-search": box, "article-search-input": input, "article-search-count": count })[id] ?? null,
      querySelectorAll: (sel: string) => (sel === "[data-search]" ? items : sel === "[data-search-section]" ? [sec] : sel === "a[data-tag]" ? [all, red] : []),
      querySelector: () => null,
      // 本物と同じく、呼んだ後で（非同期に）書き換え、飛ばされたときの ready は失敗で返す
      pending: [] as Array<() => void>,
      startViewTransition(f: () => void) {
        transitions++;
        this.pending.push(f);
        return { ready: Promise.reject(new Error("AbortError")), finished: Promise.resolve() };
      },
      flush() {
        for (const f of this.pending.splice(0)) f();
      },
    };
    // #photos は、ページにタグのリンクがないので知らないタグ：絞り込まない
    init(doc, win);
    expect(items.map((x) => x.hidden)).toEqual([false, false]);
    expect(all.attrs["aria-current"]).toBe("page");
    let prevented = false;
    const click = (key: string, extra: Record<string, unknown> = {}) => {
      prevented = false;
      for (const f of handlers[`${key}:click`] ?? []) f({ button: 0, defaultPrevented: false, preventDefault: () => (prevented = true), ...extra });
    };
    // Ctrl を押しながらのときは、ふつうのリンク（タグのページを新しいタブで開く）
    click("red", { ctrlKey: true });
    expect(prevented).toBe(false);
    expect(items.map((x) => x.hidden)).toEqual([false, false]);
    click("red");
    expect(prevented).toBe(true);
    expect(pushed).toEqual(["#redaction"]);
    expect(transitions).toBe(1);
    // 動きの途中にもう一度押しても、同じタグなら動きを重ねない
    click("red");
    expect(transitions).toBe(1);
    doc.flush();
    expect(items.map((x) => x.hidden)).toEqual([false, true]);
    expect(red.attrs["aria-current"]).toBe("page");
    expect(all.attrs["aria-current"]).toBeUndefined();
    expect(count.textContent).toBe("「黒塗り」の記事 1 本（2 本のうち）");
    // 戻る：popstate と hashchange が続けて来ても、動きは1回だけ。アドレスが元に戻ると、絞り込みも戻る
    win.location.hash = "";
    for (const f of [...(handlers["win:popstate"] ?? []), ...(handlers["win:hashchange"] ?? [])]) f();
    expect(transitions).toBe(2);
    doc.flush();
    expect(items.map((x) => x.hidden)).toEqual([false, false]);
    expect(count.textContent).toBe("2 本の記事");
    // 動きを減らす設定なら、startViewTransition を使わず、すぐ書き換える
    win.matchMedia = () => ({ matches: true });
    win.location.hash = "#redaction";
    for (const f of handlers["win:popstate"] ?? []) f();
    expect(transitions).toBe(2);
    expect(items.map((x) => x.hidden)).toEqual([false, true]);
    // 「すべての記事」を押すと、# のないアドレスに戻す
    click("all");
    expect(pushed.at(-1)).toBe("/articles/");
    expect(items.map((x) => x.hidden)).toEqual([false, false]);
  });

  it("#slug のアドレスで開くと、はじめから同じ絞り込みになる", () => {
    const items = [fakeEl({ "data-search": "a", "data-tags": "patterns redaction" }), fakeEl({ "data-search": "b", "data-tags": "guides" })];
    const count = fakeEl();
    const links = [fakeEl({ "data-tag": "redaction", "data-tag-label": "黒塗り" }), fakeEl({ "data-tag": "guides", "data-tag-label": "手順" })];
    const doc = {
      getElementById: (id: string) => ({ "article-search": fakeEl(), "article-search-input": fakeEl(), "article-search-count": count })[id] ?? null,
      querySelectorAll: (sel: string) => (sel === "[data-search]" ? items : sel === "a[data-tag]" ? links : []),
      querySelector: () => null,
    };
    init(doc, { location: { pathname: "/articles/", search: "", hash: "#guides" }, history: { pushState: () => {} }, addEventListener: () => {} });
    expect(items.map((x) => x.hidden)).toEqual([true, false]);
    expect(count.textContent).toBe("「手順」の記事 1 本（2 本のうち）");
  });
});

describe("ページの移り変わりの動き", () => {
  it("サイトの CSS に、動きを減らす設定のときだけ外れる @view-transition と、記事ごとの名前（一覧の札と記事のページで同じ）が入る", () => {
    const css = siteCss();
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*@view-transition \{\s*navigation: auto;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
    for (const a of ARTICLES) {
      expect(css).toContain(`.card[data-article="${a.slug}"] { view-transition-name: card-${a.slug}; }`);
      expect(css).toContain(`.site-article[data-article="${a.slug}"] h1 { view-transition-name: title-${a.slug}; }`);
    }
    // 記事のページにも、名前を当てる印がある
    expect(files.get(`articles/${ARTICLES[0]!.slug}.html`)).toContain(`<article class="site-article" data-article="${ARTICLES[0]!.slug}">`);
  });

  it("名前に使えない slug は止める（CSS に字を混ぜない）", () => {
    expect(() => articleTransitionNames(['x"]{}'])).toThrow(/使えません/);
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
    // 今は全部の記事に図があるので、図のない記事を作って確かめる（2026-11-05 H、記事の図を足したとき）
    const page = renderArticle({ ...ARTICLES[0]!, figure: undefined }, { origin: OFFICIAL_ORIGIN, csp: "x", cssHref: "/a.css", figures: new Map() });
    expect(page).not.toContain("<figure");
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

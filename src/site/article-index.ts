// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧のページ（/articles/）と、タグごとの一覧のページ（/articles/tags/<slug>.html）を作る。ビルドの時に site.ts が呼ぶ。
// - タグの絞り込みは、タグごとのページへのリンクなので、スクリプトなしで使える。
// - 検索は、記事の一覧のページにだけ、同じサイトのスクリプトのファイル（article-search.js）を1つ読み込む。
//   検索の欄は hidden で出し、スクリプトが動いたときだけ見せる（動かなくても、一覧とタグはそのまま使える）。
// - 記事の一覧のページでは、同じスクリプトが、タグのリンク（data-tag）を押したときに、ページを移らずにその場で絞り込む（アドレスは #slug）。
//   スクリプトが動かないときは、ふつうのリンクとしてタグのページへ移る。タグのページには、スクリプトを入れない。
// - 札（li.card）の data-article は、ページの移り変わりの動き（motion.ts の view-transition-name）を当てるための印。
// - 見た目の部品の名前は、デザインシート（design/sheet.md）のもの（card・card-head・card-body・tag）を使う。色や枠はここでは決めない。
// - 字は、すべて escapeHtml を通す。

import { ARTICLES } from "./articles.ts";
import { ARTICLES_META, ARTICLES_PATH, articlePath, escapeHtml, fileFor, layout, toInspector, type RenderOptions } from "./render.ts";
import { TAGS, articleTags, tagPath, type Tag } from "./tags.ts";
import type { Article } from "./types.ts";

const e = escapeHtml;

/** 検索で探す字（題・説明・型の番号・タグ）。ページの中の data-search に入れる */
export function searchText(a: Article): string {
  return [a.title, a.description, a.pattern ?? "", ...articleTags(a).map((t) => t.label)].join(" ");
}

/** タグのリンク。inPage（記事の一覧のページ）のときは、その場で絞り込むための data-tag を付ける */
function tagLink(t: Tag, text: string, inPage: boolean): string {
  return `<a class="tag site-tag" href="${tagPath(t)}"${inPage ? ` data-tag="${e(t.slug)}" data-tag-label="${e(t.label)}"` : ""}>${text}</a>`;
}

function card(a: Article, o: RenderOptions, current?: Tag): string {
  const fig = o.figures?.get(a.slug);
  const tags = articleTags(a).map((t) => (t === current ? `<li><span class="tag site-tag" aria-current="page">${e(t.label)}</span></li>` : `<li>${tagLink(t, e(t.label), !current)}</li>`));
  return [
    `          <li class="card" data-article="${e(a.slug)}" data-tags="${e(articleTags(a).map((t) => t.slug).join(" "))}" data-search="${e(searchText(a))}">`,
    // 一覧の小さな図は、すぐ横に題があるので飾りとして扱う（alt を空にする）
    ...(fig ? [`            <img class="card-figure" src="${e(fig.href)}" alt="" width="${fig.width}" height="${fig.height}" loading="lazy" />`] : []),
    `            <a class="card-head" href="${articlePath(a)}">${a.pattern ? `<span class="tag site-tag">${e(a.pattern)}</span>` : ""}${e(a.title)}</a>`,
    `            <div class="card-body">`,
    `              <p>${e(a.description)}</p>`,
    `              <ul class="card-tags" aria-label="タグ">${tags.join("")}</ul>`,
    `            </div>`,
    `          </li>`,
  ].join("\n");
}

/** タグで絞り込むリンクの並び（種類・話題）。いま見ているタグは、リンクにしない */
function tagNav(current?: Tag): string {
  const used = new Set(ARTICLES.flatMap((a) => articleTags(a)));
  const link = (t: Tag) => {
    const n = ARTICLES.filter((a) => articleTags(a).includes(t)).length;
    const label = `${e(t.label)}（${n}）`;
    return t === current ? `<li><span class="tag site-tag" aria-current="page">${label}</span></li>` : `<li>${tagLink(t, label, !current)}</li>`;
  };
  const group = (g: Tag["group"]) => TAGS.filter((t) => t.group === g && used.has(t)).map(link).join("");
  // 記事の一覧のページでは「すべての記事」もリンクにしておき、その場で絞り込んだあとに、元へ戻すのに使う（data-tag=""）
  const all = current ? `<a href="${ARTICLES_PATH}">すべての記事（${ARTICLES.length}）</a>` : `<a href="${ARTICLES_PATH}" data-tag="" aria-current="page">すべての記事（${ARTICLES.length}）</a>`;
  return [
    `      <nav class="site-section site-tag-nav" aria-label="タグで絞り込む">`,
    `        <h2>タグで絞り込む</h2>`,
    `        <p class="site-tag-all">${all}</p>`,
    `        <p class="site-tag-group">種類</p>`,
    `        <ul class="site-tag-list">${group("kind")}</ul>`,
    `        <p class="site-tag-group">話題</p>`,
    `        <ul class="site-tag-list">${group("topic")}</ul>`,
    `      </nav>`,
  ].join("\n");
}

function list(heading: string, items: Article[], o: RenderOptions, current?: Tag): string[] {
  if (!items.length) return [];
  return [
    `      <section class="site-section" data-search-section>`,
    `        <h2>${e(heading)}</h2>`,
    `        <ul class="site-list site-cards">`,
    ...items.map((a) => card(a, o, current)),
    `        </ul>`,
    `      </section>`,
  ];
}

/** 検索の欄。はじめは隠しておき、スクリプトが動いたときだけ出す */
function searchBox(): string {
  return [
    `      <div id="article-search" class="site-search" role="search" hidden>`,
    `        <label for="article-search-input">記事を探す（題・説明・タグから）</label>`,
    `        <input id="article-search-input" type="search" autocomplete="off" enterkeyhint="search" />`,
    `        <p id="article-search-count" class="site-note" aria-live="polite"></p>`,
    `      </div>`,
  ].join("\n");
}

/**
 * 見出しまわりの立体感のある飾り（2026-11-05 本人が承認）。はじめは CSS の版（傾けた紙の束）を出し、
 * 読み込み役（site-3d.js）が、手が空いてから 3D の描画（data-scene）に入れ替える。飾りなので読み上げない。
 */
function hero(o: RenderOptions): string[] {
  const title = `<h1>${e(ARTICLES_META.title)}</h1>`;
  const lead = `<p class="site-lead">${e(ARTICLES_META.description)}</p>`;
  if (!o.hero) return [`      ${title}`, `      ${lead}`];
  return [
    `      <div class="site-hero" data-scene="${e(o.hero.scene)}">`,
    `        <div class="site-hero-text">`,
    `          ${title}`,
    `          ${lead}`,
    `        </div>`,
    `        <div class="site-hero-3d" aria-hidden="true">`,
    `          <div class="site-stack"><span class="site-sheet"></span><span class="site-sheet"></span><span class="site-sheet"><i></i><i class="site-sheet-bar"></i><i></i><i class="site-sheet-short"></i><i></i></span><span class="site-badge">✓</span></div>`,
    `        </div>`,
    `      </div>`,
  ];
}

export function renderArticleIndex(o: RenderOptions): string {
  const body = [
    ...hero(o),
    ...(o.searchScript ? [searchBox()] : []),
    tagNav(),
    ...list("型の解説", ARTICLES.filter((a) => a.pattern), o),
    ...list("正しいやり方の手順", ARTICLES.filter((a) => !a.pattern), o),
    toInspector(),
    ...(o.searchScript ? [`      <script type="module" src="${e(o.searchScript)}"></script>`] : []),
    ...(o.hero ? [`      <script type="module" src="${e(o.hero.loader)}"></script>`] : []),
  ].join("\n");
  return layout(ARTICLES_META, body, o);
}

export function renderTagPage(t: Tag, o: RenderOptions): string {
  const items = ARTICLES.filter((a) => articleTags(a).includes(t));
  const meta = {
    path: tagPath(t),
    title: `「${t.label}」の記事`,
    description: `「${t.label}」のタグの付いた記事（${items.length} 本）です。PDF を公開・提出する前に知っておきたい、見た目では分からない情報の残り方と、正しいやり方の手順。`,
  };
  const body = [
    `      <p class="site-kicker">記事の一覧・タグ</p>`,
    `      <h1>${e(meta.title)}</h1>`,
    `      <p class="site-lead">${e(meta.description)}</p>`,
    tagNav(t),
    ...list("型の解説", items.filter((a) => a.pattern), o, t),
    ...list("正しいやり方の手順", items.filter((a) => !a.pattern), o, t),
    `      <p class="site-back"><a href="${ARTICLES_PATH}">すべての記事へ戻る</a></p>`,
  ].join("\n");
  return layout(meta, body, o);
}

/** 使われているタグ（記事が1本もないタグのページは作らない） */
export function usedTags(): Tag[] {
  const used = new Set(ARTICLES.flatMap((a) => articleTags(a)));
  return TAGS.filter((t) => used.has(t));
}

/** 記事の一覧とタグのページを全部作る。鍵は dist/ の中のファイルの名前 */
export function renderIndexPages(o: RenderOptions): Map<string, string> {
  const pages = new Map<string, string>();
  pages.set(fileFor(ARTICLES_PATH), renderArticleIndex(o));
  for (const t of usedTags()) pages.set(fileFor(tagPath(t)), renderTagPage(t, o));
  return pages;
}

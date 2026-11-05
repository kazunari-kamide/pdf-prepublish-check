// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧のページ（/articles/）と、タグごとの一覧のページ（/articles/tags/<slug>.html）を作る。ビルドの時に site.ts が呼ぶ。
// - タグの絞り込みは、タグごとのページへのリンクなので、スクリプトなしで使える。
// - 検索は、記事の一覧のページにだけ、同じサイトのスクリプトのファイル（article-search.js）を1つ読み込む。
//   検索の欄は hidden で出し、スクリプトが動いたときだけ見せる（動かなくても、一覧とタグはそのまま使える）。
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

function card(a: Article, o: RenderOptions, current?: Tag): string {
  const fig = o.figures?.get(a.slug);
  const tags = articleTags(a).map((t) =>
    t === current ? `<li><span class="tag site-tag" aria-current="page">${e(t.label)}</span></li>` : `<li><a class="tag site-tag" href="${tagPath(t)}">${e(t.label)}</a></li>`,
  );
  return [
    `          <li class="card" data-search="${e(searchText(a))}">`,
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
    return t === current ? `<li><span class="tag site-tag" aria-current="page">${label}</span></li>` : `<li><a class="tag site-tag" href="${tagPath(t)}">${label}</a></li>`;
  };
  const group = (g: Tag["group"]) => TAGS.filter((t) => t.group === g && used.has(t)).map(link).join("");
  const all = current ? `<a href="${ARTICLES_PATH}">すべての記事（${ARTICLES.length}）</a>` : `<span aria-current="page">すべての記事（${ARTICLES.length}）</span>`;
  return [
    `      <nav class="site-section site-tag-nav" aria-label="タグで絞り込む">`,
    `        <h2>タグで絞り込む</h2>`,
    `        <p>${all}</p>`,
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

export function renderArticleIndex(o: RenderOptions): string {
  const body = [
    `      <h1>${e(ARTICLES_META.title)}</h1>`,
    `      <p class="site-lead">${e(ARTICLES_META.description)}</p>`,
    ...(o.searchScript ? [searchBox()] : []),
    tagNav(),
    ...list("型の解説", ARTICLES.filter((a) => a.pattern), o),
    ...list("正しいやり方の手順", ARTICLES.filter((a) => !a.pattern), o),
    toInspector(),
    ...(o.searchScript ? [`      <script type="module" src="${e(o.searchScript)}"></script>`] : []),
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

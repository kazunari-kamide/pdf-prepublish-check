// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページ（記事の一覧・各記事・プライバシーの説明）を、字の中身から作る（sitemap.xml・robots.txt は site.ts）。
// ビルドの時に site.ts（Vite のプラグイン）が呼ぶ。ブラウザでは動かさない。
// - 字は、すべて escapeHtml を通す（HTML として解釈させない。CLAUDE.md §11-3）。
// - ページには、スクリプトを入れない。読み込むのは、同じサイトの CSS 1つだけ。
// - サイトの場所（https の公式の URL）は、呼ぶ側から受け取る（htaccess.ts の OFFICIAL_ORIGIN）。ここには書かない。

import { ARTICLES } from "./articles.ts";
import { PRIVACY_DESCRIPTION, PRIVACY_SECTIONS, PRIVACY_TITLE } from "./privacy.ts";
import type { Article, PageMeta, Section } from "./types.ts";

export const SITE_NAME = "お守りPDF";
export const ARTICLES_PATH = "/articles/";
export const PRIVACY_PATH = "/privacy.html";

export interface RenderOptions {
  /** 公式のサイトの場所（例：https の公式の URL）。末尾の / はなし */
  origin: string;
  /** <meta> に入れる CSP（csp.ts の cspForMeta） */
  csp: string;
  /** サイトのページの CSS の場所（/assets/site-xxxx.css） */
  cssHref: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const articlePath = (a: Article) => `${ARTICLES_PATH}${a.slug}.html`;

/** dist/ の中のファイルの名前（先頭の / なし）。/articles/ は articles/index.html */
export function fileFor(path: string): string {
  return (path.endsWith("/") ? `${path}index.html` : path).replace(/^\//, "");
}

function layout(meta: PageMeta, body: string, o: RenderOptions): string {
  const e = escapeHtml;
  const title = meta.path === "/" ? SITE_NAME : `${meta.title}｜${SITE_NAME}`;
  return `<!doctype html>
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${e(o.csp)}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${e(title)}</title>
    <meta name="description" content="${e(meta.description)}" />
    <link rel="canonical" href="${e(o.origin + meta.path)}" />
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="${e(o.cssHref)}" />
  </head>
  <body class="site">
    <header class="site-band">
      <a class="site-brand" href="/">${e(SITE_NAME)}</a>
      <nav class="site-nav" aria-label="サイトの案内">
        <a href="/">検査のページ</a>
        <a href="${ARTICLES_PATH}">記事の一覧</a>
        <a href="${PRIVACY_PATH}">プライバシー</a>
      </nav>
    </header>
    <main class="site-main">
${body}
    </main>
    <footer class="site-foot">
      <p>PDF はこのパソコンのブラウザの中だけで読みます。どこにも送りません。</p>
    </footer>
  </body>
</html>
`;
}

function renderSection(s: Section): string {
  const e = escapeHtml;
  const out = [`      <section class="site-section">`, `        <h2>${e(s.heading)}</h2>`];
  for (const p of s.paragraphs ?? []) out.push(`        <p>${e(p)}</p>`);
  if (s.list?.length) out.push(`        <ul>`, ...s.list.map((li) => `          <li>${e(li)}</li>`), `        </ul>`);
  if (s.steps?.length) out.push(`        <ol class="site-steps">`, ...s.steps.map((li) => `          <li>${e(li)}</li>`), `        </ol>`);
  if (s.note) out.push(`        <p class="site-note">${e(s.note)}</p>`);
  out.push(`      </section>`);
  return out.join("\n");
}

/** 記事の最後に置く、検査のページへのつなぎ */
function toInspector(): string {
  return `      <aside class="site-cta" aria-label="検査のページへ">
        <p>手元の PDF に、この記事のようなものが残っていないかを確かめられます。PDF は、このパソコンのブラウザの中だけで読みます。</p>
        <p><a class="site-cta-link" href="/">検査のページで確かめる</a></p>
        <p class="site-note">見つけられるのは、検査のページに並べた種類だけです。すべての漏れを見つけられるわけではありません。</p>
      </aside>`;
}

export function renderArticle(a: Article, o: RenderOptions): string {
  const e = escapeHtml;
  const kicker = a.pattern ? `型の解説・${a.pattern}` : "正しいやり方の手順";
  const body = [
    `      <article class="site-article">`,
    `      <p class="site-kicker">${e(kicker)}</p>`,
    `      <h1>${e(a.title)}</h1>`,
    `      <p class="site-lead">${e(a.description)}</p>`,
    ...a.sections.map(renderSection),
    toInspector(),
    `      <p class="site-back"><a href="${ARTICLES_PATH}">記事の一覧へ戻る</a></p>`,
    `      </article>`,
  ].join("\n");
  return layout({ path: articlePath(a), title: a.title, description: a.description }, body, o);
}

export const ARTICLES_META: PageMeta = {
  path: ARTICLES_PATH,
  title: "記事の一覧",
  description: "PDF を公開・提出する前に知っておきたい、見た目では分からない情報の残り方（12 の型）と、正しいやり方の手順をまとめました。",
};

export function renderArticleIndex(o: RenderOptions): string {
  const e = escapeHtml;
  const item = (a: Article) =>
    `          <li><a href="${articlePath(a)}">${a.pattern ? `<span class="site-tag">${e(a.pattern)}</span>` : ""}${e(a.title)}</a><p>${e(a.description)}</p></li>`;
  const body = [
    `      <h1>${e(ARTICLES_META.title)}</h1>`,
    `      <p class="site-lead">${e(ARTICLES_META.description)}</p>`,
    `      <section class="site-section">`,
    `        <h2>型の解説</h2>`,
    `        <ul class="site-list">`,
    ...ARTICLES.filter((a) => a.pattern).map(item),
    `        </ul>`,
    `      </section>`,
    `      <section class="site-section">`,
    `        <h2>正しいやり方の手順</h2>`,
    `        <ul class="site-list">`,
    ...ARTICLES.filter((a) => !a.pattern).map(item),
    `        </ul>`,
    `      </section>`,
    toInspector(),
  ].join("\n");
  return layout(ARTICLES_META, body, o);
}

export const PRIVACY_META: PageMeta = { path: PRIVACY_PATH, title: PRIVACY_TITLE, description: PRIVACY_DESCRIPTION };

export function renderPrivacy(o: RenderOptions): string {
  const e = escapeHtml;
  const body = [
    `      <h1>${e(PRIVACY_TITLE)}</h1>`,
    `      <p class="site-lead">${e(PRIVACY_DESCRIPTION)}</p>`,
    ...PRIVACY_SECTIONS.map(renderSection),
  ].join("\n");
  return layout(PRIVACY_META, body, o);
}

/** 検索エンジンに知らせるページの一覧（トップ・記事の一覧・各記事・プライバシー） */
export function sitePaths(): string[] {
  return ["/", ARTICLES_PATH, ...ARTICLES.map(articlePath), PRIVACY_PATH];
}

/** サイトの HTML のページを全部作る。鍵は dist/ の中のファイルの名前 */
export function renderSite(o: RenderOptions): Map<string, string> {
  const pages = new Map<string, string>();
  pages.set(fileFor(ARTICLES_PATH), renderArticleIndex(o));
  for (const a of ARTICLES) pages.set(fileFor(articlePath(a)), renderArticle(a, o));
  pages.set(fileFor(PRIVACY_PATH), renderPrivacy(o));
  return pages;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページ（記事の一覧・各記事・プライバシーの説明）を、字の中身から作る（sitemap.xml・robots.txt は site.ts）。
// ビルドの時に site.ts（Vite のプラグイン）が呼ぶ。ブラウザでは動かさない。
// - 字は、すべて escapeHtml を通す（HTML として解釈させない。CLAUDE.md §11-3）。
// - ページには、スクリプトを入れない。読み込むのは、同じサイトの CSS 1つだけ。
// - サイトの場所（https の公式の URL）は、呼ぶ側から受け取る（htaccess.ts の OFFICIAL_ORIGIN）。ここには書かない。

import { ARTICLES } from "./articles.ts";
import { PRIVACY_DESCRIPTION, PRIVACY_SECTIONS, PRIVACY_TITLE } from "./privacy.ts";
import { SITE_NAME, headFor, headLines } from "./seo.ts";
import type { Article, FigureAsset, PageMeta, Section } from "./types.ts";

export { SITE_NAME };
export const ARTICLES_PATH = "/articles/";
export const PRIVACY_PATH = "/privacy.html";
// サイトの案内のページ（中身は pages.ts）
export const LICENSES_PATH = "/licenses.html";
export const TERMS_PATH = "/terms.html";
export const CONTACT_PATH = "/contact.html";
export const FAQ_PATH = "/faq.html";
export const CHECKLIST_PATH = "/checklist.html";
/** サービス紹介のページ（持ち場 G）。検査のページの上の帯から、ここへ 1 つだけリンクする（index.html。tests/site-pages.test.ts） */
export const ABOUT_PATH = "/about";

/** どのページの下にも置く、公式のサイトの場所の1文（検査のページ index.html の下の帯にも、同じ文を置く。CLAUDE.md §11-6） */
export const OFFICIAL_NOTE = "公式のサイトは omamoripdf.com だけです。ほかの場所で動いているものは、改変されている可能性があります。";

/** どのページの下にも置く、サイトの案内のリンク（検査のページ index.html の下の帯も、同じ並び。tests/site-pages.test.ts） */
export const FOOT_LINKS: ReadonlyArray<readonly [string, string]> = [
  ["/", "検査のページ"],
  [ARTICLES_PATH, "記事の一覧"],
  [CHECKLIST_PATH, "公開前の自己点検"],
  [FAQ_PATH, "よくある質問"],
  [PRIVACY_PATH, "プライバシー"],
  [TERMS_PATH, "利用規約"],
  [LICENSES_PATH, "ライセンス"],
  [CONTACT_PATH, "お問い合わせ"],
];

export interface RenderOptions {
  /** 公式のサイトの場所（例：https の公式の URL）。末尾の / はなし */
  origin: string;
  /** <meta> に入れる CSP（csp.ts の cspForMeta） */
  csp: string;
  /** サイトのページの CSS の場所（/assets/site-xxxx.css） */
  cssHref: string;
  /** ファビコンの href（logo.ts の faviconHref）。なければ、取りに行かせない data:, にする */
  favicon?: string;
  /** 上の帯（白の地）に置くロゴマークの SVG（logo.ts の inlineMark。リポジトリの中のファイルから作るので、escapeHtml を通さない） */
  brandMark?: string;
  /** ソースを公開している GitHub のリポジトリの場所。分からないときは null（リンクを出さず、文だけにする） */
  repoUrl?: string | null;
  /** 記事の図（site.ts が src/site/figures/ から assets/ に置いたもの）。鍵は記事の slug。ない記事は、図の場所を出さない */
  figures?: ReadonlyMap<string, FigureAsset>;
  /** 記事の一覧のページで読み込む、検索のスクリプトの場所（site.ts が置いたもの）。なければ、検索の欄を出さない */
  searchScript?: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const articlePath = (a: Article) => `${ARTICLES_PATH}${a.slug}.html`;

/** dist/ の中のファイルの名前（先頭の / なし）。/articles/ は articles/index.html */
export function fileFor(path: string): string {
  return (path.endsWith("/") ? `${path}index.html` : path).replace(/^\//, "");
}

/** どのページにも共通の枠（CSP・題・説明・canonical・上の帯・下の帯）。中身の HTML は body */
export function layout(meta: PageMeta, body: string, o: RenderOptions): string {
  const e = escapeHtml;
  return `<!doctype html>
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${e(o.csp)}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    ${headLines(headFor(meta), o.origin, e)}
    <link rel="icon" href="${e(o.favicon ?? "data:,")}" />
    <link rel="stylesheet" href="${e(o.cssHref)}" />
  </head>
  <body class="site">
    <header class="site-band">
      <a class="site-brand" href="/">${o.brandMark ?? ""}${e(SITE_NAME)}</a>
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
      <nav class="site-foot-links" aria-label="サイトの案内（下）">
${FOOT_LINKS.map(([href, label]) => `        <a href="${href}">${e(label)}</a>`).join("\n")}
      </nav>
      <p class="site-official">${e(OFFICIAL_NOTE)}</p>
      <p>PDF はこのパソコンのブラウザの中だけで読みます。どこにも送りません。</p>
    </footer>
  </body>
</html>
`;
}

/** 節の HTML（見出しは h2）。.map(renderSection) で呼ぶ所があるので、引数は節 1 つだけにする */
export function renderSection(s: Section): string {
  return renderSectionAt(s, 2);
}

/** 節の HTML。検査のページの利用規約のダイアログでは、ダイアログの題（h2）の下なので見出しを h3 にする */
export function renderSectionAt(s: Section, level: 2 | 3): string {
  const e = escapeHtml;
  const out = [`      <section class="site-section">`, `        <h${level}>${e(s.heading)}</h${level}>`];
  for (const p of s.paragraphs ?? []) out.push(`        <p>${e(p)}</p>`);
  if (s.list?.length) out.push(`        <ul>`, ...s.list.map((li) => `          <li>${e(li)}</li>`), `        </ul>`);
  if (s.steps?.length) out.push(`        <ol class="site-steps">`, ...s.steps.map((li) => `          <li>${e(li)}</li>`), `        </ol>`);
  if (s.note) out.push(`        <p class="site-note">${e(s.note)}</p>`);
  out.push(`      </section>`);
  return out.join("\n");
}

/** 記事の最後に置く、検査のページへのつなぎ */
export function toInspector(): string {
  return `      <aside class="site-cta" aria-label="検査のページへ">
        <p>手元の PDF に、この記事のようなものが残っていないかを確かめられます。PDF は、このパソコンのブラウザの中だけで読みます。</p>
        <p><a class="site-cta-link" href="/">検査のページで確かめる</a></p>
        <p class="site-note">見つけられるのは、検査のページに並べた種類だけです。すべての漏れを見つけられるわけではありません。</p>
      </aside>`;
}

/** 記事の図（ないときは何も出さない。大きさを書いて、読み込む前から場所を取る） */
export function figureHtml(f: FigureAsset | undefined): string[] {
  if (!f) return [];
  const e = escapeHtml;
  return [
    `      <figure class="site-figure">`,
    `        <img src="${e(f.href)}" alt="${e(f.alt)}" width="${f.width}" height="${f.height}" />`,
    ...(f.caption ? [`        <figcaption>${e(f.caption)}</figcaption>`] : []),
    `      </figure>`,
  ];
}

/** 記事の最後に置く、関係する記事へのつなぎ（slug が記事の一覧にないときは止める） */
function toRelated(a: Article): string {
  const e = escapeHtml;
  const items = a.related.map((slug) => {
    const r = ARTICLES.find((x) => x.slug === slug);
    if (!r) throw new Error(`関係する記事が見つかりません：${a.slug} → ${slug}`);
    const tag = r.pattern ? `<span class="site-tag">${e(r.pattern)}</span>` : "";
    return `          <li><a href="${articlePath(r)}">${tag}${e(r.title)}</a></li>`;
  });
  return [
    `      <nav class="site-section" aria-label="関係する記事">`,
    `        <h2>関係する記事</h2>`,
    `        <ul class="site-list">`,
    ...items,
    `        </ul>`,
    `      </nav>`,
  ].join("\n");
}

export function renderArticle(a: Article, o: RenderOptions): string {
  const e = escapeHtml;
  const kicker = a.pattern ? `型の解説・${a.pattern}` : "正しいやり方の手順";
  const body = [
    // data-article は、記事の一覧の札から移るときの動き（motion.ts の view-transition-name）を当てるための印
    `      <article class="site-article" data-article="${e(a.slug)}">`,
    `      <p class="site-kicker">${e(kicker)}</p>`,
    `      <h1>${e(a.title)}</h1>`,
    `      <p class="site-lead">${e(a.description)}</p>`,
    ...figureHtml(o.figures?.get(a.slug)),
    ...a.sections.map(renderSection),
    toInspector(),
    ...(a.related.length ? [toRelated(a)] : []),
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

// 記事の一覧のページと、タグごとの一覧のページは article-index.ts（検索・タグの絞り込み）

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

/** 記事・プライバシーの HTML のページを作る（記事の一覧とタグのページは article-index.ts）。鍵は dist/ の中のファイルの名前 */
export function renderSite(o: RenderOptions): Map<string, string> {
  const pages = new Map<string, string>();
  for (const a of ARTICLES) pages.set(fileFor(articlePath(a)), renderArticle(a, o));
  pages.set(fileFor(PRIVACY_PATH), renderPrivacy(o));
  return pages;
}

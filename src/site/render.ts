// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページ（記事の一覧・各記事・プライバシーの説明）を、字の中身から作る（sitemap.xml・robots.txt は site.ts）。
// ビルドの時に site.ts（Vite のプラグイン）が呼ぶ。ブラウザでは動かさない。
// - 字は、すべて escapeHtml を通す（HTML として解釈させない。CLAUDE.md §11-3）。
// - ページには、スクリプトを入れない。読み込むのは、同じサイトの CSS 1つだけ。
// - サイトの場所（https の公式の URL）は、呼ぶ側から受け取る（htaccess.ts の OFFICIAL_ORIGIN）。ここには書かない。

import { CHECK_PATH, CONTACT_SEND_FILE } from "../../htaccess.ts";

/** 検査のページの場所（htaccess.ts の CHECK_PATH。/ はハッカソンの間だけ、ここへ 302） */
export const INSPECTOR_PATH = CHECK_PATH;
import { ARTICLES } from "./articles.ts";
import { PRIVACY_DESCRIPTION, PRIVACY_SECTIONS, PRIVACY_TITLE } from "./privacy.ts";
import { SITE_NAME, headFor, headLines } from "./seo.ts";
import type { Article, FigureAsset, PageMeta, Section } from "./types.ts";

export { SITE_NAME };
export const ARTICLES_PATH = "/articles/";
export const PRIVACY_PATH = "/privacy";
// サイトの案内のページ（中身は pages.ts）
export const LICENSES_PATH = "/licenses";
export const TERMS_PATH = "/terms";
export const CONTACT_PATH = "/contact";
/** お問い合わせのフォームの送り先（PHP。server/contact-send.php から site.ts が作る。検索には載せない） */
export const CONTACT_SEND_PATH = `/${CONTACT_SEND_FILE}`;
export const FAQ_PATH = "/faq";
export const CHECKLIST_PATH = "/checklist";
/** サービスの紹介のページ（LP。中身は about.ts。持ち場 G）。検査のページの上の帯から、ここへ 1 つだけリンクする（check.html。tests/site-pages.test.ts）。ファイルは about.html（fileFor） */
export const ABOUT_PATH = "/about";

/** どのページの下にも置く、公式のサイトの場所の1文（検査のページ check.html の下の帯にも、同じ文を置く。CLAUDE.md §11-6） */
export const OFFICIAL_NOTE = "公式のサイトは omamoripdf.com です。ソースコードは公開しています。";

/** どのページの下にも置く、サイトの案内のリンク（検査のページ check.html の下の帯も、同じ並び。tests/site-pages.test.ts） */
export const FOOT_LINKS: ReadonlyArray<readonly [string, string]> = [
  [INSPECTOR_PATH, "検査のページ"],
  [ABOUT_PATH, "お守りPDF について"],
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
  /** 参照元の決まり（<meta name="referrer">）。ふだんは no-referrer。お問い合わせのページだけ csp.ts の CONTACT_REFERRER */
  referrer?: string;
  /** 記事の一覧のページで読み込む、検索のスクリプトの場所（site.ts が置いたもの）。なければ、検索の欄を出さない */
  searchScript?: string;
  /** 記事の一覧の見出しまわりの 3D の飾り（scene：three.js で描くファイル、loader：あとから読む役。どちらも /assets/ の中）。
   * 案 C（2026-11-05 夜）でやめた。渡しても、記事の一覧には出さない */
  hero?: { scene: string; loader: string };
  /** 記事の一覧のサムネ（site-thumbs.ts が src/site/thumbs/ から assets/ に置いたもの）。鍵は記事の slug。16:9 と正方形の 2 つ */
  thumbs?: ReadonlyMap<string, { wide: ThumbFile; square: ThumbFile }>;
}

/** サムネの 1 つのファイル（/assets/thumbs/<名前>-<ハッシュ>.svg と、ファイルから読んだ大きさ） */
export interface ThumbFile {
  href: string;
  width: number;
  height: number;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const articlePath = (a: Article) => `${ARTICLES_PATH}${a.slug}`;

/**
 * dist/ の中のファイルの名前（先頭の / なし）。/articles/ は articles/index.html、/privacy は privacy.html。
 * サイトのページの場所は .html なし（2026-11-05）。本番は .htaccess の書き換えで、.html のファイルを返す（htaccess.ts）
 */
export function fileFor(path: string): string {
  return (path.endsWith("/") ? `${path}index.html` : `${path}.html`).replace(/^\//, "");
}

/** dist/ の中の HTML のファイルの名前から、サイトの場所（.html なし）を作る。fileFor の逆 */
export function pathForFile(file: string): string {
  const f = file.replace(/^\//, "");
  if (f === "index.html") return "/";
  if (f.endsWith("/index.html")) return `/${f.slice(0, -"index.html".length)}`;
  return `/${f.replace(/\.html$/, "")}`;
}

/** layout に足せるもの（サービスの紹介のページ about.ts だけが使う。上の帯・下の帯は、どのページも同じ形） */
export interface LayoutExtra {
  /** body に足す class（site の後ろに付ける） */
  bodyClass?: string;
  /** サイトの CSS の後に読む、そのページだけの CSS の場所（同じサイトの assets/ の中） */
  extraCssHref?: string;
}

/** 上の帯の案内（どのページにも同じ並び。検査のページへは、ロゴと右端の「PDF を確かめる」から行く） */
export const NAV_LINKS: ReadonlyArray<readonly [string, string]> = [
  [ABOUT_PATH, "お守りPDF について"],
  [ARTICLES_PATH, "記事の一覧"],
  [FAQ_PATH, "よくある質問"],
];

/** 狭い画面（40rem 以下）でも上の帯に残すリンク（「PDF を確かめる」と合わせて 2 つまで。design/sheet.md「案 C」の上の帯）。
 * メニューの丸（開け閉めのメニュー）は作らない。ほかの行き先は下の帯にある（2026-11-05 夜 本人が決定） */
export const NARROW_NAV: ReadonlySet<string> = new Set([ARTICLES_PATH]);

/** リンクの並び。今いるページ（current）へのリンクにだけ aria-current="page" を付ける（上の帯・下の帯） */
function linksHtml(links: ReadonlyArray<readonly [string, string]>, current: string, narrow: ReadonlySet<string> = new Set()): string {
  return links
    .map(([href, label]) => `        <a href="${escapeHtml(href)}"${href === current ? ' aria-current="page"' : ""}${narrow.has(href) ? " data-narrow" : ""}>${escapeHtml(label)}</a>`)
    .join("\n");
}

/** 上の帯の案内のリンク（今いるページの場所を渡すと、そのリンクに印を付ける） */
export function siteNavLinks(current = ""): string {
  return linksHtml(NAV_LINKS, current, NARROW_NAV);
}

/** どのページにも共通の枠（CSP・題・説明・canonical・上の帯・下の帯）。中身の HTML は body */
export function layout(meta: PageMeta, body: string, o: RenderOptions, x: LayoutExtra = {}): string {
  const e = escapeHtml;
  return `<!doctype html>
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${e(o.csp)}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="${e(o.referrer ?? "no-referrer")}" />
    ${headLines(headFor(meta), o.origin, e)}
    <link rel="icon" href="${e(o.favicon ?? "data:,")}" />
    <link rel="stylesheet" href="${e(o.cssHref)}" />${x.extraCssHref ? `
    <link rel="stylesheet" href="${e(x.extraCssHref)}" />` : ""}
  </head>
  <body class="site${x.bodyClass ? ` ${e(x.bodyClass)}` : ""}">
    <header class="site-band">
      <a class="site-brand" href="${INSPECTOR_PATH}">${o.brandMark ?? ""}${e(SITE_NAME)}</a>
      <nav class="site-nav" aria-label="サイトの案内">
${siteNavLinks(meta.path)}
      </nav>
      <a class="site-band-cta" href="${INSPECTOR_PATH}" data-narrow>PDF を確かめる</a>
    </header>
    <main class="site-main">
${body}
    </main>
    <footer class="site-foot">
      <nav class="site-foot-links" aria-label="サイトの案内（下）">
${linksHtml(FOOT_LINKS, meta.path)}
      </nav>
      <p class="site-official">${e(OFFICIAL_NOTE)}</p>
      <p>PDF はこの端末のブラウザの中だけで読みます。どこにも送りません。</p>
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
        <p>手元の PDF に、この記事のようなものが残っていないかを確かめられます。PDF は、この端末のブラウザの中だけで読みます。</p>
        <p><a class="site-cta-link" href="${INSPECTOR_PATH}">検査のページで確かめる</a></p>
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
    // 型の番号の札は、マーカーの帯の外に置く（帯は題の字だけに引く。design/sheet.md「案 C」の強調・リンク）。
    // 題は箱（.site-list-title）の中の字（span）に帯を引く。折り返しても行ごとに引け、2 行目は札の右にそろう
    return `          <li><a class="site-list-link" href="${articlePath(r)}">${tag}<span class="site-list-title"><span>${e(r.title)}</span></span></a></li>`;
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

/** 検索エンジンに知らせるページの一覧（トップ・サービスの紹介・記事の一覧・各記事・プライバシー） */
export function sitePaths(): string[] {
  return [INSPECTOR_PATH, ABOUT_PATH, ARTICLES_PATH, ...ARTICLES.map(articlePath), PRIVACY_PATH];
}

/** 記事・プライバシーの HTML のページを作る（記事の一覧とタグのページは article-index.ts）。鍵は dist/ の中のファイルの名前 */
export function renderSite(o: RenderOptions): Map<string, string> {
  const pages = new Map<string, string>();
  for (const a of ARTICLES) pages.set(fileFor(articlePath(a)), renderArticle(a, o));
  pages.set(fileFor(PRIVACY_PATH), renderPrivacy(o));
  return pages;
}

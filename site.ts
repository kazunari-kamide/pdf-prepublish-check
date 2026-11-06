// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページ（サービスの紹介・記事の一覧・各記事・プライバシーの説明と、ライセンス・利用規約・お問い合わせ・よくある質問・公開前の自己点検）を、ビルドに入れる Vite のプラグイン。
// 中身と HTML の作り方は src/site/（render.ts・articles.ts・privacy.ts）。ここでは、次のことだけをする。
// - ページの CSS（design/tokens.css ＋ src/site/site.css）を1つにつなぎ、中身のハッシュの名前で assets/ に置く
// - HTML のページと、sitemap.xml・robots.txt を dist/ に置く（npm run build）
// - 開発サーバー（npm run dev）でも、同じページを返す
// - 検索エンジンの確認のコード（src/site/search-console.ts）があれば、トップページに <meta> を入れる
//
// ページにはスクリプトを入れない（例外は、記事の一覧のページの検索とタグの絞り込みのスクリプト 1 つだけ。src/site/article-search.js）。通信を足さない（docs/no-network.md）。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { build as viteBuild, type Plugin } from "vite";
import { cspForMeta } from "./csp.ts";
import { CHECK_PAGE_FILE, CHECK_PATH, CONTACT_PAGE_FILE, CONTACT_SEND_FILE, LICENSE_TEXTS_DIR, OFFICIAL_ORIGIN, OLD_LICENSE_TEXTS_DIR } from "./htaccess.ts";
import { faviconHref, inlineMark } from "./logo.ts";
import { buildFigures } from "./site-figures.ts";
import { buildLicenses } from "./site-licenses.ts";
import { buildThumbs } from "./site-thumbs.ts";
import { renderAbout } from "./src/site/about.ts";
import { renderIndexPages, usedTags } from "./src/site/article-index.ts";
import { tagPath } from "./src/site/tags.ts";
import { CONTACT_ERRORS_MARK, CONTACT_ERRORS_TOP_MARK, CONTACT_MESSAGE_MARK, CONTACT_TOKEN_FIELD, GUIDE_PATHS, TERMS_DIALOG_MARKER, renderContactResults, renderGuidePages, renderTermsDialog } from "./src/site/pages.ts";
import { ABOUT_PATH, escapeHtml, fileFor, renderSite, sitePaths } from "./src/site/render.ts";
import { articleTransitionNames } from "./src/site/motion.ts";
import { GOOGLE_SITE_VERIFICATION, VERIFICATION_PATTERN } from "./src/site/search-console.ts";
import { INSPECTOR_HEAD, OG_IMAGE_PATH, headLines, type HeadInfo } from "./src/site/seo.ts";

const ROOT = import.meta.dirname;

const INSPECTOR_HEAD_INFO: HeadInfo = { ...INSPECTOR_HEAD, type: "website" };

/** OGP・X のカードの画像。リポジトリの src/site/og-image.png をそのまま配る（作り方は site-og-image.ts） */
export function ogImage(): Buffer {
  return readFileSync(path.join(ROOT, "src", "site", "og-image.png"));
}

/**
 * 同梱の書体（design/fonts.css の @font-face）を、サイトのページでも読めるようにする（2026-11-05 夜。案 C で見出しを丸ゴシックにしたため）。
 * - 書体のファイルは、名前に中身のハッシュを付けて assets/fonts/ に置く（.htaccess で 1 年キャッシュさせるため）
 * - @font-face の url() を、その場所に書き換えた CSS を返す（検査のページは Vite が同じファイルを読む）
 */
export function siteFonts(): { css: string; files: Map<string, Uint8Array> } {
  const source = readFileSync(path.join(ROOT, "design", "fonts.css"), "utf8");
  const files = new Map<string, Uint8Array>();
  const css = source.replace(/url\("(\.\.\/src\/assets\/fonts\/[\w./-]+\.woff2)"\)/g, (_m, rel: string) => {
    const buf = readFileSync(path.join(ROOT, "design", rel));
    const base = path.basename(rel, ".woff2");
    const file = `assets/fonts/${base}-${createHash("sha256").update(buf).digest("hex").slice(0, 10)}.woff2`;
    files.set(file, buf);
    return `url("/${file}")`;
  });
  if (/url\("\.\./.test(css)) throw new Error("design/fonts.css に、書き換えられない書体の場所があります");
  return { css, files };
}

/** サイトのページの CSS。書体・tokens.css・sheet.css の後に site.css、その後に動きの CSS（src/site/motion.css と、記事ごとの名前。motion.ts）をつなぐ */
export function siteCss(): string {
  const fonts = siteFonts().css;
  const tokens = readFileSync(path.join(ROOT, "design", "tokens.css"), "utf8");
  // デザインシート（design/sheet.md）の役の名前。検査の画面（src/style.css の @import）と同じファイルを読む
  const sheet = readFileSync(path.join(ROOT, "design", "sheet.css"), "utf8");
  const site = readFileSync(path.join(ROOT, "src", "site", "site.css"), "utf8");
  const motion = readFileSync(path.join(ROOT, "src", "site", "motion.css"), "utf8");
  return `${fonts}\n${tokens}\n${sheet}\n${site}\n${motion}\n${articleTransitionNames()}`;
}

/** サービスの紹介のページ（/about）だけで、サイトの CSS の後に読む CSS（src/site/about.css）。名前に中身のハッシュを付ける */
export function aboutCss(): { file: string; source: string } {
  const source = readFileSync(path.join(ROOT, "src", "site", "about.css"), "utf8");
  return { file: `assets/about-${createHash("sha256").update(source).digest("hex").slice(0, 10)}.css`, source };
}

export function siteCssFile(css = siteCss()): string {
  return `assets/site-${createHash("sha256").update(css).digest("hex").slice(0, 10)}.css`;
}

/**
 * ソースを公開している GitHub のリポジトリの場所（ライセンス・お問い合わせのページのリンクに使う）。
 * 名前をコードに書かないため、ビルドの時に取る：GitHub Actions では GITHUB_REPOSITORY、手元では git の origin。
 * どちらも GitHub のリポジトリの形でなければ null（ページはリンクを出さず、文だけにする）
 */
export function repoUrl(env: NodeJS.ProcessEnv = process.env, remote = gitRemote): string | null {
  const fromEnv = env.GITHUB_REPOSITORY;
  const name = fromEnv && /^[\w.-]+\/[\w.-]+$/.test(fromEnv) ? fromEnv : remote()?.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(\.git)?\/?$/)?.[1];
  return name ? `https://github.com/${name}` : null;
}

function gitRemote(): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * sitemap に並べるページ（トップ・記事・プライバシーと、サイトの案内のページ、タグごとの記事の一覧のページ）。
 * 検索に載せるページはすべて入れ、noindex のページ（seo.ts の NOINDEX_PATHS）は入れない（#78 の決まり。tests/site-head.test.ts）
 */
export function allSitePaths(): string[] {
  return [...sitePaths(), ...GUIDE_PATHS, ...usedTags().map(tagPath)];
}

export function renderSitemap(origin = OFFICIAL_ORIGIN): string {
  const urls = allSitePaths().map((p) => `  <url><loc>${origin}${p}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, "</urlset>", ""].join("\n");
}

export function renderRobots(origin = OFFICIAL_ORIGIN): string {
  return ["User-agent: *", "Allow: /", `Sitemap: ${origin}/sitemap.xml`, ""].join("\n");
}

/**
 * 記事の一覧のページでだけ読み込む、検索のスクリプト（src/site/article-search.js）。サイトのページで、ただ1つのスクリプト。
 * 名前に中身のハッシュを付けて assets/ に置く（check-dist が、このファイルだけを例外として通す）
 */
export function searchScript(): { file: string; source: string } {
  const source = readFileSync(path.join(ROOT, "src", "site", "article-search.js"), "utf8");
  return { file: `assets/article-search-${createHash("sha256").update(source).digest("hex").slice(0, 10)}.js`, source };
}

/**
 * 記事の一覧の見出しまわりの 3D の飾り（2026-11-05 本人が承認）。
 * - loader：あとから 3D を読む小さな役（src/site/site-3d.js。そのまま置く）
 * - scene：three.js で形を組み立てて描くファイル（src/site/omamori-3d-scene.js を、three.js と一緒に束ねて縮めたもの）
 * scene の名前は、元のファイルと three.js の版から決める（束ねる前に、HTML に書く名前が要るため）
 */
export function heroScripts(): { loader: { file: string; source: string }; scene: { file: string; entry: string } } {
  const loader = readFileSync(path.join(ROOT, "src", "site", "site-3d.js"), "utf8");
  const entry = path.join(ROOT, "src", "site", "omamori-3d-scene.js");
  const three = JSON.parse(readFileSync(path.join(ROOT, "node_modules", "three", "package.json"), "utf8")) as { version: string };
  const sceneHash = createHash("sha256").update(readFileSync(entry, "utf8")).update(`three@${three.version}`).digest("hex").slice(0, 10);
  return {
    loader: { file: `assets/site-3d-${createHash("sha256").update(loader).digest("hex").slice(0, 10)}.js`, source: loader },
    scene: { file: `assets/omamori-3d-${sceneHash}.js`, entry },
  };
}

/**
 * about の最初の画面の絵と 3D（2026-11-06 本人が承認）。
 * - img：q47 の絵、plate：3D のときに下に敷く地と影の絵（どちらも src/site/hero/。design/3d/ の書き出しから作ったもの）
 * - scene：src/site/about-3d-scene.js（形は about-3d-data.js）を three.js と束ねたもの。読み込み役は記事の一覧と同じ site-3d.js
 */
export function aboutHero(): { img: { file: string; buf: Uint8Array }; img960: { file: string; buf: Uint8Array }; plate: { file: string; buf: Uint8Array }; scene: { file: string; entry: string }; loader: { file: string; source: string } } {
  const pic = (name: string) => {
    const buf = readFileSync(path.join(ROOT, "src", "site", "hero", `${name}.webp`));
    return { file: `assets/${name}-${createHash("sha256").update(buf).digest("hex").slice(0, 10)}.webp`, buf };
  };
  const entry = path.join(ROOT, "src", "site", "about-3d-scene.js");
  const three = JSON.parse(readFileSync(path.join(ROOT, "node_modules", "three", "package.json"), "utf8")) as { version: string };
  const sceneHash = createHash("sha256")
    .update(readFileSync(entry, "utf8"))
    .update(readFileSync(path.join(ROOT, "src", "site", "about-3d-data.js"), "utf8"))
    .update(`three@${three.version}`)
    .digest("hex")
    .slice(0, 10);
  return { img: pic("about-hero"), img960: pic("about-hero-960"), plate: pic("about-hero-bg"), scene: { file: `assets/about-3d-${sceneHash}.js`, entry }, loader: heroScripts().loader };
}

/** 3D の飾りの scene を、three.js と一緒に 1 つの ES モジュールに束ねて縮める（ビルドと、開発のサーバーで使う） */
export async function buildHeroScene(entry = heroScripts().scene.entry): Promise<string> {
  const out = await viteBuild({
    configFile: false,
    logLevel: "silent",
    publicDir: false,
    build: {
      write: false,
      minify: true,
      target: "es2022",
      emptyOutDir: false,
      lib: { entry, formats: ["es"], fileName: () => "omamori-3d.js" },
    },
  });
  const outputs = (Array.isArray(out) ? out : [out]) as Array<{ output?: Array<{ type: string; code?: string }> }>;
  const chunk = outputs.flatMap((o) => o.output ?? []).find((c) => c.type === "chunk");
  if (!chunk?.code) throw new Error("3D の飾り（omamori-3d-scene.js）を束ねられませんでした");
  return chunk.code;
}

/** dist/ に置く字でないファイル（記事の図・書体）。鍵は dist/ の中の名前 */
export function siteBinaryFiles(): Map<string, Uint8Array> {
  const files = new Map(buildFigures().files);
  for (const [name, buf] of buildThumbs().files) files.set(name, buf);
  for (const [name, buf] of siteFonts().files) files.set(name, buf);
  const h = aboutHero();
  files.set(h.img.file, h.img.buf);
  files.set(h.img960.file, h.img960.buf);
  files.set(h.plate.file, h.plate.buf);
  return files;
}

/** PHP の一重引用符の文字列にする（\ と ' だけを逃がす。ほかの字はそのまま） */
export function phpString(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * お問い合わせの送り先（dist/contact-send.php）。server/contact-send.php に、フォーム・受け付けた・送れなかったのページの HTML を差し込む。
 * ヘッダー（csp.ts の contactHeaders）は .htaccess だけが付ける（PHP でも付けると、同じヘッダーが 2 つになるおそれがあるため）。
 * 届け先などの本物の設定は入れない（public_html の外の contact-config.php に、本人が置く。docs/contact.md）
 */
export function contactSendPhp(pages: { form: string; done: string; error: string }): string {
  const source = readFileSync(path.join(ROOT, "server", "contact-send.php"), "utf8").replace(/\r\n/g, "\n");
  if (!pages.error.includes(CONTACT_MESSAGE_MARK)) throw new Error("送れなかったときのページに、理由を入れる印がありません");
  // フォームのページ（静かな contact.html と同じもの）に、PHP が中身を入れる印が 1 つずつあること
  for (const mark of [CONTACT_ERRORS_MARK, CONTACT_ERRORS_TOP_MARK, CONTACT_TOKEN_FIELD]) {
    if (pages.form.split(mark).length !== 2) throw new Error(`お問い合わせのページに「${mark}」が 1 つだけあるはずです`);
  }
  const arr = (entries: Array<[string, string]>) => `[\n${entries.map(([k, v]) => `    ${phpString(k)} => ${phpString(v)},`).join("\n")}\n]`;
  const fill = (text: string, mark: string, value: string) => {
    const line = `= []; // ${mark}`;
    if (text.split(line).length !== 2) throw new Error(`server/contact-send.php に「${line}」が 1 つだけあるはずです`);
    // 置きかえる字は関数で渡す（文字列で渡すと、HTML の中の $& や $' が、置きかえの記号として化けるため）
    return text.replace(line, () => `= ${value};`);
  };
  const out = fill(source, "@@PAGES@@", arr([["form", pages.form], ["done", pages.done], ["error", pages.error]]));
  return out.replace("// dist/contact-send.php を直接書き換えない。", () => "// これは npm run build で作ったファイル。直接書き換えない（もとは server/contact-send.php）。");
}

/** dist/ に置くファイル（HTML・sitemap.xml・robots.txt・CSS・検索のスクリプト・お問い合わせの送り先の PHP）。鍵は dist/ の中の名前 */
export function siteFiles(): Map<string, string> {
  const css = siteCss();
  const cssFile = siteCssFile(css);
  const figures = buildFigures();
  const search = searchScript();
  const options = {
    origin: OFFICIAL_ORIGIN,
    csp: cspForMeta,
    cssHref: `/${cssFile}`,
    repoUrl: repoUrl(),
    // ロゴ（logo.ts）。同じ options を、記事・プライバシー・サイトの案内のページ・404 のページのすべてに渡すので、どの帯にも出る
    favicon: faviconHref(),
    brandMark: inlineMark("mark", "site-brand-mark"), // 帯は白の地（design/sheet.md）なので、明るい地のマーク
  };
  const files = renderSite({ ...options, figures: figures.assets });
  // 記事の一覧（検索のスクリプトを読む）と、タグごとの一覧のページ。札にはサムネ（site-thumbs.ts）を出す。
  // 3D の飾り（heroScripts）は、案 C でやめた（2026-11-05 夜 本人が決定）。作り方は残すが、配らない
  for (const [name, page] of renderIndexPages({ ...options, figures: figures.assets, thumbs: buildThumbs().assets, searchScript: `/${search.file}` })) files.set(name, page);
  files.set(search.file, search.source);
  // サービスの紹介のページ（LP）と、そのページだけの CSS
  const about = aboutCss();
  const ah = aboutHero();
  files.set(fileFor(ABOUT_PATH), renderAbout(options, `/${about.file}`, { img: `/${ah.img.file}`, img960: `/${ah.img960.file}`, plate: `/${ah.plate.file}`, scene: `/${ah.scene.file}`, loader: `/${ah.loader.file}` }));
  files.set(ah.loader.file, ah.loader.source);
  files.set(about.file, about.source);
  const licenses = buildLicenses(ROOT);
  for (const [name, page] of renderGuidePages(options, licenses.data)) files.set(name, page);
  for (const [name, text] of licenses.files) files.set(name, text);
  // 送り先の PHP。フォームのページは、静かな contact.html と 1 バイトも違わないもの（check-live が照らす）
  const contactPage = files.get(CONTACT_PAGE_FILE);
  if (contactPage === undefined) throw new Error(`${CONTACT_PAGE_FILE} がありません`);
  files.set(CONTACT_SEND_FILE, contactSendPhp({ form: contactPage, ...renderContactResults(options) }));
  files.set("sitemap.xml", renderSitemap());
  files.set("robots.txt", renderRobots());
  files.set(cssFile, css);
  return files;
}

/** トップページに入れる、検索エンジンの確認の <meta>。コードが空なら入れない */
export function verificationMeta(code = GOOGLE_SITE_VERIFICATION): { name: string; content: string } | null {
  if (code === "") return null;
  if (!VERIFICATION_PATTERN.test(code)) throw new Error("src/site/search-console.ts の確認のコードに、使えない字が入っています（英数字・-・_ だけ）");
  return { name: "google-site-verification", content: code };
}

/**
 * 検査のページの目印（TERMS_DIALOG_MARKER）を、利用規約のダイアログに置き換える。
 * 文は利用規約のページと同じ元（src/site/pages.ts）から作る。目印がないか 2 つ以上あれば、ビルドを止める
 */
export function withTermsDialog(html: string, repo: string | null = repoUrl()): string {
  const count = html.split(TERMS_DIALOG_MARKER).length - 1;
  if (count !== 1) throw new Error(`${CHECK_PAGE_FILE} に利用規約のダイアログの目印 ${TERMS_DIALOG_MARKER} が 1 つではありません（${count} 個）`);
  return html.replace(TERMS_DIALOG_MARKER, () => renderTermsDialog({ repoUrl: repo }));
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export type CleanUrlRoute = { kind: "redirect"; location: string } | { kind: "temporary"; location: string } | { kind: "rewrite"; url: string } | null;

/**
 * 本番の .htaccess の書き換え（htaccess.ts の CLEAN_URL_RULES）と同じ決まりで、場所をどう扱うかを決める。
 * exists は、dist/ の中のファイルの名前（先頭の / なし）があるか。
 * - / は検査のページ（/check）へ 302（kind: "temporary"）。/check/ と、前の検査のページの /index.html は /check へ 301（htaccess.ts の CHECK_PAGE_RULES）
 * - .html 付き（index.html・googleXXXX.html を除く）で、ファイルがあれば、.html なしへ 301（? のあとはそのまま）
 * - .html なしで、同じ名前の .html があれば、そのファイルで返す（アドレスはそのまま）
 */
export function cleanUrlRoute(rawUrl: string, exists: (file: string) => boolean): CleanUrlRoute {
  const q = rawUrl.indexOf("?");
  const pathname = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const query = q < 0 ? "" : rawUrl.slice(q);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = decoded.replace(/^\/+/, "");
  // ライセンスの全文の前の場所（htaccess.ts の LICENSE_TEXTS_RULES と同じ）
  if (file === `${OLD_LICENSE_TEXTS_DIR}/`) return { kind: "redirect", location: `/${OLD_LICENSE_TEXTS_DIR}${query}` };
  if (file.startsWith(`${OLD_LICENSE_TEXTS_DIR}/`)) {
    const name = file.slice(OLD_LICENSE_TEXTS_DIR.length + 1);
    if (!name.includes("/") && name.endsWith(".txt")) return { kind: "redirect", location: `/${LICENSE_TEXTS_DIR}/${name}${query}` };
  }
  // 検査のページ（htaccess.ts の CHECK_PAGE_RULES と同じ）
  if (file === "") return { kind: "temporary", location: `${CHECK_PATH}${query}` };
  if (file === `${CHECK_PATH.slice(1)}/` || file === "index.html") return { kind: "redirect", location: `${CHECK_PATH}${query}` };
  if (decoded.endsWith(".html")) {
    if (/(^|\/)index\.html$/.test(decoded) || /^\/google[0-9a-z]+\.html$/.test(decoded) || !exists(file)) return null;
    return { kind: "redirect", location: `${pathname.replace(/^\/+/, "/").replace(/\.html$/, "")}${query}` };
  }
  if (file === "" || decoded.endsWith("/") || exists(file) || !exists(`${file}.html`)) return null;
  return { kind: "rewrite", url: `${pathname}.html${query}` };
}

function cleanUrlMiddleware(exists: (file: string) => boolean) {
  return (req: { url?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(): void }, next: () => void) => {
    const route = cleanUrlRoute(req.url ?? "/", exists);
    if (route?.kind === "redirect" || route?.kind === "temporary") {
      res.statusCode = route.kind === "redirect" ? 301 : 302;
      res.setHeader("Location", route.location);
      return res.end();
    }
    if (route?.kind === "rewrite") req.url = route.url;
    next();
  };
}

export function sitePages(): Plugin {
  return {
    name: "omamori-site-pages",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const meta = verificationMeta();
        // 検査のページの題・説明・canonical・OGP・X のカード（中身は src/site/seo.ts）
        const head = headLines(INSPECTOR_HEAD_INFO, OFFICIAL_ORIGIN, escapeHtml);
        if (!/<title>[^<]*<\/title>/.test(html)) throw new Error(`${CHECK_PAGE_FILE} に <title> がありません（題・説明を入れる場所）`);
        const tags = [...(meta ? [{ tag: "meta", attrs: meta, injectTo: "head" as const }] : [])];
        return { html: withTermsDialog(html).replace(/<title>[^<]*<\/title>/, head), tags };
      },
    },
    async generateBundle() {
      for (const [fileName, source] of siteFiles()) this.emitFile({ type: "asset", fileName, source });
      this.emitFile({ type: "asset", fileName: OG_IMAGE_PATH.slice(1), source: ogImage() });
      for (const [fileName, source] of siteBinaryFiles()) this.emitFile({ type: "asset", fileName, source });
      const ah = aboutHero();
      this.emitFile({ type: "asset", fileName: ah.scene.file, source: await buildHeroScene(ah.scene.entry) });
    },
    // vite preview（check:browser・check:layout が開く）でも、本番の .htaccess と同じに、.html なしの場所でページを返す
    configurePreviewServer(server) {
      const dist = path.join(ROOT, "dist");
      server.middlewares.use(cleanUrlMiddleware((file) => isFile(path.join(dist, file))));
    },
    configureServer(server) {
      server.middlewares.use(cleanUrlMiddleware((file) => file === CHECK_PAGE_FILE || siteFiles().has(file)));
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "/").split("?")[0] ?? "/";
        const name = url.endsWith("/") ? `${url}index.html` : url;
        if (name === OG_IMAGE_PATH) {
          res.setHeader("Content-Type", "image/png");
          return res.end(ogImage());
        }
        const key = name.replace(/^\//, "");
        const sceneEntry = key === heroScripts().scene.file ? heroScripts().scene.entry : key === aboutHero().scene.file ? aboutHero().scene.entry : null;
        if (sceneEntry) {
          buildHeroScene(sceneEntry).then(
            (code) => {
              res.setHeader("Content-Type", TYPES[".js"] ?? "text/javascript");
              res.end(code);
            },
            (err: unknown) => next(err),
          );
          return;
        }
        const body = name === `/${CHECK_PAGE_FILE}` ? undefined : (siteFiles().get(key) ?? siteBinaryFiles().get(key));
        if (body === undefined) return next();
        res.setHeader("Content-Type", TYPES[path.extname(name)] ?? "application/octet-stream");
        res.end(body);
      });
    },
  };
}

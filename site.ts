// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページ（記事の一覧・各記事・プライバシーの説明と、ライセンス・利用規約・お問い合わせ・よくある質問・公開前の自己点検）を、ビルドに入れる Vite のプラグイン。
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
import type { Plugin } from "vite";
import { cspForMeta } from "./csp.ts";
import { OFFICIAL_ORIGIN } from "./htaccess.ts";
import { faviconHref, inlineMark } from "./logo.ts";
import { buildFigures } from "./site-figures.ts";
import { buildLicenses } from "./site-licenses.ts";
import { renderIndexPages, usedTags } from "./src/site/article-index.ts";
import { tagPath } from "./src/site/tags.ts";
import { GUIDE_PATHS, renderGuidePages } from "./src/site/pages.ts";
import { escapeHtml, renderSite, sitePaths } from "./src/site/render.ts";
import { articleTransitionNames } from "./src/site/motion.ts";
import { GOOGLE_SITE_VERIFICATION, VERIFICATION_PATTERN } from "./src/site/search-console.ts";
import { INSPECTOR_HEAD, OG_IMAGE_PATH, headLines, type HeadInfo } from "./src/site/seo.ts";

const ROOT = import.meta.dirname;

const INSPECTOR_HEAD_INFO: HeadInfo = { ...INSPECTOR_HEAD, type: "website" };

/** OGP・X のカードの画像。リポジトリの src/site/og-image.png をそのまま配る（作り方は site-og-image.ts） */
export function ogImage(): Buffer {
  return readFileSync(path.join(ROOT, "src", "site", "og-image.png"));
}

/** サイトのページの CSS。tokens.css・sheet.css の後に site.css、その後に動きの CSS（src/site/motion.css と、記事ごとの名前。motion.ts）をつなぐ */
export function siteCss(): string {
  const tokens = readFileSync(path.join(ROOT, "design", "tokens.css"), "utf8");
  // デザインシート（design/sheet.md）の役の名前。検査の画面（src/style.css の @import）と同じファイルを読む
  const sheet = readFileSync(path.join(ROOT, "design", "sheet.css"), "utf8");
  const site = readFileSync(path.join(ROOT, "src", "site", "site.css"), "utf8");
  const motion = readFileSync(path.join(ROOT, "src", "site", "motion.css"), "utf8");
  return `${tokens}\n${sheet}\n${site}\n${motion}\n${articleTransitionNames()}`;
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

/** dist/ に置く字でないファイル（記事の図）。鍵は dist/ の中の名前 */
export function siteBinaryFiles(): Map<string, Uint8Array> {
  return buildFigures().files;
}

/** dist/ に置くファイル（HTML・sitemap.xml・robots.txt・CSS・検索のスクリプト）。鍵は dist/ の中の名前 */
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
  // 記事の一覧（検索のスクリプトを読む）と、タグごとの一覧のページ
  for (const [name, page] of renderIndexPages({ ...options, figures: figures.assets, searchScript: `/${search.file}` })) files.set(name, page);
  files.set(search.file, search.source);
  const licenses = buildLicenses(ROOT);
  for (const [name, page] of renderGuidePages(options, licenses.data)) files.set(name, page);
  for (const [name, text] of licenses.files) files.set(name, text);
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

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export type CleanUrlRoute = { kind: "redirect"; location: string } | { kind: "rewrite"; url: string } | null;

/**
 * 本番の .htaccess の書き換え（htaccess.ts の CLEAN_URL_RULES）と同じ決まりで、場所をどう扱うかを決める。
 * exists は、dist/ の中のファイルの名前（先頭の / なし）があるか。
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
    if (route?.kind === "redirect") {
      res.statusCode = 301;
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
        if (!/<title>[^<]*<\/title>/.test(html)) throw new Error("index.html に <title> がありません（題・説明を入れる場所）");
        return { html: html.replace(/<title>[^<]*<\/title>/, head), tags: meta ? [{ tag: "meta", attrs: meta, injectTo: "head" }] : [] };
      },
    },
    generateBundle() {
      for (const [fileName, source] of siteFiles()) this.emitFile({ type: "asset", fileName, source });
      this.emitFile({ type: "asset", fileName: OG_IMAGE_PATH.slice(1), source: ogImage() });
      for (const [fileName, source] of siteBinaryFiles()) this.emitFile({ type: "asset", fileName, source });
    },
    // vite preview（check:browser・check:layout が開く）でも、本番の .htaccess と同じに、.html なしの場所でページを返す
    configurePreviewServer(server) {
      const dist = path.join(ROOT, "dist");
      server.middlewares.use(cleanUrlMiddleware((file) => isFile(path.join(dist, file))));
    },
    configureServer(server) {
      server.middlewares.use(cleanUrlMiddleware((file) => siteFiles().has(file)));
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "/").split("?")[0] ?? "/";
        const name = url.endsWith("/") ? `${url}index.html` : url;
        if (name === OG_IMAGE_PATH) {
          res.setHeader("Content-Type", "image/png");
          return res.end(ogImage());
        }
        const key = name.replace(/^\//, "");
        const body = name === "/index.html" ? undefined : (siteFiles().get(key) ?? siteBinaryFiles().get(key));
        if (body === undefined) return next();
        res.setHeader("Content-Type", TYPES[path.extname(name)] ?? "application/octet-stream");
        res.end(body);
      });
    },
  };
}

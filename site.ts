// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページ（記事の一覧・各記事・プライバシーの説明）を、ビルドに入れる Vite のプラグイン。
// 中身と HTML の作り方は src/site/（render.ts・articles.ts・privacy.ts）。ここでは、次のことだけをする。
// - ページの CSS（design/tokens.css ＋ src/site/site.css）を1つにつなぎ、中身のハッシュの名前で assets/ に置く
// - HTML のページと、sitemap.xml・robots.txt を dist/ に置く（npm run build）
// - 開発サーバー（npm run dev）でも、同じページを返す
// - 検索エンジンの確認のコード（src/site/search-console.ts）があれば、トップページに <meta> を入れる
//
// ページにはスクリプトを入れない。通信を足さない（docs/no-network.md）。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { cspForMeta } from "./csp.ts";
import { OFFICIAL_ORIGIN } from "./htaccess.ts";
import { faviconHref, inlineMark } from "./logo.ts";
import { renderSite, sitePaths } from "./src/site/render.ts";
import { GOOGLE_SITE_VERIFICATION, VERIFICATION_PATTERN } from "./src/site/search-console.ts";

const ROOT = import.meta.dirname;

/** サイトのページの CSS。tokens.css の後に site.css をつなぐ */
export function siteCss(): string {
  const tokens = readFileSync(path.join(ROOT, "design", "tokens.css"), "utf8");
  const site = readFileSync(path.join(ROOT, "src", "site", "site.css"), "utf8");
  return `${tokens}\n${site}`;
}

export function siteCssFile(css = siteCss()): string {
  return `assets/site-${createHash("sha256").update(css).digest("hex").slice(0, 10)}.css`;
}

export function renderSitemap(origin = OFFICIAL_ORIGIN): string {
  const urls = sitePaths().map((p) => `  <url><loc>${origin}${p}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, "</urlset>", ""].join("\n");
}

export function renderRobots(origin = OFFICIAL_ORIGIN): string {
  return ["User-agent: *", "Allow: /", `Sitemap: ${origin}/sitemap.xml`, ""].join("\n");
}

/** dist/ に置くファイル（HTML・sitemap.xml・robots.txt・CSS）。鍵は dist/ の中の名前 */
export function siteFiles(): Map<string, string> {
  const css = siteCss();
  const cssFile = siteCssFile(css);
  const files = renderSite({
    origin: OFFICIAL_ORIGIN,
    csp: cspForMeta,
    cssHref: `/${cssFile}`,
    favicon: faviconHref(),
    brandMark: inlineMark("mark-on-dark", "site-brand-mark"),
  });
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
};

export function sitePages(): Plugin {
  return {
    name: "omamori-site-pages",
    transformIndexHtml: {
      order: "pre",
      handler() {
        const meta = verificationMeta();
        return meta ? [{ tag: "meta", attrs: meta, injectTo: "head" }] : [];
      },
    },
    generateBundle() {
      for (const [fileName, source] of siteFiles()) this.emitFile({ type: "asset", fileName, source });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "/").split("?")[0] ?? "/";
        const name = url.endsWith("/") ? `${url}index.html` : url;
        const body = name === "/index.html" ? undefined : siteFiles().get(name.replace(/^\//, ""));
        if (body === undefined) return next();
        res.setHeader("Content-Type", TYPES[path.extname(name)] ?? "application/octet-stream");
        res.end(body);
      });
    },
  };
}

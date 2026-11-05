// SPDX-License-Identifier: AGPL-3.0-only
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cspForCheckHeader, cspForCheckMeta, securityHeaders } from "./csp.ts";
import { PDFJS_PARTS, PDFJS_PARTS_BASE } from "./src/render/pdfjs-parts.ts";
import { CHECK_PAGE_FILE, buildHtaccess } from "./htaccess.ts";
import { logoPlugin } from "./logo.ts";
import { sitePages } from "./site.ts";

// ビルドした HTML にだけ CSP の <meta> を入れる。
// 開発サーバーは更新の通知に WebSocket を使うので、開発中はかけない。
function cspMeta(): Plugin {
  return {
    name: "omamori-csp-meta",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          // 検査のページだけ connect-src 'self'（/pdfjs/ の部品を読むため。csp.ts の withConnectSelf）
          attrs: { "http-equiv": "Content-Security-Policy", content: cspForCheckMeta },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

// 配信先（Xserver）で CSP などをヘッダーで返すための .htaccess を、csp.ts から作って dist/ に置く（docs/deploy.md）
function htaccess(): Plugin {
  return {
    name: "omamori-htaccess",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: ".htaccess", source: buildHtaccess() });
    },
  };
}

// PDF.js の部品（画像を解く部品と cMap）を、pdfjs-dist から手を加えずに dist/pdfjs/ へ写す（src/render/pdfjs-parts.ts）。
// 開発サーバーでも、同じ場所で同じファイルを返す
const PDFJS_DIST = path.join(import.meta.dirname, "node_modules", "pdfjs-dist");
function pdfjsPartFiles(): Array<{ rel: string; abs: string }> {
  return PDFJS_PARTS.flatMap(({ dir, include }) =>
    readdirSync(path.join(PDFJS_DIST, dir))
      .filter(include)
      .sort()
      .map((name) => ({ rel: `${dir}/${name}`, abs: path.join(PDFJS_DIST, dir, name) })),
  );
}
function pdfjsParts(): Plugin {
  return {
    name: "omamori-pdfjs-parts",
    generateBundle() {
      if (this.environment?.name && this.environment.name !== "client") return;
      for (const f of pdfjsPartFiles()) this.emitFile({ type: "asset", fileName: `${PDFJS_PARTS_BASE.slice(1)}${f.rel}`, source: readFileSync(f.abs) });
    },
    configureServer(server) {
      const files = new Map(pdfjsPartFiles().map((f) => [`${PDFJS_PARTS_BASE}${f.rel}`, f.abs]));
      server.middlewares.use((req, res, next) => {
        const abs = req.url ? files.get(req.url) : undefined;
        if (!abs) return next();
        res.setHeader("Content-Type", abs.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(abs));
      });
    },
    // vite preview：検査のページにだけ、本番と同じ CSP のヘッダー（connect-src 'self'）を返す（htaccess.ts の <FilesMatch> と同じ）
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const p = (req.url ?? "").split("?")[0];
        if (p === "/check" || p === "/check.html") res.setHeader("Content-Security-Policy", cspForCheckHeader);
        next();
      });
    },
  };
}

export default defineConfig({
  // 検査のページは check.html（/check で開く。htaccess.ts の CHECK_PAGE_RULES）。index.html はないので、
  // ない場所を index.html で返す動き（spa）にしない（本番と同じに、ない場所は見つからないにする）
  appType: "mpa",
  // sitePages：記事の一覧・各記事・プライバシーの説明のページ（src/site/）を dist/ に置く
  // logoPlugin：見出しのロゴマークとファビコンを、design/logo/ の SVG から差し込む（logo.ts）
  plugins: [logoPlugin(), cspMeta(), htaccess(), pdfjsParts(), sitePages()],
  build: {
    // 小さな資源を data: の形で JavaScript に埋め込まない（読み込み先を見えるままにする）
    assetsInlineLimit: 0,
    // 古いブラウザ向けの「先読みの補い」は fetch を使うので入れない（通信の仕組みをコードに残さない）
    modulePreload: { polyfill: false },
    sourcemap: false,
    rollupOptions: { input: CHECK_PAGE_FILE },
  },
  worker: {
    format: "es",
  },
  server: {
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
    // ビルドしたものを、配信のときと同じヘッダーで確かめる
    headers: securityHeaders,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});

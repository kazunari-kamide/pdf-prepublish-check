// SPDX-License-Identifier: AGPL-3.0-only
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cspForMeta, securityHeaders } from "./csp.ts";
import { createHash } from "node:crypto";
import { PDFJS_PARTS, isBundledCmap } from "./src/render/pdfjs-parts.ts";
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
          // 検査のページも、ほかのページと同じ CSP（connect-src 'none'。2026-11-06 D170）
          attrs: { "http-equiv": "Content-Security-Policy", content: cspForMeta },
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

// PDF.js の部品（画像を解く部品と cMap）を、pdfjs-dist から手を加えずに dist/pdfjs/<版の印>/ へ写す（src/render/pdfjs-parts.ts）。
// 字の対応表（cmaps/*.bcmap）は、1 つのモジュール（cmaps.mjs。中身は base64）にまとめる（画面が import() で 1 回読む）。
// <版の印> は、写すファイルとまとめる中身から作るハッシュ。版が変わると場所が変わるので、長くキャッシュさせられる。
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
/** 字の対応表をまとめたモジュールの中身（名前の順。同じ pdfjs-dist からは、同じ中身になる） */
function cmapBundle(): string {
  const dir = path.join(PDFJS_DIST, "cmaps");
  const entries = readdirSync(dir)
    .filter(isBundledCmap)
    .sort()
    .map((name) => [name, readFileSync(path.join(dir, name)).toString("base64")]);
  return [
    "// SPDX-License-Identifier: BSD-3-Clause",
    "// pdfjs-dist の cmaps/*.bcmap（Adobe の cMap）を、名前ごとに base64 にしてまとめたもの。ライセンスは同じフォルダの cmaps/LICENSE。",
    "// vite.config.ts の pdfjsParts が作る（手を加えない）。scripts/check-dist.mjs が、中身が pdfjs-dist と同じかを確かめる",
    `export default ${JSON.stringify(Object.fromEntries(entries))};`,
    "",
  ].join("\n");
}
/** 版の印：写すファイルと、まとめた中身のハッシュ（頭の 10 字） */
const PARTS_HASH = (() => {
  const h = createHash("sha256");
  for (const f of pdfjsPartFiles()) h.update(f.rel).update(readFileSync(f.abs));
  h.update(cmapBundle());
  return h.digest("hex").slice(0, 10);
})();
const PARTS_DIR = `pdfjs/${PARTS_HASH}/`;

function pdfjsParts(): Plugin {
  return {
    name: "omamori-pdfjs-parts",
    generateBundle() {
      if (this.environment?.name && this.environment.name !== "client") return;
      for (const f of pdfjsPartFiles()) this.emitFile({ type: "asset", fileName: `${PARTS_DIR}${f.rel}`, source: readFileSync(f.abs) });
      this.emitFile({ type: "asset", fileName: `${PARTS_DIR}cmaps.mjs`, source: cmapBundle() });
    },
    configureServer(server) {
      const files = new Map(pdfjsPartFiles().map((f) => [`/${PARTS_DIR}${f.rel}`, f.abs]));
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        if (url === `/${PARTS_DIR}cmaps.mjs`) {
          res.setHeader("Content-Type", "text/javascript");
          res.end(cmapBundle());
          return;
        }
        const abs = files.get(url);
        if (!abs) return next();
        res.setHeader("Content-Type", abs.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(abs));
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
  // 部品の場所の版の印（src/render/pdfjs-parts.ts の PDFJS_PARTS_HASH）
  define: { __PDFJS_PARTS_HASH__: JSON.stringify(PARTS_HASH) },
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

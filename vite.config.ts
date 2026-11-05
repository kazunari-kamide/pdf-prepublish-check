// SPDX-License-Identifier: AGPL-3.0-only
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { cspForMeta, securityHeaders } from "./csp.ts";
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

export default defineConfig({
  // 検査のページは check.html（/check で開く。htaccess.ts の CHECK_PAGE_RULES）。index.html はないので、
  // ない場所を index.html で返す動き（spa）にしない（本番と同じに、ない場所は見つからないにする）
  appType: "mpa",
  // sitePages：記事の一覧・各記事・プライバシーの説明のページ（src/site/）を dist/ に置く
  // logoPlugin：見出しのロゴマークとファビコンを、design/logo/ の SVG から差し込む（logo.ts）
  plugins: [logoPlugin(), cspMeta(), htaccess(), sitePages()],
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

// SPDX-License-Identifier: AGPL-3.0-only
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { cspForMeta, securityHeaders } from "./csp.ts";

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

export default defineConfig({
  plugins: [cspMeta()],
  build: {
    // 小さな資源を data: の形で JavaScript に埋め込まない（読み込み先を見えるままにする）
    assetsInlineLimit: 0,
    // 古いブラウザ向けの「先読みの補い」は fetch を使うので入れない（通信の仕組みをコードに残さない）
    modulePreload: { polyfill: false },
    sourcemap: false,
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

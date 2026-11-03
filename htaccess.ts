// SPDX-License-Identifier: AGPL-3.0-only
//
// 配信先（Xserver。Apache）に置く .htaccess を、csp.ts から作る（docs/deploy.md）。
// CSP の値をここに書き写さないのは、<meta> の CSP・vite preview のヘッダーと食い違わないようにするため。
// npm run build で dist/.htaccess として出る（vite.config.ts）。dist/.htaccess を直接書き換えない。

import { securityHeaders } from "./csp.ts";

/** 公式のドメイン（CLAUDE.md §11-6）。www つきや http で来たら、ここへ 301 で送る */
export const OFFICIAL_HOST = "omamoripdf.com";

export function buildHtaccess(): string {
  const headers = Object.entries(securityHeaders).map(([k, v]) => {
    if (v.includes('"')) throw new Error(`${k} の値に " が入っています（.htaccess に書けません）`);
    return `  Header always set ${k} "${v}"`;
  });
  const host = OFFICIAL_HOST.replace(/\./g, "\\.");
  return [
    "# SPDX-License-Identifier: AGPL-3.0-only",
    "# npm run build で htaccess.ts（値は csp.ts）から作ったファイル。直接書き換えない。",
    "",
    "# ファイルの種類。.mjs を JavaScript として返さないと、モジュールとして読み込まれない",
    "AddType text/javascript .mjs",
    "AddType application/wasm .wasm",
    "",
    "# CSP などのヘッダー。index.html の <meta> の CSP と同じ値に、frame-ancestors 'none' を足したもの",
    "<IfModule mod_headers.c>",
    ...headers,
    "</IfModule>",
    "",
    "# www つき・http で来たら、https://" + OFFICIAL_HOST + "/ へ 301 で送る。",
    "# Xserver の「HTTPS転送設定」が書く分は、配信のたびにこのファイルで上書きされるため、ここにも書く",
    "<IfModule mod_rewrite.c>",
    "  RewriteEngine On",
    `  RewriteCond %{HTTP_HOST} ^www\\.${host}$ [NC]`,
    `  RewriteRule ^ https://${OFFICIAL_HOST}%{REQUEST_URI} [R=301,L]`,
    "  RewriteCond %{HTTPS} !on",
    `  RewriteRule ^ https://${OFFICIAL_HOST}%{REQUEST_URI} [R=301,L]`,
    "</IfModule>",
    "",
  ].join("\n");
}

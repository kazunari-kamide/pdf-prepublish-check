// SPDX-License-Identifier: AGPL-3.0-only
//
// 配信先（Xserver。Apache）に置く .htaccess を、csp.ts から作る（docs/deploy.md）。
// CSP の値をここに書き写さないのは、<meta> の CSP・vite preview のヘッダーと食い違わないようにするため。
// npm run build で dist/.htaccess として出る（vite.config.ts）。dist/.htaccess を直接書き換えない。

import { contactHeaders, securityHeaders } from "./csp.ts";

/** 公式のドメイン（CLAUDE.md §11-6）。www つきや http で来たら、ここへ 301 で送る */
export const OFFICIAL_HOST = "omamoripdf.com";

/** 公式のサイトの場所（末尾の / なし）。サイトのページの canonical・sitemap.xml に使う（site.ts） */
export const OFFICIAL_ORIGIN = `https://${OFFICIAL_HOST}`;

/**
 * HSTS（このドメインには https だけで来るよう、ブラウザに覚えさせる）。条件を付けず、いつも付ける。
 * Xserver は前の nginx で https を受けて後ろの Apache に渡すので、Header の "expr=%{HTTPS} == 'on'" が真にならず、
 * 本番で HSTS が付かなかった（2026-11-05 の初回の配信の check-live。理由は推測）。ブラウザは http の応答の HSTS を使わず
 * （RFC 6797 §8.1）、http で来た要求は下の 301 で https へ移すだけなので、いつも付けても困らない。
 * まず 1 日（86400 秒）で始め、本番で問題がないことを確かめながら延ばす（延ばし方は docs/deploy.md）。
 * 一度覚えさせると、期間が切れるまで取り消せないので、includeSubDomains・preload はまだ付けない
 */
export const HSTS = "max-age=86400";

/** HTML などのキャッシュ。毎回、新しい版があるかをサーバーに確かめさせる（古い画面が残らないように） */
export const CACHE_DEFAULT = "no-cache";

/** 名前に中身のハッシュが付いた assets/ のキャッシュ。中身が変われば名前も変わるので、1 年そのまま使わせる */
export const CACHE_ASSETS = "max-age=31536000, immutable";

/** 見つからないときに返す自前のページ（site.ts が作る。同じ CSP などのヘッダーが付く） */
export const NOT_FOUND_PAGE = "/404.html";

/**
 * お問い合わせのページと、その送り先（PHP。server/contact-send.php から site.ts が作る）の、dist/ の中のファイルの名前。
 * この 2 つだけ、CSP の form-action を 'self' にし、参照元の決まりを same-origin にする（csp.ts の contactHeaders）。
 * ファイルの名前で選ぶ（<FilesMatch>）ので、アドレスの形（.html を付けるか）が変わっても、同じファイルに当たる
 */
export const CONTACT_PAGE_FILE = "contact.html";
export const CONTACT_SEND_FILE = "contact-send.php";

export function buildHtaccess(): string {
  const quoted = (k: string, v: string) => {
    if (v.includes('"')) throw new Error(`${k} の値に " が入っています（.htaccess に書けません）`);
    return `"${v}"`;
  };
  const headers = Object.entries(securityHeaders).map(([k, v]) => `  Header always set ${k} ${quoted(k, v)}`);
  const host = OFFICIAL_HOST.replace(/\./g, "\\.");
  return [
    "# SPDX-License-Identifier: AGPL-3.0-only",
    "# npm run build で htaccess.ts（値は csp.ts）から作ったファイル。直接書き換えない。",
    "",
    "# ファイルの種類。.mjs を JavaScript として返さないと、モジュールとして読み込まれない",
    "AddType text/javascript .mjs",
    "AddType application/wasm .wasm",
    "",
    "# 見つからないときは、自前のページを返す（下のヘッダーは always なので、404 の応答にも付く）",
    `ErrorDocument 404 ${NOT_FOUND_PAGE}`,
    "",
    "# CSP などのヘッダー。index.html の <meta> の CSP と同じ値に、frame-ancestors 'none' を足したもの",
    "<IfModule mod_headers.c>",
    ...headers,
    "  # HSTS は条件を付けずに付ける（配信先の前の nginx が https を受けるため、%{HTTPS} では見分けられない。",
    "  # ブラウザは http の応答の HSTS を使わない。http で来た要求は、下の 301 で https へ移す）",
    `  Header always set Strict-Transport-Security ${quoted("Strict-Transport-Security", HSTS)}`,
    "  # キャッシュ：ふだんは毎回確かめさせ、名前にハッシュの付いた assets/ の、見つかった応答（200）だけ長く持たせる。",
    "  # 見つからない assets/ の応答（404）を長く持たせないため、状態も見る。順番に意味がある（あとの行が上書きする）",
    `  Header always set Cache-Control ${quoted("Cache-Control", CACHE_DEFAULT)}`,
    `  Header always set Cache-Control ${quoted("Cache-Control", CACHE_ASSETS)} "expr=%{REQUEST_URI} =~ m#^/assets/# && %{REQUEST_STATUS} == 200"`,
    "</IfModule>",
    "",
    "# お問い合わせのページと送り先だけ、同じサイトへフォームを送れる CSP にする（form-action 'self'。ほかは上と同じ値）。",
    "# <FilesMatch> の中の Header は、上の Header より後に当てはまるので、同じ名前のヘッダーを上書きする",
    `<FilesMatch "^(${[CONTACT_PAGE_FILE, CONTACT_SEND_FILE].map((f) => f.replace(/\./g, "\\.")).join("|")})$">`,
    "  <IfModule mod_headers.c>",
    ...Object.entries(contactHeaders)
      .filter(([k, v]) => securityHeaders[k] !== v)
      .map(([k, v]) => `    Header always set ${k} ${quoted(k, v)}`),
    "  </IfModule>",
    "</FilesMatch>",
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

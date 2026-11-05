// SPDX-License-Identifier: AGPL-3.0-only
//
// 配信先に置く .htaccess（htaccess.ts）が、csp.ts と同じ値を返すことを確かめる（docs/deploy.md）。

import { describe, expect, it } from "vitest";
import { cspForHeader, cspForMeta, securityHeaders } from "../csp.ts";
import { CACHE_ASSETS, CACHE_DEFAULT, HSTS, NOT_FOUND_PAGE, buildHtaccess } from "../htaccess.ts";

describe(".htaccess", () => {
  const text = buildHtaccess();

  it("csp.ts のヘッダーを、すべて同じ値で返す", () => {
    for (const [k, v] of Object.entries(securityHeaders)) expect(text).toContain(`Header always set ${k} "${v}"`);
  });

  it("ヘッダーの CSP は、<meta> の CSP に frame-ancestors 'none' を足しただけ", () => {
    expect(cspForHeader).toBe(`${cspForMeta}; frame-ancestors 'none'`);
    expect(cspForHeader).toContain("connect-src 'none'");
  });

  it(".mjs と .wasm の種類を決める", () => {
    expect(text).toMatch(/^AddType text\/javascript \.mjs$/m);
    expect(text).toMatch(/^AddType application\/wasm \.wasm$/m);
  });

  it("www つき・http は公式のドメインの https へ 301", () => {
    expect(text).toContain("RewriteCond %{HTTP_HOST} ^www\\.omamoripdf\\.com$ [NC]");
    expect(text).toContain("RewriteCond %{HTTPS} !on");
    expect(text.match(/RewriteRule \^ https:\/\/omamoripdf\.com%\{REQUEST_URI\} \[R=301,L\]/g)).toHaveLength(2);
  });
});

describe(".htaccess の守り（HSTS・埋め込み・一覧・キャッシュ・404）", () => {
  const text = buildHtaccess();

  it("HSTS は https の応答だけに、1 日から始める（includeSubDomains・preload はまだ付けない）", () => {
    expect(HSTS).toBe("max-age=86400");
    expect(text).toContain(`Header always set Strict-Transport-Security "${HSTS}" "expr=%{HTTPS} == 'on'"`);
    expect(text).not.toMatch(/includeSubDomains|preload/);
  });

  it("ほかのページへの埋め込みを、X-Frame-Options でも止める", () => {
    expect(securityHeaders["X-Frame-Options"]).toBe("DENY");
    expect(text).toContain('Header always set X-Frame-Options "DENY"');
  });

  it("フォルダの中身の一覧を出さない", () => {
    expect(text).toMatch(/^Options -Indexes$/m);
  });

  it("キャッシュ：ふだんは no-cache、assets/ の 200 の応答だけ 1 年。あとの行が上書きする順", () => {
    const def = text.indexOf(`Header always set Cache-Control "${CACHE_DEFAULT}"`);
    const assets = text.indexOf(`Header always set Cache-Control "${CACHE_ASSETS}" "expr=%{REQUEST_URI} =~ m#^/assets/# && %{REQUEST_STATUS} == 200"`);
    expect(CACHE_DEFAULT).toBe("no-cache");
    expect(CACHE_ASSETS).toBe("max-age=31536000, immutable");
    expect(def).toBeGreaterThan(0);
    expect(assets).toBeGreaterThan(def);
  });

  it("見つからないときは、自前の 404 のページ。ヘッダーは always なので 404 の応答にも付く", () => {
    expect(text).toContain(`ErrorDocument 404 ${NOT_FOUND_PAGE}`);
    for (const k of Object.keys(securityHeaders)) expect(text).toContain(`Header always set ${k} `);
  });
});

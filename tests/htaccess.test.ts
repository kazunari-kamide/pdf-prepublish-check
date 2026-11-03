// SPDX-License-Identifier: AGPL-3.0-only
//
// 配信先に置く .htaccess（htaccess.ts）が、csp.ts と同じ値を返すことを確かめる（docs/deploy.md）。

import { describe, expect, it } from "vitest";
import { cspForHeader, cspForMeta, securityHeaders } from "../csp.ts";
import { buildHtaccess } from "../htaccess.ts";

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

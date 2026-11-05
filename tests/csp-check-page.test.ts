// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査のページだけ connect-src 'self'（2026-11-06 本人が決定。PDF.js が /pdfjs/ の部品を読むため）。
// ほかのページ・ファイルは 'none' のまま。外のサイトを送り先に足していないことを確かめる。

import { describe, expect, it } from "vitest";
import { checkHeaders, cspForCheckHeader, cspForCheckMeta, cspForHeader, cspForMeta, securityHeaders, withConnectSelf } from "../csp.ts";
import { buildHtaccess } from "../htaccess.ts";

const connectOf = (csp: string) => csp.split("; ").find((d) => d.startsWith("connect-src "));

describe("検査のページの CSP", () => {
  it("connect-src だけが 'self' で、ほかの決まりは同じ", () => {
    expect(connectOf(cspForCheckMeta)).toBe("connect-src 'self'");
    expect(connectOf(cspForMeta)).toBe("connect-src 'none'");
    expect(cspForCheckMeta.replace("connect-src 'self'", "connect-src 'none'")).toBe(cspForMeta);
    expect(cspForCheckHeader).toBe(`${cspForCheckMeta}; frame-ancestors 'none'`);
    expect(checkHeaders["Content-Security-Policy"]).toBe(cspForCheckHeader);
    // CSP のほかのヘッダーは、ほかのページと同じ
    for (const [k, v] of Object.entries(securityHeaders)) if (k !== "Content-Security-Policy") expect(checkHeaders[k]).toBe(v);
  });

  it("外のサイト（http・https・ws）を送り先に足していない", () => {
    expect(connectOf(cspForCheckHeader)).not.toMatch(/https?:|wss?:|\*/);
  });

  it("connect-src 'none' がない CSP からは作らない", () => {
    expect(() => withConnectSelf("default-src 'self'")).toThrow(/connect-src 'none'/);
  });

  it(".htaccess：既定は 'none'、検査のページの <FilesMatch> だけ 'self'", () => {
    const h = buildHtaccess();
    expect(h).toContain(`Header always set Content-Security-Policy "${cspForHeader}"`);
    const block = h.match(/<FilesMatch "\^check\\\.html\$">[\s\S]*?<\/FilesMatch>/)?.[0] ?? "";
    expect(block).toContain(`Header always set Content-Security-Policy "${cspForCheckHeader}"`);
    expect(h.match(/^\s*Header\b[^\n]*connect-src 'self'/gm)).toHaveLength(1);
  });
});

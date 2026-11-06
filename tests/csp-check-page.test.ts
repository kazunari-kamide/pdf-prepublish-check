// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査のページも、ほかのページと同じ CSP（connect-src 'none'）であることを確かめる（2026-11-06 本人が決定。D170）。
// 2026-11-06 の朝から夕方までは、検査のページだけ 'self' だった（PDF.js が字の対応表を fetch で読んでいたため）。
// 字の対応表を cmaps.mjs として import() で読み、メモリから渡すようにしたので、戻した（src/render/pdf-view.ts）。

import { describe, expect, it } from "vitest";
import * as csp from "../csp.ts";
import { buildHtaccess, CHECK_PAGE_FILE } from "../htaccess.ts";

const connectOf = (v: string) => v.split("; ").find((d) => d.startsWith("connect-src "));

describe("検査のページの CSP", () => {
  it("<meta> とヘッダーの CSP は connect-src 'none'", () => {
    expect(connectOf(csp.cspForMeta)).toBe("connect-src 'none'");
    expect(connectOf(csp.cspForHeader)).toBe("connect-src 'none'");
    expect(csp.securityHeaders["Content-Security-Policy"]).toBe(csp.cspForHeader);
  });

  it("検査のページだけ別の CSP にする仕組み（withConnectSelf・checkHeaders）は、もう持たない", () => {
    expect(Object.keys(csp)).not.toContain("withConnectSelf");
    expect(Object.keys(csp)).not.toContain("checkHeaders");
    expect(Object.keys(csp)).not.toContain("cspForCheckMeta");
  });

  it(".htaccess：connect-src 'self' はどこにもなく、検査のページだけに当たる <FilesMatch> もない", () => {
    const h = buildHtaccess();
    expect(h).toContain(`Header always set Content-Security-Policy "${csp.cspForHeader}"`);
    expect(h).not.toContain("connect-src 'self'");
    const blocks = [...h.matchAll(/^<FilesMatch "([^"]+)">/gm)].map((m) => new RegExp(m[1]!));
    expect(blocks.filter((re) => re.test(CHECK_PAGE_FILE))).toHaveLength(0);
  });
});

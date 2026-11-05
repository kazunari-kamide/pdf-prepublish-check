// SPDX-License-Identifier: AGPL-3.0-only
//
// 公式のサイトで動いているかの確かめ（src/ui/official.ts。CLAUDE.md §11-6）。丸写しの目印で、守りの中心ではない。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isOfficialHost, OFFICIAL_HOST, UNOFFICIAL_NOTE } from "../src/ui/official";

describe("公式のサイトか", () => {
  it("公式の名前と、手元の開発用の名前は、知らせない", () => {
    for (const h of ["omamoripdf.com", "OMAMORIPDF.COM", "omamoripdf.com.", "localhost", "127.0.0.1", "[::1]"]) expect(isOfficialHost(h), h).toBe(true);
  });

  it("ほかの名前・似せた名前・空（ファイルとして開いた）は、知らせる", () => {
    for (const h of ["omamoripdf.com.example", "omamori-pdf.com", "omamoripdf.co", "www.omamoripdf.com", "evil.omamoripdf.com", "192.168.0.10", ""]) {
      expect(isOfficialHost(h), h).toBe(false);
    }
  });

  it("知らせる文に、公式の名前を書く。公式 URL は CLAUDE.md と同じ1つ", () => {
    expect(UNOFFICIAL_NOTE).toContain("これは公式のサイトではありません。公式は omamoripdf.com です");
    expect(readFileSync("CLAUDE.md", "utf8")).toContain(`https://${OFFICIAL_HOST}/`);
  });
});

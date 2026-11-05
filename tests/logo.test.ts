// SPDX-License-Identifier: AGPL-3.0-only
//
// ロゴマーク（design/logo/）と、ページへの差し込み（logo.ts）を確かめる。

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FAVICON_PLACEHOLDER, MARK_PLACEHOLDER, faviconHref, injectLogo, inlineMark, logoSvg, type LogoName } from "../logo.ts";
import { siteFiles } from "../site.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const NAMES: LogoName[] = ["mark", "mark-on-dark", "mark-small"];
const tokens = readFileSync(path.join(ROOT, "design", "tokens.css"), "utf8").toLowerCase();

describe("ロゴの SVG", () => {
  for (const name of NAMES) {
    const raw = readFileSync(path.join(ROOT, "design", "logo", `${name}.svg`), "utf8");

    it(`${name}：ロゴの条件の SPDX が付いている（AGPL ではない）`, () => {
      expect(raw.startsWith("<!-- SPDX-License-Identifier: LicenseRef-OmamoriPDF-Logo -->")).toBe(true);
      expect(raw).not.toContain("AGPL");
    });

    it(`${name}：使う色は、どれも design/tokens.css にある`, () => {
      const colors = [...new Set(raw.toLowerCase().match(/#[0-9a-f]{6}\b/g) ?? [])];
      expect(colors.length).toBeGreaterThan(0);
      expect(colors.filter((c) => !tokens.includes(c))).toEqual([]);
    });

    it(`${name}：style・script・リンクを含まず、64×64 の枠で描く`, () => {
      const svg = logoSvg(name);
      expect(svg).toContain('viewBox="0 0 64 64"');
      expect(svg).not.toMatch(/<!--/);
    });
  }

  it("ふつうの形は紙の行が2本、小さいとき用は紙を塗りつぶして行を省く", () => {
    expect(logoSvg("mark").match(/<rect /g)).toHaveLength(2);
    expect(logoSvg("mark-small")).not.toContain("<rect ");
  });
});

describe("ページへの差し込み", () => {
  const index = readFileSync(path.join(ROOT, "index.html"), "utf8");

  it("index.html の目印が、マークとファビコンに置き換わり、目印が残らない", () => {
    const html = injectLogo(index);
    expect(html).not.toContain(MARK_PLACEHOLDER);
    expect(html).not.toContain(FAVICON_PLACEHOLDER);
    expect(html).toContain('<p class="brand"><svg class="brand-mark" aria-hidden="true" focusable="false" ');
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml,');
  });

  it("目印がなければ止める（ロゴが抜けたまま配らない）", () => {
    expect(() => injectLogo(index.replace(MARK_PLACEHOLDER, ""))).toThrow(/目印/);
  });

  it("ファビコンは data: の形で、小さいとき用の形をそのまま入れる（通信を足さない）", () => {
    const href = faviconHref();
    expect(href.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(href.slice("data:image/svg+xml,".length))).toBe(logoSvg("mark-small"));
  });

  it("サイトのページの白の帯に、明るい地用のマークとファビコンが入る（帯は白の地。design/sheet.md）", () => {
    const page = siteFiles().get("privacy.html") ?? "";
    expect(page).toContain('<a class="site-brand" href="/"><svg class="site-brand-mark" aria-hidden="true"');
    expect(page).toContain(inlineMark("mark", "site-brand-mark"));
    expect(page).not.toContain('stroke="#fbfaf7"'); // 墨の地用のマーク（紐が白っぽい）は、白の帯では見えにくい
    expect(page).toContain('<link rel="icon" href="data:image/svg+xml,');
  });

  it("あとから増えたページ（サイトの案内のページ・404 のページ・記事）も含め、サイトのどのページの帯にもマークとファビコンが入る", () => {
    const pages = [...siteFiles()].filter(([name]) => name.endsWith(".html"));
    for (const must of ["404.html", "licenses.html", "terms.html", "contact.html", "faq.html", "checklist.html", "articles/index.html"]) {
      expect(pages.map(([n]) => n), must).toContain(must);
    }
    for (const [name, page] of pages) {
      expect(page, name).toContain('<a class="site-brand" href="/"><svg class="site-brand-mark" aria-hidden="true"');
      expect(page, name).toContain(`<link rel="icon" href="${faviconHref().replace(/&/g, "&amp;")}" />`);
    }
  });
});

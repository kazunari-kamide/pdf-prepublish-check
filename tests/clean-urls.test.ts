// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページを .html なしの場所で開く（2026-11-05）。
// - 本番：.htaccess の書き換え（htaccess.ts の CLEAN_URL_RULES）。手元：site.ts の cleanUrlRoute（vite の開発サーバーと preview）。
//   Apache は手元で動かせないので、同じ決まりを cleanUrlRoute の表で確かめ、.htaccess は並びと中身を確かめる。本番は check:live で確かめる。
// - サイトの中のリンク・canonical・og:url・sitemap は .html なし。

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLEAN_URL_RULES, NOT_FOUND_PAGE, OFFICIAL_ORIGIN, buildHtaccess } from "../htaccess.ts";
import { cleanUrlRoute, siteFiles } from "../site.ts";
import { pathForFile, fileFor } from "../src/site/render.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST_FILES = new Set(["index.html", "privacy.html", "404.html", "articles/index.html", "articles/p6-fake-redaction.html", "articles/tags/document-info.html", "google0123abcd.html", "assets/site-0123456789.css", "sitemap.xml"]);
const exists = (f: string) => DIST_FILES.has(f);

describe("場所の扱い（cleanUrlRoute。本番の .htaccess と同じ決まり）", () => {
  it(".html 付きは、ファイルがあれば .html なしへ 301（? のあとはそのまま）", () => {
    expect(cleanUrlRoute("/privacy.html", exists)).toEqual({ kind: "redirect", location: "/privacy" });
    expect(cleanUrlRoute("/articles/tags/document-info.html", exists)).toEqual({ kind: "redirect", location: "/articles/tags/document-info" });
    expect(cleanUrlRoute("/articles/p6-fake-redaction.html?from=x", exists)).toEqual({ kind: "redirect", location: "/articles/p6-fake-redaction?from=x" });
    expect(cleanUrlRoute("//privacy.html", exists)).toEqual({ kind: "redirect", location: "/privacy" });
  });
  it(".html なしは、同じ名前の .html のファイルで返す（アドレスはそのまま）", () => {
    expect(cleanUrlRoute("/privacy", exists)).toEqual({ kind: "rewrite", url: "/privacy.html" });
    expect(cleanUrlRoute("/articles/tags/document-info", exists)).toEqual({ kind: "rewrite", url: "/articles/tags/document-info.html" });
    expect(cleanUrlRoute("/articles/p6-fake-redaction?from=x", exists)).toEqual({ kind: "rewrite", url: "/articles/p6-fake-redaction.html?from=x" });
  });
  it("検査のページ・記事の一覧の index.html、検索エンジンの確認のファイル、ほかのファイルは、そのまま", () => {
    for (const u of ["/", "/index.html", "/articles/", "/articles/index.html", "/google0123abcd.html", "/assets/site-0123456789.css", "/sitemap.xml"]) expect(cleanUrlRoute(u, exists), u).toBeNull();
  });
  it("ないページは、どちらの形でも書き換えも移しもしない（404 のページになる）", () => {
    for (const u of ["/no-such-page", "/no-such-page.html", "/articles/no-such", "/articles/no-such.html", "/%E0%A4%A"]) expect(cleanUrlRoute(u, exists), u).toBeNull();
  });
  it("404 のページは、/404 の場所で開け、ErrorDocument はファイル（/404.html）を指す", () => {
    expect(NOT_FOUND_PAGE).toBe("/404.html");
    expect(cleanUrlRoute("/404", exists)).toEqual({ kind: "rewrite", url: "/404.html" });
  });
  it("fileFor と pathForFile は、たがいに逆", () => {
    for (const f of DIST_FILES) if (f.endsWith(".html") && !f.startsWith("google")) expect(fileFor(pathForFile(f)), f).toBe(f);
    expect(pathForFile("articles/index.html")).toBe("/articles/");
    expect(pathForFile("index.html")).toBe("/");
  });
});

describe(".htaccess の書き換え", () => {
  const ht = buildHtaccess();
  const lines = ht.split("\n").map((l) => l.trim());
  it("https・www の 301 のあとに、.html なしの書き換えがそのままの並びで入る", () => {
    const block = CLEAN_URL_RULES.map((l) => (l === "" ? "" : `  ${l}`)).join("\n");
    expect(ht).toContain(block);
    expect(ht.indexOf(block)).toBeGreaterThan(ht.indexOf("RewriteCond %{HTTPS} !on"));
    expect(ht.indexOf(block)).toBeLessThan(ht.lastIndexOf("</IfModule>"));
  });
  it("301 は、外から来た要求だけ（REDIRECT_STATUS が空）。%1 を取る THE_REQUEST の条件は、RewriteRule のすぐ上", () => {
    const rule = lines.indexOf("RewriteRule \\.html$ /%1 [R=301,L]");
    expect(rule).toBeGreaterThan(0);
    expect(lines[rule - 1]).toMatch(/^RewriteCond %\{THE_REQUEST\} /);
    const conds = lines.slice(lines.lastIndexOf("RewriteCond %{ENV:REDIRECT_STATUS} ^$", rule), rule);
    expect(conds[0]).toBe("RewriteCond %{ENV:REDIRECT_STATUS} ^$");
    expect(conds).toContain("RewriteCond %{REQUEST_FILENAME} -f");
    expect(conds.join("\n")).toContain("index\\.html$");
    expect(conds.join("\n")).toContain("google[0-9a-z]+\\.html$");
  });
  it("前からの設定（HSTS・CSP・404・https への 301）は残っている", () => {
    for (const s of ["Strict-Transport-Security", "Content-Security-Policy", `ErrorDocument 404 ${NOT_FOUND_PAGE}`, "RewriteCond %{HTTPS} !on", "AddType text/javascript .mjs"]) expect(ht, s).toContain(s);
  });
});

describe("サイトの中の場所は .html なし", () => {
  const files = siteFiles();
  it("サイトのページのリンク・canonical・og:url に、.html 付きのサイトの場所がない", () => {
    const found: string[] = [];
    for (const [name, text] of files) {
      if (!name.endsWith(".html")) continue;
      for (const m of text.matchAll(/\s(?:href|content)="((?:https:\/\/omamoripdf\.com)?\/[^"]*?\.html)(?:[?#][^"]*)?"/g)) found.push(`${name}：${m[1]}`);
    }
    expect(found).toEqual([]);
  });
  it("sitemap.xml の場所は .html なしで、ページのファイルと1対1", () => {
    const locs = [...files.get("sitemap.xml")!.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(locs.filter((u) => u.endsWith(".html"))).toEqual([]);
    for (const u of locs) {
      const p = u.slice(OFFICIAL_ORIGIN.length);
      if (p !== "/") expect(files.has(fileFor(p)), u).toBe(true);
    }
  });
  it("検査のページ（index.html）の下の帯のリンクも .html なし（中身・CSP は変えない）", () => {
    const html = readFileSync(path.join(ROOT, "index.html"), "utf8");
    expect(html).not.toMatch(/href="\/[^"]*\.html"/);
  });
});

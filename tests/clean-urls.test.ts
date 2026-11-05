// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページを .html なしの場所で開く（2026-11-05）。
// - 本番：.htaccess の書き換え（htaccess.ts の CLEAN_URL_RULES）。手元：site.ts の cleanUrlRoute（vite の開発サーバーと preview）。
//   Apache は手元で動かせないので、同じ決まりを cleanUrlRoute の表で確かめ、.htaccess は並びと中身を確かめる。本番は check:live で確かめる。
// - サイトの中のリンク・canonical・og:url・sitemap は .html なし。

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLEAN_URL_RULES, LICENSE_TEXTS_DIR, LICENSE_TEXTS_RULES, NOT_FOUND_PAGE, OFFICIAL_ORIGIN, OLD_LICENSE_TEXTS_DIR, buildHtaccess } from "../htaccess.ts";
import { cleanUrlRoute, siteFiles } from "../site.ts";
import { ABOUT_PATH, fileFor, pathForFile } from "../src/site/render.ts";

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
  it("検査のページの /?sample=1（#109）は、そのまま。サービス紹介の /about（#109）は、about.html ができれば .html なしで開ける", () => {
    expect(cleanUrlRoute("/?sample=1", exists)).toBeNull();
    expect(fileFor(ABOUT_PATH)).toBe("about.html");
    const withAbout = (f: string) => f === "about.html" || exists(f);
    expect(cleanUrlRoute(ABOUT_PATH, withAbout)).toEqual({ kind: "rewrite", url: "/about.html" });
    expect(cleanUrlRoute("/about.html", withAbout)).toEqual({ kind: "redirect", location: "/about" });
  });
  it("ライセンスのページは /licenses。全文は /license-texts/（ページと名前をぶつけない）。前の /licenses/*.txt・/licenses/ は 301 で移す", () => {
    // 2026-11-05 の本番：licenses.html と licenses/ が同じ名前で、/licenses が /licenses/ へ移って 403 になった（#119 では直らなかった）
    expect(LICENSE_TEXTS_DIR).not.toBe(OLD_LICENSE_TEXTS_DIR);
    const withLicenses = (f: string) => f === "licenses.html" || f === `${LICENSE_TEXTS_DIR}/AGPL-3.0.txt` || exists(f);
    expect(cleanUrlRoute("/licenses", withLicenses)).toEqual({ kind: "rewrite", url: "/licenses.html" });
    expect(cleanUrlRoute("/licenses.html", withLicenses)).toEqual({ kind: "redirect", location: "/licenses" });
    expect(cleanUrlRoute(`/${LICENSE_TEXTS_DIR}/AGPL-3.0.txt`, withLicenses)).toBeNull();
    expect(cleanUrlRoute("/licenses/AGPL-3.0.txt", withLicenses)).toEqual({ kind: "redirect", location: `/${LICENSE_TEXTS_DIR}/AGPL-3.0.txt` });
    expect(cleanUrlRoute("/licenses/pdf-lib-1.17.1.txt?x=1", withLicenses)).toEqual({ kind: "redirect", location: `/${LICENSE_TEXTS_DIR}/pdf-lib-1.17.1.txt?x=1` });
    expect(cleanUrlRoute("/licenses/", withLicenses)).toEqual({ kind: "redirect", location: "/licenses" });
  });
  it(".htaccess の前の全文の場所を移す規則は、https の 301 のあと、.html なしの書き換えの前", () => {
    const ht = buildHtaccess();
    for (const l of LICENSE_TEXTS_RULES) expect(ht).toContain(`  ${l}`);
    expect(ht).toContain(`RewriteRule ^${OLD_LICENSE_TEXTS_DIR}/([^/]+\\.txt)$ /${LICENSE_TEXTS_DIR}/$1 [R=301,L]`);
    expect(ht.indexOf(LICENSE_TEXTS_RULES[1]!)).toBeGreaterThan(ht.indexOf("RewriteCond %{HTTPS} !on"));
    expect(ht.indexOf(LICENSE_TEXTS_RULES[1]!)).toBeLessThan(ht.indexOf(CLEAN_URL_RULES[0]!));
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
  it(".html なしの書き換えは、フォルダかどうかを見ない（!-d を使わない）。末尾が / の場所は書き換えない", () => {
    const at = CLEAN_URL_RULES.indexOf("RewriteRule ^(.+)$ $1.html [L]");
    const redirect = CLEAN_URL_RULES.indexOf("RewriteRule \\.html$ /%1 [R=301,L]");
    expect(redirect).toBeGreaterThan(0);
    const conds = CLEAN_URL_RULES.slice(redirect + 1, at);
    expect(conds).not.toContain("RewriteCond %{REQUEST_FILENAME} !-d");
    expect(conds).toContain("RewriteCond %{REQUEST_URI} !/$");
    expect(conds).toContain("RewriteCond %{REQUEST_FILENAME}.html -f");
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

// SPDX-License-Identifier: AGPL-3.0-only
//
// scripts/check-dist.mjs の例外（PDF.js の写し）が、決めた条件のときだけ効くことを確かめる（docs/no-network.md）。
// 作りものの dist/ を一時フォルダに置き、check-dist を動かして、通るか止まるかを見る。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "check-dist.mjs");
const PDFJS = path.join(ROOT, "node_modules", "pdfjs-dist", "build");
const CSP_OK = "default-src &#39;self&#39;; connect-src &#39;none&#39;; script-src &#39;self&#39;";
const CSP_OPEN = "default-src &#39;self&#39;; script-src &#39;self&#39;";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const decode = (s: string) => s.replace(/&#39;/g, "'");
/** <meta> の CSP に合わせた .htaccess（htaccess.ts と同じ形）。headerCsp で、わざと食い違わせられる */
function fakeHtaccess(csp: string, headerCsp = `${decode(csp)}; frame-ancestors 'none'`): string {
  return `AddType text/javascript .mjs
AddType application/wasm .wasm
ErrorDocument 404 /404.html
<IfModule mod_headers.c>
  Header always set Content-Security-Policy "${headerCsp}"
  Header always set Strict-Transport-Security "max-age=86400"
</IfModule>
`;
}

function fakeDist(
  csp: string,
  files: Record<string, string | { copy: string } | { copyAndAppend: string }>,
  htaccess: string | null = fakeHtaccess(csp),
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omamori-dist-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><script type="module" src="/assets/index-Ab12Cd34.js"></script></head><body></body></html>`,
  );
  writeFileSync(path.join(dir, "assets", "index-Ab12Cd34.js"), "console.log(1);\n");
  if (htaccess !== null) writeFileSync(path.join(dir, ".htaccess"), htaccess);
  // 自前の 404 のページ（.htaccess の ErrorDocument が指す）。index.html と同じ CSP
  writeFileSync(path.join(dir, "404.html"), `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body></body></html>`);
  for (const [name, v] of Object.entries(files)) {
    const to = path.join(dir, "assets", name);
    if (typeof v === "string") writeFileSync(to, v);
    else if ("copy" in v) copyFileSync(path.join(PDFJS, v.copy), to);
    else writeFileSync(to, Buffer.concat([readFileSync(path.join(PDFJS, v.copyAndAppend)), Buffer.from("\nfetch('x');\n")]));
  }
  return dir;
}

function run(dir: string) {
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, DIST_DIR: dir }, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("check-dist の PDF.js の例外", () => {
  it("pdfjs-dist と同じ写しで、CSP に connect-src 'none' があれば通す", () => {
    const r = run(fakeDist(CSP_OK, { "pdf.min-Aa11Bb22.mjs": { copy: "pdf.min.mjs" }, "pdf.worker.min-Cc33Dd44.mjs": { copy: "pdf.worker.min.mjs" } }));
    expect(r.out).toContain("例外として許したファイル");
    expect(r.code).toBe(0);
  });

  it("1バイトでも変えた PDF.js は止める", () => {
    const r = run(fakeDist(CSP_OK, { "pdf.min-Aa11Bb22.mjs": { copyAndAppend: "pdf.min.mjs" } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("pdf.min-Aa11Bb22.mjs に fetch( が入っています");
  });

  it("CSP に connect-src 'none' がなければ、写しでも止める", () => {
    const r = run(fakeDist(CSP_OPEN, { "pdf.min-Aa11Bb22.mjs": { copy: "pdf.min.mjs" } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("CSP に connect-src 'none' がありません");
    expect(r.out).toContain("pdf.min-Aa11Bb22.mjs に fetch( が入っています");
  });

  it("自分たちのファイルの fetch は止める（.js も .mjs も）", () => {
    const r = run(fakeDist(CSP_OK, { "own-Ee55Ff66.js": "fetch('/x');\n", "own-Gg77Hh88.mjs": "new WebSocket('ws://x');\n" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("own-Ee55Ff66.js に fetch( が入っています");
    expect(r.out).toContain("own-Gg77Hh88.mjs に WebSocket が入っています");
  });
});

describe("check-dist の .htaccess（docs/deploy.md）", () => {
  it(".htaccess がなければ止める", () => {
    const r = run(fakeDist(CSP_OK, {}, null));
    expect(r.code).toBe(1);
    expect(r.out).toContain("dist/ に .htaccess がありません");
  });

  it("ヘッダーの CSP が <meta> と食い違えば止める", () => {
    const r = run(fakeDist(CSP_OK, {}, fakeHtaccess(CSP_OK, "default-src 'self'; connect-src 'self'; script-src 'self'; frame-ancestors 'none'")));
    expect(r.code).toBe(1);
    expect(r.out).toContain(".htaccess の CSP が、<meta> の CSP（＋ frame-ancestors 'none'）と食い違っています");
  });

  it("ErrorDocument の 404 のページ・HSTS がなければ止める", () => {
    const dir = fakeDist(CSP_OK, {}, fakeHtaccess(CSP_OK).replace(/^ {2}Header always set Strict-Transport-Security.*\n/m, ""));
    rmSync(path.join(dir, "404.html"));
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain(".htaccess に Strict-Transport-Security のヘッダーがありません");
    expect(r.out).toContain(".htaccess の ErrorDocument 404 が指す 404.html が、dist/ にありません");
  });

  it("assets/ にハッシュのない名前のファイルがあれば止める", () => {
    const r = run(fakeDist(CSP_OK, { "plain.js": "console.log(2);\n", "font-Ab12Cd34.woff2": "x" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("assets/plain.js の名前に中身のハッシュがありません");
    expect(r.out).not.toContain("assets/font-Ab12Cd34.woff2 の名前");
  });

  it(".mjs の種類の指定がなければ止める", () => {
    const r = run(fakeDist(CSP_OK, {}, fakeHtaccess(CSP_OK).replace("AddType text/javascript .mjs\n", "")));
    expect(r.code).toBe(1);
    expect(r.out).toContain("AddType text/javascript .mjs がありません");
  });
});

describe("check-dist のサイトのページ（site.ts）", () => {
  const page = (csp: string, extra = "") =>
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">${extra}<link rel="stylesheet" href="/assets/site.css"></head><body></body></html>`;

  function withPages(pages: Record<string, string>): string {
    const dir = fakeDist(CSP_OK, {});
    for (const [name, text] of Object.entries(pages)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    return dir;
  }

  it("同じ CSP と、公式の URL を指す canonical なら通す", () => {
    const r = run(withPages({ "articles/a.html": page(CSP_OK, '<link rel="canonical" href="https://omamoripdf.com/articles/a.html">') }));
    expect(r.out).not.toContain("問題：");
    expect(r.code).toBe(0);
  });

  it("CSP の <meta> がないページは止める", () => {
    const r = run(withPages({ "articles/a.html": "<!doctype html><html><head></head><body></body></html>" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("articles/a.html に CSP の <meta> がありません");
  });

  it("CSP が index.html と違うページは止める", () => {
    const r = run(withPages({ "privacy.html": page(CSP_OPEN) }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("privacy.html の CSP が、index.html の CSP と食い違っています");
  });

  it("ほかのサイトを指す canonical や、外のスクリプトは止める", () => {
    const r = run(
      withPages({
        "articles/a.html": page(CSP_OK, '<link rel="canonical" href="https://example.invalid/a.html">'),
        "articles/b.html": page(CSP_OK, '<script src="https://example.invalid/x.js"></script>'),
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("articles/a.html が外のサイトから読み込んでいます");
    expect(r.out).toContain("articles/b.html が外のサイトから読み込んでいます");
  });

  it("GitHub へ移る <a> のリンクは通し、GitHub から読み込む <img> などは止める", () => {
    const good = run(withPages({ "contact.html": page(CSP_OK, '<a href="https://github.com/o/r/issues">Issues</a>') }));
    expect(good.code).toBe(0);
    const bad = run(
      withPages({
        "contact.html": page(CSP_OK, '<img src="https://github.com/o/r/x.png">'),
        "faq.html": page(CSP_OK, '<a href="https://example.invalid/">x</a>'),
      }),
    );
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("contact.html が外のサイトから読み込んでいます");
    expect(bad.out).toContain("faq.html が外のサイトから読み込んでいます");
  });

  it("スクリプトは、記事の一覧のページの検索のスクリプト1つだけを通す", () => {
    const tag = '<script type="module" src="/assets/article-search-0123456789.js"></script>';
    const good = withPages({ "articles/index.html": page(CSP_OK, tag) });
    writeFileSync(path.join(good, "assets", "article-search-0123456789.js"), "export const x = 1;\n");
    const r1 = run(good);
    expect(r1.out).not.toContain("問題：");
    expect(r1.code).toBe(0);
    expect(r1.out).toContain("articles/index.html（検索のスクリプト assets/article-search-0123456789.js を読み込む");

    const bad = withPages({
      "articles/index.html": page(CSP_OK, `${tag}<script type="module" src="/assets/other-0123456789.js"></script>`),
      "faq.html": page(CSP_OK, tag),
    });
    writeFileSync(path.join(bad, "assets", "article-search-0123456789.js"), "document.body.innerHTML = location.hash;\n");
    const r2 = run(bad);
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("articles/index.html にスクリプトがあります");
    expect(r2.out).toContain("faq.html にスクリプトがあります");
    expect(r2.out).toContain("字を HTML として解釈させる書き方か eval があります");

    const missing = run(withPages({ "articles/index.html": page(CSP_OK, tag) }));
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("assets/article-search-0123456789.js が、dist/ にありません");
  });

  it("検索エンジンの確認のファイルは、決まった1行のときだけ通す", () => {
    const good = run(withPages({ "google0123abcd.html": "google-site-verification: google0123abcd.html\n" }));
    expect(good.code).toBe(0);
    expect(good.out).toContain("google0123abcd.html（検索エンジンの確認のファイル）");
    const bad = run(withPages({ "google0123abcd.html": "google-site-verification: google0123abcd.html\n<script>x</script>" }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("中身が決まった1行ではありません");
  });
});

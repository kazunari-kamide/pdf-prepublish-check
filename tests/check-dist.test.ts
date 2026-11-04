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
<IfModule mod_headers.c>
  Header always set Content-Security-Policy "${headerCsp}"
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
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><script type="module" src="/assets/index.js"></script></head><body></body></html>`,
  );
  writeFileSync(path.join(dir, "assets", "index.js"), "console.log(1);\n");
  if (htaccess !== null) writeFileSync(path.join(dir, ".htaccess"), htaccess);
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
    const r = run(fakeDist(CSP_OK, { "pdf.min-a.mjs": { copy: "pdf.min.mjs" }, "pdf.worker.min-b.mjs": { copy: "pdf.worker.min.mjs" } }));
    expect(r.out).toContain("例外として許したファイル");
    expect(r.code).toBe(0);
  });

  it("1バイトでも変えた PDF.js は止める", () => {
    const r = run(fakeDist(CSP_OK, { "pdf.min-a.mjs": { copyAndAppend: "pdf.min.mjs" } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("pdf.min-a.mjs に fetch( が入っています");
  });

  it("CSP に connect-src 'none' がなければ、写しでも止める", () => {
    const r = run(fakeDist(CSP_OPEN, { "pdf.min-a.mjs": { copy: "pdf.min.mjs" } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("CSP に connect-src 'none' がありません");
    expect(r.out).toContain("pdf.min-a.mjs に fetch( が入っています");
  });

  it("自分たちのファイルの fetch は止める（.js も .mjs も）", () => {
    const r = run(fakeDist(CSP_OK, { "own.js": "fetch('/x');\n", "own.mjs": "new WebSocket('ws://x');\n" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("own.js に fetch( が入っています");
    expect(r.out).toContain("own.mjs に WebSocket が入っています");
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

  it("検索エンジンの確認のファイルは、決まった1行のときだけ通す", () => {
    const good = run(withPages({ "google0123abcd.html": "google-site-verification: google0123abcd.html\n" }));
    expect(good.code).toBe(0);
    expect(good.out).toContain("google0123abcd.html（検索エンジンの確認のファイル）");
    const bad = run(withPages({ "google0123abcd.html": "google-site-verification: google0123abcd.html\n<script>x</script>" }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("中身が決まった1行ではありません");
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// scripts/check-dist.mjs の例外（PDF.js の写し）が、決めた条件のときだけ効くことを確かめる（docs/no-network.md）。
// 作りものの dist/ を一時フォルダに置き、check-dist を動かして、通るか止まるかを見る。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECK_PAGE_RULES, CLEAN_URL_RULES, CONTACT_REWRITE, LICENSE_TEXTS_RULES } from "../htaccess.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "check-dist.mjs");
const PDFJS = path.join(ROOT, "node_modules", "pdfjs-dist", "build");
const CSP_OK = "default-src &#39;self&#39;; connect-src &#39;none&#39;; script-src &#39;self&#39;; form-action &#39;none&#39;";
const CSP_OPEN = "default-src &#39;self&#39;; script-src &#39;self&#39;; form-action &#39;none&#39;";
/** 検査のページの CSP（connect-src だけ 'self'。2026-11-06 本人が決定。csp.ts の withConnectSelf） */
const checkCsp = (csp: string) => csp.replace("connect-src &#39;none&#39;", "connect-src &#39;self&#39;");
/** お問い合わせのページの CSP（form-action だけ 'self'） */
const contactCsp = (csp: string) => csp.replace("form-action &#39;none&#39;", "form-action &#39;self&#39;");
/** お問い合わせの送り先の PHP の作りもの（check-dist が見る形だけ） */
const FAKE_PHP = `<?php\n$PAGES = ['form' => '<!--CONTACT_ERRORS--><input type="hidden" name="t" value="" />', 'error' => '<!--CONTACT_MESSAGE-->'];\n`;

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
<FilesMatch "^(contact\\.html|contact-send\\.php)$">
  <IfModule mod_headers.c>
    Header always set Content-Security-Policy "${headerCsp.replace("form-action 'none'", "form-action 'self'")}"
  </IfModule>
</FilesMatch>
<FilesMatch "^check\\.html$">
  <IfModule mod_headers.c>
    Header always set Content-Security-Policy "${headerCsp.replace("connect-src 'none'", "connect-src 'self'")}"
  </IfModule>
</FilesMatch>
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule ${CONTACT_REWRITE}
${LICENSE_TEXTS_RULES.map((l) => `  ${l}`).join("\n")}
${CHECK_PAGE_RULES.map((l) => `  ${l}`).join("\n")}
${CLEAN_URL_RULES.map((l) => (l === "" ? "" : `  ${l}`)).join("\n")}
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
    path.join(dir, "check.html"),
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${checkCsp(csp)}"><script type="module" src="/assets/index-Ab12Cd34.js"></script></head><body></body></html>`,
  );
  writeFileSync(path.join(dir, "assets", "index-Ab12Cd34.js"), "console.log(1);\n");
  if (htaccess !== null) writeFileSync(path.join(dir, ".htaccess"), htaccess);
  // 自前の 404 のページ（.htaccess の ErrorDocument が指す）。check.html と同じ CSP
  writeFileSync(path.join(dir, "404.html"), `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body></body></html>`);
  // お問い合わせの送り先（docs/contact.md）
  writeFileSync(path.join(dir, "contact-send.php"), FAKE_PHP);
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
  it("pdfjs-dist と同じ写しで、検査のページの CSP の connect-src が 'self'（ほかのページは 'none'）なら通す", () => {
    const r = run(fakeDist(CSP_OK, { "pdf.min-Aa11Bb22.mjs": { copy: "pdf.min.mjs" }, "pdf.worker.min-Cc33Dd44.mjs": { copy: "pdf.worker.min.mjs" } }));
    expect(r.out).toContain("例外として許したファイル");
    expect(r.code).toBe(0);
  });

  it("1バイトでも変えた PDF.js は止める", () => {
    const r = run(fakeDist(CSP_OK, { "pdf.min-Aa11Bb22.mjs": { copyAndAppend: "pdf.min.mjs" } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("pdf.min-Aa11Bb22.mjs に fetch( が入っています");
  });

  it("検査のページの CSP の connect-src が 'self' でなければ（外のサイトも許す・決めていない）、写しでも止める", () => {
    const r = run(fakeDist(CSP_OPEN, { "pdf.min-Aa11Bb22.mjs": { copy: "pdf.min.mjs" } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("check.html の CSP の connect-src が 'self' ではありません");
    expect(r.out).toContain("pdf.min-Aa11Bb22.mjs に fetch( が入っています");
  });

  it("自分たちのファイルの fetch は止める（.js も .mjs も）", () => {
    const r = run(fakeDist(CSP_OK, { "own-Ee55Ff66.js": "fetch('/x');\n", "own-Gg77Hh88.mjs": "new WebSocket('ws://x');\n" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("own-Ee55Ff66.js に fetch( が入っています");
    expect(r.out).toContain("own-Gg77Hh88.mjs に WebSocket が入っています");
  });
});

describe("check-dist の PDF.js の部品（/pdfjs/。src/render/pdfjs-parts.ts）", () => {
  const PARTS = path.join(ROOT, "node_modules", "pdfjs-dist");
  /** 決めた部品を全部、pdfjs-dist から dist/pdfjs/ に写す */
  function withParts(dir: string): string {
    for (const [sub, names] of [
      ["wasm", readdirSync(path.join(PARTS, "wasm")).filter((n) => /^(jbig2|openjpeg)_nowasm_fallback\.js$|^LICENSE_(PDFJS_)?(JBIG2|OPENJPEG)$/.test(n))],
      ["cmaps", readdirSync(path.join(PARTS, "cmaps")).filter((n) => n.endsWith(".bcmap") || n === "LICENSE")],
    ] as const) {
      mkdirSync(path.join(dir, "pdfjs", sub), { recursive: true });
      for (const n of names) copyFileSync(path.join(PARTS, sub, n), path.join(dir, "pdfjs", sub, n));
    }
    return dir;
  }

  it("決めた部品が pdfjs-dist と同じ写しでそろっていれば通し、画像を解く部品の fetch は例外として許す", () => {
    const r = run(withParts(fakeDist(CSP_OK, {})));
    expect(r.out).toContain("pdfjs/wasm/jbig2_nowasm_fallback.js（pdfjs-dist@");
    expect(r.code).toBe(0);
  });

  it("1 バイトでも変えた部品・置かないと決めた書体（標準の書体）・足りない部品は止める", () => {
    const dir = withParts(fakeDist(CSP_OK, {}));
    writeFileSync(path.join(dir, "pdfjs", "cmaps", "90ms-RKSJ-H.bcmap"), "x");
    mkdirSync(path.join(dir, "pdfjs", "standard_fonts"));
    copyFileSync(path.join(PARTS, "standard_fonts", "LiberationSans-Regular.ttf"), path.join(dir, "pdfjs", "standard_fonts", "LiberationSans-Regular.ttf"));
    rmSync(path.join(dir, "pdfjs", "cmaps", "Add-H.bcmap"));
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("pdfjs/cmaps/90ms-RKSJ-H.bcmap が、pdfjs-dist のファイルと違います");
    expect(r.out).toContain("pdfjs/standard_fonts/LiberationSans-Regular.ttf は、配信に入れると決めた PDF.js の部品ではありません");
    expect(r.out).toContain("PDF.js の部品のうち 1 個が dist/ にありません（cmaps/Add-H.bcmap）");
  });

  it(".htaccess に検査のページの CSP（connect-src 'self'）がなければ止める", () => {
    const r = run(fakeDist(CSP_OK, {}, fakeHtaccess(CSP_OK).replace(/<FilesMatch "\^check[\s\S]*?<\/FilesMatch>\n/, "")));
    expect(r.code).toBe(1);
    expect(r.out).toContain(".htaccess に、検査のページの CSP（<FilesMatch>。connect-src 'self'）がありません");
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
    expect(r.out).toContain(".htaccess の CSP が、<meta> の CSP（connect-src 'none'。＋ frame-ancestors 'none'）と食い違っています");
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

  it("/ を検査のページ（/check）へ 302 で移す規則がない・.html なしの書き換えより後ろなら止める（2026-11-05）", () => {
    const ht = fakeHtaccess(CSP_OK);
    const rule = "  RewriteRule ^$ /check [R=302,L]\n";
    expect(ht).toContain(rule);
    const missing = run(fakeDist(CSP_OK, {}, ht.replace(rule, "")));
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("/ を検査のページ（/check）へ移す規則（htaccess.ts の CHECK_PAGE_RULES）がありません");
    const block = `${CHECK_PAGE_RULES.map((l) => `  ${l}`).join("\n")}\n`;
    // 規則を、.html なしの書き換えのあと（rewrite の区切りの最後）へ動かす
    const moved = ht.replace(block, "");
    const end = moved.lastIndexOf("</IfModule>");
    const late = run(fakeDist(CSP_OK, {}, `${moved.slice(0, end)}${block}${moved.slice(end)}`));
    expect(late.code).toBe(1);
    expect(late.out).toContain("/ を検査のページへ移す規則が、.html なしの書き換えより後ろにあります");
  });

  it("検査のページ（check.html）がなければ止める", () => {
    const dir = fakeDist(CSP_OK, {});
    rmSync(path.join(dir, "check.html"));
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("検査のページ（check.html）がありません");
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
    const r = run(withPages({ "articles/a.html": page(CSP_OK, '<link rel="canonical" href="https://omamoripdf.com/articles/a">') }));
    expect(r.out).not.toContain("問題：");
    expect(r.code).toBe(0);
  });

  it("サイトの場所が .html 付きのリンク・canonical は止める（場所は .html なし。2026-11-05）", () => {
    const r = run(withPages({ "articles/a.html": page(CSP_OK, '<link rel="canonical" href="https://omamoripdf.com/articles/a.html"><a href="/privacy.html">') }));
    expect(r.out).toContain("articles/a.html に、.html 付きのサイトの場所が 2 か所あります");
    expect(r.code).toBe(1);
  });

  it("ページと同じ名前のフォルダは止める（本番で /x が /x/ へ移って 403 になる。2026-11-05 の /licenses）", () => {
    const r = run(withPages({ "guide.html": page(CSP_OK, ""), "guide/a.txt": "x" }));
    expect(r.out).toContain("ページと同じ名前のフォルダがあります（guide.html）");
    expect(r.code).toBe(1);
    const ok = run(withPages({ "guide.html": page(CSP_OK, ""), "guide-texts/a.txt": "x" }));
    expect(ok.out).not.toContain("ページと同じ名前のフォルダ");
  });

  it("CSP の <meta> がないページは止める", () => {
    const r = run(withPages({ "articles/a.html": "<!doctype html><html><head></head><body></body></html>" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("articles/a.html に CSP の <meta> がありません");
  });

  it("CSP が check.html（検査のページ）と違うページは止める", () => {
    const r = run(withPages({ "privacy.html": page(CSP_OPEN) }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("privacy.html の CSP が、check.html の CSP と食い違っています");
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
    const good = run(withPages({ "licenses.html": page(CSP_OK, '<a href="https://github.com/o/r">ソース</a>') }));
    expect(good.code).toBe(0);
    const bad = run(
      withPages({
        "licenses.html": page(CSP_OK, '<img src="https://github.com/o/r/x.png">'),
        "faq.html": page(CSP_OK, '<a href="https://example.invalid/">x</a>'),
      }),
    );
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("licenses.html が外のサイトから読み込んでいます");
    expect(bad.out).toContain("faq.html が外のサイトから読み込んでいます");
  });

  it("スクリプトは、記事の一覧のページの検索のスクリプト1つだけを通す", () => {
    const tag = '<script type="module" src="/assets/article-search-0123456789.js"></script>';
    const good = withPages({ "articles/index.html": page(CSP_OK, tag) });
    writeFileSync(path.join(good, "assets", "article-search-0123456789.js"), "export const x = 1;\n");
    const r1 = run(good);
    expect(r1.out).not.toContain("問題：");
    expect(r1.code).toBe(0);
    expect(r1.out).toContain("articles/index.html（検索のスクリプト assets/article-search-0123456789.js。サイトのページの例外）");

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

  it("記事の一覧のページの 3D の飾り：読み込み役 1 つと、それが読む描画（data-scene）だけを通す（2026-11-05 本人が承認）", () => {
    const loader = '<script type="module" src="/assets/site-3d-0123456789.js"></script>';
    const hero = '<div class="site-hero" data-scene="/assets/omamori-3d-abcdef0123.js"></div>';
    const good = withPages({ "articles/index.html": page(CSP_OK, `${hero}${loader}`) });
    writeFileSync(path.join(good, "assets", "site-3d-0123456789.js"), "export const x = 1;\n");
    writeFileSync(path.join(good, "assets", "omamori-3d-abcdef0123.js"), "export function mount() { return true; }\n");
    const r1 = run(good);
    expect(r1.out).not.toContain("問題：");
    expect(r1.code).toBe(0);
    expect(r1.out).toContain("3D の飾りの読み込み役 assets/site-3d-0123456789.js");
    expect(r1.out).toContain("3D の描画（読み込み役があとから読む） assets/omamori-3d-abcdef0123.js");

    // 読み込み役が 2 つ・ほかのページに置く・描画に eval・data-scene がほかの場所を指す
    const bad = withPages({
      "articles/index.html": page(CSP_OK, `${hero}${loader}${loader}`),
      "faq.html": page(CSP_OK, loader),
      "terms.html": page(CSP_OK, '<div data-scene="https://example.com/x.js"></div>'),
    });
    writeFileSync(path.join(bad, "assets", "site-3d-0123456789.js"), "export const x = 1;\n");
    writeFileSync(path.join(bad, "assets", "omamori-3d-abcdef0123.js"), "eval(location.hash);\n");
    const r2 = run(bad);
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("articles/index.html にスクリプトがあります");
    expect(r2.out).toContain("faq.html にスクリプトがあります");
    expect(r2.out).toContain("terms.html の data-scene が");
    expect(r2.out).toContain("assets/omamori-3d-abcdef0123.js に、字を HTML として解釈させる書き方か eval があります");
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

describe("check-dist のお問い合わせ（docs/contact.md）", () => {
  const page = (csp: string) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body></body></html>`;
  const withContact = (csp: string, extra: Record<string, string> = {}) => {
    const dir = fakeDist(CSP_OK, {});
    writeFileSync(path.join(dir, "contact.html"), page(csp));
    for (const [name, text] of Object.entries(extra)) writeFileSync(path.join(dir, name), text);
    return dir;
  };

  it("お問い合わせのページは、form-action 'self' だけが違う CSP なら通す", () => {
    const r = run(withContact(contactCsp(CSP_OK)));
    expect(r.out).not.toContain("問題：");
    expect(r.code).toBe(0);
    expect(r.out).toContain("contact-send.php（お問い合わせの送り先の PHP。ただ 1 つ）");
  });

  it("お問い合わせのページが、ほかのページと同じ CSP（form-action 'none'）や、ゆるめた CSP なら止める", () => {
    for (const csp of [CSP_OK, contactCsp(CSP_OK).replace("connect-src &#39;none&#39;; ", "")]) {
      const r = run(withContact(csp));
      expect(r.code).toBe(1);
      expect(r.out).toContain("contact.html の CSP が、check.html の CSP と食い違っています");
    }
  });

  it("ほかのページが form-action 'self' なら止める", () => {
    const dir = withContact(contactCsp(CSP_OK), { "privacy.html": page(contactCsp(CSP_OK)) });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("privacy.html の CSP が、check.html の CSP と食い違っています");
  });

  it(".htaccess にお問い合わせの <FilesMatch> がない・ほかのファイルにも当たるなら止める", () => {
    const none = run(fakeDist(CSP_OK, {}, fakeHtaccess(CSP_OK).replace(/<FilesMatch[\s\S]*<\/FilesMatch>\n/, "")));
    expect(none.code).toBe(1);
    expect(none.out).toContain("お問い合わせのページの CSP（<FilesMatch>）がありません");
    const wide = run(fakeDist(CSP_OK, {}, fakeHtaccess(CSP_OK).replace('"^(contact\\.html|contact-send\\.php)$"', '"\\.(html|php)$"')));
    expect(wide.code).toBe(1);
    expect(wide.out).toContain("ほかのファイルにも当たるか");
  });

  it("PHP は送り先の 1 つだけ。本物の設定・メールアドレス・差し込み忘れは止める", () => {
    const extra = run(withContact(contactCsp(CSP_OK), { "contact-config.php": "<?php return [];\n" }));
    expect(extra.code).toBe(1);
    expect(extra.out).toContain("contact-config.php を配るものに入れています");
    const mail = run(withContact(contactCsp(CSP_OK), { "contact-send.php": FAKE_PHP + "// owner@not-a-real-site.invalid\n" }));
    expect(mail.code).toBe(1);
    expect(mail.out).toContain("メールアドレスらしい字があります");
    const raw = run(withContact(contactCsp(CSP_OK), { "contact-send.php": "<?php\n$PAGES = []; // @@PAGES@@\n" }));
    expect(raw.code).toBe(1);
    expect(raw.out).toContain("差し込まれていません");
    const gone = withContact(contactCsp(CSP_OK));
    rmSync(path.join(gone, "contact-send.php"));
    expect(run(gone).out).toContain("dist/ に contact-send.php がありません");
  });
});

describe("check-dist のお問い合わせのフォームのページ（開いた時刻の印）", () => {
  it(".htaccess に、お問い合わせのページを PHP へ回す書き換えがなければ止める", () => {
    const dir = fakeDist(CSP_OK, {}, fakeHtaccess(CSP_OK).replace(`  RewriteRule ${CONTACT_REWRITE}\n`, ""));
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("お問い合わせのページを contact-send.php へ回す書き換えがありません");
  });

  it("お問い合わせのページを PHP へ回す書き換えが、.html なしの書き換えより後ろにあれば止める（静かな contact.html が返るため）", () => {
    const rule = `  RewriteRule ${CONTACT_REWRITE}\n`;
    // 書き換えを、mod_rewrite の囲みのいちばん最後（.html なしの書き換えの後ろ）へ移す
    const moved = fakeHtaccess(CSP_OK).replace(rule, "").replace(/<\/IfModule>\n$/, `${rule}</IfModule>\n`);
    expect(moved.indexOf(rule)).toBeGreaterThan(moved.indexOf(CLEAN_URL_RULES[0]!));
    const r = run(fakeDist(CSP_OK, {}, moved));
    expect(r.code).toBe(1);
    expect(r.out).toContain(".html なしの書き換えより後ろにあります");
  });

  it("PHP にフォームのページ（印の欄）が入っていなければ止める", () => {
    const dir = fakeDist(CSP_OK, {});
    writeFileSync(path.join(dir, "contact-send.php"), "<?php\n$PAGES = ['error' => '<!--CONTACT_MESSAGE-->'];\n");
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("フォームのページ（開いた時刻の印の欄）が差し込まれていません");
  });
});

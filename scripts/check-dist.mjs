// SPDX-License-Identifier: AGPL-3.0-only
//
// ビルドしたもの（dist/）を確かめる。
// - HTML に CSP の <meta> が入っていて、connect-src 'none' を含むか
// - .htaccess（配信先で CSP をヘッダーで返す）があり、その CSP が <meta> と食い違っていないか
// - HTML の中に、直接書いたスクリプトや style がないか（CSP で止まるため。入っていたら作りの誤り）
// - 外のサイトから読み込んでいないか
// - サイトのページ（記事・プライバシー。site.ts が作る）も含め、すべての HTML に同じ CSP の <meta> があり、
//   直接書いたスクリプト・style がなく、外から読み込んでいないか（公式の URL を指す canonical のリンクと、GitHub を指す <a> のリンクだけは許す）
// - 検索エンジンの確認のファイル（public/ の googleXXXX.html）は、中身が決まった1行のときだけ通す（src/site/search-console.ts）
// - JavaScript（.js・.mjs）に、外と通信する仕組みが入っていないか（ライブラリが持ち込むこともあるため、ビルドのあとでも見る）
//
// 例外は1つだけ（2026-11-03 本人が決定。理由は docs/no-network.md）：
//   PDF.js（ページの絵を描くため）のファイルは、中に fetch などのコードを持つ。これは、
//   (1) npm の pdfjs-dist（package-lock.json で版を固定）のファイルと、1バイトも違わない写しであり、
//   (2) CSP に connect-src 'none' が入っている
//   ときに限って許す。このとき、ブラウザで外への要求が0件であることを scripts/check-browser.mjs で確かめる。
//   自分たちのコードを PDF.js のファイルに混ぜると (1) が崩れて止まる。

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { OFFICIAL_ORIGIN } from "../htaccess.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
// 調べるフォルダは、テストのときだけ DIST_DIR で変えられる（tests/check-dist.test.ts）
const DIST = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(ROOT, "dist");
const problems = [];
const allowed = [];
const allowedHtml = [];

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

let files;
try {
  files = listFiles(DIST);
} catch {
  console.error("dist/ がありません。先に vite build を実行してください。");
  process.exit(1);
}

const html = readFileSync(path.join(DIST, "index.html"), "utf8");
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
const cspHasNoConnect = !!meta && decode(meta[1]).split(";").some((d) => d.trim() === "connect-src 'none'");
if (!meta) problems.push("index.html に CSP の <meta> がありません");
else if (!cspHasNoConnect) problems.push("CSP に connect-src 'none' がありません");

// ---- 配信先（Xserver）で CSP などをヘッダーで返す .htaccess（docs/deploy.md）
// ヘッダーの CSP は、<meta> の CSP に frame-ancestors 'none' を足しただけのものであること（食い違うと厳しい方が効くため）
let htaccess = null;
try {
  htaccess = readFileSync(path.join(DIST, ".htaccess"), "utf8");
} catch {
  problems.push("dist/ に .htaccess がありません（配信先で CSP をヘッダーで返せません）");
}
if (htaccess !== null) {
  const header = htaccess.match(/^\s*Header always set Content-Security-Policy "([^"]+)"\s*$/m);
  const split = (s) => s.split(";").map((d) => d.trim()).filter(Boolean);
  if (!header) problems.push(".htaccess に CSP のヘッダーがありません");
  else if (meta) {
    const fromHeader = split(header[1]);
    const expected = [...split(decode(meta[1])), "frame-ancestors 'none'"];
    if (fromHeader.join("; ") !== expected.join("; ")) problems.push(".htaccess の CSP が、<meta> の CSP（＋ frame-ancestors 'none'）と食い違っています");
  }
  if (!/^\s*AddType text\/javascript \.mjs\s*$/m.test(htaccess)) problems.push(".htaccess に AddType text/javascript .mjs がありません");
  if (!/^\s*AddType application\/wasm \.wasm\s*$/m.test(htaccess)) problems.push(".htaccess に AddType application/wasm .wasm がありません");
}

// ---- すべての HTML（index.html と、サイトのページ）
const indexCsp = meta ? decode(meta[1]) : null;
// 公式の URL を指す canonical のリンクは、読み込みではないので許す（写したサイトでも、本物を指すように）
const canonical = new RegExp(`<link rel="canonical" href="${OFFICIAL_ORIGIN.replace(/\./g, "\\.")}/[^"]*"`, "g");
// 押して移るリンク（<a>）で GitHub を指すもの（ソースの場所・Issues・部品の出典）も、読み込みではないので許す。
// <a> 以外（img・script・link など）が GitHub を指すのは許さない
const githubLink = /<a href="https:\/\/github\.com\/[^"]*"/g;
for (const f of files.filter((x) => x.endsWith(".html"))) {
  const rel = path.relative(DIST, f).replace(/\\/g, "/");
  const text = readFileSync(f, "utf8");
  // 検索エンジンの確認のファイル：一番上にあり、名前が googleXXXX.html で、中身がその名前を書いた1行だけ
  const g = rel.match(/^(google[0-9a-z]+\.html)$/);
  if (g) {
    if (text.trim() !== `google-site-verification: ${g[1]}`) problems.push(`${rel} は検索エンジンの確認のファイルの名前ですが、中身が決まった1行ではありません`);
    else allowedHtml.push(`${rel}（検索エンジンの確認のファイル）`);
    continue;
  }
  if (rel !== "index.html") {
    const m = text.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    if (!m) problems.push(`${rel} に CSP の <meta> がありません`);
    else if (indexCsp !== null && decode(m[1]) !== indexCsp) problems.push(`${rel} の CSP が、index.html の CSP と食い違っています`);
  }
  const inlineScript = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1]) || m[2].trim() !== "");
  if (inlineScript.length) problems.push(`${rel} に直接書いたスクリプトが ${inlineScript.length} か所あります`);
  if (/<style\b/.test(text) || /\sstyle="/.test(text)) problems.push(`${rel} に直接書いた style があります`);
  if (/(src|href)="(https?:)?\/\//.test(text.replace(canonical, "").replace(githubLink, "<a"))) problems.push(`${rel} が外のサイトから読み込んでいます`);
}

// ---- PDF.js の写しを見分ける：pdfjs-dist のファイルの SHA-256 と、版を、package-lock.json と照らす
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const PDFJS_DIR = path.join(ROOT, "node_modules", "pdfjs-dist");
const PDFJS_FILES = ["build/pdf.min.mjs", "build/pdf.worker.min.mjs"];
const pdfjsHashes = new Map();
try {
  const installed = JSON.parse(readFileSync(path.join(PDFJS_DIR, "package.json"), "utf8")).version;
  const locked = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")).packages?.["node_modules/pdfjs-dist"]?.version;
  if (!locked || installed !== locked) {
    problems.push(`入っている pdfjs-dist（${installed}）が、package-lock.json の版（${locked ?? "なし"}）と違います`);
  } else {
    for (const f of PDFJS_FILES) pdfjsHashes.set(sha256(readFileSync(path.join(PDFJS_DIR, f))), `pdfjs-dist@${installed}/${f}`);
  }
} catch {
  // pdfjs-dist が入っていなければ、例外は使えない（ふつうに通信の仕組みを探す）
}

const NET = [
  ["fetch(", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["RTCPeerConnection", /\bRTCPeerConnection\b/],
  ["importScripts(", /\bimportScripts\s*\(/],
];
for (const f of files.filter((f) => /\.(m?js)$/.test(f))) {
  const buf = readFileSync(f);
  const src = buf.toString("utf8");
  const hits = NET.filter(([, re]) => re.test(src)).map(([label]) => label);
  if (!hits.length) continue;
  const rel = path.relative(DIST, f).replace(/\\/g, "/");
  const origin = pdfjsHashes.get(sha256(buf));
  if (origin && cspHasNoConnect) {
    allowed.push(`${rel}（${origin} と同じ。${hits.join("・")}）`);
    continue;
  }
  for (const label of hits) problems.push(`${rel} に ${label} が入っています`);
}

console.log(`dist/ のファイル：${files.length} 件`);
for (const f of files) console.log(`  ${path.relative(DIST, f).replace(/\\/g, "/")}  ${statSync(f).size} バイト`);
if (allowed.length) {
  console.log("\n例外として許したファイル（PDF.js の写し。CSP に connect-src 'none' があるときだけ。docs/no-network.md）：");
  for (const a of allowed) console.log(`  - ${a}`);
}
if (allowedHtml.length) {
  console.log("\nCSP の <meta> がなくても通した HTML：");
  for (const a of allowedHtml) console.log(`  - ${a}`);
}
if (problems.length) {
  console.error("\n問題：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\n問題は見つかりませんでした（すべての HTML の CSP の <meta>、.htaccess、直接書いたスクリプト・style、外からの読み込み、通信の仕組み）。");

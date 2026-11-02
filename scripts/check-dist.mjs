// SPDX-License-Identifier: AGPL-3.0-only
//
// ビルドしたもの（dist/）を確かめる。
// - HTML に CSP の <meta> が入っていて、connect-src 'none' を含むか
// - HTML の中に、直接書いたスクリプトや style がないか（CSP で止まるため。入っていたら作りの誤り）
// - 外のサイトから読み込んでいないか
// - JavaScript に、外と通信する仕組みが入っていないか（ライブラリが持ち込むこともあるため、ビルドのあとでも見る）

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const DIST = path.resolve(import.meta.dirname, "..", "dist");
const problems = [];

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
if (!meta) problems.push("index.html に CSP の <meta> がありません");
else if (!decode(meta[1]).includes("connect-src 'none'")) problems.push("CSP に connect-src 'none' がありません");

const inlineScript = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(
  (m) => !/\bsrc=/.test(m[1]) || m[2].trim() !== "",
);
if (inlineScript.length) problems.push(`index.html に直接書いたスクリプトが ${inlineScript.length} か所あります`);
if (/<style\b/.test(html) || /\sstyle="/.test(html)) problems.push("index.html に直接書いた style があります");
if (/(src|href)="(https?:)?\/\//.test(html)) problems.push("index.html が外のサイトから読み込んでいます");

const NET = [
  ["fetch(", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["RTCPeerConnection", /\bRTCPeerConnection\b/],
  ["importScripts(", /\bimportScripts\s*\(/],
];
for (const f of files.filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(f, "utf8");
  for (const [label, re] of NET) {
    if (re.test(src)) problems.push(`${path.relative(DIST, f)} に ${label} が入っています`);
  }
}

console.log(`dist/ のファイル：${files.length} 件`);
for (const f of files) console.log(`  ${path.relative(DIST, f).replace(/\\/g, "/")}  ${statSync(f).size} バイト`);
if (problems.length) {
  console.error("\n問題：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\n問題は見つかりませんでした（CSP の <meta>、直接書いたスクリプト・style、外からの読み込み、通信の仕組み）。");

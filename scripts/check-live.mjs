// SPDX-License-Identifier: AGPL-3.0-only
//
// 配信したサイト（本番）を確かめる（docs/deploy.md）。GitHub Actions の配信の最後に動かす。手元でも動かせる。
//
//   npm run build && npm run check:live                         … https://omamoripdf.com/ を確かめる
//   npm run check:live -- --url https://example.invalid/        … 確かめる先を変える
//
// 確かめること（1つでも合わなければ失敗）：
// - トップページが 200 で返り、csp.ts のヘッダー（CSP・nosniff・no-referrer など）が、同じ値で1つずつ付いている
// - サイトのページ（記事の一覧・記事1つ・プライバシー）も 200 で返り、同じヘッダーが付いている
// - トップページが、外のサイトからスクリプトを読み込んでいない（アクセス解析のスクリプトは入れない。docs/no-network.md）
// - .mjs が text/javascript、.wasm が application/wasm で返る（dist/ に .wasm がなければ、省いたと表示する）
// - dist/ のファイルが、本番のものと1バイトも違わない（.htaccess は外から読めないこと）
// - http:// で来たら https:// へ 301
// - www つきで来たら、www なしへ 301（www の名前が引けないときは「確かめられなかった」と表示し、失敗にはしない）
//
// このスクリプト自身は通信を使う（検査器のコードではない。dist/ には入らない）。

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { securityHeaders } from "../csp.ts";
import { OFFICIAL_HOST } from "../htaccess.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const args = process.argv.slice(2);
const urlArg = args.indexOf("--url");
const base = new URL(urlArg >= 0 ? args[urlArg + 1] : `https://${OFFICIAL_HOST}/`);

const problems = [];
const notes = [];
const ok = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

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
  files = listFiles(DIST).map((f) => path.relative(DIST, f).replace(/\\/g, "/"));
} catch {
  console.error("dist/ がありません。先に npm run build を実行してください。");
  process.exit(1);
}

async function get(url, method = "GET") {
  return fetch(url, { method, redirect: "manual", cache: "no-store", headers: { "Cache-Control": "no-cache" } });
}

// ---- トップページのヘッダー。つながるまで少し待つ（配信の直後のため）
let top = null;
for (let i = 0; i < 6 && !top; i++) {
  try {
    top = await get(base);
  } catch (e) {
    if (i === 5) problems.push(`${base.href} につながりません（${e?.cause?.code ?? e?.message ?? e}）`);
    else await sleep(10_000);
  }
}
if (top) {
  if (top.status !== 200) problems.push(`${base.href} が ${top.status} を返しました（200 のはず）`);
  for (const [name, want] of Object.entries(securityHeaders)) {
    const got = top.headers.get(name);
    if (got === null) problems.push(`ヘッダー ${name} がありません`);
    else if (got !== want) problems.push(`ヘッダー ${name} の値が違います（二重に付いている場合も、ここで止まります）\n      本番：${got}\n      期待：${want}`);
    else ok.push(`ヘッダー ${name}`);
  }
}

// ---- サイトのページ（記事の一覧・プライバシー。site.ts が作る）にも、同じヘッダーが付いている
// 記事は1つだけ見る（どれも同じ .htaccess のもとで返るため）
for (const page of ["articles/", "privacy.html", files.find((f) => /^articles\/(?!index\.html$).+\.html$/.test(f))].filter(Boolean)) {
  try {
    const r = await get(new URL(page, base));
    if (r.status !== 200) {
      problems.push(`${page} が ${r.status} を返しました（200 のはず）`);
      continue;
    }
    const bad = Object.entries(securityHeaders).filter(([name, want]) => r.headers.get(name) !== want).map(([name]) => name);
    if (bad.length) problems.push(`${page} のヘッダーが違います（${bad.join("・")}）`);
    else ok.push(`${page} のヘッダー`);
  } catch (e) {
    problems.push(`${page} を確かめられませんでした（${e?.message ?? e}）`);
  }
}

// ---- アクセス解析のスクリプトを入れていない（開いた回数は、サーバーの記録で数える。docs/no-network.md）
// 本番のトップページの HTML が dist/ と1バイトも違わないことは下で確かめる。ここでは、外から読み込むスクリプトがないことを見る
if (top) {
  try {
    const html = await (await get(base)).text();
    if (/<script\b[^>]*\bsrc="(https?:)?\/\//.test(html)) problems.push("トップページが、外のサイトからスクリプトを読み込んでいます");
    else ok.push("トップページに、外から読み込むスクリプトがない");
  } catch (e) {
    problems.push(`トップページの中身を確かめられませんでした（${e?.message ?? e}）`);
  }
}

// ---- ファイルの種類と中身
const TYPES = [
  [".mjs", "text/javascript"],
  [".wasm", "application/wasm"],
];
for (const [ext, want] of TYPES) {
  const f = files.find((x) => x.endsWith(ext));
  if (!f) {
    notes.push(`dist/ に ${ext} がないため、${ext} の種類（${want}）は確かめていません`);
    continue;
  }
  try {
    const r = await get(new URL(f, base), "HEAD");
    const got = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (r.status !== 200) problems.push(`${f} が ${r.status} を返しました`);
    else if (got !== want) problems.push(`${f} の種類が ${got || "（なし）"} です（${want} のはず）`);
    else ok.push(`${ext} の種類（${want}）`);
  } catch (e) {
    problems.push(`${f} を確かめられませんでした（${e?.message ?? e}）`);
  }
}

let same = 0;
for (const f of files) {
  try {
    const r = await get(new URL(f, base));
    if (f === ".htaccess") {
      if (r.status === 200) problems.push(".htaccess が外から読めます（403 か 404 のはず）");
      else ok.push(`.htaccess は外から読めない（${r.status}）`);
      continue;
    }
    if (r.status !== 200) {
      problems.push(`${f} が ${r.status} を返しました`);
      continue;
    }
    const live = Buffer.from(await r.arrayBuffer());
    if (sha256(live) !== sha256(readFileSync(path.join(DIST, f)))) problems.push(`${f} が、手元の dist/ と違います`);
    else same++;
  } catch (e) {
    problems.push(`${f} を確かめられませんでした（${e?.message ?? e}）`);
  }
}
ok.push(`dist/ のファイル ${same} 件が、本番と1バイトも違わない`);

// ---- http → https、www → www なし（公式のドメインを確かめるときだけ）
if (base.hostname === OFFICIAL_HOST) {
  const want = `https://${OFFICIAL_HOST}/`;
  for (const from of [`http://${OFFICIAL_HOST}/`, `https://www.${OFFICIAL_HOST}/`, `http://www.${OFFICIAL_HOST}/`]) {
    try {
      const r = await get(from, "HEAD");
      const loc = r.headers.get("location");
      if (r.status !== 301 || loc !== want) problems.push(`${from} が ${r.status}（行き先 ${loc ?? "なし"}）を返しました（301 で ${want} のはず）`);
      else ok.push(`${from} → 301 → ${want}`);
    } catch (e) {
      const code = e?.cause?.code ?? e?.message ?? String(e);
      if (from.includes("www.")) notes.push(`${from} は確かめられませんでした（${code}）。www の名前が引けないか、証明書が www を含まない`);
      else problems.push(`${from} を確かめられませんでした（${code}）`);
    }
  }
}

console.log(`確かめた先：${base.href}`);
for (const o of ok) console.log(`  合う：${o}`);
for (const n of notes) console.log(`  省いた：${n}`);
if (problems.length) {
  console.error("\n問題：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\n本番の確かめで、問題は見つかりませんでした。");

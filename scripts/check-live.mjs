// SPDX-License-Identifier: AGPL-3.0-only
//
// 配信したサイト（本番）を確かめる（docs/deploy.md）。GitHub Actions の配信の最後に動かす。手元でも動かせる。
//
//   npm run build && npm run check:live                         … https://omamoripdf.com/ を確かめる
//   npm run check:live -- --url https://example.invalid/        … 確かめる先を変える
//
// 確かめること（1つでも合わなければ失敗）：
// - トップページが 200 で返り、csp.ts のヘッダー（CSP・nosniff・no-referrer など）が、同じ値で1つずつ付いている
// - サイトのページ（記事の一覧・記事1つ・タグのページ・プライバシー）も .html なしの場所で 200 で返り、同じヘッダーが付いている。.html 付きの場所は .html なしへ 301
// - トップページが、外のサイトからスクリプトを読み込んでいない（アクセス解析のスクリプトは入れない。docs/no-network.md）
// - https の応答に Strict-Transport-Security が付き、Cache-Control が HTML は no-cache・assets/ は 1 年（htaccess.ts）
// - 見つからない場所は、404 で自前の 404 のページ（dist/404.html と同じ中身）を、同じヘッダーをつけて返す。assets/ を開いてもファイルの一覧は出ない
// - .mjs が text/javascript、.wasm が application/wasm で返る（dist/ に .wasm がなければ、省いたと表示する）
// - お問い合わせのページと送り先（contact-send.php）だけ、form-action 'self' の CSP（csp.ts の contactHeaders）。どちらも PHP がフォームを返し、
//   中身は dist/contact.html と開いた時刻の印だけが違う。PHP のソースを出さない（印がないときは、設定がまだないと表示する）
// - dist/ のファイルが、本番のものと1バイトも違わない（.htaccess は外から読めないこと。送り先の PHP は、サーバーが動かすので照らさない）
// - http:// で来たら https:// へ 301
// - www つきで来たら、www なしへ 301（www の名前が引けないときは「確かめられなかった」と表示し、失敗にはしない）
//
// このスクリプト自身は通信を使う（検査器のコードではない。dist/ には入らない）。

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { contactHeaders, securityHeaders } from "../csp.ts";
import { CACHE_ASSETS, CACHE_DEFAULT, CONTACT_PAGE_FILE, CONTACT_SEND_FILE, HSTS, NOT_FOUND_PAGE, OFFICIAL_HOST } from "../htaccess.ts";

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

// ---- サイトのページの場所は .html なし（2026-11-05。htaccess.ts の CLEAN_URL_RULES）
// dist/ の HTML のファイルの名前から、本番で開く場所を作る（index.html と検索エンジンの確認のファイルは、そのまま）
const pageUrlFor = (f) => {
  if (f === "index.html" || /^google[0-9a-z]+\.html$/.test(f)) return f;
  if (f.endsWith("/index.html")) return f.slice(0, -"index.html".length);
  return f.endsWith(".html") ? f.slice(0, -".html".length) : f;
};
const articleFile = files.find((f) => /^articles\/(?!index\.html$|tags\/).+\.html$/.test(f));
const tagFile = files.find((f) => /^articles\/tags\/.+\.html$/.test(f));
// 同じ名前のフォルダがあるページ（licenses.html と licenses/ など）。フォルダを先に見ると /x/ へ移って 403 になったので、別に確かめる
const pagesWithFolder = files.filter((f) => f.endsWith(".html") && !f.endsWith("index.html") && files.some((g) => g.startsWith(`${f.slice(0, -".html".length)}/`)));

// ---- .html 付きの場所は、.html なしへ 301（外からのリンクや検索の結果を切らさないため）
for (const f of [...new Set(["privacy.html", CONTACT_PAGE_FILE, articleFile, tagFile, ...pagesWithFolder].filter(Boolean))]) {
  try {
    const r = await get(new URL(f, base), "HEAD");
    const loc = r.headers.get("location");
    const want = new URL(pageUrlFor(f), base).href;
    if (r.status !== 301 || !loc || new URL(loc, base).href !== want) problems.push(`${f} が ${r.status}（行き先 ${loc ?? "なし"}）を返しました（301 で ${want} のはず）`);
    else ok.push(`${f} → 301 → ${pageUrlFor(f)}`);
  } catch (e) {
    problems.push(`${f} の移し先を確かめられませんでした（${e?.message ?? e}）`);
  }
}

// ---- サイトのページ（記事の一覧・プライバシー・記事1つ・タグのページ・同じ名前のフォルダがあるページ。site.ts が作る）が .html なしの場所で 200 を返し、同じヘッダーが付いている
// 記事は1つだけ見る（どれも同じ .htaccess のもとで返るため）
for (const page of [...new Set(["articles/", "privacy", articleFile && pageUrlFor(articleFile), tagFile && pageUrlFor(tagFile), ...pagesWithFolder.map(pageUrlFor)].filter(Boolean))]) {
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

// ---- お問い合わせのページと送り先（docs/contact.md）：この 2 つだけ、form-action 'self' の CSP と same-origin の参照元の決まり。
// どちらも、PHP がフォームのページを返す（.htaccess が /contact を contact-send.php へ中で回す。/contact.html は上で 301 を確かめた）。
// 中身は dist/contact.html と、開いた時刻の印（隠れた欄 t の値）だけが違う。PHP のソースが、そのまま返らない（PHP が動いている）
for (const page of [CONTACT_PAGE_FILE, CONTACT_SEND_FILE]) {
  if (!files.includes(page)) {
    problems.push(`dist/ に ${page} がありません`);
    continue;
  }
  try {
    const r = await get(new URL(pageUrlFor(page), base));
    const text = await r.text();
    const bad = Object.entries(contactHeaders).filter(([name, want]) => r.headers.get(name) !== want).map(([name]) => name);
    const token = text.match(/name="t" value="([^"]*)"/)?.[1];
    const want = readFileSync(path.join(DIST, CONTACT_PAGE_FILE), "utf8");
    if (r.status !== 200) problems.push(`${page} が ${r.status} を返しました（200 のはず）`);
    else if (bad.length) problems.push(`${page} のヘッダーが、お問い合わせの決まり（csp.ts の contactHeaders）と違います（${bad.join("・")}）`);
    else if (/<\?php|contact_handle/.test(text)) problems.push(`${page} で PHP のソースが返りました（PHP が動いていません）`);
    else if (token === undefined || text.replace(`name="t" value="${token}"`, 'name="t" value=""') !== want) problems.push(`${page} が、dist/${CONTACT_PAGE_FILE} と、開いた時刻の印のほかでも違います（.htaccess の書き換えが効いていないか、古い版）`);
    else if (!/^\d+\.[0-9a-f]{32}$/.test(token)) notes.push(`${page}：開いた時刻の印が入っていません。サーバーに contact-config.php がまだないか、形が違います（docs/contact.md）。この間は送れません`);
    else ok.push(`${page}：PHP がフォームを返し、開いた時刻の印が入っている。ヘッダーはお問い合わせの決まりと同じ`);
  } catch (e) {
    problems.push(`${page} を確かめられませんでした（${e?.message ?? e}）`);
  }
}

// ---- HSTS（https の応答だけ）とキャッシュ（HTML は no-cache、名前にハッシュの付いた assets/ は 1 年）
if (top) {
  if (base.protocol === "https:") {
    const got = top.headers.get("strict-transport-security");
    if (got !== HSTS) problems.push(`Strict-Transport-Security が ${got ?? "（なし）"} です（${HSTS} のはず）`);
    else ok.push(`Strict-Transport-Security（${HSTS}）`);
  } else notes.push("http の場所を確かめているため、Strict-Transport-Security は確かめていません");
  const cc = top.headers.get("cache-control");
  if (cc !== CACHE_DEFAULT) problems.push(`トップページの Cache-Control が ${cc ?? "（なし）"} です（${CACHE_DEFAULT} のはず）`);
  else ok.push(`トップページの Cache-Control（${CACHE_DEFAULT}）`);
}
{
  const asset = files.find((f) => f.startsWith("assets/") && f.endsWith(".css")) ?? files.find((f) => f.startsWith("assets/"));
  if (asset) {
    try {
      const r = await get(new URL(asset, base), "HEAD");
      const cc = r.headers.get("cache-control");
      if (r.status !== 200) problems.push(`${asset} が ${r.status} を返しました`);
      else if (cc !== CACHE_ASSETS) problems.push(`${asset} の Cache-Control が ${cc ?? "（なし）"} です（${CACHE_ASSETS} のはず）`);
      else ok.push(`assets/ の Cache-Control（${CACHE_ASSETS}）`);
    } catch (e) {
      problems.push(`${asset} を確かめられませんでした（${e?.message ?? e}）`);
    }
  }
}

// ---- 見つからないとき：自前の 404 のページを、404 で、同じヘッダーをつけて返す。フォルダの中身の一覧は出さない
try {
  // .html なしの場所（今のサイトの形）と、.html 付きの場所（前の形。ファイルがないので 301 にせず 404）と、assets/ の中
  const missing = `this-page-does-not-exist-${Date.now()}`;
  for (const where of [missing, `${missing}.html`, `articles/${missing}`, `assets/${missing}.html`]) {
    const r = await get(new URL(where, base));
    const body = Buffer.from(await r.arrayBuffer());
    const want = readFileSync(path.join(DIST, NOT_FOUND_PAGE.slice(1)));
    const bad = Object.entries(securityHeaders).filter(([name, v]) => r.headers.get(name) !== v).map(([name]) => name);
    if (r.status !== 404) problems.push(`見つからない場所（${where}）が ${r.status} を返しました（404 のはず）`);
    else if (sha256(body) !== sha256(want)) problems.push(`見つからない場所（${where}）で、自前の 404 のページ（${NOT_FOUND_PAGE}）が返りませんでした`);
    else if (bad.length) problems.push(`404 の応答のヘッダーが違います（${bad.join("・")}）`);
    else if (r.headers.get("cache-control") !== CACHE_DEFAULT) problems.push(`404 の応答（${where}）の Cache-Control が ${r.headers.get("cache-control") ?? "（なし）"} です（${CACHE_DEFAULT} のはず）`);
    else ok.push(`見つからない場所（${where.replace(/this-page-does-not-exist-[0-9]+/, "…")}）は、404 で自前の 404 のページと同じヘッダー`);
  }
  const dir = await get(new URL("assets/", base));
  const listing = dir.status === 200 && /Index of \/assets/i.test(await dir.text());
  if (listing) problems.push("assets/ を開くと、ファイルの一覧が出ます（配信先の設定で、フォルダの一覧を止める必要がある）");
  else ok.push(`assets/ を開いても、ファイルの一覧は出ない（${dir.status}）`);
} catch (e) {
  problems.push(`見つからない場所の確かめができませんでした（${e?.message ?? e}）`);
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
    // お問い合わせの送り先（PHP）は、サーバーが動かすので中身を照らせない。上で、GET の答えとヘッダーを確かめた
    // お問い合わせのページも、本番では PHP が返す（開いた時刻の印が毎回違う）。上で、印のほかが同じことを確かめた
    if (f === CONTACT_SEND_FILE || f === CONTACT_PAGE_FILE) continue;
    // HTML は、本番で開く場所（.html なし）で取る。.html 付きは 301 になるため
    const r = await get(new URL(f.endsWith(".html") ? pageUrlFor(f) : f, base));
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

// SPDX-License-Identifier: AGPL-3.0-only
//
// 通信を数える拡張機能（extension/）を、本物の Chrome に入れて確かめる。
//
//   npm run build && npm run check:extension                 … 確かめるだけ
//   npm run check:extension -- --shots <フォルダ>             … ページの隅の表示のスクリーンショットも撮る
//
// 1. ビルドした検査器（dist/ を vite preview で）を開く。PDF を入れる前は「待っています」で、送ったデータに数えないこと。
// 2. 合成 PDF（fixtures/）を入れる。数え始め（PDF の合図）になり、送った要求が 0 件・0 B のままであること。
// 3. 確かめのページ（extension/test-page/。手元のサーバーだけに送る）で、わざと要求を出し、送った数が増えること。
//
// - Chrome を headless で動かし、DevTools の決まり（CDP）を pipe でつなぐ。拡張機能は Extensions.loadUnpacked で入れる
//   （Chrome の --load-extension は、いまの Chrome では効かないため）。場所は CHROME_PATH で変えられる。
// - このスクリプト自身は、手元の Chrome と手元のサーバーとだけ話す（検査器のコードではない。dist/ には入らない）。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHECK_PAGE_FILE, CHECK_PATH } from "../htaccess.ts";
import { startTestServer } from "../extension/test-page/serve.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PDF = path.join(ROOT, "fixtures/p6/p6-t01-rect-over-name.pdf");
const args = process.argv.slice(2);
const shotsDir = args.includes("--shots") ? path.resolve(args[args.indexOf("--shots") + 1]) : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const chromePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(
  (p) => p && existsSync(p),
);
if (!chromePath) {
  console.error("Chrome が見つかりません。CHROME_PATH で場所を指定してください。");
  process.exit(2);
}
if (!existsSync(path.join(ROOT, "dist", CHECK_PAGE_FILE))) {
  console.error("dist/ がありません。先に npm run build をしてください。");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "  ok " : "  NG "} ${label}${detail ? `（${detail}）` : ""}`);
  if (!ok) failed++;
}

// ---- 手元のサーバー：確かめのページと、要求の受け口（中身は捨てる）
const testServer = await startTestServer();
const testUrl = `http://127.0.0.1:${testServer.address().port}/`;

const preview = await (await import("vite")).preview({ root: ROOT, logLevel: "silent", preview: { host: "127.0.0.1", port: 0, strictPort: false, open: false } });
const appUrl = new URL(CHECK_PATH, preview.resolvedUrls.local[0]).href;

// ---- Chrome（pipe でつなぐ）
const profile = mkdtempSync(path.join(tmpdir(), "omamori-ext-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
);
const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];
let seq = 0;
const waiting = new Map();
let buf = Buffer.alloc(0);
fromChrome.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let i;
  while ((i = buf.indexOf(0)) >= 0) {
    const msg = JSON.parse(buf.subarray(0, i).toString("utf8"));
    buf = buf.subarray(i + 1);
    if (msg.id && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(`${w.method}: ${msg.error.message}`));
      else w.resolve(msg.result);
    }
  }
});
function send(method, params = {}, sessionId) {
  const id = ++seq;
  toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, method });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), reject(new Error(`${method}: 時間切れ`))), 30000);
  });
}

async function openPage(url) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  await send("Page.navigate", { url }, sessionId);
  for (let i = 0; i < 300 && (await evaluate("document.readyState")) !== "complete"; i++) await sleep(100);
  return { targetId, sessionId, evaluate };
}

async function shot(sessionId, name) {
  if (!shotsDir) return;
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  const file = path.join(shotsDir, name);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  （スクリーンショット：${file}）`);
}

try {
  const { id: extId } = await send("Extensions.loadUnpacked", { path: path.join(ROOT, "extension") });
  console.log(`拡張機能を入れました：${extId}`);

  // 拡張機能の本体（service worker）につなぎ、タブごとの数を読む
  let swSession = null;
  for (let i = 0; i < 50 && !swSession; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
    if (sw) swSession = (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).sessionId;
    else await sleep(100);
  }
  if (!swSession) throw new Error("拡張機能の service worker が見つかりません");
  const states = async () => {
    await sleep(600); // 本体は 150ms ごとにまとめて書く
    const r = await send("Runtime.evaluate", { expression: "chrome.storage.session.get(null)", returnByValue: true, awaitPromise: true }, swSession);
    return Object.values(r.result.value ?? {});
  };
  const stateFor = async (origin) => (await states()).find((s) => s.pageOrigin === origin);

  // 1. 検査器を開く
  console.log(`\n1. 検査器を開く：${appUrl}`);
  const app = await openPage(appUrl);
  await sleep(500);
  const appOrigin = new URL(appUrl).origin;
  let s = await stateFor(appOrigin);
  check("数の入れ物がある", Boolean(s));
  check("PDF を入れる前は「待っています」", s?.phase === "waiting", `phase=${s?.phase}`);
  check("ページを開いた時の読み込みを数えた（数には入れない）", (s?.before ?? 0) > 0, `${s?.before} 件`);
  const overlay = await app.evaluate("Boolean(document.querySelector('omamori-traffic'))");
  check("ページの隅の表示がある", overlay === true);
  await shot(app.sessionId, "ext-1-waiting.png");

  // 2. PDF を入れる
  console.log(`\n2. 合成 PDF を入れる：${path.relative(ROOT, PDF)}`);
  const { root } = await send("DOM.getDocument", {}, app.sessionId);
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" }, app.sessionId);
  await send("DOM.setFileInputFiles", { nodeId, files: [PDF] }, app.sessionId);
  for (let i = 0; i < 150; i++) {
    await sleep(200);
    if ((await app.evaluate("document.getElementById('workspace')?.dataset.state")) === "result") break;
  }
  await sleep(2000);
  check("ページが合図を出した", (await app.evaluate("document.documentElement.dataset.omamoriPdf")) === "1");
  s = await stateFor(appOrigin);
  check("数え始めた（PDF の合図）", s?.phase === "counting" && s?.startedBy === "pdf", `phase=${s?.phase} startedBy=${s?.startedBy}`);
  check("PDF を入れたあとに送った要求が 0 件", s?.sent.count === 0, `${s?.sent.count} 件・${s?.sent.bytes} B`);
  console.log(`     このサイトから読み込んだ部品：${s?.loaded.count} 件（${(s?.recent ?? []).map((r) => r.where).join("、")}）`);
  await shot(app.sessionId, "ext-2-after-pdf.png");

  // 3. 確かめのページで、わざと要求を出す
  console.log(`\n3. 確かめのページ：${testUrl}`);
  const t = await openPage(testUrl);
  await sleep(300);
  const testOrigin = new URL(testUrl).origin;
  s = await stateFor(testOrigin);
  check("合図の前は「待っています」", s?.phase === "waiting");
  const click = async (id) => {
    await t.evaluate(`document.getElementById('${id}').click()`);
    await sleep(400);
  };
  await click("post");
  s = await stateFor(testOrigin);
  check("合図の前の要求は、送った数に入れない", s?.phase === "waiting" && s?.sent.count === 0, `before=${s?.before}`);
  await click("signal");
  for (const id of ["post", "cross", "beacon", "image", "load"]) await click(id);
  await sleep(500);
  s = await stateFor(testOrigin);
  check("数え始めた", s?.phase === "counting" && s?.startedBy === "pdf");
  check("送った要求が 4 件（POST・別サイトへの POST・beacon・? つきの画像）", s?.sent.count === 4, `${s?.sent.count} 件`);
  check("送ったデータが本文の合計（3300 B）より大きい", (s?.sent.bytes ?? 0) > 3300, `${s?.sent.bytes} B`);
  check("? なしの GET は「読み込み」に数える", s?.loaded.count === 1, `${s?.loaded.count} 件`);
  const cross = (s?.recent ?? []).find((r) => r.where.startsWith("http://localhost:"));
  check("別のサイトへの要求も見える", Boolean(cross), cross?.where ?? "");
  await shot(t.sessionId, "ext-3-test-page.png");
  if (shotsDir) {
    // ポップアップを、確かめのページのタブの数でタブとして開いて撮る
    const r = await send("Runtime.evaluate", { expression: `chrome.tabs.query({ url: "${testUrl}*" }).then((t) => t[0]?.id)`, returnByValue: true, awaitPromise: true }, swSession);
    const popup = await openPage(`chrome-extension://${extId}/popup.html?tab=${r.result.value}`);
    await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 640, deviceScaleFactor: 1, mobile: false }, popup.sessionId);
    await sleep(500);
    await shot(popup.sessionId, "ext-4-popup.png");
  }

  // 4. もう1つ PDF の合図を出しても、数は消えない
  await click("signal");
  const s2 = await stateFor(testOrigin);
  check("2 つめの合図で数を消さない", s2?.sent.count === s?.sent.count, `${s2?.sent.count} 件`);
} catch (e) {
  console.error(e);
  failed++;
} finally {
  try {
    await send("Browser.close");
  } catch {
    chrome.kill();
  }
  await preview.close();
  testServer.close();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome が閉じきる前は消せないことがある
  }
}

console.log(failed ? `\n失敗：${failed} 件` : "\nすべて通りました");
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// 「1回の指示で作った版」を、fixtures/ の合成 PDF にかけ、その版の生の結果を JSON に書き出す（手順は ADAPTER.md）。
//   node baseline/one_prompt/run-baseline.mjs --app <その版のフォルダ> [--out <書き出し先>] [--browser <chrome.exe>] [--only p6]
//   その版のフォルダは、環境変数 ONE_PROMPT_APP_DIR でも渡せる（手元のパスはリポジトリに書かない）。
//
// しくみ：
// - その版のフォルダは読むだけ。ファイルは、この道具の中の小さな配信（127.0.0.1 だけ）で、そのまま返す。
// - ただし app.js だけは、末尾に「結果を取り出す口」（HOOK）を足して返す（ディスクのファイルは変えない）。
//   その版の analyze() をそのまま呼び、終わったあとの状態（current）を写すだけ。判定には手を入れない。
// - ブラウザは頭なしの Chrome（または Edge）。操作は Chrome DevTools Protocol を、Node の標準の WebSocket で送る（ライブラリは足さない）。
// - パスワードを聞く窓（prompt）が出たら「キャンセル」する（その版の利用者が入力しないのと同じ）。
// 書き出し：<out>/raw/<型>/<合成PDFの名前>.json。合成 PDF の字（架空の名前）を含むので、.tmp/ の下に置き、コミットしない。

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TYPES = ["p1", "p9", "p5", "p7", "p6"];
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APP = arg("--app") ?? process.env.ONE_PROMPT_APP_DIR;
const OUT = path.resolve(arg("--out") ?? path.join(ROOT, ".tmp", "one-prompt"));
const ONLY = arg("--only");
const PER_FILE_MS = 180_000;
if (!APP || !existsSync(path.join(APP, "app.js")) || !existsSync(path.join(APP, "index.html"))) {
  console.error("その版のフォルダ（app.js と index.html があるもの）を --app か ONE_PROMPT_APP_DIR で渡してください");
  process.exit(1);
}
const BROWSER =
  arg("--browser") ??
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!BROWSER) {
  console.error("Chrome か Edge が見つかりません。--browser で場所を渡してください");
  process.exit(1);
}

// ---------- その版の app.js の末尾に足す口 ----------
// その版のモジュールの中で動くので、analyze・loadPdf・current をそのまま使える。
// analyzePage と同じ式で viewport を作り直すのは、描画の座標（画素）をページの座標（ポイント）に戻すため。
const HOOK = `
;window.__omamoriRun = async (b64, name) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  current = null;
  await analyze(new File([bytes], name, { type: 'application/pdf' }));
  if (!current) return { ok: false, status: document.getElementById('status')?.textContent || '' };
  const s = current;
  const vps = [];
  let attachments = [];
  try {
    const pdf = await loadPdf(bytes.slice(), false);
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 2200 / Math.max(vp1.width, vp1.height));
      vps.push({ n, transform: Array.from(page.getViewport({ scale }).transform) });
      page.cleanup();
    }
    const att = await pdf.getAttachments();
    attachments = att ? Object.entries(att).map(([k, a]) => ({ filename: a.filename || k })) : [];
    await pdf.destroy();
  } catch (e) { vps.push({ error: String(e && e.message || e) }); }
  return {
    ok: true,
    numPages: s.numPages,
    findings: s.findings.map((f) => ({ level: f.level, title: f.title, items: f.items })),
    metaRows: s.metaRows,
    attachments,
    vps,
    pages: s.pages.map((p) => ({
      n: p.n, error: p.error || null,
      marks: p.marks, dark: p.dark, flat: p.flat, off: p.off, tiny: p.tiny,
      images: p.images.map((im) => ({ regions: im.regions, size: im.size })),
      annots: p.annots.map((a) => ({ ...a, file: a.file ? { filename: a.file.filename || '', size: a.file.content ? a.file.content.length : 0 } : null })),
    })),
  };
};
`;

// ---------- その版のファイルを返す、小さな配信（127.0.0.1 だけ） ----------
const TYPES_MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".ttf": "font/ttf" };
const appRoot = path.resolve(APP);
const server = createServer((req, res) => {
  try {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(appRoot, rel);
    if (!file.startsWith(appRoot + path.sep) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    let body = readFileSync(file);
    if (rel === "app.js") body = Buffer.concat([body, Buffer.from(HOOK, "utf8")]);
    res.writeHead(200, { "content-type": TYPES_MIME[path.extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const appUrl = `http://127.0.0.1:${server.address().port}/index.html`;

// ---------- ブラウザ ----------
const profile = path.join(OUT, "browser-profile");
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const browser = spawn(BROWSER, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-pings",
  "--disable-default-apps", "--metrics-recording-only", "about:blank",
], { stdio: "ignore" });
let wsPath = null;
for (let k = 0; k < 100 && !wsPath; k++) {
  await sleep(100);
  const f = path.join(profile, "DevToolsActivePort");
  if (existsSync(f)) {
    const [port, p] = readFileSync(f, "utf8").split(/\r?\n/);
    if (port && p) wsPath = `ws://127.0.0.1:${port}${p}`;
  }
}
if (!wsPath) throw new Error("ブラウザの操作の口が開かなかった");

const ws = new WebSocket(wsPath);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  } else if (m.method) for (const l of listeners) l(m);
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
let dialogs = 0;
listeners.push((m) => {
  if (m.sessionId === sessionId && m.method === "Page.javascriptDialogOpening") {
    dialogs++;
    send("Page.handleJavaScriptDialog", { accept: false }, sessionId).catch(() => {});
  }
});
const loadApp = async () => {
  const loaded = new Promise((r) => listeners.push(function f(m) {
    if (m.sessionId === sessionId && m.method === "Page.loadEventFired") { listeners.splice(listeners.indexOf(f), 1); r(); }
  }));
  await send("Page.navigate", { url: appUrl }, sessionId);
  await loaded;
  for (let k = 0; k < 50; k++) {
    const r = await send("Runtime.evaluate", { expression: "typeof window.__omamoriRun", returnByValue: true }, sessionId);
    if (r.result.value === "function") return;
    await sleep(100);
  }
  throw new Error("その版の app.js が読み込めなかった");
};

// ---------- 合成 PDF ごとに動かす ----------
// --file <PDF> を付けたときは、その1つだけにかけ、<out>/raw/file/ に書く（道具が動くかを、その版に付いてきた試しの PDF で確かめるため）
const ONE_FILE = arg("--file");
const jobs = ONE_FILE
  ? [{ type: "file", dir: path.dirname(path.resolve(ONE_FILE)), files: [path.basename(ONE_FILE)] }]
  : TYPES.filter((t) => !ONLY || t === ONLY).map((t) => {
      const dir = path.join(ROOT, "fixtures", t);
      return { type: t, dir, files: readdirSync(dir).filter((f) => f.endsWith(".pdf")).sort() };
    });
const summary = [];
for (const { type, dir, files } of jobs) {
  const outDir = path.join(OUT, "raw", type);
  mkdirSync(outDir, { recursive: true });
  let ok = 0, failed = 0;
  for (const file of files) {
    await loadApp(); // 1つごとに開き直す（前の結果を持ち越さない）
    dialogs = 0;
    const b64 = readFileSync(path.join(dir, file)).toString("base64");
    const t0 = Date.now();
    let out;
    try {
      const r = await Promise.race([
        send("Runtime.evaluate", { expression: `window.__omamoriRun(${JSON.stringify(b64)}, ${JSON.stringify(file)})`, awaitPromise: true, returnByValue: true }, sessionId),
        sleep(PER_FILE_MS).then(() => ({ timeout: true })),
      ]);
      if (r.timeout) out = { ok: false, timeout: true };
      else if (r.exceptionDetails) out = { ok: false, exception: r.exceptionDetails.exception?.description?.split("\n")[0] ?? "例外" };
      else out = r.result.value;
    } catch (e) {
      out = { ok: false, exception: String(e?.message ?? e) };
    }
    out.passwordPrompts = dialogs;
    out.ms = Date.now() - t0;
    writeFileSync(path.join(outDir, file.replace(/\.pdf$/, ".json")), JSON.stringify(out, null, 2) + "\n");
    out.ok ? ok++ : failed++;
  }
  summary.push(`${type}：${ok + failed} 個（結果あり ${ok}、開けなかった・止まった ${failed}）`);
  console.log(summary.at(-1));
}

await send("Browser.close").catch(() => {});
ws.close();
server.close();
browser.kill();
console.log(`生の結果を ${path.relative(ROOT, path.join(OUT, "raw"))} に書いた`);

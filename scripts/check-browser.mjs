// SPDX-License-Identifier: AGPL-3.0-only
//
// ビルドした画面（dist/）を本物のブラウザで開き、合成 PDF（fixtures/）を入れて、外への要求が0件であることを確かめる。
// PDF.js の中の通信のコードを許す条件の1つ（docs/no-network.md）。
//
//   npm run build && npm run check:browser                  … 確かめるだけ
//   npm run check:browser -- --shots <フォルダ>              … スクリーンショットも撮る
//   npm run check:browser -- <PDF のパス>...                  … 入れる PDF を変える（既定は下の DEFAULT_PDFS）
//   npm run check:browser -- --self-test                     … 数える仕組みの点検。わざと外へ要求を出し、失敗になることを確かめる
//   npm run check:browser -- --url https://omamoripdf.com/   … vite preview の代わりに、配信したサイト（本番）を開く（docs/deploy.md）
//   npm run check:browser -- --no-sanitize                   … 「片付ける」を押さない（検査だけを確かめる）
//
// - 既定では、検査のあとに「片付ける」を押し、読み直すまで待ち、「片付けた PDF を保存する」を押して、保存された PDF を確かめる。
//   片付け・読み直し・保存の間の要求も数える。保存先は一時フォルダで、終わったら消す。
//
// - Chrome（または Edge）を headless で動かし、DevTools の決まり（CDP）で操作する。場所は CHROME_PATH で変えられる。
// - 数えるもの：ページを開いてから閉じるまでの、すべての要求（CSP で止められた要求も数える）。
//   同じサイト（127.0.0.1 の vite preview）と blob:・data: 以外への要求が1件でもあれば、失敗にする。
// - 要求は「最初の表示」（PDF を入れる前）と「PDF を入れた後」に分けて数える。アクセス解析のスクリプトは入れていないので、
//   どちらも外への要求は0件のはず（開いた回数は、配信先のサーバーの記録で数える。docs/no-network.md）。
// - サイトのページ（記事の一覧・各記事・プライバシー。dist/ の HTML から拾う）も1つずつ開き、外への要求が0件で、
//   CSP の違反・console のエラーがなく、200 で返ることを確かめる（--self-test のときは省く）。
// - 待ち時間とやり直し（CI や重いページで、たまに落ちていたため）：
//   - Chrome の DevTools：待ち受けの番号は Chrome に選ばせ、最大 60 秒待つ。つながらなければ、Chrome を立て直して 3 回までやり直す。
//   - 保存：Chrome の保存の知らせ（completed）と大きさがそろうまで、最大 60 秒待つ。だめなら 3 回まで押し直す。
//     それでも保存できなければ、その PDF をページから開き直して、3 回までやり直す。
//   - やり直す前の回の要求も、すべて合計に入れる。外への要求・止められた要求が出た回は、やり直さずに失敗にする。
//     途中で例外になった回もやり直さない（数え損ねないため）。
// - このスクリプト自身は、手元の Chrome と話すために通信を使う（検査器のコードではない。dist/ には入らない）。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_PDFS = [
  "fixtures/p6/p6-t01-rect-over-name.pdf",
  "fixtures/p6/p6-m01-two-pages.pdf",
  "fixtures/p6/p6-e01-encrypted-empty-userpw.pdf",
  "fixtures/p6/p6-h01-heavy-page.pdf",
  "fixtures/p6/p6-n01-text-removed.pdf",
  "fixtures/p5/p5-25-encrypted-user-password.pdf",
];

const args = process.argv.slice(2);
let shotsDir = null;
let selfTest = false;
let liveUrl = null;
let sanitize = true;
const pdfs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--shots") shotsDir = path.resolve(args[++i]);
  else if (args[i] === "--self-test") selfTest = true;
  else if (args[i] === "--url") liveUrl = new URL(args[++i]).href;
  else if (args[i] === "--no-sanitize") sanitize = false;
  else pdfs.push(path.resolve(args[i]));
}
if (!pdfs.length) pdfs.push(...DEFAULT_PDFS.slice(0, selfTest ? 1 : undefined).map((p) => path.join(ROOT, p)));
if (!liveUrl && !existsSync(path.join(ROOT, "dist", "index.html"))) {
  console.error("dist/ がありません。先に npm run build を実行してください。");
  process.exit(1);
}
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const chromePath = CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error("Chrome が見つかりません。CHROME_PATH で場所を指定してください。");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// --url のときは、手元の vite preview を立てずに、配信したサイトを開く
// vite は、手元の vite preview を立てるときだけ読み込む（本番を開く --url のときは要らない。配信のジョブでは npm を動かさず、vite を入れないため）
const server = liveUrl ? null : await (await import("vite")).preview({ root: ROOT, logLevel: "silent", preview: { host: "127.0.0.1", port: 0, strictPort: false, open: false } });
const appUrl = liveUrl ?? server.resolvedUrls.local[0];
const origin = new URL(appUrl).origin;

// 立ち上げのやり直しと、待つ時間（配信の直後の CI は遅いことがあるため、長めにとる）
const LAUNCH_TRIES = 3;
const LAUNCH_WAIT_MS = 60_000;
// 1つの PDF の確かめを、保存に失敗したときにやり直す回数。やり直す前の回の要求も、すべて数えに入れる
const PDF_TRIES = 3;
const SAVE_TRIES = 3;
const SAVE_WAIT_MS = 60_000;

const profiles = [];
let chrome = null;
let downloads = null;
let cdp = null;
let exitCode = 0;
try {
  let version = null;
  const launchErrors = [];
  for (let t = 1; t <= LAUNCH_TRIES && !cdp; t++) {
    try {
      ({ version, cdp } = await launch());
    } catch (e) {
      launchErrors.push(`${t} 回目：${e instanceof Error ? e.message : e}`);
      chrome?.kill();
      chrome = null;
      if (t < LAUNCH_TRIES) {
        console.error(`Chrome の DevTools につながりませんでした（${t} 回目）。立ち上げ直します。`);
        await sleep(2000);
      }
    }
  }
  if (!cdp) throw new Error(`Chrome の DevTools につながりませんでした（${LAUNCH_TRIES} 回。${launchErrors.join(" / ")}）`);
  const results = [];
  // やり直す前の回の結果。ここに外への要求・止められた要求があっても失敗にする（数え方を弱めない）
  const discarded = [];
  for (const pdf of pdfs) {
    for (let t = 1; t <= PDF_TRIES; t++) {
      // 途中で例外になった回はやり直さない（その回の要求を数え損ねるため。失敗のまま止める）
      const r = await checkOne(cdp, pdf);
      // やり直すのは「保存できなかった」ときだけ。外への要求・止められた要求があったときは、やり直さずに失敗として残す
      const retry = r.cleaned && r.cleaned.ok === false && !r.outside.length && !r.blocked.length && t < PDF_TRIES;
      if (!retry) {
        r.tries = t;
        results.push(r);
        break;
      }
      console.error(`${r.name}：片付けた PDF を保存できませんでした（${r.cleaned.saved}）。開き直してやり直します（${t + 1} 回目）。`);
      discarded.push(r);
    }
  }
  // サイトのページ（記事の一覧・各記事・プライバシー）も開き、外への要求が0件かを確かめる（点検のときは省く）
  const pages = [];
  if (!selfTest) for (const p of sitePagePaths()) pages.push(await checkPage(cdp, p));

  console.log(`\n画面：${appUrl}（${liveUrl ? "配信したサイト" : "vite preview。配信と同じヘッダー"}）`);
  console.log(`ブラウザ：${path.basename(chromePath)} ${version.Browser}`);
  for (const r of results) {
    console.log(`\n■ ${r.name}`);
    console.log(`  状態：${r.status}`);
    console.log(`  ページの絵：${r.drawn}`);
    if (r.cleaned) {
      console.log(`  片付け：${r.cleaned.status}`);
      if (r.cleaned.count) console.log(`  読み直し：${r.cleaned.count}`);
      console.log(`  保存：${r.cleaned.saved}${r.cleaned.saveTries > 1 ? `（${r.cleaned.saveTries} 回目で保存）` : ""}`);
      if (r.tries > 1) console.log(`  やり直し：${r.tries} 回目で通った`);
    }
    console.log(`  要求：全部で ${r.all.length} 件。同じサイト ${r.same.length} 件、外 ${r.outside.length} 件、CSP で止められた ${r.blocked.length} 件`);
    console.log(`    最初の表示：${r.first.all} 件（外 ${r.first.outside} 件・止められた ${r.first.blocked} 件）`);
    console.log(`    PDF を入れた後：${r.after.all} 件（同じサイト ${r.after.same} 件・外 ${r.after.outside} 件・止められた ${r.after.blocked} 件）`);
    for (const u of r.same) console.log(`    同じサイト：${u}`);
    for (const u of r.outside) console.log(`    外：${u}`);
    for (const b of r.blocked) console.log(`    CSP で止められた：${b}`);
    if (r.errors.length) console.log(`  console のエラー：${r.errors.join(" / ")}`);
    if (r.shot) console.log(`  スクリーンショット：${r.shot}`);
    if (r.cleanShot) console.log(`  スクリーンショット（片付けたあと）：${r.cleanShot}`);
  }
  if (pages.length) {
    console.log(`\n■ サイトのページ ${pages.length} 件`);
    for (const p of pages) {
      const bad = p.outside.length || p.blocked.length || p.errors.length || p.status !== 200;
      console.log(`  ${bad ? "×" : "○"} ${p.path}：状態 ${p.status}・要求 ${p.all.length} 件（外 ${p.outside.length} 件・止められた ${p.blocked.length} 件）`);
      for (const u of p.outside) console.log(`    外：${u}`);
      for (const b of p.blocked) console.log(`    CSP で止められた：${b}`);
      if (p.errors.length) console.log(`    console のエラー：${p.errors.join(" / ")}`);
    }
  }
  const pageProblems = pages.filter((p) => p.outside.length || p.blocked.length || p.errors.length || p.status !== 200);
  for (const r of discarded) {
    for (const u of r.outside) console.log(`  （やり直す前の回）${r.name} 外：${u}`);
    for (const b of r.blocked) console.log(`  （やり直す前の回）${r.name} CSP で止められた：${b}`);
  }
  if (discarded.length) console.log(`\nやり直した回：${discarded.length} 回（${discarded.map((r) => r.name).join("、")}）。その回の要求も合計に入れています。`);
  const tried = [...results, ...discarded];
  const outside = tried.reduce((n, r) => n + r.outside.length, 0) + pages.reduce((n, p) => n + p.outside.length, 0);
  const blocked = tried.reduce((n, r) => n + r.blocked.length, 0) + pages.reduce((n, p) => n + p.blocked.length, 0);
  const firstOutside = tried.reduce((n, r) => n + r.first.outside, 0);
  const afterOutside = tried.reduce((n, r) => n + r.after.outside, 0);
  console.log(`\n最初の表示：外への要求 ${firstOutside} 件（解析のスクリプトは入れていないので、0 のはず）`);
  console.log(`PDF を入れた後：外への要求 ${afterOutside} 件`);
  const notSaved = results.filter((r) => r.cleaned && r.cleaned.ok === false);
  console.log(`\n合計：PDF ${results.length} 件、外への要求 ${outside} 件、CSP で止められた要求 ${blocked} 件`);
  if (selfTest) {
    // 点検では、外への要求を捕まえられていれば成功
    if (outside > 0 || blocked > 0) console.log("点検：わざと出した外への要求を捕まえました（数える仕組みは動いています）。");
    else {
      console.error("点検の失敗：わざと出した外への要求を、捕まえられませんでした。");
      exitCode = 1;
    }
  } else if (outside > 0 || blocked > 0) {
    console.error("失敗：外への要求、または止められた要求がありました。");
    exitCode = 1;
  } else if (pageProblems.length) {
    console.error(`失敗：サイトのページが開けないか、console にエラーが出ました（${pageProblems.map((p) => p.path).join("、")}）。`);
    exitCode = 1;
  } else if (notSaved.length) {
    console.error(`失敗：片付けた PDF を保存できませんでした（${notSaved.map((r) => r.name).join("、")}）。`);
    exitCode = 1;
  } else {
    console.log("外への要求は0件でした。");
  }
} catch (e) {
  console.error(`確かめられませんでした：${e instanceof Error ? e.message : e}`);
  exitCode = 1;
} finally {
  cdp?.close();
  chrome?.kill();
  await server?.close();
  await sleep(300);
  for (const p of profiles) rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(exitCode);

// ---------------------------------------------------------------- CDP

/**
 * Chrome を立ち上げて、DevTools につなぐ。待ち受けの番号は Chrome に選ばせ（--remote-debugging-port=0）、
 * Chrome が書く DevToolsActivePort から読む（決めた番号だと、ほかのものとぶつかることがあるため）
 */
async function launch() {
  const profile = mkdtempSync(path.join(tmpdir(), "omamori-chrome-"));
  profiles.push(profile);
  downloads = path.join(profile, "downloads");
  mkdirSync(downloads);
  let exited = null;
  chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "about:blank"], { stdio: "ignore" });
  chrome.once("exit", (code) => (exited = code ?? "signal"));
  chrome.once("error", (e) => (exited = e.message));
  const portFile = path.join(profile, "DevToolsActivePort");
  const until = Date.now() + LAUNCH_WAIT_MS;
  let version = null;
  let last = "DevToolsActivePort ができませんでした";
  while (!version && Date.now() < until) {
    if (exited !== null) throw new Error(`Chrome が止まりました（${exited}）`);
    await sleep(250);
    if (!existsSync(portFile)) continue;
    const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
    if (!/^\d+$/.test(port)) continue;
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
    } catch (e) {
      last = `127.0.0.1:${port} から答えがありませんでした（${e?.cause?.code ?? e?.name ?? e}）`;
    }
  }
  if (!version) throw new Error(`${LAUNCH_WAIT_MS / 1000} 秒待ちました。${last}`);
  return { version, cdp: await connect(version.webSocketDebuggerUrl) };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("DevTools の WebSocket が開きませんでした")), 15_000);
    ws.addEventListener("open", () => (clearTimeout(timer), res()), { once: true });
    ws.addEventListener("error", () => (clearTimeout(timer), rej(new Error("DevTools の WebSocket につながりませんでした"))), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else for (const l of listeners) l(m);
  });
  return {
    send(method, params = {}, sessionId) {
      return new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      ws.close();
    },
  };
}

async function checkOne(c, pdf) {
  const name = path.basename(pdf);
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  const all = [];
  const blocked = [];
  const errors = [];
  // 新しくできる Worker（検査の Worker・PDF.js の Worker）にもつなぎ、その中の要求も数える
  const sessions = new Set([sessionId]);
  const off = c.on((m) => {
    if (m.method === "Target.attachedToTarget" && m.sessionId && sessions.has(m.sessionId)) {
      const child = m.params.sessionId;
      sessions.add(child);
      void c.send("Network.enable", {}, child).catch(() => {});
      void c.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
      return;
    }
    if (!sessions.has(m.sessionId)) return;
    if (m.method === "Network.requestWillBeSent") all.push(m.params.request.url);
    if (m.method === "Network.loadingFailed" && m.params.blockedReason) blocked.push(`${m.params.blockedReason}（${m.params.requestId}）`);
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push(m.params.entry.text);
    // fetch などは、CSP に止められると要求にならず、console の文だけが出る。その文も「止められた要求」に数える
    if (m.method === "Log.entryAdded" && /violates the following Content Security Policy/.test(m.params.entry.text)) {
      blocked.push(`console の CSP 違反：${m.params.entry.text.slice(0, 160)}`);
    }
  });
  try {
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    await c.send("Network.enable", {}, sessionId);
    await c.send("Runtime.enable", {}, sessionId);
    await c.send("Log.enable", {}, sessionId);
    await c.send("Page.enable", {}, sessionId);
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
    const evaluate = async (expr) => (await c.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId)).result.value;

    await c.send("Page.navigate", { url: appUrl }, sessionId);
    // 本番（--url）は遠いので、読み込みを最大 30 秒待つ
    for (let i = 0; i < 300 &&(await evaluate("document.readyState")) !== "complete"; i++) await sleep(100);
    await sleep(300); // 最初の表示のあとに遅れて出る要求も、最初の表示の分として数える
    // ここまでが「最初の表示」。ここから後が「PDF を入れた後」
    const firstAll = all.length;
    const firstBlocked = blocked.length;
    const { root } = await c.send("DOM.getDocument", {}, sessionId);
    const { nodeId } = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" }, sessionId);
    await c.send("DOM.setFileInputFiles", { nodeId, files: [pdf] }, sessionId);

    // 検査が終わり、大きなページを描き終えるまで待つ（描けないときは知らせの文が出る）
    let status = "";
    for (let i = 0; i < 300; i++) {
      await sleep(200);
      status = await evaluate("document.getElementById('status').textContent");
      const settled = await evaluate(
        "document.getElementById('sheet').dataset.drawn !== undefined || !document.getElementById('render-note').hidden || document.getElementById('sheet-wrap').hidden && !document.getElementById('status').textContent.startsWith('確かめています')",
      );
      if (!status.startsWith("確かめています") && settled) break;
    }
    if (selfTest) {
      // 点検：ページの中と Worker の中から、外へ要求を出してみる（CSP で止まるはず。止まっても数える）
      await evaluate("new Image().src = 'http://198.51.100.1/self-test.png'; fetch('http://198.51.100.1/self-test').catch(() => {}); void 0");
      await evaluate(
        `new Worker(URL.createObjectURL(new Blob(["fetch('http://198.51.100.1/self-test-worker').catch(() => {})"], { type: "text/javascript" }))); void 0`,
      );
    }
    await sleep(1500); // 縮小した絵を描く時間
    const drawn = await evaluate(
      "(() => { const d = document.getElementById('sheet').dataset.drawn; const n = document.getElementById('render-note'); return d === 'true' ? '描けた' : (n.hidden ? '描いていない' : n.textContent); })()",
    );

    let shot = null;
    if (shotsDir) shot = await screenshot(c, sessionId, evaluate, path.join(shotsDir, `${path.basename(pdf, ".pdf")}.png`));
    let cleaned = null;
    let cleanShot = null;
    if (sanitize && !selfTest) {
      cleaned = await pressSanitize(c, sessionId, evaluate, pdf);
      if (cleaned.pressed && shotsDir) {
        await sleep(1500); // 縮小した絵を描く時間
        cleanShot = await screenshot(c, sessionId, evaluate, path.join(shotsDir, `${path.basename(pdf, ".pdf")}-cleaned.png`));
      }
    }
    const local = (u) => u.startsWith(origin + "/") || u.startsWith("blob:") || u.startsWith("data:") || u === "about:blank";
    return {
      name,
      status,
      drawn,
      all,
      same: all.filter((u) => u.startsWith(origin + "/")).map((u) => u.slice(origin.length)),
      outside: all.filter((u) => !local(u)),
      blocked,
      // 最初の表示（PDF を入れる前）と、PDF を入れた後に分けた数
      first: { all: firstAll, outside: all.slice(0, firstAll).filter((u) => !local(u)).length, blocked: firstBlocked },
      after: {
        all: all.length - firstAll,
        same: all.slice(firstAll).filter((u) => u.startsWith(origin + "/")).length,
        outside: all.slice(firstAll).filter((u) => !local(u)).length,
        blocked: blocked.length - firstBlocked,
      },
      errors,
      shot: shot ? path.relative(ROOT, shot).replace(/\\/g, "/") : null,
      cleaned,
      cleanShot: cleanShot ? path.relative(ROOT, cleanShot).replace(/\\/g, "/") : null,
    };
  } finally {
    off();
    await c.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// ---------------------------------------------------------------- サイトのページ

/** dist/ の HTML から、サイトのページの場所（.html なし。本番の .htaccess と同じに、vite preview が .html のファイルを返す）を作る（index.html と、検索エンジンの確認のファイルは除く） */
function sitePagePaths() {
  const out = [];
  if (!existsSync(path.join(ROOT, "dist"))) return out;
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) walk(path.join(dir, name.name), r);
      else if (r.endsWith(".html") && r !== "index.html" && !/^google[0-9a-z]+\.html$/.test(r)) out.push(r.endsWith("/index.html") ? `/${r.slice(0, -"index.html".length)}` : `/${r.slice(0, -".html".length)}`);
    }
  };
  walk(path.join(ROOT, "dist"), "");
  return out.sort();
}

/** サイトのページを1つ開き、閉じるまでの要求を数える */
async function checkPage(c, pagePath) {
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  const all = [];
  const blocked = [];
  const errors = [];
  const off = c.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Network.requestWillBeSent") all.push(m.params.request.url);
    if (m.method === "Network.loadingFailed" && m.params.blockedReason) blocked.push(`${m.params.blockedReason}（${m.params.requestId}）`);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push(m.params.entry.text);
    if (m.method === "Log.entryAdded" && /violates the following Content Security Policy/.test(m.params.entry.text)) {
      blocked.push(`console の CSP 違反：${m.params.entry.text.slice(0, 160)}`);
    }
  });
  try {
    await c.send("Network.enable", {}, sessionId);
    await c.send("Log.enable", {}, sessionId);
    await c.send("Page.enable", {}, sessionId);
    const evaluate = async (expr) => (await c.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId)).result.value;
    await c.send("Page.navigate", { url: new URL(pagePath, appUrl).href }, sessionId);
    for (let i = 0; i < 300 &&(await evaluate("document.readyState")) !== "complete"; i++) await sleep(100);
    await sleep(500);
    const status = await evaluate("performance.getEntriesByType('navigation')[0]?.responseStatus ?? 0");
    const local = (u) => u.startsWith(origin + "/") || u.startsWith("blob:") || u.startsWith("data:") || u === "about:blank";
    return { path: pagePath, status, all, outside: all.filter((u) => !local(u)), blocked, errors };
  } finally {
    off();
    await c.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

async function screenshot(c, sessionId, evaluate, file) {
  const h = await evaluate("Math.ceil(document.documentElement.scrollHeight)");
  const w = await evaluate("Math.ceil(document.documentElement.clientWidth)");
  const { data } = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(h, 4000), scale: 1 } }, sessionId);
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

// ---------------------------------------------------------------- 3 片付ける → 4 読み直す → 保存

/** 「片付ける」を押し、読み直しが終わるまで待ち、保存のボタンを押して、保存された PDF を確かめる */
async function pressSanitize(c, sessionId, evaluate, pdf) {
  const can = await evaluate("(() => { const b = document.getElementById('sanitize'); return !b.disabled && !document.getElementById('actions').hidden; })()");
  if (!can) {
    const note = await evaluate("document.getElementById('actions').hidden ? '片付けるボタンが出ていません' : document.getElementById('sanitize-note').textContent");
    return { pressed: false, status: `押せない形でした（${note}）`, count: null, saved: "—", ok: null };
  }
  await evaluate("document.getElementById('sanitize').click(); void 0");
  const working = "(() => { const s = document.getElementById('status').textContent; return /^(片付けています|整えています|片付けた PDF を、最初から|整えた PDF を、最初から)/.test(s); })()";
  // 重いページ（h01）は、片付けと読み直しに時間がかかる。最大 180 秒待つ
  for (let i = 0; i < 900 && (await evaluate(working)); i++) await sleep(200);
  const status = await evaluate("document.getElementById('status').textContent");
  if (!(await evaluate("!document.getElementById('clean').hidden"))) return { pressed: true, status, count: null, saved: "保存のボタンが出ませんでした", ok: false };
  const count = await evaluate("document.getElementById('clean-count').textContent");
  const name = await evaluate("document.getElementById('download').download");

  // 保存：ブラウザの保存先を、押すたびに新しい一時フォルダにし、保存のボタンを押す。
  // ファイルが見えただけでは、書き終わっていないことがある（大きい PDF で、書きかけのファイルを読むと落ちる）。
  // そこで Chrome の保存の知らせ（Browser.downloadProgress の completed）を待ち、大きさが合うことを確かめてから読む
  let file = null;
  let why = "";
  let saveTries = 0;
  for (let t = 1; t <= SAVE_TRIES && !file; t++) {
    saveTries = t;
    const target = mkdtempSync(path.join(downloads, `${path.basename(pdf, ".pdf")}-`));
    await c.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: target, eventsEnabled: true });
    const got = await waitDownload(c, () => evaluate("document.getElementById('download').click(); void 0"));
    if (got.state !== "completed") {
      why = got.state === "canceled" ? "保存が取り消されました" : `${SAVE_WAIT_MS / 1000} 秒待っても、保存が終わりませんでした`;
    } else {
      // 知らせのあと、名前を付け替え終わるまで少し待つ
      for (let i = 0; i < 50 && !file; i++) {
        const done = readdirSync(target).filter((f) => !f.endsWith(".crdownload")).map((f) => path.join(target, f));
        file = done.find((f) => statSync(f).size === got.bytes) ?? null;
        if (!file) await sleep(100);
      }
      if (!file) why = `保存の知らせ（${got.bytes} バイト）と、ファイルの大きさが合いませんでした`;
    }
    if (!file && t < SAVE_TRIES) {
      console.error(`${path.basename(pdf)}：${why}。保存を押し直します（${t + 1} 回目）。`);
      await sleep(1000);
    }
  }
  if (!file) return { pressed: true, status, count, saved: `保存されませんでした（${SAVE_TRIES} 回。${why}）`, ok: false, saveTries };
  const bytes = readFileSync(file);
  const isPdf = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  const sameName = path.basename(file) === name;
  return {
    pressed: true,
    status,
    count,
    saved: `${sameName ? `「${name}」` : `名前が違う（${path.basename(file)}）`}・${bytes.length} バイト・${isPdf ? "%PDF- で始まる" : "PDF ではない"}`,
    ok: isPdf && sameName,
    saveTries,
  };
}

/** click() で保存を始め、Chrome の保存の知らせで、終わる（completed）か取り消される（canceled）まで待つ */
function waitDownload(c, click) {
  return new Promise((resolve) => {
    let guid = null;
    const finish = (v) => {
      clearTimeout(timer);
      off();
      resolve(v);
    };
    const timer = setTimeout(() => finish({ state: "timeout", bytes: 0 }), SAVE_WAIT_MS);
    const off = c.on((m) => {
      if (m.method === "Browser.downloadWillBegin" && guid === null) guid = m.params.guid;
      if (m.method === "Browser.downloadProgress" && m.params.guid === guid && m.params.state !== "inProgress") {
        finish({ state: m.params.state, bytes: m.params.receivedBytes });
      }
    });
    click().catch(() => finish({ state: "canceled", bytes: 0 }));
  });
}

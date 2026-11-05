// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査の画面（dist/ の index.html）を、いろいろな画面の大きさで本物のブラウザに開き、
// 見本の PDF で「入れる → 結果 → 黒塗りする所を選ぶ → 片付ける・読み直す → 小さくする → 保存」を通して、
// 崩れを数える。黒塗りする所は、片付ける前にしか選べないので、片付けるの前に置く。
// 見本の PDF には画像がなく、小さくしても変わらないため、大きな画像のある架空の PDF（ここで作る）でも、
// 片付ける → 小さくする → 小さくした PDF の保存のボタンまでを通す。仕組みは check-browser.mjs と同じ（Chrome の headless を DevTools の決まり＝CDP で動かす）。
//
//   npm run build && npm run check:layout                   … 数えて表にする（崩れがあっても止まらない）
//   npm run check:layout -- --shots .tmp/ux/shots           … 画面の写しも撮る
//   npm run check:layout -- --json .tmp/ux/layout.json      … 数えた中身を JSON で書く
//   npm run check:layout -- --only 390x844,1280x800         … 大きさをしぼる（名前は下の SIZES の name）
//   npm run check:layout -- --strict                        … 崩れが1つでもあれば、終わりのコードを 1 にする
//   npm run check:layout -- --self-test                     … 数える仕組みの点検（わざと崩した字のページで、どれも数えられるか）
//
// 数えるもの（どれも、その時に画面に出ているものだけ）：
// - 横のはみ出し：ページが横に動く幅（scrollWidth − 窓の幅）と、窓の右へはみ出した部品（切り抜く親のないもの）
// - 重なり：押せる所の真ん中に、ほかの部品がかぶっている（elementFromPoint で見る。見るために、その所まで動かす）
// - 切れる字：はみ出しを隠す箱で、中の字が箱より長い所（… で切る所も数える）
// - 小さすぎる押せる所：幅か高さが 44px 未満（文の中のリンクは別に数え、崩れには入れない）
// - 画面の外のボタン：大事なボタン（片付ける・保存する・小さくする など）が、窓の横の外にある。
//   押したあとに出るボタンが、そのとき見えている所の外に出たかも記録する（下へ何画面分か）
// - キーボード：決めた大きさで Tab を押して回り、順番と、フォーカスの印が見えるか（outline か box-shadow）を記録する
//
// - 拡大（200%・400%）は、幅と高さを 1/2・1/4 にし、画素の密度を 2・4 倍にして代わりに測る。
// - 文字だけを大きくした時は、ブラウザの標準の字の大きさ（Page.setFontSizes）を 16px → 32px にし、
//   html の字の大きさも倍にする（px で決めた字は、標準の字の設定では大きくならないため）。
//   あわせて「標準の字の設定だけで、html の字が変わったか」も記録する（fontSetting）。
// - 長い名前で崩れないかは、長いファイル名と長い文書情報の値を持つ架空の PDF を作って入れ、結果まで見る。
// - このスクリプト自身は、手元の Chrome と話すために通信を使う（検査器のコードではない。dist/ には入らない）。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { preview } from "vite";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIN_TARGET = 44;

/** 測る大きさ。zoom は拡大の代わり（幅・高さを割り、画素の密度を掛ける）。font は標準の字の大きさ */
const SIZES = [
  { name: "320x568", width: 320, height: 568, mobile: true },
  { name: "360x740", width: 360, height: 740, mobile: true },
  { name: "390x844", width: 390, height: 844, mobile: true, keys: true },
  { name: "414x896", width: 414, height: 896, mobile: true },
  { name: "768x1024", width: 768, height: 1024, mobile: true },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "1280x800", width: 1280, height: 800, keys: true },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1280x600-低い窓", width: 1280, height: 600 },
  { name: "844x390-横向き", width: 844, height: 390, mobile: true },
  { name: "拡大200%", width: 640, height: 400, scale: 2, note: "1280×800 を 200% に拡大した代わり" },
  { name: "拡大400%", width: 320, height: 200, scale: 4, note: "1280×800 を 400% に拡大した代わり" },
  { name: "字だけ大きく-1280x800", width: 1280, height: 800, font: 32, note: "標準の字を 16px → 32px" },
  { name: "字だけ大きく-390x844", width: 390, height: 844, mobile: true, font: 32, note: "標準の字を 16px → 32px" },
];

const args = process.argv.slice(2);
let shotsDir = null;
let jsonOut = null;
let strict = false;
let selfTest = false;
let only = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--shots") shotsDir = path.resolve(args[++i]);
  else if (args[i] === "--json") jsonOut = path.resolve(args[++i]);
  else if (args[i] === "--strict") strict = true;
  else if (args[i] === "--self-test") selfTest = true;
  else if (args[i] === "--only") only = args[++i].split(",");
}
if (!selfTest && !existsSync(path.join(ROOT, "dist", "index.html"))) {
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
const work = mkdtempSync(path.join(tmpdir(), "omamori-layout-"));
let chrome = null;
let cdp = null;
let server = null;
let exitCode = 0;

try {
  cdp = await launch();
  if (selfTest) {
    exitCode = await runSelfTest(cdp);
  } else {
    server = await preview({ root: ROOT, logLevel: "silent", preview: { host: "127.0.0.1", port: 0, strictPort: false, open: false } });
    const appUrl = server.resolvedUrls.local[0];
    const longPdf = await makeLongNamePdf();
    const scanPdf = await makeScanPdf();
    const results = [];
    for (const size of SIZES.filter((s) => !only || only.includes(s.name))) {
      process.stdout.write(`${size.name} … `);
      const r = await checkSize(cdp, appUrl, size, longPdf, scanPdf);
      results.push(r);
      console.log(`${r.problems} 件`);
    }
    printTable(results);
    if (jsonOut) {
      mkdirSync(path.dirname(jsonOut), { recursive: true });
      writeFileSync(jsonOut, JSON.stringify({ measuredAt: new Date().toISOString(), minTarget: MIN_TARGET, results }, null, 2));
      console.log(`\nJSON：${path.relative(ROOT, jsonOut).replace(/\\/g, "/")}`);
    }
    const total = results.reduce((n, r) => n + r.problems, 0);
    const broken = results.filter((r) => r.flowErrors.length);
    if (broken.length) {
      console.error(`\n失敗：流れを最後まで通せなかった大きさがあります（${broken.map((r) => r.name).join("、")}）。`);
      exitCode = 1;
    } else if (strict && total > 0) {
      console.error(`\n崩れが ${total} 件ありました（--strict）。`);
      exitCode = 1;
    } else {
      console.log(`\n崩れの合計：${total} 件（--strict のときだけ失敗にします）`);
    }
  }
} catch (e) {
  console.error(`確かめられませんでした：${e instanceof Error ? e.message : e}`);
  exitCode = 1;
} finally {
  cdp?.close();
  chrome?.kill();
  await server?.close();
  await sleep(300);
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(exitCode);

// ---------------------------------------------------------------- 1つの大きさ

async function checkSize(c, appUrl, size, longPdf, scanPdf) {
  const steps = [];
  const flowErrors = [];
  let keys = null;
  let fontSetting = null;
  // 見本の PDF で、流れを最後まで通す
  await withPage(c, size, async (p) => {
    await p.open(appUrl);
    fontSetting = p.fontSetting ?? null;
    steps.push(await p.measure("最初の表示"));
    await p.eval("document.getElementById('sample').click(); void 0");
    if (!(await p.waitInspected())) flowErrors.push("見本の PDF の検査が終わりませんでした");
    await sleep(1200); // ページの絵を描く時間
    steps.push(await p.measure("結果", { full: true }));
    if (size.keys) keys = await p.tabWalk(80);

    // 黒塗りする所を選ぶ（片付ける前だけ選べる）
    if (await p.eval("!document.getElementById('pick-tools').hidden")) {
      await p.eval("document.getElementById('pick-toggle').click(); void 0");
      await sleep(300);
      const dragged = await p.dragOnSheet();
      if (!dragged) flowErrors.push("ページの絵の上でドラッグできませんでした");
      await sleep(300);
      steps.push(await p.measure("黒塗りする所を選ぶ"));
      await p.eval("document.getElementById('pick-toggle').click(); void 0");
    } else flowErrors.push("「自分で黒塗りする所を選ぶ」が出ませんでした");

    // 片付ける → 読み直す
    if (await p.eval("!document.getElementById('sanitize').disabled && !document.getElementById('actions').hidden")) {
      await p.eval("document.getElementById('sanitize').click(); void 0");
      await p.waitWhile("(() => { const s = document.getElementById('status').textContent; return s.startsWith('片付けています') || s.startsWith('片付けた PDF を、最初から'); })()", 180_000);
      await sleep(1200);
      if (await p.eval("document.getElementById('clean').hidden")) flowErrors.push("片付けた結果が出ませんでした");
      steps.push(await p.measure("片付け・読み直し", { full: true }));
    } else flowErrors.push("「片付ける」を押せませんでした");

    // 小さくする
    if (await p.eval("!document.getElementById('compress').hidden")) {
      await p.eval("document.getElementById('compress-run').click(); void 0");
      await sleep(300);
      await p.waitWhile("document.getElementById('compress-run').disabled", 180_000);
      await sleep(500);
      steps.push(await p.measure("小さくする"));
    } else flowErrors.push("「ファイルを小さくする」が出ませんでした");

    // 保存（片付けた PDF）
    const target = mkdtempSync(path.join(work, "dl-"));
    await c.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: target });
    const canSave = await p.eval("!document.getElementById('download').hasAttribute('aria-disabled')");
    if (canSave) {
      await p.eval("document.getElementById('download').scrollIntoView({ block: 'center' }); document.getElementById('download').click(); void 0");
      await sleep(1000);
    } else flowErrors.push("「片付けた PDF を保存する」が押せない形でした");
    steps.push(await p.measure("保存"));
  });
  // 大きな画像のある架空の PDF（下の makeScanPdf）で、片付ける → 小さくする → 小さくした PDF の保存のボタンまで
  await withPage(c, size, async (p) => {
    await p.open(appUrl);
    await p.setFile(scanPdf);
    if (!(await p.waitInspected())) flowErrors.push("スキャンの PDF の検査が終わりませんでした");
    await sleep(800);
    if (!(await p.eval("!document.getElementById('sanitize').disabled && !document.getElementById('actions').hidden"))) {
      flowErrors.push("スキャンの PDF で「片付ける」を押せませんでした");
      return;
    }
    await p.eval("document.getElementById('sanitize').click(); void 0");
    await p.waitWhile("(() => { const s = document.getElementById('status').textContent; return s.startsWith('片付けています') || s.startsWith('片付けた PDF を、最初から'); })()", 180_000);
    await sleep(800);
    if (await p.eval("document.getElementById('compress').hidden")) {
      flowErrors.push("スキャンの PDF で「ファイルを小さくする」が出ませんでした");
      return;
    }
    await p.eval("document.getElementById('compress-run').click(); void 0");
    await sleep(300);
    await p.waitWhile("document.getElementById('compress-run').disabled", 180_000);
    await sleep(500);
    if (await p.eval("document.getElementById('compress-download').hidden")) flowErrors.push("スキャンの PDF で「小さくした PDF を保存する」が出ませんでした");
    steps.push(await p.measure("小さくした（画像のある PDF）", { full: true }));
  });
  // 長いファイル名と、長い文書情報の値の PDF（結果まで）
  await withPage(c, size, async (p) => {
    await p.open(appUrl);
    await p.setFile(longPdf);
    if (!(await p.waitInspected())) flowErrors.push("長い名前の PDF の検査が終わりませんでした");
    await sleep(1000);
    await p.eval("document.getElementById('props').open = true; void 0");
    await sleep(200);
    steps.push(await p.measure("長い名前の PDF の結果", { full: true }));
  });
  const problems = steps.reduce((n, s) => n + s.count, 0) + (keys ? keys.noFocusRing.length : 0);
  return { name: size.name, width: size.width, height: size.height, scale: size.scale ?? 1, font: size.font ?? 16, note: size.note ?? "", fontSetting, steps, keys, flowErrors, problems };
}

/** 新しいタブを開き、大きさを決めて、操作の道具を渡す。終わったら閉じる */
async function withPage(c, size, fn) {
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (m, params = {}) => c.send(m, params, sessionId);
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`ページの中で失敗：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  let shotNo = 0;
  const p = {
    eval: evalJs,
    async open(url) {
      await send("Page.navigate", { url });
      for (let i = 0; i < 300 && (await evalJs("document.readyState")) !== "complete"; i++) await sleep(100);
      // 字だけを大きく：ブラウザの標準の字（Page.setFontSizes）に加え、html の字の大きさも倍にする
      // （html が px で決めてあると、標準の字の設定では変わらないため。Firefox の「文字だけ拡大」に近い形）
      if (size.font) {
        const f = size.font / 16;
        p.fontSetting = await evalJs("getComputedStyle(document.documentElement).fontSize");
        await evalJs(`(() => { const h = document.documentElement; h.style.setProperty("font-size", parseFloat(getComputedStyle(h).fontSize) * ${f} + "px", "important"); })()`);
      }
      await sleep(300);
    },
    async setFile(file) {
      const { root } = await send("DOM.getDocument", {});
      const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" });
      await send("DOM.setFileInputFiles", { nodeId, files: [file] });
    },
    async waitInspected() {
      for (let i = 0; i < 300; i++) {
        await sleep(200);
        const done = await evalJs(
          "(() => { const s = document.getElementById('status').textContent; const settled = document.getElementById('sheet').dataset.drawn !== undefined || !document.getElementById('render-note').hidden || document.getElementById('sheet-wrap').hidden; return !s.startsWith('確かめています') && !s.startsWith('まだ PDF') && settled; })()",
        );
        if (done) return true;
      }
      return false;
    },
    async waitWhile(expr, ms) {
      const until = Date.now() + ms;
      while (Date.now() < until && (await evalJs(expr))) await sleep(200);
    },
    async dragOnSheet() {
      const r = await evalJs(
        "(() => { const s = document.getElementById('sheet'); s.scrollIntoView({ block: 'center' }); const b = s.getBoundingClientRect(); return b.width > 10 && b.height > 10 ? { x: b.left, y: b.top, w: b.width, h: b.height } : null; })()",
      );
      if (!r) return false;
      await sleep(200);
      const a = { x: r.x + r.w * 0.2, y: r.y + r.h * 0.2 };
      const b = { x: r.x + r.w * 0.45, y: r.y + r.h * 0.3 };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 5; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x + ((b.x - a.x) * i) / 5, y: a.y + ((b.y - a.y) * i) / 5, button: "left", buttons: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
      return true;
    },
    /** その時の画面を数え、写しを撮る */
    async measure(step, { full = false } = {}) {
      const m = await evalJs(`(${measureInPage.toString()})(${MIN_TARGET})`);
      const count = m.overflowX > 1 ? 1 + m.overflowEls.length : 0;
      const total = count + m.covered.length + m.clipped.length + m.small.length + m.offscreen.length;
      let shot = null;
      let fullShot = null;
      if (shotsDir) {
        const base = `${safe(size.name)}-${String(++shotNo).padStart(2, "0")}-${safe(step)}`;
        shot = await capture(send, path.join(shotsDir, `${base}.png`), false);
        if (full) fullShot = await capture(send, path.join(shotsDir, `${base}-全体.png`), true, evalJs);
      }
      return { step, ...m, count: total, shot: rel(shot), fullShot: rel(fullShot) };
    },
    /** Tab で回り、順番とフォーカスの印を記録する */
    async tabWalk(max) {
      // 検査の途中（Worker・絵を描く所）で、headless の窓のフォーカスが外れることがある。いったん切って入れ直す
      await c.send("Target.activateTarget", { targetId });
      await send("Page.bringToFront");
      await send("Emulation.setFocusEmulationEnabled", { enabled: false });
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await evalJs("window.focus(); window.scrollTo(0, 0); document.activeElement?.blur(); void 0");
      // 窓の左上の、押せる物のない所を一度押して、窓にフォーカスを渡す（Tab はここから始まる）
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 2, y: 2, button: "left", buttons: 1, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 2, y: 2, button: "left", buttons: 0, clickCount: 1 });
      await sleep(100);
      const order = [];
      for (let i = 0; i < max; i++) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        await sleep(60);
        const f = await evalJs(`(${focusInPage.toString()})()`);
        if (!f) break;
        if (order.length && f.desc === order[0].desc) break; // 一回りした
        order.push(f);
      }
      return { order, noFocusRing: order.filter((f) => !f.ring), outOfView: order.filter((f) => !f.inView) };
    },
  };
  try {
    await send("Page.enable");
    await send("Runtime.enable");
    // headless では窓にフォーカスが来ないので、来ている形にする（Tab で回るため）
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale ?? 1, mobile: !!size.mobile });
    if (size.font) await send("Page.setFontSizes", { fontSizes: { standard: size.font, fixed: Math.round(size.font * 0.8125) } });
    await fn(p);
  } finally {
    await c.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

function safe(s) {
  return s.replace(/[^\p{L}\p{N}x%-]+/gu, "_");
}
function rel(f) {
  return f ? path.relative(ROOT, f).replace(/\\/g, "/") : null;
}

async function capture(send, file, full, evalJs) {
  let params = { format: "png" };
  if (full) {
    const h = await evalJs("Math.ceil(document.documentElement.scrollHeight)");
    const w = await evalJs("Math.ceil(document.documentElement.clientWidth)");
    params = { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(h, 6000), scale: 1 } };
  }
  const { data } = await send("Page.captureScreenshot", params);
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

// ---------------------------------------------------------------- ページの中で動かす（文字列にして渡す）

/* 窓の中の崩れを数える。ここは Chrome の中で動く */
function measureInPage(minTarget) {
  const vw = document.documentElement.clientWidth;
  const vh = innerHeight;
  const IMPORTANT = ["sample", "sanitize", "pick-toggle", "download", "compress-run", "compress-download", "report-download"];
  const desc = (el) => {
    if (el.id) return `#${el.id}`;
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : "";
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 18);
    const holder = el.closest("[id]");
    return `${holder && holder !== el ? `#${holder.id} ` : ""}${el.tagName.toLowerCase()}${cls}${text ? `「${text}」` : ""}`;
  };
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  // 箱の外を隠す親（その中のはみ出しは、ページのはみ出しにならない）
  const clippedBy = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o !== "visible") return p;
    }
    return null;
  };
  const all = [...document.body.querySelectorAll("*")].filter(shown);

  // 横のはみ出し
  const overflowX = document.documentElement.scrollWidth - vw;
  const overflowEls = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 && !clippedBy(el) && !overflowEls.some((o) => o.el.contains(el))) overflowEls.push({ el, right: Math.round(r.right) });
  }

  // 押せる所
  const SEL = "a[href], a[download], button, input:not([type=hidden]), select, textarea, summary, label[for], [role=button], [tabindex]:not([tabindex='-1'])";
  const targets = [...document.querySelectorAll(SEL)].filter((el) => {
    if (el.matches("input[type=file]")) return false; // ファイルの欄は、まわりの label が押せる所
    if (el.matches("input[type=radio], input[type=checkbox]") && el.closest("label")) return false; // label ごと押せる
    return shown(el);
  });
  const isInline = (el) => el.tagName === "A" && getComputedStyle(el).display === "inline" && (el.parentElement?.textContent || "").trim().length > (el.textContent || "").trim().length + 4;
  const small = [];
  const inlineSmall = [];
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    if (r.width >= minTarget && r.height >= minTarget) continue;
    const it = { what: desc(el), w: Math.round(r.width), h: Math.round(r.height) };
    (isInline(el) ? inlineSmall : small).push(it);
  }

  // 重なり：押せる所の真ん中に、別の部品がかぶっていないか（見るために、その所まで動かす。終わったら戻す）
  const sx = scrollX;
  const sy = scrollY;
  const covered = [];
  for (const el of targets) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
    if (lab && (lab === hit || lab.contains(hit))) continue;
    covered.push({ what: desc(el), by: desc(hit) });
  }
  scrollTo(sx, sy);

  // 切れる字：はみ出しを隠す箱の中で、字が箱より長い
  const clipped = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.overflowX === "visible" && cs.textOverflow !== "ellipsis") continue;
    if (!(el.textContent || "").trim()) continue;
    if (el.scrollWidth > el.clientWidth + 1 && ["hidden", "clip"].includes(cs.overflowX)) clipped.push({ what: desc(el), over: el.scrollWidth - el.clientWidth });
  }

  // 大事なボタンの場所
  const buttons = [];
  const offscreen = [];
  for (const id of IMPORTANT) {
    const el = document.getElementById(id);
    if (!el || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    const inView = r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw;
    const b = { id, inView, screensDown: Math.round(((r.top + scrollY) / vh) * 10) / 10, w: Math.round(r.width), h: Math.round(r.height) };
    buttons.push(b);
    if (r.right > vw + 1 || r.left < -1) offscreen.push({ what: `#${id}`, left: Math.round(r.left), right: Math.round(r.right) });
  }

  // ページの絵と結果の並び（横に並ぶか、縦に積むか）
  const stage = document.querySelector(".stage")?.getBoundingClientRect();
  const results = document.getElementById("results")?.getBoundingClientRect();
  const arrangement =
    stage && results
      ? results.top >= stage.bottom - 4
        ? "縦に積む（ページの絵が上）"
        : stage.top >= results.bottom - 4
          ? "縦に積む（結果が上）"
          : results.left >= stage.right - 4
            ? "横に並ぶ"
            : "重なる"
      : "—";

  return {
    viewport: { w: vw, h: vh },
    pageHeight: document.documentElement.scrollHeight,
    overflowX: Math.max(0, overflowX),
    overflowEls: overflowEls.slice(0, 8).map((o) => ({ what: desc(o.el), right: o.right })),
    covered: covered.slice(0, 20),
    clipped: clipped.slice(0, 20),
    small: small.slice(0, 40),
    smallTotal: small.length,
    inlineSmall: inlineSmall.length,
    offscreen,
    buttons,
    arrangement,
    status: document.getElementById("status")?.textContent?.slice(0, 60) ?? "",
  };
}

/* いまのフォーカスの所と、印が見えるか。ここは Chrome の中で動く */
function focusInPage() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none");
  const r = el.getBoundingClientRect();
  const text = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("value") || "").replace(/\s+/g, " ").trim().slice(0, 24);
  const desc = `${el.id ? `#${el.id}` : el.tagName.toLowerCase()}${text ? `「${text}」` : ""}`;
  return { desc, ring: !!ring, inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < document.documentElement.clientWidth, x: Math.round(r.left), y: Math.round(r.top + scrollY) };
}

// ---------------------------------------------------------------- 長い名前の PDF（架空）

async function makeLongNamePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Kasou shinsei-sho (layout test)", { x: 60, y: 760, size: 16, font });
  // 文書情報に、切れ目のない長い値を入れる（架空）
  doc.setTitle("Kasou-no-tottemo-nagai-daimei-".repeat(6) + "owari");
  doc.setAuthor("Kasou Taro / " + "kakari-no-namae-".repeat(8));
  doc.setSubject("区切りのない長い主題".repeat(12));
  doc.setKeywords(["kasou", "x".repeat(120)]);
  const bytes = await doc.save({ useObjectStreams: false });
  const name = `${"とても長いファイルの名前_令和○年度_○○課_架空の申請書_最終版_修正済み".repeat(3)}.pdf`;
  const file = path.join(work, name);
  writeFileSync(file, bytes);
  return file;
}

/** A4・300dpi のスキャンに見立てた、大きな画像 1 枚の架空の PDF（小さくするのを試すため） */
async function makeScanPdf() {
  const w = 2480;
  const h = 3508;
  const canvas = createCanvas(w, h);
  const g = canvas.getContext("2d");
  g.fillStyle = "#f4f1ea";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#333";
  g.font = "64px sans-serif";
  for (let y = 300; y < h - 200; y += 120) g.fillText("Kasou no shinsei-sho  0000-0000", 200, y);
  // 紙のざらつき（小さくする余地を作る）
  for (let i = 0; i < 60000; i++) {
    g.fillStyle = `rgba(0,0,0,${(i % 7) / 60})`;
    g.fillRect((i * 7919) % w, (i * 104729) % h, 2, 2);
  }
  const jpg = canvas.toBuffer("image/jpeg", 95);
  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(jpg);
  const page = doc.addPage([595, 842]);
  page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  const file = path.join(work, "kasou-scan.pdf");
  writeFileSync(file, await doc.save({ useObjectStreams: false }));
  return file;
}

// ---------------------------------------------------------------- 表

function printTable(results) {
  console.log("\n| 大きさ | 流れ | 横のはみ出し | 重なり | 切れる字 | 小さすぎる押せる所 | 画面の外のボタン | フォーカスの印なし |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const max = (k) => Math.max(0, ...r.steps.map((s) => (k === "overflowX" ? s.overflowX : s[k].length)));
    const smallMax = Math.max(0, ...r.steps.map((s) => s.smallTotal));
    console.log(
      `| ${r.name} | ${r.flowErrors.length ? `× ${r.flowErrors.join("・")}` : "通った"} | ${max("overflowX")}px | ${max("covered")} | ${max("clipped")} | ${smallMax} | ${max("offscreen")} | ${r.keys ? `${r.keys.noFocusRing.length}/${r.keys.order.length}` : "—"} |`,
    );
  }
  console.log("（数は、手順ごとに数えたうちの多い方。小さすぎる押せる所に、文の中のリンクは入れていない）");
}

// ---------------------------------------------------------------- 点検

/** わざと崩したページで、どれも数えられるかを確かめる（数える仕組みが空振りしていないこと） */
async function runSelfTest(c) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="margin:0;font:16px sans-serif">
<div style="width:900px;height:20px;background:#ccc">はみ出す帯</div>
<button id="sanitize" style="position:relative;left:600px;width:120px;height:48px">画面の外</button>
<button style="width:20px;height:20px">小</button>
<div style="position:relative;height:60px"><button style="width:80px;height:50px">下</button><div style="position:absolute;left:0;top:0;width:100px;height:60px;background:#f00"></div></div>
<div style="width:80px;overflow:hidden;white-space:nowrap">切れる長い長い長い字の並び</div>
<button style="width:100px;height:50px;outline:none">印なし</button>
</body>`;
  const file = path.join(work, "self-test.html");
  writeFileSync(file, html);
  const url = `file:///${file.replace(/\\/g, "/")}`;
  let m = null;
  let keys = null;
  await withPage(c, { name: "点検", width: 390, height: 600, mobile: true }, async (p) => {
    await p.open(url);
    m = await p.eval(`(${measureInPage.toString()})(${MIN_TARGET})`);
    keys = await p.tabWalk(10);
  });
  const checks = [
    ["横のはみ出し", m.overflowX > 0 && m.overflowEls.length > 0],
    ["重なり", m.covered.length > 0],
    ["切れる字", m.clipped.length > 0],
    ["小さすぎる押せる所", m.small.length > 0],
    ["画面の外のボタン", m.offscreen.length > 0],
    ["フォーカスの印なし", keys.noFocusRing.length > 0],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? "○" : "×"} ${label}`);
  const bad = checks.filter(([, ok]) => !ok);
  if (bad.length) {
    console.error(`点検の失敗：数えられなかったもの（${bad.map(([l]) => l).join("、")}）`);
    return 1;
  }
  console.log("点検：わざと崩した所を、どれも数えられました。");
  return 0;
}

// ---------------------------------------------------------------- CDP（check-browser.mjs と同じ仕組み）

async function launch() {
  const profile = mkdtempSync(path.join(work, "chrome-"));
  let exited = null;
  chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "about:blank"], { stdio: "ignore" });
  chrome.once("exit", (code) => (exited = code ?? "signal"));
  chrome.once("error", (e) => (exited = e.message));
  const portFile = path.join(profile, "DevToolsActivePort");
  const until = Date.now() + 60_000;
  let version = null;
  while (!version && Date.now() < until) {
    if (exited !== null) throw new Error(`Chrome が止まりました（${exited}）`);
    await sleep(250);
    if (!existsSync(portFile)) continue;
    const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
    if (!/^\d+$/.test(port)) continue;
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
    } catch {
      // まだ立ち上がっていない
    }
  }
  if (!version) throw new Error("Chrome の DevTools につながりませんでした");
  return connect(version.webSocketDebuggerUrl);
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
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      return new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    close() {
      ws.close();
    },
  };
}

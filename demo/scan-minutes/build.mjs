// SPDX-License-Identifier: AGPL-3.0-only
//
// 動画の最初の場面で使う、合成の PDF を作る（中身はすべて架空。手順と出すものは demo/scan-minutes/README.md）。
//
//   node demo/scan-minutes/build.mjs
//
// 作り方：
// 1. 架空の市の会議録の 1 ページを HTML で組み、手元の Chrome（headless）で 1 枚の画像（JPEG）にする。
//    書体は、リポジトリの design/fonts/source/ の Noto Sans JP（端末の書体に頼らない）。
//    スキャンの見た目（わずかな傾き・紙の地の色むら・ノイズ）は CSS と SVG のフィルターで付ける（種を決めているので、毎回同じ）。
// 2. その画像をページ全体に置き、黒く塗った四角の注釈（Square）を、申請者の名前・住所・理由の上に重ねる（fixtures/p6/p6-i03 と同じ型）。
//    字の層は作らない。文書情報（作成者など）も書かない（P6 のほかの型を出さないため）。
// 3. 隅に「合成のテスト用PDF」と入れた版と、入れない版を出す。黒い四角を外した版（下が見える版）の画像と、四角の場所（boxes.json）も出す。
// 4. 大きい版（撮影で「3MB 以下」に縮める所を見せるため）：同じ組み方を 300 dpi・JPEG の質 95 で写し、参考資料の 2 ページを足した 3 ページの PDF。
//
// fixtures/ には入れない（採点に使う場所のため）。このスクリプト自身は、手元の Chrome と話すために通信を使う（検査器のコードではない）。

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument, PDFName } from "pdf-lib";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");
const FONT = path.join(ROOT, "design", "fonts", "source", "NotoSansJP[wght].ttf");

/** A4 を 150 dpi で：1240 × 1754 ピクセル。PDF のページは A4（595.28 × 841.89 pt） */
export const IMAGE = { width: 1240, height: 1754 };
export const PAGE = { width: 595.28, height: 841.89 };
/** 黒い四角を、字の外側にどれだけ広げるか（ピクセル） */
const PAD = 6;
const JPEG_QUALITY = 85;

/** 出すファイル（demo/scan-minutes/ の中） */
export const OUT = {
  pdf: "scan-minutes.pdf",
  pdfMarked: "scan-minutes-synthetic.pdf",
  image: "scan-minutes-uncovered.jpg",
  imageMarked: "scan-minutes-synthetic-uncovered.jpg",
  boxes: "boxes.json",
  large: "scan-minutes-large.pdf",
  largeMarked: "scan-minutes-large-synthetic.pdf",
};

/**
 * 大きい版（撮影で「3MB 以下」に縮める所を見せるため）：同じ会議録を 300 dpi・カラーの細かいスキャンにし、参考資料のページを足す。
 * 黒い四角の場所（PDF の pt）は、今の版と同じ。ファイルの大きさは、3MB（3,000,000 バイト）を超え、6MB 前後にする
 */
export const LARGE = { scale: 2, dpi: 300, pages: 3, quality: 95 };
/** 大きい版が超える大きさ（画面の「3MB 以下」と同じく、1MB＝1,000,000 バイトで数える。src/ui/compress-model.ts の SIZE_LIMITS） */
export const LARGE_MIN_BYTES = 3_000_000;

/** 黒い四角で塗る所（data-redact の値）。下の画像に写っている、架空の字 */
export const REDACTED = {
  name: "山田太郎",
  address: "星見台町1-2-3",
  reason: "理由：借金の返済のため",
};

/** 架空の市のマーク（自作の簡単な図形：丸の中に、白樺の幹 3 本と葉 1 枚） */
const MARK = `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
  <circle cx="32" cy="32" r="29" fill="none" stroke="#2c4a3a" stroke-width="4"/>
  <rect x="21" y="16" width="5" height="32" fill="#2c4a3a"/>
  <rect x="30" y="12" width="5" height="36" fill="#2c4a3a"/>
  <rect x="39" y="18" width="5" height="30" fill="#2c4a3a"/>
  <path d="M44 20 q10 -6 12 4 q-8 2 -12 -4z" fill="#2c4a3a"/>
</svg>`;

/** 大きい版の、2 ページめからの中身（会議録に付けた参考資料。架空。黒く塗る所はない） */
const EXTRA_PAGES = [
  {
    no: 4,
    body: `<h1 class="ref">参考資料1　白樺野市 生活支援資金 貸付要綱（抜粋）</h1>
  <h2>第1条（目的）</h2>
  <p>この要綱は、一時的に生活に困っている世帯に対し、生活支援資金を貸し付けることにより、その世帯の生活の安定を図ることを目的とする。</p>
  <h2>第2条（貸付の対象）</h2>
  <p>貸付の対象は、市内に住所を有し、次の各号のいずれにも当てはまる世帯とする。</p>
  <p class="say">(1) 申請の日の前の6か月の間に、収入が大きく減ったこと。</p>
  <p class="say">(2) 返済の計画を示すことができること。</p>
  <p class="say">(3) ほかの公的な貸付を、同じ目的で受けていないこと。</p>
  <h2>第3条（貸付の額）</h2>
  <p>貸付の額は、1世帯につき50万円を上限とし、審査会の意見を聴いて市長が決める。</p>
  <h2>第4条（返済）</h2>
  <p>返済は、貸付の日の翌月から始め、24回以内の分割で行う。利子は付けない。</p>
  <h2>第5条（審査会）</h2>
  <p>申請の審査のため、生活支援資金審査会を置く。審査会は、委員5名以内で組織する。</p>
  <p>審査会の会議録は、申請者の氏名・住所など、個人を特定できる情報を除いて公開する。</p>`,
  },
  {
    no: 5,
    body: `<h1 class="ref">参考資料2　審査の基準と、これまでの件数</h1>
  <h2>1 審査の基準</h2>
  <table>
    <tr><th>項目</th><td>確かめる内容</td></tr>
    <tr><th>収入の状況</th><td>収入が減った時期と、その理由が分かる書類があるか</td></tr>
    <tr><th>返済の計画</th><td>毎月の返済の額が、世帯の収入に比べて無理のない額か</td></tr>
    <tr><th>ほかの制度</th><td>ほかの給付・貸付を先に使えないか、案内したか</td></tr>
  </table>
  <h2>2 これまでの件数（令和8年度）</h2>
  <table>
    <tr><th>回</th><td>申請　承認　不承認</td></tr>
    <tr><th>第1回（6月）</th><td>2件　　2件　　0件</td></tr>
    <tr><th>第2回（8月）</th><td>3件　　2件　　1件</td></tr>
    <tr><th>第3回（10月）</th><td>1件　　1件　　0件</td></tr>
  </table>
  <h2>3 事務局から</h2>
  <p>申請の書類は、受け付けた日から5年間保存する。会議録を公開するときは、申請者の情報を黒く塗って伏せる。</p>`,
  },
];

/** n ページめ（0 から）の中身。0 は会議録（今の版と同じ）、1 から先は参考資料 */
function pageBody(n) {
  const r = (key) => `<span data-redact="${key}">${REDACTED[key]}</span>`;
  if (n > 0) {
    const p = EXTRA_PAGES[n - 1];
    return `<div class="sheet">
  <div class="head">${MARK}<span class="city">白樺野市</span><span class="dept">福祉課</span><span class="open">公開</span></div>
  ${p.body}
</div>
<div class="foot"><span>白樺野市 福祉課</span><span class="no">- ${p.no} -</span><span class="date">令和8年10月22日 公開</span></div>`;
  }
  return `<div class="sheet">
  <div class="head">${MARK}<span class="city">白樺野市</span><span class="dept">福祉課</span><span class="open">公開</span></div>
  <h1>第3回 白樺野市 生活支援資金審査会 会議録</h1>
  <table>
    <tr><th>日時</th><td>令和8年10月15日（木）午後2時から午後3時30分まで</td></tr>
    <tr><th>場所</th><td>白樺野市役所 本庁舎3階 第2会議室</td></tr>
    <tr><th>出席者</th><td>委員5名（委員長ほか4名）、事務局（福祉課）2名</td></tr>
    <tr><th>議題</th><td>(1) 生活支援資金の貸付の申請の審査について<br>(2) その他</td></tr>
  </table>
  <h2>1 審査の経過</h2>
  <p>事務局から、今回の審査の対象は、次の申請1件であることを説明した。</p>
  <table class="apply">
    <tr><th>申請番号</th><td>第12号</td></tr>
    <tr><th>申請者の氏名</th><td>${r("name")}</td></tr>
    <tr><th>住所</th><td>白樺野市${r("address")}</td></tr>
    <tr><th>申請の内容</th><td>${r("reason")}</td></tr>
    <tr><th>貸付の希望額</th><td>300,000円（12回の分割で返済）</td></tr>
  </table>
  <h2>2 主な意見</h2>
  <p class="say">委員長　申請の内容と、返済の計画について、意見はありますか。</p>
  <p class="say">委員　　返済の計画が示されており、毎月の額にも無理がないため、承認してよいと考えます。</p>
  <p class="say">委員　　事務局は、貸付の後も、返済の状況を確かめてください。</p>
  <p class="say">事務局　承知しました。</p>
  <h2>3 結果</h2>
  <p>第12号の申請を、全員の賛成で承認した。</p>
  <h2>4 その他</h2>
  <p>次回の審査会は、令和8年11月19日（木）に開くこととした。</p>
</div>
<div class="foot"><span>白樺野市 福祉課</span><span class="no">- 3 -</span><span class="date">令和8年10月22日 公開</span></div>`;
}

function html(marked, n = 0) {
  const font = pathToFileURL(FONT).href;
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<style>
@font-face { font-family: "Doc"; src: url("${font}"); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${IMAGE.width}px; height: ${IMAGE.height}px; overflow: hidden; }
body { font-family: "Doc", sans-serif; color: #26241f; background: #ece7da; position: relative; -webkit-font-smoothing: antialiased; }
/* 紙の地の色むら（明るい所と、少し黄ばんだ所）と、スキャナーのふちの影 */
.paper { position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 60% 45% at 30% 25%, rgba(255,253,246,0.9), rgba(255,253,246,0) 70%),
    radial-gradient(ellipse 55% 40% at 75% 70%, rgba(250,246,234,0.8), rgba(250,246,234,0) 70%),
    radial-gradient(ellipse 40% 30% at 85% 15%, rgba(226,214,186,0.35), rgba(226,214,186,0) 70%),
    linear-gradient(90deg, rgba(0,0,0,0.10), rgba(0,0,0,0) 2.5%, rgba(0,0,0,0) 97%, rgba(0,0,0,0.08));
}
/* 中身は、わずかに傾ける（紙を少し斜めに置いてスキャンした形） */
.sheet { position: absolute; left: 118px; top: 104px; width: 1004px; transform: rotate(0.45deg); transform-origin: 50% 0; }
.head { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #26241f; padding-bottom: 12px; }
.city { font-size: 30px; font-weight: 700; letter-spacing: 0.08em; }
.dept { font-size: 18px; margin-left: 6px; color: #3b3832; }
.open { margin-left: auto; border: 4px solid #b23a30; color: #b23a30; font-size: 30px; font-weight: 800; padding: 2px 16px; letter-spacing: 0.3em; transform: rotate(-3deg); opacity: 0.85; }
h1 { font-size: 30px; font-weight: 700; text-align: center; margin: 34px 0 26px; letter-spacing: 0.04em; }
table { width: 100%; border-collapse: collapse; font-size: 21px; }
th, td { border: 2px solid #3a3731; padding: 10px 14px; text-align: left; vertical-align: top; line-height: 1.55; }
th { width: 190px; font-weight: 600; background: rgba(0,0,0,0.03); }
h1.ref { font-size: 26px; text-align: left; margin: 30px 0 18px; }
h2 { font-size: 23px; font-weight: 700; margin: 30px 0 10px; }
p { font-size: 21px; line-height: 1.75; }
.say { margin-left: 1em; text-indent: -1em; }
.apply { margin-top: 12px; }
.apply td { font-size: 22px; }
.foot { position: absolute; left: 118px; right: 118px; top: 1640px; display: flex; font-size: 18px; color: #3b3832; transform: rotate(0.45deg); }
.foot .no { position: absolute; left: 0; right: 0; text-align: center; font-size: 20px; }
.foot .date { margin-left: auto; }
.synthetic { position: absolute; left: 40px; bottom: 26px; font-size: 15px; color: #6b675e; letter-spacing: 0.05em; display: ${marked ? "block" : "none"}; }
/* 紙のざらつき（ノイズ）。種を決めているので、毎回同じ模様になる */
.noise { position: absolute; inset: 0; opacity: 0.22; mix-blend-mode: multiply; pointer-events: none; }
</style></head>
<body>
<div class="paper"></div>
${pageBody(n)}
<div class="synthetic">合成のテスト用PDF（中身はすべて架空です）</div>
<svg class="noise" width="${IMAGE.width}" height="${IMAGE.height}" xmlns="http://www.w3.org/2000/svg">
  <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${7 + n}"/><feColorMatrix type="saturate" values="0"/></filter>
  <rect width="100%" height="100%" filter="url(#n)"/>
</svg>
</body></html>`;
}

// ---------------------------------------------------------------- Chrome（headless）で画像にする

const CHROME = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withChrome(fn) {
  const chromePath = CHROME.find((p) => existsSync(p));
  if (!chromePath) throw new Error("Chrome が見つかりません。CHROME_PATH で場所を指定してください。");
  const profile = mkdtempSync(path.join(tmpdir(), "omamori-demo-chrome-"));
  const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--allow-file-access-from-files", "--force-color-profile=srgb", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    let ws = null;
    for (let i = 0; i < 240 && !ws; i++) {
      await sleep(250);
      if (!existsSync(portFile)) continue;
      const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
      try {
        ws = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
      } catch {
        // まだ立ち上がっていない
      }
    }
    if (!ws) throw new Error("Chrome の DevTools につながりませんでした");
    const cdp = await connect(ws);
    try {
      return await fn(cdp);
    } finally {
      cdp.close();
    }
  } finally {
    chrome.kill();
    await sleep(500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("DevTools の WebSocket につながりませんでした")), { once: true });
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
    close: () => ws.close(),
  };
}

/**
 * HTML を開いて、JPEG の画像と、黒く塗る所の場所を返す。場所は、150 dpi の画像のピクセル（CSS の px）。
 * scale を 2 にすると、同じ組み方のまま、2 倍の細かさ（300 dpi）の画像にする
 */
async function render(cdp, marked, { page = 0, scale = 1, quality = JPEG_QUALITY } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), "omamori-demo-page-"));
  const file = path.join(work, "page.html");
  writeFileSync(file, html(marked, page));
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    const s = (m, p) => cdp.send(m, p, sessionId);
    await s("Emulation.setDeviceMetricsOverride", { width: IMAGE.width, height: IMAGE.height, deviceScaleFactor: scale, mobile: false });
    await s("Page.enable");
    await s("Page.navigate", { url: pathToFileURL(file).href });
    const evaluate = async (expression) => (await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
    for (let i = 0; i < 80 && (await evaluate("document.readyState")) !== "complete"; i++) await sleep(100);
    const font = await evaluate(`document.fonts.ready.then(() => [...document.fonts].map((f) => f.family + ":" + f.status).join(","))`);
    if (!/Doc:loaded/.test(font)) throw new Error(`書体を読み込めませんでした（${font}）`);
    const boxes = await evaluate(`[...document.querySelectorAll("[data-redact]")].map((el) => { const r = el.getBoundingClientRect(); return { key: el.dataset.redact, x: r.left, y: r.top, width: r.width, height: r.height }; })`);
    const { data } = await s("Page.captureScreenshot", { format: "jpeg", quality, clip: { x: 0, y: 0, width: IMAGE.width, height: IMAGE.height, scale: 1 } });
    return { jpeg: Buffer.from(data, "base64"), boxes };
  } finally {
    await cdp.send("Target.closeTarget", { targetId });
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- PDF にする

/** 黒く塗る所（ピクセル、上が 0）を、少し広げて整数にそろえる */
export function padBox(b) {
  const x = Math.floor(b.x - PAD), y = Math.floor(b.y - PAD);
  return { key: b.key, x, y, width: Math.ceil(b.x + b.width + PAD) - x, height: Math.ceil(b.y + b.height + PAD) - y };
}

/** ピクセル（上が 0）を、PDF の場所（pt、下が 0）の [左, 下, 右, 上] にする */
export function toPdfRect(b) {
  const sx = PAGE.width / IMAGE.width, sy = PAGE.height / IMAGE.height;
  const r = (v) => Math.round(v * 1000) / 1000;
  return [r(b.x * sx), r(PAGE.height - (b.y + b.height) * sy), r((b.x + b.width) * sx), r(PAGE.height - b.y * sy)];
}

/** jpeg：1 ページめの画像（1 枚）か、ページごとの画像の並び。黒い四角は 1 ページめにだけ重ねる */
async function buildPdf(jpeg, boxes) {
  // 文書情報（作成者・作成した道具・日時）を書かない。毎回同じ中身になり、P1 などのほかの型も出ない
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pages = [];
  for (const j of Array.isArray(jpeg) ? jpeg : [jpeg]) {
    const p = doc.addPage([PAGE.width, PAGE.height]);
    p.drawImage(await doc.embedJpg(j), { x: 0, y: 0, width: PAGE.width, height: PAGE.height });
    pages.push(p);
  }
  const page = pages[0];
  for (const b of boxes) {
    const rect = toPdfRect(b);
    const w = (rect[2] - rect[0]).toFixed(3), h = (rect[3] - rect[1]).toFixed(3);
    // 見た目（AP）：黒で塗った四角（fixtures/p6/p6-i03 と同じ型）。塗るだけで、線は引かない（枠の線 BS の太さも 0）。
    // 線を引くと、四角の外へ半分はみ出した細い帯ができ、整えるときに帯ごとに「済」の印が付いて、画面がにぎやかになるため
    const ap = doc.context.register(doc.context.stream(`0 g 0 0 ${w} ${h} re f`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, Number(w), Number(h)] }));
    const annot = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: rect, C: [0, 0, 0], IC: [0, 0, 0], BS: { W: 0 }, F: 4, AP: { N: ap } }));
    page.node.addAnnot(annot);
  }
  if (!page.node.get(PDFName.of("Annots"))) throw new Error("注釈を付けられませんでした");
  return doc.save({ useObjectStreams: false });
}

// ---------------------------------------------------------------- 出す

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { plain, marked, large, largeMarked } = await withChrome(async (cdp) => {
    const big = async (m) => {
      const out = [];
      for (let page = 0; page < LARGE.pages; page++) out.push(await render(cdp, m, { page, scale: LARGE.scale, quality: LARGE.quality }));
      return out;
    };
    return { plain: await render(cdp, false), marked: await render(cdp, true), large: await big(false), largeMarked: await big(true) };
  });
  const boxes = plain.boxes.map(padBox);
  // 隅の一言のあるなしで、黒く塗る所が動いていないこと
  if (JSON.stringify(marked.boxes.map(padBox)) !== JSON.stringify(boxes)) throw new Error("隅の一言のあるなしで、黒く塗る所の場所が変わりました");
  if (boxes.length !== Object.keys(REDACTED).length) throw new Error(`黒く塗る所が ${boxes.length} か所です（${Object.keys(REDACTED).length} か所のはず）`);
  writeFileSync(path.join(HERE, OUT.image), plain.jpeg);
  writeFileSync(path.join(HERE, OUT.imageMarked), marked.jpeg);
  writeFileSync(path.join(HERE, OUT.pdf), await buildPdf(plain.jpeg, boxes));
  writeFileSync(path.join(HERE, OUT.pdfMarked), await buildPdf(marked.jpeg, boxes));
  // 大きい版：黒く塗る所は、今の版と同じ場所（CSS の px で比べる。画像のピクセルは scale 倍）
  for (const [file, pages] of [
    [OUT.large, large],
    [OUT.largeMarked, largeMarked],
  ]) {
    if (JSON.stringify(pages[0].boxes.map(padBox)) !== JSON.stringify(boxes)) throw new Error(`${file}：黒く塗る所の場所が、今の版と違います`);
    if (pages.slice(1).some((p) => p.boxes.length)) throw new Error(`${file}：2 ページめから先に、黒く塗る所があります`);
    const bytes = await buildPdf(
      pages.map((p) => p.jpeg),
      boxes,
    );
    if (bytes.length <= LARGE_MIN_BYTES) throw new Error(`${file}：${bytes.length} バイトで、${LARGE_MIN_BYTES} バイトを超えていません`);
    writeFileSync(path.join(HERE, file), bytes);
  }
  const json = { image: IMAGE, page: PAGE, note: "x・y・width・height は画像のピクセル（左上が 0）。pdfRect は PDF の [左, 下, 右, 上]（pt、左下が 0）", boxes: boxes.map((b) => ({ ...b, pdfRect: toPdfRect(b) })) };
  writeFileSync(path.join(HERE, OUT.boxes), `${JSON.stringify(json, null, 2)}\n`);
  for (const f of Object.values(OUT)) console.log(`  demo/scan-minutes/${f}  ${readFileSync(path.join(HERE, f)).length} バイト`);
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// 拡張機能の本体（service worker）。見ているタブから出た要求を、webRequest で読み取るだけ（止めない・書き換えない）。
// - 数は、タブごとに、メモリの中（chrome.storage.session。ブラウザを閉じると消え、ディスクには書かない）にだけ置く。
//   service worker は止まることがあるので、メモリの変数だけでは数が消えてしまう。そのために session に写しを置く。
// - 外へは何も送らない（fetch などは使わない。tests/extension.test.ts で確かめる）。

import { addHeaders, addRequest, badgeText, isWatchedPage, newTabState, start, view } from "./count.js";

const COLOR_ZERO = "#2f6f5e"; // design/tokens.css の --color-ok
const COLOR_SENT = "#a3201b"; // --color-accent
const COLOR_WAIT = "#57534e"; // --color-muted

/** @type {Map<number, any>} */
const tabs = new Map();
/** 数えた要求の印（requestId → 印）。ヘッダーの分を足すためだけに、少しの間だけ持つ */
const marks = new Map();

const ready = chrome.storage.session.get(null).then((all) => {
  for (const [key, value] of Object.entries(all)) {
    const m = /^tab:(\d+)$/.exec(key);
    if (m && !tabs.has(Number(m[1]))) tabs.set(Number(m[1]), value);
  }
});

function save(tabId) {
  const state = tabs.get(tabId);
  if (state) void chrome.storage.session.set({ [`tab:${tabId}`]: state });
  else void chrome.storage.session.remove(`tab:${tabId}`);
}

let pending = new Set();
let timer = null;
/** 要求が続けて来たときに、表示を 1 回にまとめる */
function changed(tabId) {
  pending.add(tabId);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const ids = pending;
    pending = new Set();
    for (const id of ids) {
      save(id);
      show(id);
    }
  }, 150);
}

function show(tabId) {
  const state = tabs.get(tabId);
  const v = view(state);
  const color = v.tone === "zero" ? COLOR_ZERO : v.tone === "sent" ? COLOR_SENT : COLOR_WAIT;
  void chrome.action.setBadgeText({ tabId, text: state ? badgeText(state) : "" }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  void chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" }).catch(() => {});
  void chrome.tabs.sendMessage(tabId, { type: "omamori-view", view: v }).catch(() => {});
  void chrome.runtime.sendMessage({ type: "omamori-view", tabId, view: v, state }).catch(() => {});
}

function reset(tabId, url) {
  if (isWatchedPage(url)) tabs.set(tabId, newTabState(url));
  else tabs.delete(tabId);
  changed(tabId);
}

chrome.webRequest.onBeforeRequest.addListener(
  (req) => {
    if (req.tabId < 0) return;
    void ready.then(() => {
      if (req.type === "main_frame") {
        // ページを開き直した：数を消して、PDF を待つ
        reset(req.tabId, req.url);
        const fresh = tabs.get(req.tabId);
        if (fresh) fresh.before += 1;
        return;
      }
      const state = tabs.get(req.tabId);
      if (!state) return;
      const mark = addRequest(state, req);
      if (mark) marks.set(req.requestId, { tabId: req.tabId, mark });
      changed(req.tabId);
    });
  },
  { urls: ["<all_urls>"] },
  ["requestBody"],
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (req) => {
    void ready.then(() => {
      const m = marks.get(req.requestId);
      if (!m) return;
      marks.delete(req.requestId);
      const state = tabs.get(m.tabId);
      if (!state) return;
      addHeaders(state, m.mark, req.requestHeaders);
      changed(m.tabId);
    });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"],
);

for (const ev of [chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred]) {
  ev.addListener(
    (req) => {
      // ヘッダーを送る前に終わった要求（つながらなかったなど）の印を片付ける
      setTimeout(() => marks.delete(req.requestId), 5000);
    },
    { urls: ["<all_urls>"] },
  );
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(() => {
    tabs.delete(tabId);
    save(tabId);
  });
});

/** 拡張機能の中のページ（ポップアップ）からの頼みか。ページの隅の表示（content.js）からの頼みとは、送り元の URL で分ける */
function fromExtensionPage(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  void ready.then(() => {
    if (msg?.type === "omamori-hello" && sender.tab?.id != null) {
      // ページの隅の表示が始まった。拡張機能を入れる前から開いていたタブなら、ここで数え始めの入れ物を作る
      const tabId = sender.tab.id;
      if (!tabs.has(tabId) && isWatchedPage(sender.tab.url ?? "")) {
        tabs.set(tabId, newTabState(sender.tab.url ?? ""));
        save(tabId);
      }
      show(tabId);
      sendResponse({ view: view(tabs.get(tabId)) });
    } else if (msg?.type === "omamori-pdf" && sender.tab?.id != null) {
      // 検査のページが PDF を読み込んだ合図（ページの属性 data-omamori-pdf が変わった）
      const state = tabs.get(sender.tab.id);
      if (state && start(state, "pdf", Date.now())) changed(sender.tab.id);
      sendResponse({ ok: true });
    } else if (msg?.type === "omamori-reset" && typeof msg.tabId === "number" && fromExtensionPage(sender)) {
      // ポップアップの「今から数え直す」
      const state = tabs.get(msg.tabId);
      if (state) {
        start(state, "manual", Date.now());
        changed(msg.tabId);
      }
      sendResponse({ ok: Boolean(state) });
    } else if (msg?.type === "omamori-get" && typeof msg.tabId === "number" && fromExtensionPage(sender)) {
      sendResponse({ view: view(tabs.get(msg.tabId)), state: tabs.get(msg.tabId) ?? null });
    } else {
      sendResponse(null);
    }
  });
  return true;
});

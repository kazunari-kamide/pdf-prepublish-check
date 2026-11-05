// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの隅に、送ったデータの大きさを重ねて出す。見ているページ（manifest.json の matches）でだけ動く。
// - 検査のページが PDF を読み込むと、<html> の data-omamori-pdf 属性が変わる（src/main.ts）。それを見て、本体に「数え始めて」と伝える。
//   属性を見るだけなので、合図のために通信は増えない。
// - 表示は閉じた shadow DOM の中に作り、ページの字や CSS と混ざらないようにする。字は textContent で入れる。

(() => {
  const host = document.createElement("omamori-traffic");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  // 色は design/tokens.css と同じ値（tests/extension.test.ts で確かめる）
  style.textContent = `
    :host { all: initial; }
    .box {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      min-width: 300px; max-width: min(460px, calc(100vw - 32px)); box-sizing: border-box;
      padding: 14px 18px 12px; border-radius: 12px;
      background: #2b2a28; color: #ffffff; border: 3px solid #2b2a28;
      box-shadow: 0 1px 2px rgb(0 0 0 / 8%), 0 2px 8px rgb(0 0 0 / 6%);
      font-family: "Noto Sans JP Omamori", "BIZ UDPGothic", "Yu Gothic UI", "Hiragino Sans", "Meiryo", sans-serif;
      letter-spacing: 0.02em; line-height: 1.4;
    }
    .box[data-tone="zero"] { border-color: #2f6f5e; }
    .box[data-tone="sent"] { background: #a3201b; border-color: #ffffff; }
    .head { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; }
    .mark {
      display: inline-flex; align-items: center; justify-content: center; flex: none;
      min-width: 26px; height: 26px; padding: 0 6px; box-sizing: border-box; border-radius: 999px;
      font-size: 14px; font-weight: 700; background: #ffffff; color: #2b2a28;
    }
    .box[data-tone="zero"] .mark { background: #2f6f5e; color: #ffffff; }
    .box[data-tone="sent"] .mark { color: #a3201b; }
    .value { margin-top: 4px; font-size: 44px; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; }
    .box[data-tone="waiting"] .value { font-size: 26px; }
    .detail { font-size: 20px; font-weight: 700; }
    .note { margin-top: 6px; font-size: 13px; opacity: 0.85; }
    .by { margin-top: 2px; font-size: 12px; opacity: 0.7; }
    .hide {
      position: absolute; top: 6px; right: 8px; border: 0; background: transparent; color: inherit;
      font: inherit; font-size: 12px; padding: 4px 6px; cursor: pointer; opacity: 0.8; text-decoration: underline;
    }
    .box[hidden] { display: none; }
  `;
  const box = el("div", "box");
  box.setAttribute("role", "status");
  const head = el("div", "head");
  const mark = el("span", "mark");
  const title = el("span", "title");
  head.append(mark, title);
  const value = el("div", "value");
  const detail = el("div", "detail");
  const note = el("div", "note");
  const by = el("div", "by");
  by.textContent = "拡張機能「お守りPDF 通信を数える」が数えています（この拡張機能も、外へは送りません）";
  const hide = el("button", "hide");
  hide.type = "button";
  hide.textContent = "隠す";
  hide.addEventListener("click", () => {
    box.hidden = true;
  });
  box.append(hide, head, value, detail, note, by);
  root.append(style, box);

  function el(tag, cls) {
    const e = document.createElement(tag);
    e.className = cls;
    return e;
  }

  const MARKS = { zero: "✓", sent: "!", waiting: "…", off: "－" };

  function render(v) {
    if (!v) return;
    box.dataset.tone = v.tone;
    mark.textContent = MARKS[v.tone] ?? "－";
    title.textContent = v.title;
    value.textContent = v.value;
    detail.textContent = v.detail;
    detail.hidden = !v.detail;
    note.textContent = v.note;
    note.hidden = !v.note;
  }

  function mount() {
    if (!host.isConnected) (document.body ?? document.documentElement).append(host);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "omamori-view") {
      render(msg.view);
      if (msg.show) box.hidden = false;
    }
  });

  let lastSignal = null;
  function checkSignal() {
    const s = document.documentElement.getAttribute("data-omamori-pdf");
    if (s && s !== lastSignal) {
      lastSignal = s;
      void chrome.runtime.sendMessage({ type: "omamori-pdf" }).catch(() => {});
    }
  }
  new MutationObserver(checkSignal).observe(document.documentElement, { attributes: true, attributeFilter: ["data-omamori-pdf"] });

  void chrome.runtime
    .sendMessage({ type: "omamori-hello" })
    .then((r) => {
      render(r?.view);
      checkSignal();
    })
    .catch(() => {});

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();

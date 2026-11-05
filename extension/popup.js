// SPDX-License-Identifier: AGPL-3.0-only
//
// 拡張機能のボタンを押すと出る小さな画面。今のタブの数と、数え始めてからの要求の一覧を出す。字は textContent で入れる。

import { formatBytes } from "./count.js";

const $ = (id) => document.getElementById(id);
const MARKS = { zero: "✓", sent: "!", waiting: "…", off: "－" };
const KINDS = { sent: "送った", loaded: "読み込み" };

// ?tab=番号 は、確かめのスクリプト（scripts/check-extension.mjs）がポップアップをタブで開いて撮るときだけ使う
const asked = Number(new URLSearchParams(location.search).get("tab"));
const [tab] = Number.isInteger(asked) && asked > 0 ? [{ id: asked }] : await chrome.tabs.query({ active: true, currentWindow: true });
const tabId = tab?.id ?? -1;

function render(v, state) {
  $("box").dataset.tone = v.tone;
  $("mark").textContent = MARKS[v.tone] ?? "－";
  $("title").textContent = v.title;
  $("value").textContent = v.value;
  $("detail").textContent = v.detail;
  $("note").textContent = v.note;
  $("reset").disabled = !state;
  $("show").disabled = !state;
  const list = $("list");
  list.replaceChildren();
  for (const r of state?.recent ?? []) {
    const li = document.createElement("li");
    li.dataset.kind = r.kind;
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = KINDS[r.kind] ?? r.kind;
    const where = document.createElement("span");
    where.className = "where";
    where.textContent = `${r.method} ${r.where}`;
    const bytes = document.createElement("span");
    bytes.textContent = formatBytes(r.bytes);
    li.append(kind, where, bytes);
    list.append(li);
  }
  $("empty").hidden = (state?.recent ?? []).length > 0;
}

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: "omamori-get", tabId });
  if (r) render(r.view, r.state);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "omamori-view" && msg.tabId === tabId) render(msg.view, msg.state);
});

$("reset").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "omamori-reset", tabId });
  await refresh();
});
$("show").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "omamori-get", tabId });
  if (r) await chrome.tabs.sendMessage(tabId, { type: "omamori-view", view: r.view, show: true }).catch(() => {});
});

await refresh();

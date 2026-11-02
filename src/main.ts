// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面。PDF を受け取り、Worker で検査し、結果を出す。
// ファイルから取り出した文字や、ファイル名は、HTML として解釈させない（textContent だけを使う。CLAUDE.md §11-3）。

import { inspectInWorker } from "./inspect/run";
import type { InspectOutcome } from "./inspect/protocol";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`画面の部品が見つかりません：${id}`);
  return found as T;
}

const input = el<HTMLInputElement>("file");
const drop = el<HTMLLabelElement>("drop");
const status = el<HTMLParagraphElement>("status");
const facts = el<HTMLDListElement>("facts");

let busy = false;

function setStatus(text: string, tone: "neutral" | "ok" | "problem" = "neutral") {
  status.textContent = text;
  status.dataset.tone = tone;
}

function showFacts(rows: Array<[string, string]>) {
  facts.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    facts.append(dt, dd);
  }
  facts.hidden = rows.length === 0;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} バイト`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function render(name: string, outcome: InspectOutcome) {
  const seconds = `${(outcome.elapsedMs / 1000).toFixed(1)} 秒`;
  if (outcome.kind === "timeout") {
    setStatus("時間がかかりすぎたため、検査を止めました。画面はそのまま使えます。", "problem");
    showFacts([["ファイル", name], ["かかった時間", seconds]]);
    return;
  }
  if (outcome.kind === "error") {
    setStatus(outcome.message, "problem");
    showFacts([["ファイル", name]]);
    return;
  }
  const r = outcome.precheck;
  if (!r.ok) {
    setStatus(r.message, "problem");
    showFacts([["ファイル", name]]);
    return;
  }
  setStatus("PDF として読めました。", "ok");
  showFacts([
    ["ファイル", name],
    ["大きさ", formatBytes(r.byteLength)],
    ["PDF の版", r.version],
    ["かかった時間", seconds],
  ]);
}

async function handle(file: File) {
  if (busy) return;
  busy = true;
  showFacts([]);
  setStatus("確かめています…");
  try {
    const buffer = await file.arrayBuffer();
    const outcome = await inspectInWorker(buffer);
    render(file.name, outcome);
  } catch {
    setStatus("ファイルを読めませんでした。", "problem");
  } finally {
    busy = false;
    input.value = "";
  }
}

input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (file) void handle(file);
});

drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.dataset.over = "true";
});
drop.addEventListener("dragleave", () => {
  delete drop.dataset.over;
});
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  delete drop.dataset.over;
  const file = e.dataTransfer?.files?.[0];
  if (file) void handle(file);
});

// 画面の外に落としたファイルを、ブラウザが開いてしまわないようにする
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

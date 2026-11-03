// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面。PDF を受け取り、Worker で検査し、結果を出す。
// ファイルから取り出した文字や、ファイル名は、HTML として解釈させない（textContent だけを使う。CLAUDE.md §11-3）。
// 見た目は仮。design/ の案を選んでから整える（CLAUDE.md §6）。

import { inspectInWorker } from "./inspect/run";
import type { InspectOutcome } from "./inspect/protocol";
import { buildView, type ViewModel } from "./ui/model";
import { toFraction, viewSize } from "./inspect/view";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`画面の部品が見つかりません：${id}`);
  return found as T;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}

const input = el<HTMLInputElement>("file");
const drop = el<HTMLLabelElement>("drop");
const status = el<HTMLParagraphElement>("status");
const progress = el<HTMLProgressElement>("progress");
const facts = el<HTMLDListElement>("facts");
const notices = el<HTMLDivElement>("notices");
const noticeList = el<HTMLUListElement>("notice-list");
const findings = el<HTMLDivElement>("findings");
const findingsTitle = el<HTMLHeadingElement>("findings-title");
const findingRows = el<HTMLTableSectionElement>("finding-rows");
const unchecked = el<HTMLDivElement>("unchecked");
const uncheckedList = el<HTMLUListElement>("unchecked-list");
const coverage = el<HTMLDivElement>("coverage");
const coverageList = el<HTMLUListElement>("coverage-list");
const actions = el<HTMLDivElement>("actions");
const verified = el<HTMLDivElement>("verified");
const verifiedText = el<HTMLParagraphElement>("verified-text");
const pagesSection = el<HTMLElement>("pages-section");
const pagesBox = el<HTMLDivElement>("pages");

let busy = false;

type Tone = "neutral" | "ok" | "problem";

function setStatus(text: string, tone: Tone = "neutral") {
  status.textContent = text;
  status.dataset.tone = tone;
}

function showFacts(rows: Array<[string, string]>) {
  facts.replaceChildren();
  for (const [k, v] of rows) facts.append(make("dt", k), make("dd", v));
  facts.hidden = rows.length === 0;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} バイト`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function clearResult() {
  showFacts([]);
  for (const list of [noticeList, findingRows, uncheckedList, coverageList, pagesBox]) list.replaceChildren();
  for (const part of [notices, findings, unchecked, coverage, actions, verified, pagesSection]) part.hidden = true;
  progress.hidden = true;
}

function renderModel(view: ViewModel) {
  setStatus(view.headline, view.tone);

  if (view.notices.length) {
    for (const n of view.notices) noticeList.append(make("li", n));
    notices.hidden = false;
  }

  if (view.rows.length) {
    findingsTitle.textContent = `見つかった所（${view.rows.length} 件）`;
    for (const r of view.rows) {
      const tr = make("tr");
      tr.id = `item-${r.no}`;
      tr.dataset.severity = r.severity;
      tr.append(
        make("td", String(r.no), "no"),
        make("td", r.severityLabel, `sev sev-${r.severity}`),
        make("td", r.patternLabel),
        make("td", r.pageLabel),
      );
      const what = make("td");
      what.append(make("strong", r.title), make("span", r.why, "why"), make("span", r.detail, "detail"));
      if (r.page !== null && r.hasRect) {
        const link = make("a", `ページ ${r.page} の上で見る`, "to-page");
        link.href = `#mark-${r.no}`;
        what.append(link);
      }
      tr.append(what);
      findingRows.append(tr);
    }
    findings.hidden = false;
    actions.hidden = false;
  }

  if (view.unchecked.length) {
    for (const u of view.unchecked) uncheckedList.append(make("li", u));
    unchecked.hidden = false;
  }

  for (const c of view.coverage) coverageList.append(make("li", c));
  coverage.hidden = view.coverage.length === 0;

  // 片付けたあとに「全部緑」になる所。いまは状態の札だけを置く（片付けは C が作る）
  verified.dataset.state = view.clean ? "clean" : "none";
  verifiedText.textContent = view.clean
    ? "調べた項目では、見つかりませんでした。"
    : "";
  verified.hidden = !view.clean;

  renderPages(view);
}

function renderPages(view: ViewModel) {
  if (!view.pages.length) return;
  for (const p of view.pages) {
    const figure = make("figure", undefined, "page");
    const sheet = make("div", undefined, "sheet");
    const size = viewSize(p.box);
    sheet.style.aspectRatio = `${size.width} / ${size.height}`;
    for (const m of p.marks) {
      const f = toFraction(p.box, m.rect);
      if (!f) continue;
      const mark = make("a", undefined, `mark sev-${m.severity}`);
      mark.append(make("span", String(m.no), "mark-no"));
      mark.id = `mark-${m.no}`;
      mark.href = `#item-${m.no}`;
      mark.setAttribute("aria-label", `番号 ${m.no}：${m.title}`);
      // CSSOM で位置を入れる（style 属性の文字列は使わない。CSP の style-src に合わせる）
      mark.style.left = `${f.left * 100}%`;
      mark.style.top = `${f.top * 100}%`;
      mark.style.width = `${f.width * 100}%`;
      mark.style.height = `${f.height * 100}%`;
      sheet.append(mark);
    }
    figure.append(sheet, make("figcaption", `ページ ${p.box.page}（${p.marks.length} か所）`));
    pagesBox.append(figure);
  }
  pagesSection.hidden = false;
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
  showFacts([
    ["ファイル", name],
    ["大きさ", formatBytes(r.byteLength)],
    ["ページの数", outcome.summary && !outcome.summary.pagesUnreadable ? `${outcome.summary.pages.length}` : "不明"],
    ["かかった時間", seconds],
  ]);
  if (!outcome.summary) {
    setStatus("検査の結果を受け取れませんでした。", "problem");
    return;
  }
  renderModel(buildView(outcome.summary));
}

async function handle(file: File) {
  if (busy) return;
  busy = true;
  clearResult();
  setStatus("確かめています…");
  progress.hidden = false;
  progress.value = 0;
  try {
    const buffer = await file.arrayBuffer();
    const outcome = await inspectInWorker(buffer, (p) => {
      progress.max = p.total;
      progress.value = p.done;
      setStatus(`確かめています…（${p.label}、${p.done + 1}/${p.total}）`);
    });
    progress.hidden = true;
    render(file.name, outcome);
  } catch {
    progress.hidden = true;
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

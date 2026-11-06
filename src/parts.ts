// SPDX-License-Identifier: AGPL-3.0-only
//
// 処理に要る部品を、画面の表示が終わってから裏で読み込む（2026-11-06 本人が決定：
// 「画面表示が終わってから、処理に必要な部品を読み込む」。PDF を入れた後は、同じサイトへの要求も 0 件にする）。
// 最初の表示（今の約 0.2MB）は遅らせない。読み終わる前に PDF が入ったら「準備しています」と出して待つ（main.ts の handle）。
//
// 裏で読む順番（前のものから、要る順に）：
//   1. ページの絵の PDF.js（画面）
//   2. ページの絵の PDF.js の Worker と、画像を解く部品（Worker に、小さな見本を 1 回描かせる）
//   3. 字の対応表（cmaps.mjs）
//   4. 検査の Worker（中で PDF.js と画像を解く部品も読む）
//   5. 整える処理の Worker（同じ）
// 作り直し：最初の画面に戻ったとき（resetParts）。前のファイルで使った Worker を捨て、新しく作って温める。

import { prepareInspectWorker, resetInspectWorker } from "./inspect/run";
import { loadCmaps, pdfjs, prepareRenderWorker, resetRenderWorker } from "./render/pdf-view";
import { prepareSanitizeWorker, resetSanitizeWorker } from "./sanitize/run";

export type PartsProgress = { done: number; total: number; label: string };

const STEPS: ReadonlyArray<{ label: string; run: () => Promise<unknown>; reset?: () => Promise<unknown> }> = [
  { label: "ページの絵の部品", run: () => pdfjs() },
  { label: "ページの絵の Worker と画像を解く部品", run: () => prepareRenderWorker(), reset: () => resetRenderWorker() },
  { label: "字の対応表", run: () => loadCmaps() },
  { label: "検査の部品", run: () => prepareInspectWorker(), reset: () => resetInspectWorker() },
  { label: "整える処理の部品", run: () => prepareSanitizeWorker(), reset: () => resetSanitizeWorker() },
];

let done = 0;
let current: Promise<void> | null = null;
const listeners = new Set<(p: PartsProgress) => void>();

function notify(label: string) {
  const p = { done, total: STEPS.length, label };
  for (const l of listeners) l(p);
  // 確かめの道具（scripts/check-browser.mjs）と拡張機能への合図。ページの中の属性を変えるだけで、通信はしない
  document.documentElement.dataset.partsReady = done >= STEPS.length ? "true" : `${done}/${STEPS.length}`;
}

/** 部品を順に読み込む（もう始めていれば、同じものを返す）。1 つが失敗しても先へ進む（その部品は、使うときに読む） */
export function loadParts(): Promise<void> {
  current ??= (async () => {
    done = 0;
    notify(STEPS[0]!.label);
    for (const step of STEPS) {
      await step.run().catch(() => undefined);
      done++;
      notify(step.label);
    }
  })();
  return current;
}

/** 読み終わるまで待つ。待っている間、進み具合を知らせる */
export async function waitParts(onProgress: (p: PartsProgress) => void): Promise<void> {
  if (done >= STEPS.length && current) return current;
  listeners.add(onProgress);
  onProgress({ done, total: STEPS.length, label: STEPS[Math.min(done, STEPS.length - 1)]!.label });
  try {
    await loadParts();
  } finally {
    listeners.delete(onProgress);
  }
}

/** 最初の画面に戻ったとき：前のファイルで使った Worker を捨て、新しく作って温める（次の PDF を入れる前に済ませる） */
export function resetParts(): Promise<void> {
  current = (async () => {
    await (current ?? Promise.resolve());
    done = 0;
    notify(STEPS[0]!.label);
    for (const step of STEPS) {
      await (step.reset ?? step.run)().catch(() => undefined);
      done++;
      notify(step.label);
    }
  })();
  return current;
}

/** 画面の表示が終わってから読み込み始める（最初の表示を遅らせない） */
export function loadPartsAfterDisplay(): void {
  const start = () => {
    const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (idle) idle(() => void loadParts(), { timeout: 2000 });
    else setTimeout(() => void loadParts(), 0);
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}

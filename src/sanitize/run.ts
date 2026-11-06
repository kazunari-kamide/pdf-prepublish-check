// SPDX-License-Identifier: AGPL-3.0-only
//
// 整える処理の Worker（整える前の確かめ・整える・小さくする）。検査と同じ作り（src/inspect/run.ts）。
// 時間の上限を超えたら、その Worker だけを止める。画面は止めない（CLAUDE.md §5）。
// 温め・使い回し・作り直しの決まりは src/worker-slot.ts（2026-11-06 本人が決定：PDF を入れた後は、同じサイトへの要求も 0 件）。
// 1 つのファイルの流れの中では、同じ Worker を使う。ファイルが変わるときは作り直す（最初の画面に戻ったとき）。

import { WORKER_TIMEOUT_MS } from "../inspect/limits.ts";
import { WorkerSlot } from "../worker-slot.ts";
import type { CompressOutcome, SanitizeOutcome, SanitizeResponse, TidyChoices } from "./protocol.ts";
import type { TidyPreflight } from "../../sanitize/types.ts";
import type { RedactArea } from "./areas.ts";

const slot = new WorkerSlot(() => new Worker(new URL("../worker/sanitize.worker.ts", import.meta.url), { type: "module" }));

/** 整える処理の Worker を作って温める（まだなければ） */
export const prepareSanitizeWorker = (): Promise<boolean> => slot.prepare();
/** 前のファイルの Worker を捨て、新しい Worker を作って温める（最初の画面に戻ったとき） */
export const resetSanitizeWorker = (): Promise<boolean> => slot.reset();

const asRes = (raw: unknown) => raw as SanitizeResponse;

/** 1 つのファイルを片付ける */
export function sanitizeInWorker(buffer: ArrayBuffer, timeoutMs: number = WORKER_TIMEOUT_MS, areas: RedactArea[] = [], tidy: TidyChoices = {}): Promise<SanitizeOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  return slot.job<SanitizeOutcome>({
    request: (id) => ({ message: { type: "sanitize", id, buffer, ...(areas.length ? { areas } : {}), tidy }, transfer: [buffer] }),
    handle: (raw) => {
      const res = asRes(raw);
      if (res.type === "sanitized") {
        return {
          kind: "done",
          bytes: new Uint8Array(res.buffer),
          pages: res.pages,
          removed: res.removed,
          notDone: res.notDone,
          decrypted: res.decrypted,
          ...(res.properties ? { properties: res.properties } : {}),
          elapsedMs: elapsed(),
        };
      }
      if (res.type === "redact_blocked") return { kind: "blocked", removed: res.removed, notDone: res.notDone, leftovers: res.leftovers, elapsedMs: elapsed() };
      if (res.type === "refused") return { kind: "refused", message: res.message, elapsedMs: elapsed() };
      if (res.type === "error") return { kind: "error", message: res.message, elapsedMs: elapsed() };
      return { kind: "error", message: "整えた結果を受け取れませんでした。", elapsedMs: elapsed() };
    },
    onTimeout: () => ({ kind: "timeout", elapsedMs: elapsed() }),
    onBroken: () => ({ kind: "error", message: "整える処理 が止まりました。", elapsedMs: elapsed() }),
    timeoutMs,
  });
}

/** 片付けた PDF を小さくする（片付けと同じ時間の上限。超えたら、その Worker だけを止める） */
export function compressInWorker(
  buffer: ArrayBuffer,
  preset: { maxDpi: number; jpegQuality: number },
  timeoutMs: number = WORKER_TIMEOUT_MS,
): Promise<CompressOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  return slot.job<CompressOutcome>({
    request: (id) => ({ message: { type: "compress", id, buffer, maxDpi: preset.maxDpi, jpegQuality: preset.jpegQuality }, transfer: [buffer] }),
    handle: (raw) => {
      const res = asRes(raw);
      if (res.type === "compressed") {
        return { kind: "done", bytes: new Uint8Array(res.buffer), sizeBefore: res.sizeBefore, sizeAfter: res.sizeAfter, changed: res.changed, images: res.images, elapsedMs: elapsed() };
      }
      if (res.type === "compress_blocked") return { kind: "blocked", sizeBefore: res.sizeBefore, sizeAfter: res.sizeAfter, increased: res.increased, elapsedMs: elapsed() };
      if (res.type === "refused") return { kind: "refused", message: res.message, elapsedMs: elapsed() };
      if (res.type === "error") return { kind: "error", message: res.message, elapsedMs: elapsed() };
      return { kind: "error", message: "小さくした結果を受け取れませんでした。", elapsedMs: elapsed() };
    },
    onTimeout: () => ({ kind: "timeout", elapsedMs: elapsed() }),
    onBroken: () => ({ kind: "error", message: "整える処理 が止まりました。", elapsedMs: elapsed() }),
    timeoutMs,
  });
}

/**
 * 整える前に、プロパティの今の値・PDF/A の印・電子署名の数を聞く。渡したバイト列は Worker に渡し切るので、呼ぶ側は写しを渡す
 */
export function preflightInWorker(buffer: ArrayBuffer, timeoutMs: number = WORKER_TIMEOUT_MS): Promise<TidyPreflight | null> {
  return slot.job<TidyPreflight | null>({
    request: (id) => ({ message: { type: "preflight", id, buffer }, transfer: [buffer] }),
    handle: (raw) => {
      const res = asRes(raw);
      return res.type === "preflighted" ? res.result : null;
    },
    onTimeout: () => null,
    onBroken: () => null,
    timeoutMs,
  });
}

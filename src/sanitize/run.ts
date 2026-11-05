// SPDX-License-Identifier: AGPL-3.0-only
//
// 1つのファイルを、新しい Worker で片付ける（検査と同じ作り。src/inspect/run.ts）。
// 時間の上限を超えたら、その Worker だけを止める。画面は止めない（CLAUDE.md §5）。

import { WORKER_TIMEOUT_MS } from "../inspect/limits.ts";
import type { CompressOutcome, SanitizeOutcome, SanitizeRequest, SanitizeResponse } from "./protocol.ts";
import type { RedactArea } from "./areas.ts";

let nextId = 1;

export function sanitizeInWorker(buffer: ArrayBuffer, timeoutMs: number = WORKER_TIMEOUT_MS, areas: RedactArea[] = []): Promise<SanitizeOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const id = nextId++;
  const worker = new Worker(new URL("../worker/sanitize.worker.ts", import.meta.url), { type: "module" });

  return new Promise<SanitizeOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: SanitizeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout", elapsedMs: elapsed() }), timeoutMs);

    worker.onmessage = (e: MessageEvent<SanitizeResponse>) => {
      const res = e.data;
      if (!res || res.id !== id) return;
      if (res.type === "sanitized") {
        finish({
          kind: "done",
          bytes: new Uint8Array(res.buffer),
          pages: res.pages,
          removed: res.removed,
          notDone: res.notDone,
          decrypted: res.decrypted,
          elapsedMs: elapsed(),
        });
      } else if (res.type === "redact_blocked") {
        finish({ kind: "blocked", removed: res.removed, notDone: res.notDone, leftovers: res.leftovers, elapsedMs: elapsed() });
      } else if (res.type === "refused") finish({ kind: "refused", message: res.message, elapsedMs: elapsed() });
      else if (res.type === "error") finish({ kind: "error", message: res.message, elapsedMs: elapsed() });
      else finish({ kind: "error", message: "片付けた結果を受け取れませんでした。", elapsedMs: elapsed() });
    };
    worker.onerror = () => finish({ kind: "error", message: "片付けの Worker が止まりました。", elapsedMs: elapsed() });
    worker.onmessageerror = () => finish({ kind: "error", message: "片付けた結果を受け取れませんでした。", elapsedMs: elapsed() });

    const req: SanitizeRequest = areas.length ? { type: "sanitize", id, buffer, areas } : { type: "sanitize", id, buffer };
    worker.postMessage(req, [buffer]);
  });
}

/** 片付けた PDF を、新しい Worker で小さくする（片付けと同じ時間の上限。超えたら、その Worker だけを止める） */
export function compressInWorker(
  buffer: ArrayBuffer,
  preset: { maxDpi: number; jpegQuality: number },
  timeoutMs: number = WORKER_TIMEOUT_MS,
): Promise<CompressOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const id = nextId++;
  const worker = new Worker(new URL("../worker/sanitize.worker.ts", import.meta.url), { type: "module" });
  return new Promise<CompressOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: CompressOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout", elapsedMs: elapsed() }), timeoutMs);
    worker.onmessage = (e: MessageEvent<SanitizeResponse>) => {
      const res = e.data;
      if (!res || res.id !== id) return;
      if (res.type === "compressed") {
        finish({ kind: "done", bytes: new Uint8Array(res.buffer), sizeBefore: res.sizeBefore, sizeAfter: res.sizeAfter, changed: res.changed, images: res.images, elapsedMs: elapsed() });
      } else if (res.type === "compress_blocked") {
        finish({ kind: "blocked", sizeBefore: res.sizeBefore, sizeAfter: res.sizeAfter, increased: res.increased, elapsedMs: elapsed() });
      } else if (res.type === "refused") finish({ kind: "refused", message: res.message, elapsedMs: elapsed() });
      else if (res.type === "error") finish({ kind: "error", message: res.message, elapsedMs: elapsed() });
      else finish({ kind: "error", message: "小さくした結果を受け取れませんでした。", elapsedMs: elapsed() });
    };
    worker.onerror = () => finish({ kind: "error", message: "片付けの Worker が止まりました。", elapsedMs: elapsed() });
    worker.onmessageerror = () => finish({ kind: "error", message: "小さくした結果を受け取れませんでした。", elapsedMs: elapsed() });
    const req: SanitizeRequest = { type: "compress", id, buffer, maxDpi: preset.maxDpi, jpegQuality: preset.jpegQuality };
    worker.postMessage(req, [buffer]);
  });
}

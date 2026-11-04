// SPDX-License-Identifier: AGPL-3.0-only
//
// 1つのファイルを、新しい Worker で片付ける（検査と同じ作り。src/inspect/run.ts）。
// 時間の上限を超えたら、その Worker だけを止める。画面は止めない（CLAUDE.md §5）。

import { WORKER_TIMEOUT_MS } from "../inspect/limits";
import type { SanitizeOutcome, SanitizeRequest, SanitizeResponse } from "./protocol";
import type { RedactArea } from "./redact";

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
      } else if (res.type === "refused") finish({ kind: "refused", message: res.message, elapsedMs: elapsed() });
      else finish({ kind: "error", message: res.message, elapsedMs: elapsed() });
    };
    worker.onerror = () => finish({ kind: "error", message: "片付けの Worker が止まりました。", elapsedMs: elapsed() });
    worker.onmessageerror = () => finish({ kind: "error", message: "片付けた結果を受け取れませんでした。", elapsedMs: elapsed() });

    const req: SanitizeRequest = areas.length ? { type: "sanitize", id, buffer, areas } : { type: "sanitize", id, buffer };
    worker.postMessage(req, [buffer]);
  });
}

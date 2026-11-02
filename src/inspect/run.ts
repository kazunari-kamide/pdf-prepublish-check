// SPDX-License-Identifier: AGPL-3.0-only
//
// 1つのファイルを、新しい Worker で検査する。
// 時間の上限を超えたら、その Worker だけを止める。画面は止めない（CLAUDE.md §5）。
// ファイルごとに Worker を作り直すのは、細工された PDF の影響を次のファイルに残さないため。

import { WORKER_TIMEOUT_MS } from "./limits";
import type { InspectOutcome, InspectRequest, InspectResponse } from "./protocol";

let nextId = 1;

export function inspectInWorker(buffer: ArrayBuffer, timeoutMs: number = WORKER_TIMEOUT_MS): Promise<InspectOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const id = nextId++;
  const worker = new Worker(new URL("../worker/inspect.worker.ts", import.meta.url), { type: "module" });

  return new Promise<InspectOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: InspectOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ kind: "timeout", elapsedMs: elapsed() }), timeoutMs);

    worker.onmessage = (e: MessageEvent<InspectResponse>) => {
      const res = e.data;
      if (!res || res.id !== id) return;
      if (res.type === "result") finish({ kind: "done", precheck: res.precheck, elapsedMs: elapsed() });
      else finish({ kind: "error", message: res.message, elapsedMs: elapsed() });
    };
    worker.onerror = () => finish({ kind: "error", message: "検査の Worker が止まりました。", elapsedMs: elapsed() });
    worker.onmessageerror = () =>
      finish({ kind: "error", message: "検査の結果を受け取れませんでした。", elapsedMs: elapsed() });

    const req: InspectRequest = { type: "inspect", id, buffer };
    // ArrayBuffer は渡し切る（コピーしない）。渡したあと、画面の側からは読めなくなる
    worker.postMessage(req, [buffer]);
  });
}

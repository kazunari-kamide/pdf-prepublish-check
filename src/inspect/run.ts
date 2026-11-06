// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査の Worker。時間の上限を超えたら、その Worker だけを止める。画面は止めない（CLAUDE.md §5）。
// 温め・使い回し・作り直しの決まりは src/worker-slot.ts（2026-11-06 本人が決定：PDF を入れた後は、同じサイトへの要求も 0 件）。
// - 1 つのファイルの流れ（検査・整えたあとの読み直し・小さくしたあとの読み直し）の中では、同じ Worker を使う。
// - ファイルが変わるときは作り直す（細工された PDF の影響を次のファイルに残さないため）。作り直すのは、最初の画面に戻ったとき。

import { WorkerSlot } from "../worker-slot.ts";
import { WORKER_TIMEOUT_MS } from "./limits.ts";
import type { InspectOutcome, InspectProgress, InspectResponse } from "./protocol.ts";

const slot = new WorkerSlot(() => new Worker(new URL("../worker/inspect.worker.ts", import.meta.url), { type: "module" }));

/** 検査の Worker を作って温める（まだなければ）。温め終わったら true */
export const prepareInspectWorker = (): Promise<boolean> => slot.prepare();
/** 前のファイルの Worker を捨て、新しい Worker を作って温める（最初の画面に戻ったとき） */
export const resetInspectWorker = (): Promise<boolean> => slot.reset();

/** 1 つのファイルを検査する（新しいファイルかは、src/worker-slot.ts の startFile で決まる） */
export function inspectInWorker(
  buffer: ArrayBuffer,
  onProgress: (p: InspectProgress) => void = () => {},
  timeoutMs: number = WORKER_TIMEOUT_MS,
): Promise<InspectOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  return slot.job<InspectOutcome>({
    // ArrayBuffer は渡し切る（コピーしない）。渡したあと、画面の側からは読めなくなる
    request: (id) => ({ message: { type: "inspect", id, buffer }, transfer: [buffer] }),
    handle: (raw) => {
      const res = raw as unknown as InspectResponse;
      if (res.type === "progress") {
        onProgress({ done: res.done, total: res.total, label: res.label });
        return undefined;
      }
      if (res.type === "result") return { kind: "done", precheck: res.precheck, summary: res.summary, elapsedMs: elapsed() };
      if (res.type === "error") return { kind: "error", message: res.message, elapsedMs: elapsed() };
      return undefined;
    },
    onTimeout: () => ({ kind: "timeout", elapsedMs: elapsed() }),
    onBroken: () => ({ kind: "error", message: "検査の Worker が止まりました。", elapsedMs: elapsed() }),
    timeoutMs,
  });
}

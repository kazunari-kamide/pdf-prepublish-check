// SPDX-License-Identifier: AGPL-3.0-only
//
// 仕事1つ（ファイル1つを調べる・2つを比べる）を、新しい Worker でする（CLAUDE.md §5：上限を超えたら、その Worker だけを止める）。
// 上限を超えた・Worker が落ちたときは、理由だけを返す。

import { Worker } from "node:worker_threads";
import type { CompareReport } from "../compare/index.ts";
import type { FileReport } from "./report.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
/** Worker のメモリの上限（MB）【仮の値】。図形の多いページで 2.6GB を超えた例があるため（CLAUDE.md §5）、それより下に置く */
export const DEFAULT_MAX_MEMORY_MB = 2048;

export type RunOptions = { timeoutMs?: number; maxMemoryMb?: number };
export type RunFailure = { failed: "timeout" | "out_of_memory" | "worker_error"; message: string };

const FAIL_MESSAGE = {
  out_of_memory: "調べるのにメモリを使いすぎたため、途中で止めました。",
  worker_error: "調べている途中で問題が起きたため、このファイルは調べられませんでした。",
} as const;

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function runJob<T>(task: "inspect" | "compare", inputs: Uint8Array[], options: RunOptions): Promise<T | RunFailure> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const buffers = inputs.map(toBuffer);
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    workerData: { task, buffers },
    transferList: buffers,
    resourceLimits: { maxOldGenerationSizeMb: options.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB },
    stdout: true,
    stderr: true,
  });
  // ルールの中の console の出力（ファイルの中身を含むことがある）は、結果に混ぜずに捨てる
  worker.stdout.resume();
  worker.stderr.resume();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: T | RunFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ failed: "timeout", message: `調べるのに ${Math.round(timeoutMs / 1000)} 秒より長くかかったため、途中で止めました。` }),
      timeoutMs,
    );
    worker.on("message", (m: { ok: boolean; result?: T }) => {
      if (m.ok && m.result) finish(m.result);
      else finish({ failed: "worker_error", message: FAIL_MESSAGE.worker_error });
    });
    worker.on("error", (e: Error & { code?: string }) => {
      const kind = e.code === "ERR_WORKER_OUT_OF_MEMORY" ? "out_of_memory" : "worker_error";
      finish({ failed: kind, message: FAIL_MESSAGE[kind] });
    });
    worker.on("exit", () => finish({ failed: "worker_error", message: FAIL_MESSAGE.worker_error }));
  });
}

export const isFailure = (r: unknown): r is RunFailure => typeof r === "object" && r !== null && "failed" in r;

export async function inspectInWorker(bytes: Uint8Array, options: RunOptions = {}): Promise<FileReport> {
  const r = await runJob<FileReport>("inspect", [bytes], options);
  if (!isFailure(r)) return r;
  return { format: "unknown", items: [], notices: [{ ruleId: null, kind: r.failed, message: r.message, pages: [], unchecked: true }] };
}

export function compareInWorker(before: Uint8Array, after: Uint8Array, options: RunOptions = {}): Promise<CompareReport | RunFailure> {
  return runJob<CompareReport>("compare", [before, after], options);
}

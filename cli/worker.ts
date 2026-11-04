// SPDX-License-Identifier: AGPL-3.0-only
//
// 1つの仕事（ファイル1つを調べる・2つを比べる）をする Worker（run.ts から、仕事ごとに作り直す）。
// 細工されたファイルの影響を次のファイルに残さないためと、時間・メモリの上限を超えたら、この Worker だけを止めるため。

import { parentPort, workerData } from "node:worker_threads";
import { registerTsResolve } from "./resolve-ts.ts";

// 画面のコード（src/）を読む前に、拡張子のない import を探せるようにする
registerTsResolve();

type Job = { task: "inspect"; buffers: [ArrayBuffer] } | { task: "compare"; buffers: [ArrayBuffer, ArrayBuffer] };

const job = workerData as Job;
try {
  let result: unknown;
  if (job.task === "inspect") {
    const { inspectFile } = await import("./inspect-file.ts");
    result = await inspectFile(new Uint8Array(job.buffers[0]));
  } else {
    const { comparePdfs } = await import("../compare/index.ts");
    result = await comparePdfs(new Uint8Array(job.buffers[0]), new Uint8Array(job.buffers[1]));
  }
  parentPort!.postMessage({ ok: true, result });
} catch {
  // 例外の中身（ファイルの中身を含むことがある）は返さない
  parentPort!.postMessage({ ok: false });
}

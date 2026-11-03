// SPDX-License-Identifier: AGPL-3.0-only
//
// 採点：すべての型（下の EVALS に並べたもの）を順に回す。npm run eval で動く。
// 型ごとの採点は、それぞれ別の Node のプロセスで動かし、結果をそのまま出す。どれかが不合格なら終了コード 1。
// シェルの && や ; でつながないのは、P6 が不合格のとき P1 が動かなくなるのと、Windows（cmd.exe）と他の OS で書き方が違うため。
//
// 型ごとの選択肢（--reports・--sanitized・--json）は、型ごとに意味が違うので、ここでは受け取らない。
//   npm run eval:<型> -- <選択肢>   その型だけ（例：npm run eval:p6 -- --json out.json）

import { spawnSync } from "node:child_process";
import path from "node:path";

const EVALS = [
  { pattern: "P6", script: "p6.ts" },
  { pattern: "P1", script: "p1.ts" },
  { pattern: "P9", script: "p9.ts" },
  { pattern: "P5", script: "p5.ts" },
];

if (process.argv.length > 2) {
  console.error("npm run eval は選択肢を受け取りません。型ごとに npm run eval:<型> -- …（例：npm run eval:p6 -- --json out.json）を使ってください。");
  process.exit(2);
}

const results: Array<{ pattern: string; code: number | null }> = [];
for (const e of EVALS) {
  if (results.length) console.log("\n" + "─".repeat(40) + "\n");
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, e.script)], { stdio: "inherit" });
  results.push({ pattern: e.pattern, code: r.status });
}

const label = (code: number | null) => (code === 0 ? "合格" : code === 1 ? "不合格" : `採点が終わらなかった（終了コード ${code ?? "なし"}）`);
console.log("\n" + "─".repeat(40));
console.log("まとめ：" + results.map((r) => `${r.pattern} ${label(r.code)}`).join("、"));
process.exitCode = results.every((r) => r.code === 0) ? 0 : 1;

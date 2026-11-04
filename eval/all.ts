// SPDX-License-Identifier: AGPL-3.0-only
//
// 採点：すべての型（下の EVALS に並べたもの）を順に回す。npm run eval で動く。
// 先に合成 PDF を片付け（sanitize/）にかけて .tmp/sanitized/<型>/ に書き出し、型ごとの採点に --sanitized で渡す。
// これで、検出率・誤検知率と「片付けたあとに残る情報」を、型ごとに一度に測る。
// 片付けは検出ルールの部品（rules/p6-text/・rules/shared/）を読んでいるので、ルールを変えたら片付けの結果も一緒に測る（2026-11-04 人が決めた）。
// 型ごとの採点は、それぞれ別の Node のプロセスで動かし、結果をそのまま出す。どれかが不合格なら終了コード 1。
// シェルの && や ; でつながないのは、P6 が不合格のとき P1 が動かなくなるのと、Windows（cmd.exe）と他の OS で書き方が違うため。
//
// 型ごとの選択肢（--reports・--json）は、型ごとに意味が違うので、ここでは受け取らない。
//   npm run eval:<型> -- <選択肢>   その型だけ（例：npm run eval:p6 -- --json out.json）
//   npm run eval:sanitize           片付けと、片付けたあとに残る情報だけ

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const EVALS = [
  { pattern: "P6", script: "p6.ts", dir: "p6" },
  { pattern: "P1", script: "p1.ts", dir: "p1" },
  { pattern: "P9", script: "p9.ts", dir: "p9" },
  { pattern: "P5", script: "p5.ts", dir: "p5" },
  { pattern: "P7", script: "p7.ts", dir: "p7" },
  // 見える文字の個人情報（rules/pii。番号 P13 は【仮】）。片付けをしない型なので、片付けた PDF は渡らない
  { pattern: "P13【仮】", script: "pii.ts", dir: "pii" },
];

if (process.argv.length > 2) {
  console.error("npm run eval は選択肢を受け取りません。型ごとに npm run eval:<型> -- …（例：npm run eval:p6 -- --json out.json）を使ってください。");
  process.exit(2);
}

const SANITIZED = path.resolve(import.meta.dirname, "..", ".tmp", "sanitized");

// 片付け：合成 PDF を片付けて書き出すだけ（採点は、下の型ごとの採点の中で行う）
console.log("片付け（sanitize/）：合成 PDF を片付けて .tmp/sanitized/ に書き出す");
const s = spawnSync(process.execPath, [path.join(import.meta.dirname, "sanitize.ts"), "--no-score", "--out", SANITIZED], { stdio: "inherit" });
const sanitizeOk = s.status === 0;
if (!sanitizeOk) console.log(`片付けが終わらなかった（終了コード ${s.status ?? "なし"}）。片付けたあとに残る情報は測れない`);

const results: Array<{ pattern: string; code: number | null }> = [];
for (const e of EVALS) {
  console.log("\n" + "─".repeat(40) + "\n");
  const dir = path.join(SANITIZED, e.dir);
  const args = [path.join(import.meta.dirname, e.script)];
  if (sanitizeOk && existsSync(dir)) args.push("--sanitized", dir);
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  results.push({ pattern: e.pattern, code: r.status });
}

const label = (code: number | null) => (code === 0 ? "合格" : code === 1 ? "不合格" : `採点が終わらなかった（終了コード ${code ?? "なし"}）`);
console.log("\n" + "─".repeat(40));
console.log("まとめ：" + results.map((r) => `${r.pattern} ${label(r.code)}`).join("、"));
process.exitCode = sanitizeOk && results.every((r) => r.code === 0) ? 0 : 1;

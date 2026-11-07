// SPDX-License-Identifier: AGPL-3.0-only
//
// 定時に回す 1 回分（docs/ratchet-schedule.md）。ratchet/schedule.json を読み、npm run ratchet と同じ道具（run.ts）を、
// 決めた呼び方・費用の上限・読む数で起こす。タスクスケジューラに登録するときは、これを起こす（scripts/ratchet-schedule.ps1）。
// - 読むのは手元の束だけ（OMAMORI_RATCHET_CORPUS）。ウェブには向けない。
// - 既定は dry-run（PR の本文を記録のフォルダに書くだけ）。マージはしない。
// - API キー・束の場所は、設定のファイルに書かない。起こした人（タスク）の環境変数から run.ts が読む。
//
// 使い方：npm run ratchet:scheduled（設定の中身を見るだけなら npm run ratchet:scheduled -- --show）

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export type Schedule = { times: string[]; via: "api" | "cli"; dryRun: boolean; runBudgetUsd: number; bundle: number };

/** 設定を読んで確かめる。形が違えば止める（上限の無い設定で回さない） */
export function readSchedule(file = join(HERE, "schedule.json")): Schedule {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const bad: string[] = [];
  if (!Array.isArray(j.times) || !j.times.length || !j.times.every((t: unknown) => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) bad.push("times");
  if (j.via !== "api" && j.via !== "cli") bad.push("via");
  if (typeof j.dryRun !== "boolean") bad.push("dryRun");
  if (typeof j.runBudgetUsd !== "number" || !(j.runBudgetUsd > 0)) bad.push("runBudgetUsd");
  if (!Number.isInteger(j.bundle) || j.bundle < 1) bad.push("bundle");
  if (bad.length) throw new Error(`定時の設定の形が違います：${bad.join("、")}`);
  return { times: j.times, via: j.via, dryRun: j.dryRun, runBudgetUsd: j.runBudgetUsd, bundle: j.bundle };
}

/** run.ts に渡す引数。dry-run でないときだけ --pr を付ける */
export function scheduleArgs(s: Schedule): string[] {
  return ["--via", s.via, "--run-budget", String(s.runBudgetUsd), "--bundle", String(s.bundle), ...(s.dryRun ? [] : ["--pr"])];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = readSchedule();
  const args = scheduleArgs(s);
  if (process.argv.includes("--show")) {
    console.log(`時刻：${s.times.join("・")}／呼び方：${s.via}／${s.dryRun ? "dry-run" : "PR を出す"}／費用の上限：${s.runBudgetUsd} ドル／読む数：${s.bundle}`);
    console.log(`起こすもの：node ratchet/run.ts ${args.join(" ")}`);
  } else {
    const r = spawnSync(process.execPath, [join(HERE, "run.ts"), ...args], { cwd: resolve(HERE, ".."), stdio: "inherit", windowsHide: true });
    process.exit(r.status ?? 1);
  }
}

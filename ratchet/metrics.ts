// SPDX-License-Identifier: AGPL-3.0-only
//
// 1 つの作業の木（main か、候補の worktree）で、歯止めに使う数をそろえて測る（docs/ratchet.md §3.4）。
// 採点の道具は、測る木の中のものをそのまま動かす（ここで採点の中身を作り直さない）：
//   - 合格基準のある型（P1・P5・P6・P7・P9）：eval/<型>.ts --json（片付けたあとに残る情報も --sanitized で数える）
//   - 合格基準のまだない型：eval/cases/registry.ts の scoreType（仮の採点。npm run eval:new と同じ）
//   - 見ないで作るテスト集：eval/blind/run.ts の report.json（「合」の型の数）
//   - npm test・npm run build
// 子のプロセスで：node ratchet/metrics.ts <木のフォルダ> <書き出すフォルダ>  → <書き出すフォルダ>/metrics.json

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type TypeScore = {
  /** 型の鍵（rubric:P6 や cases:p8-annot など） */
  key: string;
  source: "rubric" | "cases";
  expected: number;
  found: number;
  /** 誤検知率（rubric は false_positive_rate、cases は対照のうち誤検知のあった割合）。対照が無ければ null */
  falsePositiveRate: number | null;
  falsePositives: number;
  /** 片付けたあとに残る情報（rubric の型だけ。測れなければ null） */
  residual: number | null;
};

export type Metrics = {
  types: TypeScore[];
  blind: { pass: number; total: number } | null;
  test: { ok: boolean; passed: number | null; failed: number | null };
  build: { ok: boolean };
  /** 画面の一覧（src/inspect/rules.ts の RULES）に入っているルールの id。読めなければ null */
  ruleIds?: string[] | null;
  errors: string[];
};

const RUBRIC_TYPES = ["p1", "p5", "p6", "p7", "p9"];

function run(root: string, args: string[], timeoutMs = 20 * 60_000) {
  return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
}

function npm(root: string, script: string, timeoutMs = 30 * 60_000) {
  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "-s", script], {
    cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32", windowsHide: true,
  });
}

export async function measure(rootIn: string, outIn: string): Promise<Metrics> {
  const root = resolve(rootIn);
  const out = resolve(outIn);
  mkdirSync(out, { recursive: true });
  const m: Metrics = { types: [], blind: null, test: { ok: false, passed: null, failed: null }, build: { ok: false }, errors: [] };

  // 片付け（採点はしない。型ごとの採点の中で、残りを数える）
  const sanitized = join(out, "sanitized");
  const s = run(root, ["eval/sanitize.ts", "--no-score", "--out", sanitized]);
  if (s.status !== 0) m.errors.push("片付けが終わらなかった");

  for (const t of RUBRIC_TYPES) {
    const json = join(out, `${t}.json`);
    const args = [`eval/${t}.ts`, "--json", json];
    if (s.status === 0 && existsSync(join(sanitized, t))) args.push("--sanitized", join(sanitized, t));
    run(root, args);
    if (!existsSync(json)) {
      m.errors.push(`${t} の採点が終わらなかった`);
      continue;
    }
    const j = JSON.parse(readFileSync(json, "utf8"));
    const fp = (j.false_positives?.on_negative ?? 0) + (j.false_positives?.nowhere ?? 0);
    m.types.push({
      key: `rubric:${t.toUpperCase()}`, source: "rubric", expected: j.leaks ?? 0, found: j.found ?? 0,
      falsePositiveRate: typeof j.false_positive_rate === "number" ? j.false_positive_rate : null, falsePositives: fp,
      residual: typeof j.residual === "number" ? j.residual : typeof j.residual?.total === "number" ? j.residual.total : null,
    });
  }

  // 仮の採点（合格基準のまだない型）。測る木の registry を読む
  const cases = run(root, [fileURLToPath(import.meta.url), "--cases", root]);
  try {
    for (const c of JSON.parse(cases.stdout) as Array<{ ruleId: string; pattern: string; expected: number; found: number; extra: number; controls: number; controlsWithExtra: number }>) {
      m.types.push({
        key: `cases:${c.pattern}:${c.ruleId}`, source: "cases", expected: c.expected, found: c.found,
        falsePositiveRate: c.controls ? c.controlsWithExtra / c.controls : null, falsePositives: c.extra, residual: null,
      });
    }
  } catch {
    m.errors.push("仮の採点が終わらなかった");
  }

  // 画面の一覧に入っているルール（マージしたら検査器に入るかを、歯止めで確かめるため）
  const ids = run(root, [fileURLToPath(import.meta.url), "--rule-ids", root]);
  try {
    m.ruleIds = JSON.parse(ids.stdout);
  } catch {
    m.ruleIds = null;
    m.errors.push("画面の一覧のルールを読めなかった");
  }

  // 見ないで作るテスト集
  const blindOut = join(out, "blind");
  run(root, ["eval/blind/run.ts", "--out", blindOut]);
  const rep = join(blindOut, "report.json");
  if (existsSync(rep)) {
    const r = JSON.parse(readFileSync(rep, "utf8"));
    const types: any[] = Array.isArray(r.types) ? r.types : [];
    m.blind = { pass: types.filter((x) => x.verdict === "合").length, total: types.length };
  } else m.errors.push("見ないで作るテスト集の採点が終わらなかった");

  const test = npm(root, "test");
  const tm = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(test.stdout ?? "");
  m.test = { ok: test.status === 0, passed: tm ? Number(tm[2]) : null, failed: tm ? Number(tm[1] ?? 0) : null };
  const build = npm(root, "build");
  m.build = { ok: build.status === 0 };

  writeFileSync(join(out, "metrics.json"), JSON.stringify(m, null, 1));
  return m;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] === "--rule-ids") {
    const root = resolve(process.argv[3]!);
    const mod = await import(pathToFileURL(join(root, "src/inspect/rules.ts")).href);
    process.stdout.write(JSON.stringify((mod.RULES as Array<{ id: string }>).map((r) => r.id).sort()));
  } else if (process.argv[2] === "--cases") {
    const root = resolve(process.argv[3]!);
    const reg = await import(pathToFileURL(join(root, "eval/cases/registry.ts")).href);
    const rows = [];
    for (const t of reg.TYPES) {
      const sc = await reg.scoreType(t);
      rows.push({ ruleId: t.ruleId, pattern: sc.pattern, expected: sc.expected, found: sc.found, extra: sc.extra, controls: sc.controls, controlsWithExtra: sc.controlsWithExtra });
    }
    process.stdout.write(JSON.stringify(rows));
  } else {
    const m = await measure(process.argv[2]!, process.argv[3]!);
    console.log(JSON.stringify({ types: m.types.length, blind: m.blind, test: m.test, build: m.build, errors: m.errors }));
  }
}

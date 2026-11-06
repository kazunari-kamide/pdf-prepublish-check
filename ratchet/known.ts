// SPDX-License-Identifier: AGPL-3.0-only
//
// 歯止めの「良くなった」を正しくするための確かめ：ループが足した新しい型の合成 PDF を、main の検査器（検査の全体）にかける。
// main がすでに別のルールで報告するなら、その「隠しあり」は新しく見つけたものではない（2026-11-07 の 1 回目で、3 件ともこれだった）。
//
// 数え方：
//   - 新しい型の合成 PDF（隠しあり・対照）を、候補の木でその場で作る（候補の木の eval/cases を使う）
//   - それぞれを main の木の `cli/omamori.ts check` にかけ、報告の「型の番号・ルール・見出し」を集める
//   - 「隠しあり」に、同じ型の番号（P9 の候補なら P9）の報告が 1 つでもあれば、main がすでに捕まえたものと数える。
//     対照にも同じ報告が出ていても引かない（例：添付の中の個人情報の候補では、対照にも添付があり「添付ファイルが入っています」が出る。
//     利用者には main の報告で添付が見えているので、捕まえたものと数える）
//   - 型が NEW のときだけは、同じ番号が無いので、対照のどれにも出ない報告（見出しの数字は # にそろえる）があれば捕まえたと数える
//
// 子のプロセスで：node ratchet/known.ts --build <候補の木> <書き出すフォルダ> <ruleId>...  → 標準出力に、作った PDF の一覧（JSON）

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type BuiltCase = { ruleId: string; id: string; kind: "leak" | "control"; file: string };

export type CaughtByMain = {
  /** 型の鍵（metrics の cases:<P>:<ruleId>） */
  key: string;
  leaks: number;
  /** main がすでに報告した「隠しあり」の数 */
  caught: number;
  /** main で報告したルール（対照に出るものを除く） */
  byRules: string[];
};

/** main の報告 1 件（型の番号・ルール・見出しだけ） */
export type Seen = { pattern: string; ruleId: string; title: string };

export function seenOf(item: { pattern?: unknown; ruleId?: unknown; title?: unknown }): Seen {
  return { pattern: String(item.pattern ?? ""), ruleId: String(item.ruleId ?? ""), title: String(item.title ?? "") };
}

const sig = (s: Seen) => `${s.ruleId}｜${s.title.replace(/[0-9０-９]+/g, "#")}`;

/** 合成 PDF ごとの main の報告から、main が捕まえた「隠しあり」を数える（純粋な関数。テストで確かめる） */
export function countCaught(key: string, rows: Array<{ kind: "leak" | "control"; seen: Seen[] }>): CaughtByMain {
  const pattern = patternOfKey(key);
  const background = new Set<string>();
  for (const r of rows) if (r.kind === "control") for (const s of r.seen) background.add(sig(s));
  let leaks = 0;
  let caught = 0;
  const by = new Set<string>();
  for (const r of rows) {
    if (r.kind !== "leak") continue;
    leaks++;
    const hit = pattern && pattern !== "NEW" ? r.seen.filter((s) => s.pattern === pattern) : r.seen.filter((s) => !background.has(sig(s)));
    if (hit.length) {
      caught++;
      for (const s of hit) by.add(s.ruleId);
    }
  }
  return { key, leaks, caught, byRules: [...by].sort() };
}

/** metrics の鍵（cases:P12:p12-outline-js）から、registry の ruleId を取る */
export function ruleIdOfKey(key: string): string | null {
  const m = /^cases:[^:]+:(.+)$/.exec(key);
  return m ? m[1]! : null;
}

/** metrics の鍵から、型の番号を取る */
export function patternOfKey(key: string): string | null {
  const m = /^cases:([^:]+):/.exec(key);
  return m ? m[1]! : null;
}

/**
 * 新しい型ごとに、main の検査器がすでに捕まえる「隠しあり」を数える。
 * 確かめられなかった型は null（歯止めは、確かめられないときは通さない）。
 */
export function caughtByMain(opts: { tool: string; baseDir: string; candDir: string; outDir: string; keys: string[]; timeoutSec?: number }): Record<string, CaughtByMain | null> {
  const res: Record<string, CaughtByMain | null> = {};
  const ids = opts.keys.map(ruleIdOfKey);
  for (const k of opts.keys) res[k] = null;
  if (!opts.keys.length) return res;
  mkdirSync(opts.outDir, { recursive: true });
  const b = spawnSync(process.execPath, [join(opts.tool, "known.ts"), "--build", opts.candDir, opts.outDir, ...ids.filter((x): x is string => !!x)], {
    cwd: opts.candDir, encoding: "utf8", windowsHide: true, timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024,
  });
  let built: BuiltCase[];
  try {
    built = JSON.parse(b.stdout);
  } catch {
    return res;
  }
  const t = opts.timeoutSec ?? 120;
  for (let i = 0; i < opts.keys.length; i++) {
    const id = ids[i];
    const mine = built.filter((c) => c.ruleId === id);
    if (!id || !mine.length) continue;
    const rows: Array<{ kind: "leak" | "control"; seen: Seen[] }> = [];
    let failed = false;
    for (const c of mine) {
      const r = spawnSync(process.execPath, [join(opts.baseDir, "cli/omamori.ts"), "check", "--format", "json", "--fail-on", "never", "--timeout", String(t), c.file], {
        cwd: opts.baseDir, encoding: "utf8", windowsHide: true, timeout: (t + 30) * 1000, maxBuffer: 64 * 1024 * 1024,
      });
      try {
        const j = JSON.parse(r.stdout);
        const items: unknown[] = Array.isArray(j?.files?.[0]?.items) ? j.files[0].items : [];
        rows.push({ kind: c.kind, seen: items.map((x) => seenOf(x as Record<string, unknown>)) });
      } catch {
        failed = true;
        break;
      }
    }
    if (!failed) res[opts.keys[i]!] = countCaught(opts.keys[i]!, rows);
  }
  return res;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]) && process.argv[2] === "--build") {
  const root = resolve(process.argv[3]!);
  const out = resolve(process.argv[4]!);
  const want = new Set(process.argv.slice(5));
  const reg = await import(pathToFileURL(join(root, "eval/cases/registry.ts")).href);
  const list: BuiltCase[] = [];
  let n = 0;
  for (const t of reg.TYPES as Array<{ ruleId: string; cases: Array<{ id: string; kind: "leak" | "control"; build(): Promise<Uint8Array> }> }>) {
    if (!want.has(t.ruleId)) continue;
    for (const c of t.cases) {
      const file = join(out, `case-${String(++n).padStart(3, "0")}.pdf`);
      writeFileSync(file, await c.build());
      list.push({ ruleId: t.ruleId, id: c.id, kind: c.kind, file });
    }
  }
  process.stdout.write(JSON.stringify(list));
}

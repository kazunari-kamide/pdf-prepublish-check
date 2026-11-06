// SPDX-License-Identifier: AGPL-3.0-only
//
// main にある検出ルールの一覧（下読み・候補・反証・ルール書きに渡す）。
// 束の PDF で報告したルールだけを渡すと、束で一度も当たらなかったルールが Claude に見えず、
// 「この型のルールが無い」と思い違いをする（2026-11-07 の 1 回目で、3 件とも main がすでに見ている型だった）。
// そのため、main の作業の木から、画面の一覧（RULES）・仮の採点の型（registry）・ルールの README の要点を、全部渡す。
//
// 子のプロセスで：node ratchet/catalog.ts <木のフォルダ>  → 標準出力に JSON を 1 つ

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type KnownRule = {
  id: string;
  pattern: string;
  label: string;
  /** README のはじめの段落（何を見ているか） */
  summary: string;
  /** README の表の「種類（kind）」と、その説明 */
  kinds: Array<{ kind: string; what: string }>;
};

export type Catalog = {
  /** 画面の一覧（src/inspect/rules.ts の RULES） */
  rules: KnownRule[];
  /** 仮の採点の型（eval/cases/registry.ts の TYPES）。ルールの id は RULES と別の名前のこともある */
  scoredTypes: Array<{ pattern: string; label: string; ruleId: string }>;
};

const MAX_SUMMARY = 400;
const MAX_KINDS = 30;
const MAX_WHAT = 120;

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** README から、はじめの段落と、表の「種類」の行を取る */
export function parseReadme(text: string): { summary: string; kinds: Array<{ kind: string; what: string }> } {
  const lines = text.replace(/\r/g, "").split("\n");
  // 見出し・表・コードを除いた地の文を、はじめから上限の字数まで
  let summary = "";
  let inCode = false;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !t || t.startsWith("#") || t.startsWith("|")) continue;
    summary += (summary ? " " : "") + t;
    if (summary.length >= MAX_SUMMARY) break;
  }
  const kinds: Array<{ kind: string; what: string }> = [];
  const seen = new Set<string>();
  for (const l of lines) {
    // | `open_action` | 説明 | … ／ | hidden_layer | 説明 | … のような行
    const m = /^\|\s*`?([a-z][a-z0-9_]*)`?\s*\|\s*([^|]+)\|/.exec(l.trim());
    if (!m || seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    kinds.push({ kind: m[1]!, what: cap(m[2]!.trim(), MAX_WHAT) });
    if (kinds.length >= MAX_KINDS) break;
  }
  return { summary: cap(summary, MAX_SUMMARY), kinds };
}

/** registry の ruleId（「p9-attach（inner）」など）から、rules/ のフォルダの名前を取る */
export function ruleDirOf(ruleId: string): string {
  return ruleId.replace(/[（(].*$/, "").trim();
}

/** 測る木から一覧を作る（その木の RULES と registry を import する。子のプロセスで呼ぶ） */
export async function readCatalog(rootIn: string): Promise<Catalog> {
  const root = resolve(rootIn);
  const rulesMod = await import(pathToFileURL(join(root, "src/inspect/rules.ts")).href);
  const reg = await import(pathToFileURL(join(root, "eval/cases/registry.ts")).href);
  const readme = (id: string) => {
    const f = join(root, "rules", ruleDirOf(id), "README.md");
    return existsSync(f) ? parseReadme(readFileSync(f, "utf8")) : { summary: "", kinds: [] };
  };
  const rules: KnownRule[] = (rulesMod.RULES as Array<{ id: string; pattern: string; label: string }>).map((r) => ({
    id: r.id, pattern: r.pattern, label: r.label, ...readme(r.id),
  }));
  // RULES に無いが、registry で採点しているルール（RULES の中で呼ばれているものなど）も、README があれば足す
  const scoredTypes = (reg.TYPES as Array<{ pattern: string; label: string; ruleId: string }>).map((t) => ({ pattern: t.pattern, label: t.label, ruleId: t.ruleId }));
  for (const t of scoredTypes) {
    const dir = ruleDirOf(t.ruleId);
    if (rules.some((r) => r.id === dir)) continue;
    const md = readme(t.ruleId);
    rules.push({ id: dir, pattern: t.pattern, label: t.label, ...md });
  }
  return { rules, scoredTypes };
}

/** 下読み（軽いモデル・呼び出しが多い）には、短い形だけを渡す */
export function shortCatalog(c: Catalog): Array<{ id: string; pattern: string; label: string; kinds: string[] }> {
  return c.rules.map((r) => ({ id: r.id, pattern: r.pattern, label: r.label, kinds: r.kinds.map((k) => k.kind) }));
}

/** 子のプロセスで一覧を作る（測る木のモジュールを、この道具のプロセスに読み込まないため） */
export function catalogIn(root: string): Catalog | null {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), root], { encoding: "utf8", windowsHide: true, timeout: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  try {
    const c = JSON.parse(r.stdout) as Catalog;
    return Array.isArray(c.rules) && c.rules.length ? c : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(JSON.stringify(await readCatalog(process.argv[2]!)));
}

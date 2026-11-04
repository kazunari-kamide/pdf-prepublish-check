#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// コマンドの道具。通信はしない（ファイルを読んで、結果を画面かファイルに書くだけ）。
//
//   node cli/omamori.ts check [選択肢] <ファイルやフォルダ>...
//   node cli/omamori.ts compare [選択肢] <元のファイル> <公開するファイル>
//
// 使い方の説明は docs/cli.md。

import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_FILE_BYTES } from "../src/inspect/limits.ts";
import { collectFiles } from "./collect.ts";
import { runCompare } from "./compare.ts";
import { formatJson, formatSarif, formatText, type CheckedFile } from "./output.ts";
import type { FileReport, Stage } from "./report.ts";
import { DEFAULT_TIMEOUT_MS, inspectInWorker } from "./run.ts";
import { DEFAULT_FAIL_ON, USAGE_ERROR, exitCodeOf, parseFailOn } from "./stage.ts";
import { CHECK_EXTENSIONS } from "./extensions.ts";

const USAGE = `使い方：
  node cli/omamori.ts check [選択肢] <ファイルやフォルダ>...
  node cli/omamori.ts compare [選択肢] <元のファイル> <公開するファイル>

check の選択肢：
  --format text|json|sarif   出し方（既定は text）
  --output <ファイル>         結果をファイルに書く（既定は画面）
  --fail-on <段階,…>          終了コードを 0 以外にする段階。review・high・unchecked を , でつなぐ。never で落とさない
                             （既定は review,high,unchecked）
  --timeout <秒>              ファイル1つにかけてよい時間（既定は ${DEFAULT_TIMEOUT_MS / 1000} 秒）

compare の選択肢：
  --format text|json         出し方（既定は text）
  --output <ファイル>         結果をファイルに書く

終了コード（check）：0 見つからない／1 確認してほしい所だけ／2 高い危険／3 調べられなかった所がある／64 使い方の誤り
終了コード（compare）：0 消したはずの字が残っていない／2 残っている／3 比べられなかった所がある／64 使い方の誤り`;

type Args = { positional: string[]; options: Map<string, string> };

const VALUED = new Set(["--format", "--output", "--fail-on", "--timeout"]);

function parseArgs(argv: string[]): Args | string {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (name === "--help") {
        options.set("--help", "");
        continue;
      }
      if (!VALUED.has(name)) return `知らない選択肢です：${name}`;
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) return `${name} のあとに値が要ります。`;
      options.set(name, value);
    } else positional.push(a);
  }
  return { positional, options };
}

function displayPath(p: string): string {
  const rel = path.relative(process.cwd(), path.resolve(p));
  // 結果の場所は、OS によらず / で区切る（CI の記録や SARIF とそろえる）
  return (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p).replace(/\\/g, "/");
}

function emit(text: string, output: string | undefined) {
  if (output) writeFileSync(output, text + "\n", "utf8");
  else process.stdout.write(text + "\n");
}

function tooLarge(): FileReport {
  const mb = Math.floor(MAX_FILE_BYTES / (1024 * 1024));
  return {
    format: "unknown",
    items: [],
    notices: [{ ruleId: null, kind: "too_large", message: `ファイルが大きすぎるため、検査できません（上限は ${mb}MB です）。`, pages: [], unchecked: true }],
  };
}

function unreadable(): FileReport {
  return { format: "unknown", items: [], notices: [{ ruleId: null, kind: "unreadable", message: "ファイルを読めませんでした。", pages: [], unchecked: true }] };
}

async function check(args: Args): Promise<number> {
  const format = args.options.get("--format") ?? "text";
  if (!["text", "json", "sarif"].includes(format)) return usage(`--format は text・json・sarif のどれかです。`);
  let failOn: ReadonlySet<Stage> = DEFAULT_FAIL_ON;
  if (args.options.has("--fail-on")) {
    const f = parseFailOn(args.options.get("--fail-on")!);
    if (!f) return usage("--fail-on は review・high・unchecked を , でつないだもの、または never です。");
    failOn = f;
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (args.options.has("--timeout")) {
    const s = Number(args.options.get("--timeout"));
    if (!Number.isFinite(s) || s <= 0 || s > 24 * 3600) return usage("--timeout は 1 以上の秒数です。");
    timeoutMs = Math.round(s * 1000);
  }
  if (args.positional.length === 0) return usage("調べるファイルかフォルダを渡してください。");

  const c = collectFiles(args.positional, CHECK_EXTENSIONS);
  if (c.missing.length) return usage(`見つからないファイル・フォルダがあります：${c.missing.join("、")}`);
  if (c.truncated) process.stderr.write(`ファイルが多すぎるため、先の ${c.files.length} 個だけを調べます。\n`);

  // 進み具合は、結果を画面に出さないときで、端末につながっているときだけ出す（CI の記録を汚さない）
  const progress = Boolean(process.stderr.isTTY) && (format !== "text" || args.options.has("--output"));
  const checked: CheckedFile[] = [];
  for (const file of c.files) {
    const started = performance.now();
    let report: FileReport;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) report = tooLarge();
      else report = await inspectInWorker(new Uint8Array(readFileSync(file)), { timeoutMs });
    } catch {
      report = unreadable();
    }
    checked.push({ path: displayPath(file), report, elapsedMs: Math.round(performance.now() - started) });
    if (progress) process.stderr.write(`調べました：${checked.length}/${c.files.length}\r`);
  }
  if (progress) process.stderr.write("\n");

  const code = exitCodeOf(
    checked.map((f) => f.report),
    failOn,
  );
  const text = format === "json" ? formatJson(checked, code) : format === "sarif" ? formatSarif(checked, code) : formatText(checked, code);
  emit(text, args.options.get("--output"));
  return code;
}

function usage(message: string): number {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  return USAGE_ERROR;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (typeof args === "string") return usage(args);
  if (command === undefined || command === "--help" || args.options.has("--help")) {
    process.stdout.write(USAGE + "\n");
    return command === undefined ? USAGE_ERROR : 0;
  }
  if (command === "check") return check(args);
  if (command === "compare") {
    const format = args.options.get("--format") ?? "text";
    if (!["text", "json"].includes(format)) return usage("compare の --format は text・json のどちらかです。");
    if (args.positional.length !== 2) return usage("compare には、元のファイルと公開するファイルの2つを渡してください。");
    const r = await runCompare(args.positional[0]!, args.positional[1]!, format as "text" | "json");
    if (r.usage) return usage(r.usage);
    emit(r.text, args.options.get("--output"));
    return r.code;
  }
  return usage(`知らないコマンドです：${command}`);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    process.stderr.write("思わぬ問題が起きたため、止まりました。\n");
    process.exitCode = USAGE_ERROR;
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// 実物の PDF で、見える文字の個人情報（rules/pii）の件数だけを数える入口（誤検知を別の段で測るため）。
//
//   npm run eval:pii-count -- <フォルダ>            フォルダの中の *.pdf を全部かける
//   PII_COUNT_DIR=<フォルダ> npm run eval:pii-count  場所を環境変数で渡す（場所をコマンドの履歴やコミットに残さないため）
//   … -- --json <ファイル>                         結果を JSON でも書き出す
//
// 出すのは件数だけ（型ごとの高・確認の数、除いたものの数、読めなかった・省いたページの数、かかった時間）。
// ファイル名・場所・字の中身は出さない（CLAUDE.md §2-7・§11-2）。フォルダの場所もリポジトリに書かない。

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PII_TYPES, countsOnly, detectPii } from "../rules/pii/index.ts";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const jsonOut = argValue("--json");
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--json");
  const dir = positional[0] ?? process.env.PII_COUNT_DIR;
  if (!dir) {
    console.error("フォルダを渡してください（npm run eval:pii-count -- <フォルダ>、または環境変数 PII_COUNT_DIR）。");
    process.exit(2);
  }
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .sort();

  const total = { files: files.length, errors: 0, pages: 0, skippedPages: 0, unreadablePages: 0, filesWithFindings: 0, ms: 0 };
  const byType = Object.fromEntries(PII_TYPES.map((t) => [t, { high: 0, check: 0 }])) as Record<string, { high: number; check: number }>;
  const excluded: Record<string, number> = {};
  let slowestMs = 0;
  for (const f of files) {
    const started = performance.now();
    const c = countsOnly(await detectPii(new Uint8Array(readFileSync(path.join(dir, f)))));
    const ms = performance.now() - started;
    total.ms += ms;
    slowestMs = Math.max(slowestMs, ms);
    if (c.status !== "ok") {
      total.errors++;
      continue;
    }
    total.pages += c.pages;
    total.skippedPages += c.skippedPages;
    total.unreadablePages += c.unreadablePages;
    if (c.counts.total > 0) total.filesWithFindings++;
    for (const t of PII_TYPES) {
      byType[t]!.high += c.counts.byType[t].high;
      byType[t]!.check += c.counts.byType[t].check;
    }
    for (const [k, v] of Object.entries(c.excluded)) excluded[k] = (excluded[k] ?? 0) + v;
  }

  console.log(`ファイル：${total.files} 個（読めなかった ${total.errors} 個）　ページ：${total.pages}（省いた ${total.skippedPages}、読めない字のある ${total.unreadablePages}）`);
  console.log(`候補のあったファイル：${total.filesWithFindings} 個`);
  console.log("型ごとの候補の数（高 / 確認）：");
  for (const t of PII_TYPES) console.log(`  ${t.padEnd(13)} ${byType[t]!.high} / ${byType[t]!.check}`);
  console.log(`除いたもの：${Object.entries(excluded).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join("、") || "なし"}`);
  console.log(`かかった時間：合計 ${(total.ms / 1000).toFixed(1)} 秒、1ファイルでいちばん長いもの ${(slowestMs / 1000).toFixed(1)} 秒`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ total, byType, excluded, slowestMs: Math.round(slowestMs) }, null, 2) + "\n");
}

if (import.meta.main) await main();

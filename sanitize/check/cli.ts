// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付けても壊れていないかを、フォルダごとに確かめる。
//
//   npm run check:sanitized -- <片付ける前のフォルダ> <片付けたフォルダ>
//   npm run check:sanitized -- <片付ける前の PDF> <片付けた PDF>
//
// 片付けたフォルダに _summary.json（npm run eval:sanitize が書く）があれば、適用した墨消しの箱を
// 「変わってよい所」として読む。出すのは件数・画素の数だけ（字そのものは出さない）。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { checkSanitized, type Rect } from "./check.ts";

type SummaryEntry = { file: string; status: string; removed?: Array<{ kind: string; page?: number; rect?: Rect }> };

async function main() {
  const [beforeArg, afterArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!beforeArg || !afterArg) {
    console.error("使い方：npm run check:sanitized -- <片付ける前のフォルダ> <片付けたフォルダ>");
    process.exit(1);
  }
  const pairs: Array<{ name: string; before: string; after: string }> = [];
  let summary: SummaryEntry[] = [];
  if (statSync(afterArg).isDirectory()) {
    const sp = path.join(afterArg, "_summary.json");
    if (existsSync(sp)) summary = JSON.parse(readFileSync(sp, "utf8")) as SummaryEntry[];
    for (const f of readdirSync(afterArg).filter((x) => x.endsWith(".pdf")).sort()) {
      pairs.push({ name: f, before: path.join(beforeArg, f), after: path.join(afterArg, f) });
    }
  } else {
    pairs.push({ name: path.basename(afterArg), before: beforeArg, after: afterArg });
  }

  let bad = 0;
  let diffTotal = 0;
  let pagesTotal = 0;
  for (const p of pairs) {
    const allowed = new Map<number, Rect[]>();
    for (const r of summary.find((s) => s.file === p.name)?.removed ?? []) {
      if (r.kind === "redaction_applied" && r.page && r.rect) allowed.set(r.page, [...(allowed.get(r.page) ?? []), r.rect]);
    }
    const r = await checkSanitized(new Uint8Array(readFileSync(p.before)), new Uint8Array(readFileSync(p.after)), { allowedChanges: allowed });
    pagesTotal += r.pages.length;
    diffTotal += r.diffPixels ?? 0;
    const removedChars = r.pages.reduce((s, x) => s + (x.charsBefore - x.charsAfter), 0);
    const line = `${r.ok ? "○" : "×"} ${p.name}　ページ ${r.pagesBefore}→${r.pagesAfter}　見た目の差 ${r.diffPixels ?? "描けない"} 画素　取り出せる字 ${r.pages.reduce((s, x) => s + x.charsBefore, 0)}→${r.pages.reduce((s, x) => s + x.charsAfter, 0)}（${removedChars} 字減った）`;
    console.log(line);
    if (!r.ok) {
      bad++;
      for (const pr of r.problems) console.log(`    ${pr}`);
    }
  }
  console.log(`\n確かめた PDF：${pairs.length} 個（${pagesTotal} ページ）　問題あり：${bad} 個　見た目の差の合計：${diffTotal} 画素`);
  process.exitCode = bad ? 1 : 0;
}

if (import.meta.main) await main();

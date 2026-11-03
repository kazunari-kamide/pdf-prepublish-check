// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器 P7（隠れたテキスト）そのものを、合成 PDF と正解データで確かめる。
//   node verifier/p7-selfcheck.mjs
// 照らし合わせ方は rubric/p7.md §3（同じページ・同じ理由・箱の重なり 50% 以上・1対1）。
// 確かめること：漏れをすべて見つける。漏れでないものに重ならない。正解にない出力がない。字数が正解と同じ。壊れた入力で止まらない。

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyP7 } from "./p7.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures", "p7");
const MIN_OVERLAP = 0.5;

function overlap(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const small = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  return small > 0 ? (w * h) / small : 0;
}

const problems = [];
let leaks = 0;
let found = 0;
let negatives = 0;
let negHit = 0;
let extra = 0;
const byReason = new Map();
const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".expected.json")).sort();

for (const name of files) {
  const exp = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
  const r = await verifyP7(new Uint8Array(readFileSync(path.join(FIXTURES, exp.file))));
  if (r.status !== "ok") {
    problems.push(`${exp.file}：読めなかった（${r.error?.code}）`);
    continue;
  }
  if (r.skipped_pages.length) problems.push(`${exp.file}：省いたページ ${JSON.stringify(r.skipped_pages)}`);
  const used = new Set();
  for (const l of exp.leaks) {
    leaks++;
    const row = byReason.get(l.reason) ?? { total: 0, found: 0 };
    row.total++;
    let best = -1;
    let bestOv = 0;
    r.items.forEach((it, i) => {
      if (used.has(i) || it.page !== l.page || it.reason !== l.reason) return;
      const ov = overlap(it.rect, l.rect);
      if (ov >= MIN_OVERLAP && ov > bestOv) {
        best = i;
        bestOv = ov;
      }
    });
    if (best >= 0) {
      used.add(best);
      found++;
      row.found++;
      if (r.items[best].chars !== l.chars) problems.push(`${exp.file}：${l.id} の字数 ${r.items[best].chars}（正解 ${l.chars}）`);
    } else problems.push(`${exp.file}：漏れ ${l.id}（${l.reason}）を見つけなかった`);
    byReason.set(l.reason, row);
  }
  for (const n of exp.negatives) negatives++;
  r.items.forEach((it, i) => {
    if (used.has(i)) return;
    const neg = exp.negatives.find((n) => n.page === it.page && overlap(n.rect, it.rect) >= MIN_OVERLAP);
    if (neg) {
      negHit++;
      problems.push(`${exp.file}：漏れでない ${neg.id}（${neg.kind}）に重なる報告（${it.reason}）`);
    } else {
      extra++;
      problems.push(`${exp.file}：正解にない出力（${it.reason}、${it.page} ページ）`);
    }
  });
}

// 壊れた入力
const enc = (s) => new TextEncoder().encode(s);
const good = new Uint8Array(readFileSync(path.join(FIXTURES, "p7-01-white-text.pdf")));
for (const [label, bytes] of [
  ["空のファイル", new Uint8Array(0)],
  ["PDF でないもの", enc("hello")],
  ["途中で切れた PDF", good.slice(0, Math.floor(good.length / 2))],
]) {
  try {
    const r = await verifyP7(bytes);
    if (label !== "途中で切れた PDF" && r.status !== "error") problems.push(`${label}：error を返さなかった`);
  } catch (e) {
    problems.push(`${label}：止まった（${e?.message}）`);
  }
}

console.log(`合成 PDF ${files.length} 個：漏れ ${leaks} 件中 ${found} 件を見つけた。漏れでないもの ${negatives} 件中 ${negHit} 件に反応。正解にない出力 ${extra} 件`);
console.log(`理由ごと：${[...byReason].map(([k, v]) => `${k} ${v.total} 件中 ${v.found}`).join("、")}`);
if (problems.length) {
  for (const p of problems) console.log(`  NG ${p}`);
  console.log("不合格");
  process.exit(1);
}
console.log("すべて正解データと合った");

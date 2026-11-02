// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器そのものの確かめ（PRD §2-3-1 の採点の流れの 1）。
//   node verifier/selfcheck.mjs
// fixtures/p6/ の片付ける前の合成 PDF を検証器にかけ、正解データ（*.expected.json）と合うかを見る。
// 照らし合わせ方は rubric/p6.md の「照らし合わせ方」と同じ（型・ページ・箱の重なり）。
// さらに厳しく、字の層は「残っている字数」も正解と同じかを見る。

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyP6 } from "./p6.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures", "p6");
const MIN_OVERLAP = 0.5; // rubric/p6.json の match.min_overlap と同じ

const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
function overlap(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const m = Math.min(area(a), area(b));
  return m > 0 ? (w * h) / m : 0;
}

let failures = 0;
let leaksTotal = 0, leaksFound = 0, negTotal = 0, negHit = 0, unexpected = 0;
const byType = new Map();

for (const name of readdirSync(FIXTURES).filter((n) => n.endsWith(".expected.json")).sort()) {
  const exp = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
  const res = await verifyP6(readFileSync(path.join(FIXTURES, exp.file)));
  const problems = [];
  if (res.status !== "ok") problems.push(`読めなかった: ${res.error?.code}`);
  if (res.skipped_pages.length) problems.push(`省いたページ: ${JSON.stringify(res.skipped_pages)}`);
  const used = new Set();
  for (const l of exp.leaks) {
    leaksTotal++;
    const key = `${l.layer}/${l.cover}`;
    const t = byType.get(key) ?? { total: 0, found: 0 };
    t.total++;
    byType.set(key, t);
    let best = -1, bestOv = 0;
    res.items.forEach((it, i) => {
      if (used.has(i) || it.page !== l.page || it.layer !== l.layer) return;
      const ov = overlap(it.rect, l.rect);
      if (ov > bestOv) { bestOv = ov; best = i; }
    });
    if (best < 0 || bestOv < MIN_OVERLAP) { problems.push(`見逃し ${l.id}（${key}）`); continue; }
    used.add(best);
    leaksFound++;
    t.found++;
    const it = res.items[best];
    if (it.cover !== l.cover) problems.push(`${l.id}: 覆っているものの種類が違う（正解 ${l.cover}、出力 ${it.cover}）`);
    if (l.layer === "text" && it.remaining.chars !== l.remaining.chars) {
      problems.push(`${l.id}: 字数が違う（正解 ${l.remaining.chars}、出力 ${it.remaining.chars}）`);
    }
  }
  for (const n of exp.negatives) {
    negTotal++;
    const hit = res.items.some((it, i) => !used.has(i) && it.page === n.page && overlap(it.rect, n.rect) >= MIN_OVERLAP);
    if (hit) { negHit++; problems.push(`誤検知 ${n.id}（${n.kind}）`); }
  }
  res.items.forEach((it, i) => {
    if (used.has(i)) return;
    const onNeg = exp.negatives.some((n) => it.page === n.page && overlap(it.rect, n.rect) >= MIN_OVERLAP);
    if (!onNeg) { unexpected++; problems.push(`正解にない出力: p${it.page} ${it.layer}/${it.cover} ${JSON.stringify(it.rect)}`); }
  });
  if (problems.length) failures++;
  console.log(`${problems.length ? "NG" : "OK"}  ${exp.file}${problems.length ? "\n      " + problems.join("\n      ") : ""}`);
}

// 壊れた入力で止まらないか
const broken = [
  ["空のファイル", new Uint8Array(0), "empty"],
  ["PDF でないもの", new TextEncoder().encode("これは PDF ではありません"), "unreadable"],
  ["途中で切れた PDF", readFileSync(path.join(FIXTURES, "p6-t01-rect-over-name.pdf")).subarray(0, 400), null],
];
for (const [label, bytes, code] of broken) {
  const res = await verifyP6(bytes);
  const ok = code ? res.status === "error" && res.error.code === code : res.status === "error" || res.items.length >= 0;
  if (!ok) failures++;
  console.log(`${ok ? "OK" : "NG"}  壊れた入力：${label} → ${res.status}${res.error ? `（${res.error.code}）` : ""}`);
}

console.log("");
console.log(`漏れ ${leaksTotal} 件中 ${leaksFound} 件を見つけた。漏れでないもの ${negTotal} 件中 ${negHit} 件に反応。正解にない出力 ${unexpected} 件`);
for (const [k, v] of [...byType.entries()].sort()) console.log(`  ${k}: ${v.total} 件中 ${v.found} 件`);
console.log(failures ? `合わなかったもの ${failures} 個` : "すべて正解データと合った");
process.exit(failures ? 1 : 0);

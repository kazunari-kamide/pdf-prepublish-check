// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器 P1（文書情報）そのものを、合成 PDF と正解データで確かめる。
//   node verifier/p1-selfcheck.mjs
// 確かめること：
// - 正解の漏れ（leaks）の欄が、すべて items にある
// - 漏れでない欄（negatives）が、items になく、not_counted に正しい理由で入っている
// - 正解にない欄を items に出していない
// - 前の版の文書情報があるもの（previous_info）を数えている
// - 2つの読み方（バイト列・PDF.js）が食い違っていない（食い違いは件数を出す）
// - 壊れた入力で止まらずに error を返す

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyP1 } from "./p1.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures", "p1");

const problems = [];
let leaks = 0;
let found = 0;
let negatives = 0;
let negHit = 0;
let extra = 0;
let crossDiffs = 0;
const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".expected.json")).sort();

for (const name of files) {
  const exp = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
  const r = await verifyP1(new Uint8Array(readFileSync(path.join(FIXTURES, exp.file))));
  if (r.status !== "ok") {
    problems.push(`${exp.file}：読めなかった（${r.error?.code}）`);
    continue;
  }
  const got = new Set(r.items.map((i) => i.key));
  for (const l of exp.leaks) {
    leaks++;
    if (got.has(l.key)) found++;
    else problems.push(`${exp.file}：漏れ ${l.key} を見つけなかった`);
  }
  for (const n of exp.negatives) {
    negatives++;
    if (got.has(n.key)) {
      negHit++;
      problems.push(`${exp.file}：漏れでない ${n.key} を出した`);
    }
    const nc = r.not_counted.find((x) => x.key === n.key);
    if (!nc || nc.reason !== n.kind) problems.push(`${exp.file}：${n.key} の数えない理由が ${nc?.reason ?? "なし"}（正解 ${n.kind}）`);
  }
  const known = new Set([...exp.leaks.map((l) => l.key), ...exp.negatives.map((n) => n.key)]);
  for (const i of r.items) {
    if (!known.has(i.key)) {
      extra++;
      problems.push(`${exp.file}：正解にない欄 ${i.key} を出した`);
    }
  }
  if (exp.previous_info && r.previous_info === 0) problems.push(`${exp.file}：前の版の文書情報を数えていない`);
  if (!exp.previous_info && r.previous_info > 0) problems.push(`${exp.file}：前の版の文書情報がないのに ${r.previous_info} と数えた`);
  const cc = r.cross_check;
  const diffs = cc.only_bytes.length + cc.only_pdfjs.length + cc.value_mismatch.length + (cc.bytes_unreadable ? 1 : 0);
  if (diffs) {
    crossDiffs++;
    console.log(`  （参考）${exp.file}：読み方の食い違い ${JSON.stringify(cc)}`);
  }
}

// 壊れた入力
const good = new Uint8Array(readFileSync(path.join(FIXTURES, "p1-01-author-name.pdf")));
const broken = [
  ["空のファイル", new Uint8Array(0)],
  ["PDF でないもの", new TextEncoder().encode("hello")],
  ["途中で切れた PDF", good.slice(0, Math.floor(good.length / 2))],
  ["深すぎる入れ子", new TextEncoder().encode("%PDF-1.7\n1 0 obj\n" + "[".repeat(5000) + "\nendobj\ntrailer\n<< /Info 1 0 R >>\nstartxref\n9\n%%EOF\n")],
  ["暗号化のしるしがある", new TextEncoder().encode("%PDF-1.7\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Encrypt << /Filter /Standard >> >>\nstartxref\n9\n%%EOF\n")],
];
for (const [label, bytes] of broken) {
  try {
    const r = await verifyP1(bytes);
    if (label === "途中で切れた PDF") {
      // 途中で切れても、読めた所まででよい。止まらないこと、items が正解を超えないことだけを見る
      if (r.status === "ok" && r.items.some((i) => i.key !== "Author")) problems.push(`${label}：正解にない欄を出した`);
    } else if (r.status !== "error") problems.push(`${label}：error を返さなかった`);
    else if (label === "暗号化のしるしがある" && r.error.code !== "encrypted") problems.push(`${label}：encrypted でなく ${r.error.code}`);
  } catch (e) {
    problems.push(`${label}：止まった（${e?.message}）`);
  }
}

console.log(`合成 PDF ${files.length} 個：漏れ ${leaks} 件中 ${found} 件を見つけた。漏れでない欄 ${negatives} 件中 ${negHit} 件に反応。正解にない出力 ${extra} 件。読み方が食い違った PDF ${crossDiffs} 個`);
if (problems.length) {
  for (const p of problems) console.log(`  NG ${p}`);
  console.log("不合格");
  process.exit(1);
}
console.log("すべて正解データと合った");

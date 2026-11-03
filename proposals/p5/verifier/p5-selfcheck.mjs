// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器 P5（旧版の残存）そのものを、合成 PDF と正解データで確かめる。
//   node verifier/p5-selfcheck.mjs
// 確かめること：
// - 正解の漏れ（leaks）が、同じ番号・種類・場所で items にある（同じ組が2つあれば2つ）
// - 漏れでないもの（negatives）は items になく、not_counted に同じ番号・種類・場所である
// - 正解にない items・not_counted を出していない
// - 壊れた入力で止まらない

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyP5 } from "./p5.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// verifier/ に移したあとは fixtures/p5、proposals/p5/verifier/ にある間は proposals/p5/fixtures/p5
const FIXTURES = path.resolve(HERE, "..", "fixtures", "p5");

const problems = [];
let leaks = 0;
let found = 0;
let negatives = 0;
let negHit = 0;
let extra = 0;
const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".expected.json")).sort();
const key = (x) => `${x.object}|${x.kind}|${x.where}`;

for (const name of files) {
  const exp = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
  const r = await verifyP5(new Uint8Array(readFileSync(path.join(FIXTURES, exp.file))));
  if (r.status !== "ok") {
    problems.push(`${exp.file}：読めなかった（${r.error?.code}）`);
    continue;
  }
  const items = r.items.map(key);
  for (const l of exp.leaks) {
    leaks++;
    const k = items.indexOf(key(l));
    if (k >= 0) {
      found++;
      items.splice(k, 1);
    } else problems.push(`${exp.file}：漏れ ${l.id}（${key(l)}）を見つけなかった`);
  }
  const nc = r.not_counted.map(key);
  for (const n of exp.negatives) {
    negatives++;
    const ki = items.indexOf(key(n));
    if (ki >= 0) {
      negHit++;
      items.splice(ki, 1);
      problems.push(`${exp.file}：漏れでない ${n.id}（${key(n)}）を items に出した`);
    }
    const k = nc.indexOf(key(n));
    if (k >= 0) nc.splice(k, 1);
    else problems.push(`${exp.file}：漏れでない ${n.id}（${key(n)}）が not_counted にない`);
  }
  for (const i of items) {
    extra++;
    problems.push(`${exp.file}：正解にない items（${i}）`);
  }
  for (const i of nc) problems.push(`${exp.file}：正解にない not_counted（${i}）`);
}

// 壊れた入力
const enc = (s) => new TextEncoder().encode(s);
const good = new Uint8Array(readFileSync(path.join(FIXTURES, "p5-01-info-overwritten.pdf")));
const broken = [
  ["空のファイル", new Uint8Array(0), "error"],
  ["PDF でないもの", enc("hello"), "error"],
  ["途中で切れた PDF", good.slice(0, Math.floor(good.length / 2)), "any"],
  ["/Prev が自分を指す", enc("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R /Prev 47 >>\nstartxref\n47\n%%EOF\n"), "any"],
  ["暗号化のしるしがある", enc("%PDF-1.7\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Encrypt << /Filter /Standard >> >>\nstartxref\n9\n%%EOF\n"), "encrypted"],
];
for (const [label, bytes, want] of broken) {
  try {
    const r = await verifyP5(bytes);
    if (want === "error" && r.status !== "error") problems.push(`${label}：error を返さなかった`);
    if (want === "encrypted" && r.error?.code !== "encrypted") problems.push(`${label}：encrypted でなく ${r.error?.code ?? r.status}`);
  } catch (e) {
    problems.push(`${label}：止まった（${e?.message}）`);
  }
}

console.log(`合成 PDF ${files.length} 個：漏れ ${leaks} 件中 ${found} 件を見つけた。漏れでないもの ${negatives} 件中 ${negHit} 件に反応。正解にない出力 ${extra} 件`);
console.log(`壊れた入力 ${broken.length} 種：止まらずに返した（下に NG がなければ、期待どおり）`);
if (problems.length) {
  for (const p of problems) console.log(`  NG ${p}`);
  console.log("不合格");
  process.exit(1);
}
console.log("すべて正解データと合った");

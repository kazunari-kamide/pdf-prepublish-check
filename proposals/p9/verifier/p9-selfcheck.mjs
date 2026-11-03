// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器 P9（添付ファイル）そのものを、合成 PDF と正解データで確かめる。
//   node verifier/p9-selfcheck.mjs
// 確かめること：
// - 正解の漏れ（leaks）が、同じファイル名・同じ場所（where）で items にある
// - 漏れでないもの（negatives）を items に出していない
// - 正解にない items を出していない
// - 2つの読み方（バイト列・PDF.js）の食い違いの数（参考）
// - 壊れた入力・輪になった木で、止まらずに返す

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyP9 } from "./p9.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures", "p9");

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
  const r = await verifyP9(new Uint8Array(readFileSync(path.join(FIXTURES, exp.file))), { includeNames: true });
  if (r.status !== "ok") {
    problems.push(`${exp.file}：読めなかった（${r.error?.code}）`);
    continue;
  }
  const rest = [...r.items];
  for (const l of exp.leaks) {
    leaks++;
    const k = rest.findIndex((i) => i.name === l.name && i.where === l.where);
    if (k >= 0) {
      found++;
      rest.splice(k, 1);
    } else problems.push(`${exp.file}：漏れ ${l.id}（${l.where}）を見つけなかった`);
  }
  for (const n of exp.negatives) {
    negatives++;
    if (n.name && r.items.some((i) => i.name === n.name)) {
      negHit++;
      problems.push(`${exp.file}：漏れでない ${n.id}（${n.kind}）を出した`);
    }
  }
  for (const i of rest) {
    if (exp.negatives.some((n) => n.name && n.name === i.name)) continue; // 上で数えた
    extra++;
    problems.push(`${exp.file}：正解にない出力（${i.where}、オブジェクト ${i.object}）`);
  }
  if (r.cross_check.only_bytes || r.cross_check.only_pdfjs || r.cross_check.pdfjs_unreadable) {
    crossDiffs++;
    console.log(`  （参考）${exp.file}：読み方の食い違い ${JSON.stringify(r.cross_check)}`);
  }
}

// 壊れた入力
const enc = (s) => new TextEncoder().encode(s);
const good = new Uint8Array(readFileSync(path.join(FIXTURES, "p9-01-names-xlsx.pdf")));
const cyclic = (() => {
  // 名前の木の /Kids が自分を指す（輪になった木）。表の形の xref を手で書く
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 4 0 R >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
    "<< /Kids [4 0 R] >>",
  ];
  let s = "%PDF-1.7\n";
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(s.length);
    s += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return enc(s);
})();
const broken = [
  ["空のファイル", new Uint8Array(0), "error"],
  ["PDF でないもの", enc("hello"), "error"],
  ["途中で切れた PDF", good.slice(0, Math.floor(good.length / 2)), "any"],
  ["深すぎる入れ子", enc("%PDF-1.7\n1 0 obj\n" + "[".repeat(5000) + "\nendobj\ntrailer\n<< /Root 1 0 R >>\nstartxref\n9\n%%EOF\n"), "error"],
  ["暗号化のしるしがある", enc("%PDF-1.7\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Encrypt << /Filter /Standard >> >>\nstartxref\n9\n%%EOF\n"), "encrypted"],
  ["輪になった名前の木", cyclic, "ok-empty"],
];
for (const [label, bytes, want] of broken) {
  try {
    const r = await verifyP9(bytes);
    if (want === "error" && r.status !== "error") problems.push(`${label}：error を返さなかった`);
    if (want === "encrypted" && r.error?.code !== "encrypted") problems.push(`${label}：encrypted でなく ${r.error?.code ?? r.status}`);
    if (want === "ok-empty" && (r.status !== "ok" || r.items.length !== 0)) problems.push(`${label}：${r.status}、${r.items.length} 件`);
    if (want === "any" && r.status === "ok" && r.items.length > 1) problems.push(`${label}：正解より多く出した`);
  } catch (e) {
    problems.push(`${label}：止まった（${e?.message}）`);
  }
}

console.log(`合成 PDF ${files.length} 個：漏れ ${leaks} 件中 ${found} 件を見つけた。漏れでないもの ${negatives} 件中 ${negHit} 件に反応。正解にない出力 ${extra} 件。読み方が食い違った PDF ${crossDiffs} 個`);
console.log(`壊れた入力など ${broken.length} 種：止まらずに返した（下に NG がなければ、期待どおり）`);
if (problems.length) {
  for (const p of problems) console.log(`  NG ${p}`);
  console.log("不合格");
  process.exit(1);
}
console.log("すべて正解データと合った");

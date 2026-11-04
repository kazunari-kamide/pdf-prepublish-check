// SPDX-License-Identifier: AGPL-3.0-only
//
// 仮の採点：新しい型（P2 の文書全体の XMP・P8・P10・P11・P12 など）。npm run eval:new で動く。
// これらの型には、まだ合格基準（rubric/）・検証器（verifier/）・採点用の合成 PDF（fixtures/）がない（人が決めて置く場所）。
// そのため、検出ルールの担当が作った合成 PDF（eval/cases/。その場で作る）で、検出と誤検知の数だけを測る。
// 合格・不合格は決めない（合格の線は人が決める）。見逃しか誤検知があれば、合成 PDF の id と鍵を出す（中身の字は出さない）。

import { scoreType, TYPES } from "./cases/registry.ts";

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);

let problems = 0;
console.log("仮の採点（新しい型。合格基準はまだ無い。数だけを測る）");
for (const t of TYPES) {
  const s = await scoreType(t);
  console.log(
    `${s.pattern} ${s.label}（${t.ruleId}）：合成 PDF ${t.cases.length} 件、検出 ${s.found}/${s.expected}（${pct(s.found, s.expected)}）、` +
      `誤検知 ${s.extra} 件（対照 ${s.controls} 件のうち ${s.controlsWithExtra} 件）`,
  );
  for (const f of s.failures) {
    problems++;
    console.log(`  ${f.id}：見逃し [${f.missed.join(", ")}]、誤検知 [${f.extra.join(", ")}]`);
  }
}
process.exitCode = problems ? 1 : 0;

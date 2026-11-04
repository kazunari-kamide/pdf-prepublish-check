// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査で「調べていない所」を、画面に添える一言にする。出す所はここ1か所だけ（CLAUDE.md §11-5b）。
//
// いまは決め打ち：P6 の検出ルールは、画像の層（スキャン画像の上の黒い四角）をまだ見ない（npm run eval の image/* が 0/8）。
// そのため、P6 を調べられたときは、いつも「画像の下の中身は調べていない」と添える。
// 検出ルールの結果に「どの層を調べたか」が足されたら（A の担当。まだ main にない）、この関数の中だけを、
// その値を見て出し分ける形に直す。呼ぶ側（src/ui/model.ts）は変えなくてよい。

import type { RuleResult } from "../inspect/report";

/** 型ごとの「調べていない層」の一言。読み直しの範囲の文の後ろに、そのまま並べる */
export function scopeCaveats(rules: readonly RuleResult[]): string[] {
  const out: string[] = [];
  const p6 = rules.find((r) => r.pattern === "P6");
  if (p6 && p6.status === "ok") out.push("P6 のうち、画像の下の中身は、読み直しではまだ調べていません。");
  return out;
}

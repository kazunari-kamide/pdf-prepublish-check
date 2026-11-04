// SPDX-License-Identifier: AGPL-3.0-only
//
// ルールの版・更新日・最近足した型（11/5 B の 10）。画面の下に出す。
// - 版は、検査の結果に入ったもの（ルールの報告の rule.version）をそのまま出す。ここでは決めない。
// - 更新日と「最近足した型」は、docs/evolution.md の記録に合わせて、ルールを足したときに手で直す。
//   ここに書いたルールが一覧（RULES）にあることは、テストで確かめる（tests/ui-ruleset.test.ts）。

import type { RuleResult } from "../inspect/report";

/** 画面に出すルールの一覧の更新日（docs/evolution.md の最後の記録の日） */
export const RULESET_UPDATED = "2026-11-05";

/** 最近足したルール（docs/evolution.md で「新規」として記録した日。新しい順） */
export const RECENT_RULES: ReadonlyArray<{ id: string; added: string }> = [
  { id: "p2-xmp", added: "2026-11-05" },
  { id: "p4-paths", added: "2026-11-05" },
  { id: "p10-exif", added: "2026-11-05" },
  { id: "p11-forms", added: "2026-11-05" },
  { id: "p12-actions", added: "2026-11-05" },
  { id: "alt-text", added: "2026-11-05" },
  { id: "props-diff", added: "2026-11-05" },
  { id: "extras", added: "2026-11-05" },
  { id: "font-glyphs", added: "2026-11-05" },
  { id: "p8-annot", added: "2026-11-04" },
];

export type RulesetView = {
  /** 例：「検出ルール 15 個・最終更新 2026-11-05」 */
  headline: string;
  /** 最近足した型（名前と P の番号、足した日） */
  recent: string[];
  /** ルールごとの版（名前・P の番号・ID@版） */
  versions: string[];
};

export function buildRulesetView(rules: readonly RuleResult[]): RulesetView {
  const recent = RECENT_RULES.flatMap((r) => {
    const hit = rules.find((x) => x.ruleId === r.id);
    return hit ? [`${hit.label}（${hit.pattern}）：${r.added} に足しました`] : [];
  });
  const versions = rules.map((r) => `${r.label}（${r.pattern}）　${r.ruleId}${r.ruleVersion ? `@${r.ruleVersion}` : "（版は分かりません）"}`);
  return { headline: `検出ルール ${rules.length} 個・最終更新 ${RULESET_UPDATED}`, recent, versions };
}

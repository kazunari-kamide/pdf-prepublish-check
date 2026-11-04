// SPDX-License-Identifier: AGPL-3.0-only
//
// 1つのファイルを、登録したすべての検出ルール（rules.ts）にかける。Worker から呼ぶ。
// 1つのルールが例外で止まっても、ほかのルールは続ける（止まったルールは「調べられなかった」と返す）。

import { readPageBoxes } from "./pages.ts";
import { readProperties } from "./properties.ts";
import type { InspectSummary, RuleResult } from "./report.ts";
import { RULES, type RuleEntry, type RunContext } from "./rules.ts";

export async function inspectAll(
  bytes: Uint8Array,
  onProgress: (done: number, total: number, label: string) => void = () => {},
  rules: RuleEntry[] = RULES,
  ctx: RunContext = {},
): Promise<InspectSummary> {
  const results: RuleResult[] = [];
  const total = rules.length + 1;
  onProgress(0, total, "ページの形");
  let pages: InspectSummary["pages"] | null = null;
  try {
    pages = await readPageBoxes(bytes);
  } catch {
    pages = null;
  }
  for (const [i, rule] of rules.entries()) {
    onProgress(i + 1, total, rule.label);
    try {
      results.push(await rule.run(bytes, ctx));
    } catch {
      // 例外の中身（ファイルの中身を含むことがある）は画面に出さない
      results.push({
        ruleId: rule.id,
        ruleVersion: "",
        label: rule.label,
        pattern: rule.pattern,
        status: "error",
        message: "調べている途中で問題が起きたため、この項目は調べられませんでした。",
        items: [],
        notices: [],
      });
    }
  }
  let properties: InspectSummary["properties"] = null;
  try {
    properties = await readProperties(bytes);
  } catch {
    properties = null;
  }
  return { pages: pages ?? [], pagesUnreadable: pages === null, rules: results, properties };
}

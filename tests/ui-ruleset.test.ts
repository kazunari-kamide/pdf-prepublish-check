// SPDX-License-Identifier: AGPL-3.0-only
//
// ルールの版・更新日・最近足した型（src/ui/ruleset.ts）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RuleResult } from "../src/inspect/report";
import { RULES } from "../src/inspect/rules";
import { buildRulesetView, RECENT_RULES, RULESET_UPDATED } from "../src/ui/ruleset";

describe("ルールの版", () => {
  it("最近足したルールは、どれも一覧（RULES）にある", () => {
    for (const r of RECENT_RULES) expect(RULES.map((x) => x.id)).toContain(r.id);
  });

  it("更新日と、足した日は、docs/evolution.md に記録がある", () => {
    const log = readFileSync("docs/evolution.md", "utf8");
    expect(log).toContain(`| ${RULESET_UPDATED} |`);
    for (const r of RECENT_RULES) expect(log).toMatch(new RegExp(`\\| ${r.added} \\|[^\\n]*\`${r.id === "props-diff" ? "props" : r.id}\``));
  });

  it("版は、検査の結果のものをそのまま出す", () => {
    const rule = (id: string, version: string): RuleResult => ({ ruleId: id, ruleVersion: version, label: "名前", pattern: "P2", status: "ok", items: [], notices: [] });
    const v = buildRulesetView([rule("p2-xmp", "1.0.0"), rule("x", "")]);
    expect(v.headline).toBe(`検出ルール 2 個・最終更新 ${RULESET_UPDATED}`);
    expect(v.versions).toEqual(["名前（P2）　p2-xmp@1.0.0", "名前（P2）　x（版は分かりません）"]);
    expect(v.recent).toEqual(["名前（P2）：2026-11-05 に足しました"]);
  });
});

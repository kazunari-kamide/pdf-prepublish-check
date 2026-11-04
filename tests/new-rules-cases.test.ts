// SPDX-License-Identifier: AGPL-3.0-only
//
// 新しい型の合成 PDF（eval/cases/）を、検出ルールにかけて、鍵が正解と同じかを1件ずつ確かめる。

import { describe, expect, it } from "vitest";
import { compare, TYPES } from "../eval/cases/registry.ts";

for (const t of TYPES) {
  describe(`${t.pattern} ${t.label}（${t.ruleId}）の合成 PDF`, () => {
    for (const c of t.cases) {
      it(`${c.id}（${c.kind === "leak" ? "隠しあり" : "対照"}）：${c.description}`, async () => {
        const got = await t.keys(await c.build());
        expect(compare(c.leaks, got)).toEqual({ missed: [], extra: [] });
      });
    }
  });
}

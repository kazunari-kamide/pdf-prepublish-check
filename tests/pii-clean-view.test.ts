// SPDX-License-Identifier: AGPL-3.0-only
//
// 黒塗りの候補（P13【仮】、見える文字の個人情報らしい字。rules/pii）を、片付けたあとの読み直しで「残っている所」に数えないこと。
// 片付けは見える字を消さない（黒塗りにするかは利用者が決める）ため（2026-11-04 人が決めた）。

import { describe, expect, it } from "vitest";
import type { InspectSummary, Item, RuleResult } from "../src/inspect/report";
import { buildCleanView } from "../src/ui/clean-model";
import { buildView } from "../src/ui/model";

const page = { page: 1, view: [0, 0, 595, 842] as [number, number, number, number], rotate: 0 as const };
const rule = (over: Partial<RuleResult> & Pick<RuleResult, "pattern" | "label">): RuleResult => ({
  ruleId: over.pattern.toLowerCase(),
  ruleVersion: "1",
  status: "ok",
  items: [],
  notices: [],
  ...over,
});
const summary = (rules: RuleResult[]): InspectSummary => ({ pages: [page], pagesUnreadable: false, rules });
const candidate: Item = { pattern: "P13", severity: "medium", title: "氏名らしい字があります（黒塗りの候補）", why: "…", detail: "確からしさ：高", page: 1, rect: [10, 10, 50, 20] };
const p6: Item = { pattern: "P6", severity: "high", title: "黒い四角の下に、字が残っています", why: "…", detail: "4字", page: 1, rect: [10, 30, 50, 40] };

describe("黒塗りの候補と、片付けたあとの読み直し", () => {
  it("読み直しで残っているのが黒塗りの候補だけなら、全部緑", () => {
    const before = buildView(summary([rule({ pattern: "P6", label: "見せかけの黒塗り", items: [p6] }), rule({ pattern: "P13", label: "個人情報らしい字", items: [candidate] })]));
    const after = buildView(summary([rule({ pattern: "P6", label: "見せかけの黒塗り" }), rule({ pattern: "P13", label: "個人情報らしい字", items: [candidate] })]));
    const c = buildCleanView({ before, after, removed: [], notDone: [], decrypted: false });
    expect(c.left).toBe(0);
    expect(c.verdict).toBe("clean");
    expect(c.scope).not.toContain("P13");
  });

  it("ほかの型が残っていれば、その数だけを残りとして数える", () => {
    const after = buildView(summary([rule({ pattern: "P6", label: "見せかけの黒塗り", items: [p6] }), rule({ pattern: "P13", label: "個人情報らしい字", items: [candidate, candidate] })]));
    const c = buildCleanView({ before: after, after, removed: [], notDone: [], decrypted: false });
    expect(c.left).toBe(1);
    expect(c.verdict).toBe("left");
  });

  it("候補のほかに知らせること（調べられなかった所など）があれば、全部緑と言わない", () => {
    const after = buildView(
      summary([
        rule({
          pattern: "P13",
          label: "個人情報らしい字",
          items: [candidate],
          notices: [{ kind: "partial", message: "このページには、中身を読み取れない字があります。", pages: [1] }],
        }),
      ]),
    );
    const c = buildCleanView({ before: after, after, removed: [], notDone: [], decrypted: false });
    expect(c.left).toBe(0);
    expect(c.verdict).toBe("unsure");
  });
});

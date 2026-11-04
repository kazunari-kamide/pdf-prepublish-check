// SPDX-License-Identifier: AGPL-3.0-only
//
// 「見た所・見なかった所」（src/ui/coverage.ts）と、結論の3つの分け方（src/ui/model.ts）を確かめる。

import { describe, expect, it } from "vitest";
import type { InspectSummary, Item, RuleResult } from "../src/inspect/report";
import { RULES } from "../src/inspect/rules";
import { buildCoverage, CATALOG } from "../src/ui/coverage";
import { buildView } from "../src/ui/model";

const rule = (over: Partial<RuleResult>): RuleResult => ({
  ruleId: "p6-text",
  ruleVersion: "1",
  label: "見せかけの黒塗り",
  pattern: "P6",
  status: "ok",
  items: [],
  notices: [],
  ...over,
});
const summary = (rules: RuleResult[]): InspectSummary => ({ pages: [{ page: 1, view: [0, 0, 100, 100], rotate: 0 }], pagesUnreadable: false, rules });
const item = (over: Partial<Item> = {}): Item => ({ pattern: "P6", severity: "high", title: "t", why: "w", detail: "d", page: 1, rect: [0, 0, 1, 1], ...over });
const row = (s: InspectSummary, key: string) => buildCoverage(s).find((r) => r.key === key)!;

describe("見た所・見なかった所", () => {
  it("P1〜P12 と新しい型を、毎回1行ずつ並べる", () => {
    const keys = buildCoverage(summary([])).map((r) => r.key);
    expect(keys).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12", "個人情報", "お知らせ"]);
  });

  it("ルールのない型は「この版では調べていない」とし、理由を添える", () => {
    const p3 = row(summary([rule({})]), "P3");
    expect(p3.state).toBe("not_in_version");
    expect(p3.reasons[0]).toMatch(/この版では調べていません/);
  });

  it("いまの一覧（RULES）で、P3 と個人情報のほかは、どの型にもルールがある", () => {
    const missing = CATALOG.filter((c) => !RULES.some((r) => c.match({ ...rule({}), ruleId: r.id, pattern: r.pattern, label: r.label })));
    expect(missing.map((c) => c.key)).toEqual(["P3", "個人情報"]);
  });

  it("省いたページ・読み解けなかった画像は「一部だけ」とし、ページ番号を添える", () => {
    const r = row(
      summary([
        rule({
          notices: [
            { kind: "skipped_pages", message: "省いた", pages: [3], reason: "heavy" },
            { kind: "unchecked_images", message: "読めない", pages: [2, 1] },
          ],
        }),
      ]),
      "P6",
    );
    expect(r.state).toBe("partial");
    expect(r.reasons).toEqual(["図形が多すぎるため、ページ 3 を省きました。", "ページ 1、2 に、読み解けなかった画像があります。"]);
  });

  it("暗号などで調べられなかった型は「調べられなかった」とし、ルールの理由を添える", () => {
    const r = row(summary([rule({ status: "error", message: "パスワードが要る PDF は、調べられません。" })]), "P6");
    expect(r).toMatchObject({ state: "failed", reasons: ["パスワードが要る PDF は、調べられません。"] });
  });

  it("同じ型の一部のルールだけが止まったら「一部だけ」とし、止まったルールの名前を添える", () => {
    const r = row(
      summary([
        rule({ ruleId: "p7-hidden", label: "隠れたテキスト", pattern: "P7" }),
        rule({ ruleId: "font-glyphs", label: "書体に残った字形", pattern: "P7", status: "error", message: "止まりました。" }),
      ]),
      "P7",
    );
    expect(r.state).toBe("partial");
    expect(r.reasons).toEqual(["「書体に残った字形」は調べられませんでした。止まりました。"]);
  });

  it("見つかった数と、確かめてほしい数を分けて数える", () => {
    const r = row(summary([rule({ items: [item(), item({ confidence: "check" }), item()] })]), "P6");
    expect(r).toMatchObject({ state: "checked", found: 2, check: 1 });
  });

  it("お知らせの行は、XFA・来歴のお知らせの数を数える（縮小画像は P5 の行）", () => {
    const s = summary([
      rule({
        ruleId: "extras",
        label: "ページの縮小画像",
        pattern: "P5",
        items: [item({ pattern: "P5", rect: null })],
        notices: [{ kind: "info", message: "XFA", pages: [] }],
      }),
    ]);
    expect(row(s, "お知らせ")).toMatchObject({ state: "checked", found: 1 });
    expect(row(s, "P5")).toMatchObject({ state: "checked", found: 1 });
  });
});

describe("結論の3つの分け方", () => {
  it("言い切れる所があれば「見つかった」。確かめてほしい所の数は別に添える", () => {
    const v = buildView(summary([rule({ items: [item(), item({ confidence: "check" })] })]));
    expect(v.verdict).toBe("found");
    expect(v.headline).toBe("見た目では分からない情報が、1 か所見つかりました。ほかに、確かめてほしい所が 1 か所あります。");
    expect(v.rows.map((r) => r.check)).toEqual([false, true]);
  });

  it("確かめてほしい所だけなら、断定しない", () => {
    const v = buildView(summary([rule({ items: [item({ confidence: "check" })] })]));
    expect(v.verdict).toBe("found");
    expect(v.headline).toBe("見た目では分からない情報が残っているかもしれない所が、1 か所あります。確かめてください。");
  });

  it("見つからず、調べきれなかった所もなければ「調べた範囲では見つからなかった」", () => {
    expect(buildView(summary([rule({})])).verdict).toBe("none");
  });

  it("見つからなくても、調べきれなかった所があれば「調べきれなかった」", () => {
    const v = buildView(summary([rule({ status: "error", message: "読めません。" })]));
    expect(v.verdict).toBe("incomplete");
    expect(v.clean).toBe(false);
  });

  it("「安全です」「問題なし」とは言わない", () => {
    for (const s of [summary([rule({})]), summary([rule({ status: "error", message: "x" })]), summary([rule({ items: [item()] })])]) {
      const v = buildView(s);
      const words = [v.headline, ...v.coverage.flatMap((c) => c.reasons)].join("");
      expect(words).not.toMatch(/安全です|問題なし/);
    }
  });
});

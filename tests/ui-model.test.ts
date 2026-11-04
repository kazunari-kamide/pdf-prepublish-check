// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査の結果を画面の形に直す計算（src/ui/model.ts）。お知らせのまとめ方と「全部緑」の条件を確かめる。

import { describe, expect, it } from "vitest";
import type { InspectSummary, RuleResult } from "../src/inspect/report";
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

describe("画面の形", () => {
  it("何も見つからず、省いた所もなければ「全部緑」", () => {
    const v = buildView(summary([rule({})]));
    expect(v.clean).toBe(true);
    expect(v.tone).toBe("ok");
    expect(v.verdict).toBe("none");
    expect(v.headline).toBe("調べた範囲では、見つかりませんでした。");
    expect(v.coverage.find((c) => c.key === "P6")).toMatchObject({ state: "checked", found: 0, reasons: [] });
  });

  it("調べなかった画像があれば、見つからなくても「全部緑」にしない。ページ番号をまとめて出す", () => {
    const msg = "このページの画像は調べていません（画像の形式を読めなかったため）。";
    const v = buildView(
      summary([
        rule({ notices: [{ kind: "unchecked_images", message: msg, pages: [3, 1] }] }),
        rule({ ruleId: "p7-hidden", notices: [{ kind: "unchecked_images", message: msg, pages: [1, 2] }] }),
      ]),
    );
    expect(v.clean).toBe(false);
    expect(v.notices).toEqual([`${msg}（ページ 1、2、3）`]);
  });

  it("省いたページは、どのルールが省いたかを添える", () => {
    const v = buildView(summary([rule({ ruleId: "p7-hidden", label: "隠れたテキスト", pattern: "P7", notices: [{ kind: "skipped_pages", message: "省きました。", pages: [1] }] })]));
    expect(v.notices).toEqual(["隠れたテキスト（P7）：省きました。（ページ 1）"]);
    expect(v.clean).toBe(false);
  });

  it("暗号化をほどいた知らせだけなら「全部緑」のまま", () => {
    const v = buildView(summary([rule({ notices: [{ kind: "decrypted", message: "ほどいた", pages: [] }] })]));
    expect(v.clean).toBe(true);
    expect(v.notices).toEqual(["ほどいた"]);
  });

  it("調べられなかったルールがあれば「全部緑」にせず、別に並べる", () => {
    const v = buildView(summary([rule({ status: "error", message: "パスワードが要る PDF は、調べられません。" })]));
    expect(v.clean).toBe(false);
    expect(v.unchecked).toEqual(["見せかけの黒塗り（P6）：パスワードが要る PDF は、調べられません。"]);
  });

  it("深刻度の高いものから並べ、番号をふり、ページの上の枠と番号をそろえる", () => {
    const v = buildView(
      summary([
        rule({
          ruleId: "p1-info",
          label: "文書情報",
          pattern: "P1",
          items: [{ pattern: "P1", severity: "medium", title: "a", why: "", detail: "", page: null, rect: null }],
        }),
        rule({ items: [{ pattern: "P6", severity: "high", title: "b", why: "", detail: "", page: 1, rect: [0, 0, 10, 10] }] }),
      ]),
    );
    expect(v.rows.map((r) => [r.no, r.title, r.pageLabel])).toEqual([
      [1, "b", "1"],
      [2, "a", "ファイル全体"],
    ]);
    expect(v.pages).toHaveLength(1);
    expect(v.pages[0]!.marks.map((m) => m.no)).toEqual([1]);
  });

  it("型ごとにまとめ、見つからなかった型も並べる", () => {
    const v = buildView(
      summary([
        rule({ items: [{ pattern: "P6", severity: "high", title: "b", why: "", detail: "", page: 1, rect: [0, 0, 10, 10] }] }),
        rule({ ruleId: "p9-attach", label: "添付ファイル", pattern: "P9" }),
        rule({ ruleId: "p1-info", label: "文書情報", pattern: "P1", status: "error", message: "読めません。" }),
      ]),
    );
    expect(v.groups.map((g) => [g.label, g.status, g.rows.map((r) => r.no), g.message])).toEqual([
      ["見せかけの黒塗り", "ok", [1], null],
      ["添付ファイル", "ok", [], null],
      ["文書情報", "error", [], "読めません。"],
    ]);
  });

  it("図形が多すぎて省いたページを、ルールをまたいでまとめる（絵も描かない）", () => {
    const heavy = (pages: number[]) => ({ kind: "skipped_pages" as const, message: "省きました。", pages, reason: "heavy" as const });
    const broken = { kind: "skipped_pages" as const, message: "読めませんでした。", pages: [9], reason: "unreadable" as const };
    const v = buildView(summary([rule({ notices: [heavy([3, 1])] }), rule({ ruleId: "p7-hidden", notices: [heavy([3]), broken] })]));
    expect(v.heavyPages).toEqual([1, 3]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 「整える」を押す前の確かめの文と、処理中の帯の字（src/ui/tidy-confirm.ts。7 の案 A。2026-11-06）。

import { describe, expect, it } from "vitest";
import { ALWAYS_REMOVED, bandProgressRatio, bandProgressText, buildTidyConfirm, propertySummary } from "../src/ui/tidy-confirm";

const tiers = [
  { key: "high" as const, label: "▲ 高", count: 1 },
  { key: "check" as const, label: "？ 確かめる", count: 1 },
  { key: "medium" as const, label: "■ 中", count: 64 },
  { key: "low" as const, label: "● 低", count: 21 },
  { key: "candidate" as const, label: "ｉ 個人情報の候補", count: 3 },
];

describe("押す前の確かめ", () => {
  it("見えない情報の数を段ごとに並べ、候補は数に入れない", () => {
    const c = buildTidyConfirm({ tiers, picks: 0, properties: "プロパティは、すべて消します。" });
    expect(c.lead).toBe("見えない情報 87 か所を消した PDF を、新しく作ります。元の PDF は変えません。");
    expect(c.counts).toBe("▲ 高 1 か所・？ 確かめる 1 か所・■ 中 64 か所・● 低 21 か所");
    expect(c.notes).toContain("個人情報の候補（見えている字）3 か所は、黒塗りにしません（一覧の「黒塗りに加える」で加えられます）。");
    expect(c.notes).toContain("プロパティは、すべて消します。");
    expect(c.notes).toContain(ALWAYS_REMOVED);
    expect(c.run).toBe("87 か所を整える");
  });

  it("自分で選んだ所は、数に足して伝える", () => {
    const c = buildTidyConfirm({ tiers, picks: 2, properties: "" });
    expect(c.notes[0]).toBe("自分で選んだ 2 か所も、黒塗りにします。");
    expect(c.notes[1]).toMatch(/押した所だけ/);
    expect(c.run).toBe("89 か所を整える");
  });

  it("何も見つからないときも、作るものと元の PDF のことを伝える", () => {
    const c = buildTidyConfirm({ tiers: [], picks: 0, properties: "", shrink: "10MB" });
    expect(c.lead).toMatch(/^見つかった所はありませんが/);
    expect(c.counts).toBe("");
    expect(c.notes).toEqual([ALWAYS_REMOVED, "整えて読み直したあとに、選んだ上限（10MB）まで小さくします。"]);
    expect(c.run).toBe("整える");
  });
});

describe("プロパティの一文（実際の選びの数。案内の先は「整える内容」）", () => {
  const all = (m: "remove" | "keep" | "set") => Array.from({ length: 8 }, () => m);
  it("全部消すとき", () => {
    expect(propertySummary(all("remove"))).toBe("プロパティは、8 項目とも消します（「整える内容」で変えられます）。");
  });
  it("消す・書き直す・そのままが混ざるとき", () => {
    const m = [...all("remove").slice(0, 6), "set" as const, "keep" as const];
    expect(propertySummary(m)).toBe("プロパティは、8 項目のうち、6 項目を消し、1 項目を書き直し、1 項目をそのまま残します（「整える内容」で変えられます）。ほかの欄（独自の欄・履歴など）は消します。");
  });
  it("消すものがないとき", () => {
    expect(propertySummary(all("set"))).toBe("プロパティは、8 項目のうち、8 項目を書き直します（「整える内容」で変えられます）。ほかの欄（独自の欄・履歴など）は消します。");
  });
  it("古い案内（プロパティの一覧で選ぶ）を出さない", () => {
    for (const m of [all("remove"), all("keep")]) expect(propertySummary(m)).not.toMatch(/プロパティの一覧/);
  });
});

describe("処理中の帯", () => {
  it("段階と読み直しの数を出す", () => {
    expect(bandProgressText("tidy")).toBe("1 整えています… → 2 読み直す");
    expect(bandProgressText("verify", { done: 6, total: 19 })).toBe("1 整えた ✓ → 2 読み直しています（調べる種類 7/19）");
    expect(bandProgressText("verify", { done: 19, total: 19 })).toBe("1 整えた ✓ → 2 読み直しています（調べる種類 19/19）");
    expect(bandProgressText("verify")).toBe("1 整えた ✓ → 2 読み直しています");
  });
  it("割合は、整える段は半分の手前、読み直しで半分から全部まで", () => {
    expect(bandProgressRatio("tidy")).toBeLessThan(0.5);
    expect(bandProgressRatio("verify", { done: 0, total: 19 })).toBe(0.5);
    expect(bandProgressRatio("verify", { done: 19, total: 19 })).toBe(1);
    expect(bandProgressRatio("verify", { done: 40, total: 19 })).toBe(1);
  });
});

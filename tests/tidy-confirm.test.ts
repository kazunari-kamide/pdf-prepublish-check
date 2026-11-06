// SPDX-License-Identifier: AGPL-3.0-only
//
// 「整える」を押す前の確かめの文と、処理中の帯の字（src/ui/tidy-confirm.ts。7 の案 A。2026-11-06）。

import { describe, expect, it } from "vitest";
import { bandProgressRatio, bandProgressText, buildTidyConfirm, propertySummary } from "../src/ui/tidy-confirm";

const tiers = [
  { key: "high" as const, label: "▲ 高", count: 1 },
  { key: "check" as const, label: "？ 確かめる", count: 1 },
  { key: "medium" as const, label: "■ 中", count: 64 },
  { key: "low" as const, label: "● 低", count: 21 },
  { key: "candidate" as const, label: "ｉ 個人情報の候補", count: 3 },
];

describe("押す前の確かめ（ふだんの言い方の 3 行。2026-11-07 本人が承認した案 A）", () => {
  it("見つかった数は段ごとの数と種類で 1 行。候補は数に入れない", () => {
    const c = buildTidyConfirm({ tiers, picks: 0, properties: "プロパティは、すべて消します。", kinds: [{ name: "見せかけの黒塗り", count: 2 }, { name: "文書情報", count: 85 }], propsFilled: 4 });
    expect(c.lead).toBe("次のものを消した PDF を、新しく作ります。元の PDF は、そのまま残ります。");
    expect(c.items.map((i) => i.head)).toEqual(["見つかった 87 か所", "プロパティ（作った人の名前などを書く欄）", "見えない所にしまわれた情報"]);
    expect(c.items[0]!.text).toBe("見せかけの黒塗り 2 か所・文書情報 85 か所（▲ 高 1・？ 確かめる 1・■ 中 64・● 低 21）。");
    expect(c.items[1]!.text).toBe("プロパティは、すべて消します。");
    expect(c.notes).toContain("個人情報の候補（見えている字）3 か所は、黒塗りにしません（「詳しく見る」の中の「黒塗りに加える」で加えられます）。");
    expect(c.hint).toBe("消すのは、新しく作る PDF だけです。");
    expect(c.run).toBe("87 か所を整える");
  });

  it("窓の本文には専門の名前を出さず、「専門の名前で見る」の中だけに出す", () => {
    const c = buildTidyConfirm({ tiers, picks: 0, properties: "プロパティは、8 項目とも消します。" });
    const body = [c.lead, ...c.items.flatMap((i) => [i.head, i.text]), ...c.notes].join("");
    expect(body).not.toMatch(/XMP|JavaScript|増分更新|メタデータ/);
    expect(c.items.at(-1)!.text).toBe("作ったときの記録・前の版の残り・添付ファイル・書き込みのメモ・開くと動く仕掛け。あれば、まとめて消します。");
    expect(c.tech).toBe("作ったときの記録＝XMP メタデータ、前の版の残り＝増分更新、添付ファイル＝埋め込みファイル、書き込みのメモ＝注釈とコメント、開くと動く仕掛け＝JavaScript と外の動作。");
  });

  it("プロパティが空のときは、空だったと言う", () => {
    const c = buildTidyConfirm({ tiers, picks: 0, properties: "プロパティは、8 項目とも消します。", propsFilled: 0 });
    expect(c.items[1]!.text).toBe("今回は、どの欄も空でした。");
  });

  it("自分で選んだ所は、数に足して伝える", () => {
    const c = buildTidyConfirm({ tiers, picks: 2, properties: "" });
    expect(c.notes[0]).toBe("自分で選んだ 2 か所も、黒塗りにします。");
    expect(c.notes[1]).toMatch(/押した所だけ/);
    expect(c.run).toBe("89 か所を整える");
    // プロパティを調べられなかったときは、プロパティの行を出さない
    expect(c.items.map((i) => i.head)).not.toContain("プロパティ（作った人の名前などを書く欄）");
  });

  it("何も見つからないときも、作るものと元の PDF のことを伝える", () => {
    const c = buildTidyConfirm({ tiers: [], picks: 0, properties: "", shrink: "10MB" });
    expect(c.lead).toMatch(/^見つかった所はありませんが/);
    expect(c.items.map((i) => i.head)).toEqual(["見えない所にしまわれた情報"]);
    expect(c.notes).toEqual(["整えて読み直したあとに、選んだ上限（10MB）まで小さくします。"]);
    expect(c.run).toBe("整える");
  });
});

describe("プロパティの一文（実際の選びの数。案内の先は「詳しく見る」の「整える内容」）", () => {
  const all = (m: "remove" | "keep" | "set") => Array.from({ length: 8 }, () => m);
  it("全部消すとき", () => {
    expect(propertySummary(all("remove"))).toBe("プロパティは、8 項目とも消します（「詳しく見る」の「整える内容」で変えられます）。");
  });
  it("消す・書き直す・そのままが混ざるとき", () => {
    const m = [...all("remove").slice(0, 6), "set" as const, "keep" as const];
    expect(propertySummary(m)).toBe("プロパティは、8 項目のうち、6 項目を消し、1 項目を書き直し、1 項目をそのまま残します（「詳しく見る」の「整える内容」で変えられます）。ほかの欄（独自の欄・履歴など）は消します。");
  });
  it("消すものがないとき", () => {
    expect(propertySummary(all("set"))).toBe("プロパティは、8 項目のうち、8 項目を書き直します（「詳しく見る」の「整える内容」で変えられます）。ほかの欄（独自の欄・履歴など）は消します。");
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

// SPDX-License-Identifier: AGPL-3.0-only
//
// 整える内容を種類ごとに選ぶ（5 の案 B。2026-11-06 本人が決定。D168）の画面の計算：
// 最初の印（defaultOn と例外）・外せない行・外した種類の数え方（読み直しと結果・保存の確認）・押す前の確かめ・種類ごとの数の表・報告書。
// 中身はすべて架空。

import { describe, expect, it } from "vitest";
import type { InspectSummary, Item, RuleResult } from "../src/inspect/report";
import { buildCleanView, CONFIRM_LABEL, PATTERN_NAME, SAVE_NOTE, saveGate, saveTexts } from "../src/ui/clean-model";
import { buildKeepRows, DEFAULT_ON_EXCEPTIONS, defaultOn, initialKept, keepList, keptCount, keptSummary, tierCounts } from "../src/ui/keep-model";
import { buildView } from "../src/ui/model";
import { beforeAfterCounts, buildProcessReport } from "../src/ui/process-report";
import { alwaysRemovedText, buildTidyConfirm, sanitizeListText } from "../src/ui/tidy-confirm";

const page = { page: 1, view: [0, 0, 595, 842] as [number, number, number, number], rotate: 0 as const };
const rule = (over: Partial<RuleResult> & Pick<RuleResult, "pattern" | "label">): RuleResult => ({
  ruleId: `${over.pattern.toLowerCase()}-${over.label.length}`,
  ruleVersion: "1",
  status: "ok",
  items: [],
  notices: [],
  ...over,
});
const summary = (rules: RuleResult[]): InspectSummary => ({ pages: [page], pagesUnreadable: false, rules });
const item = (pattern: Item["pattern"], severity: Item["severity"], over: Partial<Item> = {}): Item => ({ pattern, severity, title: `${pattern} の見本`, why: "…", detail: "1 か所", page: 1, rect: [10, 10, 50, 20], ...over });

const p6 = item("P6", "high");
const p8a = item("P8", "medium");
const p8b = item("P8", "low");
const p9 = item("P9", "high");
const p11 = item("P11", "low");
const p12 = item("P12", "low");
const p5 = item("P5", "medium");

const before = buildView(
  summary([
    rule({ pattern: "P6", label: "見せかけの黒塗り", items: [p6] }),
    rule({ pattern: "P8", label: "注釈", items: [p8a, p8b] }),
    rule({ pattern: "P9", label: "添付", items: [p9] }),
    rule({ pattern: "P11", label: "フォーム", items: [p11] }),
    rule({ pattern: "P12", label: "スクリプト", items: [p12] }),
    rule({ pattern: "P5", label: "前の版", items: [p5] }),
  ]),
);
const nameOf = (p: string) => PATTERN_NAME[p] ?? p;

describe("最初の印（defaultOn）", () => {
  it("高か確かめるを 1 件でも含む種類だけに印を入れる", () => {
    expect(defaultOn("P9", [{ key: "high", count: 1 }])).toBe(true);
    expect(defaultOn("P8", [{ key: "check", count: 1 }, { key: "low", count: 3 }])).toBe(true);
    expect(defaultOn("P8", [{ key: "medium", count: 2 }, { key: "low", count: 1 }])).toBe(false);
    expect(defaultOn("P11", [{ key: "low", count: 1 }])).toBe(false);
  });
  it("例外：P12（JavaScript・外の動作）は、段によらず最初から印あり（2026-11-06 本人が決定）", () => {
    expect(DEFAULT_ON_EXCEPTIONS.P12).toBe(true);
    expect(defaultOn("P12", [{ key: "low", count: 1 }])).toBe(true);
    expect(defaultOn("P12", [{ key: "medium", count: 2 }])).toBe(true);
    // 例外のない種類は決まりどおり（P11 は中・低だけなら印なし）
    expect(defaultOn("P11", [{ key: "medium", count: 1 }, { key: "low", count: 1 }])).toBe(false);
  });
});

describe("種類ごとの行", () => {
  const rows = buildKeepRows(before.rows, nameOf);
  const by = Object.fromEntries(rows.map((r) => [r.pattern, r]));
  it("外せる種類は印を付け外しでき、外せない種類は理由つきで印が入ったまま", () => {
    expect(by.P8).toMatchObject({ keepable: true, defaultOn: false, count: 2 });
    expect(tierCounts(by.P8!)).toBe("中 1・低 1");
    expect(by.P9).toMatchObject({ keepable: true, defaultOn: true });
    expect(by.P11).toMatchObject({ keepable: true, defaultOn: false });
    expect(by.P12).toMatchObject({ keepable: true, defaultOn: true });
    expect(by.P6).toMatchObject({ keepable: false, defaultOn: true });
    expect(by.P6!.note).toMatch(/^外せません/);
    expect(by.P5!.note).toContain("必ず消える");
  });
  it("最初に外しておく種類・片付けへ渡す一覧・外す数と一言", () => {
    const kept = initialKept(rows);
    expect([...kept].sort()).toEqual(["P11", "P8"]);
    expect(keepList(kept)).toEqual(["P8", "P11"]);
    expect(keptCount(rows, kept)).toBe(3);
    expect(keptSummary(rows, kept)).toBe(`${PATTERN_NAME.P8} 2 か所・${PATTERN_NAME.P11} 1 か所`);
    // 外せない種類は、外す一覧に入れても渡さない
    expect(keepList(new Set(["P6", "P5", "P8"]))).toEqual(["P8"]);
  });
  it("P10 は、外しても XMP の中の分は消えることを添える", () => {
    const r = buildKeepRows(buildView(summary([rule({ pattern: "P10", label: "写真", items: [item("P10", "high")] })])).rows, nameOf);
    expect(r[0]!.note).toContain("XMP");
  });
});

describe("外した種類の、読み直しと結果", () => {
  // 整えたあと：外した P8（2 件）だけが残っている
  const after = buildView(summary([rule({ pattern: "P6", label: "見せかけの黒塗り" }), rule({ pattern: "P8", label: "注釈", items: [p8a, p8b] })]));

  it("外した種類は「残っている所」に数えず、別の行で必ず並べる。結論は「全部消えた」と読めない形、保存は確認の印つき", () => {
    const c = buildCleanView({ before, after, removed: [], notDone: [], decrypted: false, kept: ["P8"] });
    expect(c.left).toBe(0);
    expect(c.kept).toBe(2);
    expect(c.keptLines).toEqual([`${PATTERN_NAME.P8}（P8）：2 か所を残しています（あなたが「整えない」を選んだ種類）`]);
    expect(c.verdict).toBe("unsure");
    expect(c.headline).toContain("あなたが外した種類");
    expect(c.headline).toContain("「全部消えた」ではありません");
    expect(saveGate(c)).toBe("confirm");
  });

  it("保存の文と印の字：外した種類だけが理由なら「言い切れない」と言わない", () => {
    const c = buildCleanView({ before, after, removed: [], notDone: [], decrypted: false, kept: ["P8"] });
    expect(c.alsoUnsure).toBe(false);
    expect(saveTexts(c)).toEqual({
      note: `あなたが外した種類（${PATTERN_NAME.P8} 2 か所）が残っています。残したまま保存するときだけ、印を付けてください。`,
      label: "外した種類を残したまま保存する",
    });
  });

  it("保存の文と印の字：言い切れない所もあるときは、今の文に外した種類の一文を足す", () => {
    const notDone = [{ pattern: "P6" as const, reason: "unsupported_image" as const, page: 1, label: "塗れない画像がありました" }];
    const c = buildCleanView({ before, after, removed: [], notDone, decrypted: false, kept: ["P8"] });
    expect(c.alsoUnsure).toBe(true);
    expect(c.headline).toContain("消せなかった所か、調べられなかった所もあります");
    expect(saveTexts(c)).toEqual({ note: `${SAVE_NOTE.confirm}あなたが外した種類（${PATTERN_NAME.P8} 2 か所）が残っています。`, label: CONFIRM_LABEL });
  });

  it("保存の文と印の字：外した物がなければ今までどおり", () => {
    const notDone = [{ pattern: "P6" as const, reason: "unsupported_image" as const, page: 1, label: "塗れない画像がありました" }];
    const clean = buildView(summary([rule({ pattern: "P6", label: "見せかけの黒塗り" })]));
    const c = buildCleanView({ before, after: clean, removed: [], notDone, decrypted: false, kept: [] });
    expect(saveTexts(c)).toEqual({ note: SAVE_NOTE.confirm, label: CONFIRM_LABEL });
    const ok = buildCleanView({ before, after: clean, removed: [], notDone: [], decrypted: false });
    expect(saveTexts(ok)).toEqual({ note: SAVE_NOTE.ok, label: CONFIRM_LABEL });
  });

  it("外していない種類が残っていれば、今までどおり「残っている」で保存できない", () => {
    const c = buildCleanView({ before, after, removed: [], notDone: [], decrypted: false, kept: [] });
    expect(c.left).toBe(2);
    expect(c.verdict).toBe("left");
    expect(saveGate(c)).toBe("blocked");
  });

  it("外したが、読み直しで見つからなかったときは、外した行を出さない（全部緑のまま）", () => {
    const clean = buildView(summary([rule({ pattern: "P6", label: "見せかけの黒塗り" }), rule({ pattern: "P8", label: "注釈" })]));
    const c = buildCleanView({ before, after: clean, removed: [], notDone: [], decrypted: false, kept: ["P8"] });
    expect(c.kept).toBe(0);
    expect(c.keptLines).toEqual([]);
    expect(c.verdict).toBe("clean");
  });
});

describe("押す前の確かめ・種類ごとの数の表・報告書に「外した」", () => {
  it("押す前の確かめ：整える数から除き、外す種類を 1 行で並べる", () => {
    const c = buildTidyConfirm({ tiers: before.tiers, picks: 0, properties: "", kept: [{ pattern: "P8", name: PATTERN_NAME.P8!, count: 2 }] });
    expect(c.items[0]!.head).toBe(`見つかった ${before.hidden - 2} か所`);
    expect(c.items[0]!.text).toContain("うち外す 2 か所は消しません");
    expect(c.notes[0]).toBe(`外す（整えずに残す）：${PATTERN_NAME.P8} 2 か所。整えた PDF に残ります。`);
    expect(c.run).toBe(`${before.hidden - 2} か所を整える`);
    // 「書き込みのメモも消します」と「注釈を外す」を並べない（専門の名前の対応からも除く）
    const hidden = c.items.at(-1)!;
    expect(hidden.head).toBe("見えない所にしまわれた情報");
    expect(hidden.text).not.toContain("書き込みのメモ");
    expect(hidden.text).toContain("開くと動く仕掛け");
    expect(c.tech).not.toContain("注釈とコメント");
    expect(c.tech).toContain("JavaScript");
  });

  it("消すものの一覧も、外した種類を除く", () => {
    expect(sanitizeListText()).toContain("注釈とコメント");
    expect(sanitizeListText(new Set(["P8", "P12"]))).not.toMatch(/注釈とコメント|JavaScript/);
    expect(alwaysRemovedText(new Set(["P9"]))).toBe("XMP メタデータ・前の版の残り・注釈とコメント・JavaScript なども消します。");
  });

  it("種類ごとの数の表と報告書に、外した印と行が入る", () => {
    const rows = beforeAfterCounts(before.coverage, before.coverage, ["P8"]);
    expect(rows.find((r) => r.key === "P8")?.kept).toBe(true);
    expect(rows.find((r) => r.key === "P6")?.kept).toBe(false);
    const report = buildProcessReport({
      date: "2026-11-06",
      before: { sha256: "a".repeat(64), bytes: 100, coverage: before.coverage },
      after: { sha256: "b".repeat(64), bytes: 90, pages: 1, coverage: before.coverage },
      removed: [],
      notDone: [],
      verdict: "読み直したところ…",
      rules: [],
      kept: { patterns: ["P8"], lines: ["注釈・コメント（P8）：2 か所を残しています（あなたが「整えない」を選んだ種類）"] },
    });
    expect(report).toContain("■ 外した種類（本人が「整えない」を選んだ。残しています）");
    expect(report).toContain("（外した：整えていません）");
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 「3 片付ける」「4 読み直す」の結果の並べ方（src/ui/clean-model.ts）を確かめる。
// - 残っている所の数は、読み直し（片付けた PDF の検査）の結果だけで決める。片付けの報告は数に使わない
// - 片付けられなかった所・調べられなかった所があれば「全部緑」と言わない
// - 読み直しで調べていない型は、そうと書く

import { describe, expect, it } from "vitest";
import type { NotDoneItem, RemovedItem } from "../sanitize/types.ts";
import type { InspectSummary, RuleResult } from "../src/inspect/report";
import { buildCleanView, cleanedFileName, MAX_LINES_PER_GROUP } from "../src/ui/clean-model";
import { buildView } from "../src/ui/model";
import { scopeCaveats } from "../src/ui/scope";

const page = { page: 1, view: [0, 0, 595, 842] as [number, number, number, number], rotate: 0 as const };

function rule(over: Partial<RuleResult> & Pick<RuleResult, "pattern" | "label">): RuleResult {
  return { ruleId: over.pattern.toLowerCase(), ruleVersion: "1", status: "ok", items: [], notices: [], ...over };
}

function summary(rules: RuleResult[]): InspectSummary {
  return { pages: [page], pagesUnreadable: false, rules };
}

const found = summary([
  rule({
    pattern: "P6",
    label: "見せかけの黒塗り",
    items: [{ pattern: "P6", severity: "high", title: "黒い四角の下に字が残っています", why: "コピーで取り出せます。", detail: "4字", page: 1, rect: [10, 10, 50, 20] }],
  }),
  rule({ pattern: "P1", label: "文書情報" }),
]);
const empty = summary([rule({ pattern: "P6", label: "見せかけの黒塗り" }), rule({ pattern: "P1", label: "文書情報" })]);

const removed: RemovedItem[] = [
  { pattern: "P6", kind: "covered_text", label: "黒い四角の下に残っていた字（4 字）", count: 4, page: 1, rect: [10, 10, 50, 20] },
  { pattern: "P1", kind: "docinfo", label: "文書のプロパティの欄（2 個）を消しました", count: 2 },
  { pattern: "P12", kind: "javascript", label: "JavaScript（1 か所）を外しました", count: 1 },
];

describe("片付けた結果", () => {
  it("読み直して 0 件・片付けられなかった所なし → 全部緑", () => {
    const c = buildCleanView({ before: buildView(found), after: buildView(empty), removed, notDone: [], decrypted: false });
    expect(c.verdict).toBe("clean");
    expect(c.before).toBe(1);
    expect(c.left).toBe(0);
    expect(c.headline).toContain("調べた項目で残っている所は 0 件");
  });

  it("残っている数は読み直しの結果で決める（片付けの報告が全部消したと言っても）", () => {
    const c = buildCleanView({ before: buildView(found), after: buildView(found), removed, notDone: [], decrypted: false });
    expect(c.verdict).toBe("left");
    expect(c.left).toBe(1);
  });

  it("片付けられなかった所があれば、0 件でも全部緑と言わない", () => {
    const notDone: NotDoneItem[] = [{ pattern: "P6", reason: "unsupported_image", label: "黒い四角の下の画像を塗りつぶせませんでした", page: 1 }];
    const c = buildCleanView({ before: buildView(found), after: buildView(empty), removed, notDone, decrypted: false });
    expect(c.verdict).toBe("unsure");
    expect(c.notDone).toEqual(["黒い四角の下の画像を塗りつぶせませんでした（ページ 1）"]);
    expect(c.headline).toContain("「全部消えた」ではありません");
  });

  it("読み直しで調べられなかった型があれば、全部緑と言わない", () => {
    const broken = summary([rule({ pattern: "P6", label: "見せかけの黒塗り" }), rule({ pattern: "P1", label: "文書情報", status: "error", message: "調べられませんでした。" })]);
    const c = buildCleanView({ before: buildView(found), after: buildView(broken), removed, notDone: [], decrypted: false });
    expect(c.verdict).toBe("unsure");
    expect(c.scope).toContain("見せかけの黒塗り（P6）");
    expect(c.scope).not.toContain("文書情報（P1）");
  });

  it("読み直せなかったら、残っていないとは言わない", () => {
    const c = buildCleanView({ before: buildView(found), after: null, removed, notDone: [], decrypted: false });
    expect(c.verdict).toBe("unsure");
    expect(c.left).toBeNull();
  });

  it("取り除いたものを型ごとにまとめ、読み直しで調べていない型を書く", () => {
    const c = buildCleanView({ before: buildView(found), after: buildView(empty), removed, notDone: [], decrypted: true });
    expect(c.removed.map((g) => g.pattern)).toEqual(["P6", "P1", "P12"]);
    expect(c.removed[0]!.lines).toEqual(["黒い四角の下に残っていた字（4 字）（ページ 1）"]);
    expect(c.scope).toContain("P12 は片付けましたが、読み直しでは調べていません");
    expect(c.notes[0]).toContain("暗号化");
    expect(c.doneMarks).toEqual([{ page: 1, rect: [10, 10, 50, 20], label: "黒い四角の下に残っていた字（4 字）" }]);
  });

  it("1つの型の行が多すぎるときは、数だけにする", () => {
    const many: RemovedItem[] = Array.from({ length: MAX_LINES_PER_GROUP + 5 }, (_, i) => ({
      pattern: "P7",
      kind: "hidden_text",
      label: `白い字（${i + 1} 字）`,
      count: i + 1,
      page: 1,
    }));
    const c = buildCleanView({ before: buildView(found), after: buildView(empty), removed: many, notDone: [], decrypted: false });
    expect(c.removed[0]!.total).toBe(MAX_LINES_PER_GROUP + 5);
    expect(c.removed[0]!.lines).toHaveLength(MAX_LINES_PER_GROUP + 1);
    expect(c.removed[0]!.lines.at(-1)).toBe("ほか 5 件");
  });
});

describe("保存するファイルの名前", () => {
  it("元の名前の後ろに「_片付け済み」をつける", () => {
    expect(cleanedFileName("報告書.pdf")).toBe("報告書_片付け済み.pdf");
    expect(cleanedFileName("a.PDF")).toBe("a_片付け済み.pdf");
    expect(cleanedFileName(".pdf")).toBe("document_片付け済み.pdf");
  });
});

describe("読み直しで調べていない層の一言（src/ui/scope.ts）", () => {
  const CAVEAT = "P6 のうち、画像の下の中身は、読み直しではまだ調べていません。";

  it("P6 を調べられたときは、画像の下の中身を調べていないと添える", () => {
    const c = buildCleanView({ before: buildView(found), after: buildView(empty), removed, notDone: [], decrypted: false });
    expect(c.scope).toContain(CAVEAT);
  });

  it("P6 を調べられなかったときは添えない（調べた型に P6 が入らないため）", () => {
    const broken = summary([rule({ pattern: "P6", label: "見せかけの黒塗り", status: "error", message: "調べられませんでした。" })]);
    expect(scopeCaveats(broken.rules)).toEqual([]);
    const c = buildCleanView({ before: buildView(found), after: buildView(broken), removed, notDone: [], decrypted: false });
    expect(c.scope).not.toContain(CAVEAT);
  });

  it("出す所は1か所：ViewModel の caveats は scopeCaveats と同じ", () => {
    expect(buildView(empty).caveats).toEqual(scopeCaveats(empty.rules));
  });
});

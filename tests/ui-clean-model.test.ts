// SPDX-License-Identifier: AGPL-3.0-only
//
// 「3 片付ける」「4 読み直す」の結果の並べ方（src/ui/clean-model.ts）を確かめる。
// - 残っている所の数は、読み直し（片付けた PDF の検査）の結果だけで決める。片付けの報告は数に使わない
// - 片付けられなかった所・調べられなかった所があれば「全部緑」と言わない
// - 読み直しで調べていない型は、そうと書く

import { describe, expect, it } from "vitest";
import type { NotDoneItem, RemovedItem } from "../sanitize/types.ts";
import type { InspectSummary, RuleResult } from "../src/inspect/report";
import { buildCleanView, cleanedFileName, saveGate, MAX_LINES_PER_GROUP, patternWithName, SELF_GROUP_NAME } from "../src/ui/clean-model";
import { RULES } from "../src/inspect/rules";
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

describe("整えた結果", () => {
  it("読み直して 0 件・消せなかった所なし → 全部緑", () => {
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

  it("消せなかった所があれば、0 件でも全部緑と言わない", () => {
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
    // 調べた種類の一覧は「見た所・見なかった所」と重なるので並べない。P1 は「消したが、読み直しでは調べていない」の側に名前で出る
    expect(c.scope).not.toContain("見せかけの黒塗り");
    expect(c.scope).toMatch(/^文書情報・スクリプト・外部動作は消しましたが/);
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
    expect(c.scope).toContain("スクリプト・外部動作は消しましたが、読み直しでは調べていません");
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
  it("元の名前の後ろに「_整えた」をつける", () => {
    expect(cleanedFileName("報告書.pdf")).toBe("報告書_整えた.pdf");
    expect(cleanedFileName("a.PDF")).toBe("a_整えた.pdf");
    expect(cleanedFileName(".pdf")).toBe("document_整えた.pdf");
  });
});

describe("読み直しで調べていない所の一言（src/ui/scope.ts）", () => {
  const CAVEAT = "P6 のうち、読み解けなかった画像の下の中身は、調べていません。";
  const unread = summary([
    rule({ pattern: "P6", label: "見せかけの黒塗り", notices: [{ kind: "unchecked_images", message: "読めない", pages: [2] }] }),
  ]);

  it("P6 で読み解けなかった画像があれば、その下を調べていないと添える", () => {
    const c = buildCleanView({ before: buildView(found), after: buildView(unread), removed, notDone: [], decrypted: false });
    expect(c.scope).toContain(CAVEAT);
  });

  it("読み解けなかった画像がなければ添えない（画像の層も調べたため）", () => {
    const c = buildCleanView({ before: buildView(found), after: buildView(empty), removed, notDone: [], decrypted: false });
    expect(c.scope).not.toContain(CAVEAT);
  });

  it("P6 を調べられなかったときは添えない（調べた型に P6 が入らないため）", () => {
    const broken = summary([rule({ pattern: "P6", label: "見せかけの黒塗り", status: "error", message: "調べられませんでした。" })]);
    expect(scopeCaveats(broken.rules)).toEqual([]);
    const c = buildCleanView({ before: buildView(found), after: buildView(broken), removed, notDone: [], decrypted: false });
    expect(c.scope).not.toContain(CAVEAT);
  });

  it("出す所は1か所：ViewModel の caveats は scopeCaveats と同じ", () => {
    expect(buildView(unread).caveats).toEqual(scopeCaveats(unread.rules));
  });
});

describe("保存のボタンを押せるか（saveGate）", () => {
  it("読み直しが通ったときだけ、そのまま押せる", () => {
    expect(saveGate({ verdict: "clean", left: 0 })).toBe("ok");
  });
  it("残りは 0 件でも、言い切れない所があれば、分かったうえでの印が要る", () => {
    expect(saveGate({ verdict: "unsure", left: 0 })).toBe("confirm");
  });
  it("残っている所がある・読み直せなかったときは押せない", () => {
    expect(saveGate({ verdict: "left", left: 2 })).toBe("blocked");
    expect(saveGate({ verdict: "unsure", left: null })).toBe("blocked");
  });
});

describe("見つかった所と、念のため消したもの（数が合わないように見せない）", () => {
  it("確かめた画面に項目があった種類だけを found にし、その項目の数を seen に入れる", () => {
    const c = buildCleanView({ before: buildView(found), after: buildView(empty), removed, notDone: [], decrypted: false });
    expect(c.removed.map((g) => [g.pattern, g.found, g.seen, g.total])).toEqual([
      ["P6", true, 1, 1],
      ["P1", false, 0, 1],
      ["P12", false, 0, 1],
    ]);
  });
});

describe("読み直しの範囲の文", () => {
  it("読み直しで調べた種類の一覧は並べない（「見た所・見なかった所」と重なるため）", () => {
    const after = summary([
      rule({ ruleId: "p7-hidden", pattern: "P7", label: "隠れたテキスト" }),
      rule({ ruleId: "font-glyphs", pattern: "P7", label: "書体に残った字形" }),
      rule({ ruleId: "p4-paths", pattern: "P4", label: "ファイルパス・内部ホスト名" }),
    ]);
    const c = buildCleanView({ before: buildView(found), after: buildView(after), removed: [], notDone: [], decrypted: false });
    expect(c.scope).toBe("");
  });
});

describe("型の名前（「P11（P11）」と番号を重ねない）", () => {
  it("消したが読み直していない種類は、名前で出し、画面に P の番号を出さない", () => {
    const after = buildView(summary([rule({ pattern: "P10", label: "画像の位置情報など" }), rule({ pattern: "P11", label: "フォームの入力値" })]));
    const c = buildCleanView({ before: buildView(empty), after, removed, notDone: [], decrypted: false });
    expect(c.scope).toContain("見せかけの黒塗り・文書情報・スクリプト・外部動作は消しましたが");
    expect(c.scope).not.toMatch(/P\d+/);
  });

  it("いまの一覧（RULES）の型は、どれも名前がある", () => {
    for (const r of RULES) {
      if (!/^P\d+$/.test(r.pattern)) continue;
      expect(patternWithName(r.pattern), r.pattern).not.toBe(r.pattern);
    }
  });

  it("名前の分からない型は、番号だけにする", () => {
    expect(patternWithName("P99")).toBe("P99");
  });
});

describe("自分で選んだ所の黒塗り", () => {
  it("片付けの redact が返した所は、見せかけの黒塗りの片付けと分けて、先頭に並べる", () => {
    const self: RemovedItem[] = [
      { pattern: "P6", kind: "redacted_text", label: "選んだ所の字（3 字）を消しました", count: 3, page: 1, rect: [10, 10, 40, 20] },
      { pattern: "P6", kind: "redaction_box", label: "選んだ所に黒い四角を描きました", count: 1, page: 1, rect: [10, 10, 40, 20] },
    ];
    const c = buildCleanView({ before: buildView(found), after: buildView(empty), removed: [...removed, ...self], notDone: [], decrypted: false });
    expect(c.removed[0]).toMatchObject({ name: SELF_GROUP_NAME, self: true, total: 2 });
    expect(c.removed.find((g) => g.pattern === "P6" && !g.self)?.total).toBe(1);
    expect(c.doneMarks.filter((m) => m.label.startsWith("選んだ所"))).toHaveLength(2);
  });
});

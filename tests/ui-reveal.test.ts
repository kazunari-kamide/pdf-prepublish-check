// SPDX-License-Identifier: AGPL-3.0-only
//
// 見つけた字の中身の出し方（src/ui/reveal.ts）と、報告書に中身を入れるか（src/ui/process-report.ts）。中身はすべて架空。

import { describe, expect, it } from "vitest";
import { buildProcessReport, type ProcessReportInput } from "../src/ui/process-report";
import { cleanContent, fullContent, MAX_DOTS, MAX_SHOWN_CHARS, maskContent, showsWhole } from "../src/ui/reveal";

describe("伏せ方：頭の 2 字と「●」（3 字以下は伏せない）", () => {
  it("4 字以上は頭の 2 字", () => {
    expect(maskContent("見本花子")).toBe("見本●●");
    expect(maskContent("ritsu@kakuu.test")).toBe("ri" + "●".repeat(MAX_DOTS) + "…");
  });
  it("3 字以下は伏せずに全部を出し、「中身を見る」も出さない（2026-11-06 本人が決定）", () => {
    expect(maskContent("見本子")).toBe("見本子");
    expect(maskContent("見本")).toBe("見本");
    expect(maskContent("見")).toBe("見");
    expect(showsWhole("見本子")).toBe(true);
    expect(showsWhole("見本花子")).toBe(false);
    expect(showsWhole("  ")).toBe(false);
  });
  it("字はコードポイントで数える（サロゲートペアの字も 1 字）", () => {
    expect(maskContent("𠮷野家具")).toBe("𠮷野●●");
  });
  it("見えない制御の字・向きを変える字は「�」に、改行は空白にする", () => {
    expect(cleanContent("見‮本​\n花子\u0007")).toBe("見�本� 花子�");
    expect(maskContent("‮‮")).toBe("��");
    expect(maskContent("‮‮‮‮")).toBe("��●●");
  });
  it("全部を出すときも、長すぎるものは切って残りの字数を添える", () => {
    const long = "あ".repeat(MAX_SHOWN_CHARS + 5);
    expect(fullContent(long)).toBe("あ".repeat(MAX_SHOWN_CHARS) + "…（ほか 5 字）");
    expect(fullContent("見本花子")).toBe("見本花子");
  });
  it("空の中身は空", () => {
    expect(maskContent("  ")).toBe("");
  });
});

describe("報告書：中身は、選んだときだけ入れる", () => {
  const base: ProcessReportInput = {
    date: "2026-11-05",
    before: { sha256: "a".repeat(64), bytes: 100, coverage: [] },
    after: { sha256: "b".repeat(64), bytes: 90, pages: 1, coverage: [] },
    removed: [],
    notDone: [],
    verdict: "読み直したところ、調べた項目で残っている所は 0 件でした。",
    rules: ["p6-text@1"],
  };
  const contents = [{ pattern: "P6", page: 1, title: "黒い四角の下に、字が残っています", content: "見本花子" }];

  it("初めは入れない（中身の字も、中身の見出しもない）", () => {
    const text = buildProcessReport(base);
    expect(text).not.toContain("見本花子");
    expect(text).not.toContain("見つけた字の中身");
    expect(text).toContain("字の中身・欄の値・ファイル名を載せていません");
  });
  it("「中身も入れる」を選んだときだけ、型・ページ・題と一緒に入れる", () => {
    const text = buildProcessReport({ ...base, contents });
    expect(text).toContain("■ 見つけた字の中身");
    expect(text).toContain("見せかけの黒塗り（P6）／ページ 1／黒い四角の下に、字が残っています／中身：見本花子");
    expect(text).not.toContain("載せていません。数と場所だけです");
  });
});

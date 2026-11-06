// SPDX-License-Identifier: AGPL-3.0-only
//
// 処理の報告書（src/ui/process-report.ts）。前後の SHA-256・消した所と字数・調べた範囲が入り、中身とファイル名が入らないこと。

import { describe, expect, it } from "vitest";
import type { CoverageRow } from "../src/ui/coverage";
import { beforeAfterCounts, buildProcessReport, sha256Hex } from "../src/ui/process-report";

const cov = (key: string, over: Partial<CoverageRow> = {}): CoverageRow => ({ key, name: `名前${key}`, state: "checked", found: 0, check: 0, reasons: [], ...over });

const input = () => ({
  date: "2026-11-05",
  before: { sha256: "a".repeat(64), bytes: 1000, coverage: [cov("P6", { found: 2, check: 1 }), cov("P1", { found: 1 }), cov("P3", { state: "not_in_version" as const, reasons: ["調べていません。"] })] },
  after: { sha256: "b".repeat(64), bytes: 900, pages: 2, coverage: [cov("P6"), cov("P1"), cov("P3", { state: "not_in_version" as const, reasons: ["調べていません。"] })] },
  removed: [
    { pattern: "P6" as const, kind: "covered_text" as const, label: "黒い四角の下の字を消しました", count: 12, page: 1, rect: [0, 0, 1, 1] as [number, number, number, number] },
    { pattern: "P6" as const, kind: "covered_text" as const, label: "黒い四角の下の字を消しました", count: 3, page: 2 },
    { pattern: "P1" as const, kind: "docinfo" as const, label: "文書のプロパティの欄（2 個）を消しました", count: 2 },
  ],
  notDone: [],
  verdict: "読み直したところ、調べた項目で残っている所は 0 件でした。",
  rules: ["p6-text@1.10.0", "p1-info@1.2.0"],
});

describe("処理の報告書", () => {
  it("前後の SHA-256・消した字数・型ごとの前後の数・調べた範囲・ルールの版が入る", () => {
    const t = buildProcessReport(input());
    expect(t).toContain(`整える前：${"a".repeat(64)}（1000 バイト）`);
    expect(t).toContain(`整えた後：${"b".repeat(64)}（900 バイト・2 ページ）`);
    expect(t).toContain("消した字の数：合わせて 15 字");
    expect(t).toContain("- 見せかけの黒塗り（P6）／ページ 1／黒い四角の下の字を消しました／数：12 字");
    expect(t).toContain("- 名前P6（P6）：3 → 0");
    expect(t).toContain("- 名前P3（P3）：この版では調べていない　理由：調べていません。");
    expect(t).toContain("p6-text@1.10.0、p1-info@1.2.0");
  });

  it("ファイル名を受け取る口がない（入れられない）。中身の代わりに数だけ", () => {
    const t = buildProcessReport(input());
    expect(t).not.toMatch(/\.pdf/);
    expect(t).toContain("ファイル名を載せていません");
  });

  it("読み直せなかったときは、そう書く", () => {
    const i = input();
    const t = buildProcessReport({ ...i, after: { ...i.after, coverage: null } });
    expect(t).toContain("- 名前P6（P6）：3 → 読み直せなかった");
    expect(t).toContain("- 読み直せませんでした。");
  });

  it("前後の数は、見つかった型だけを並べる", () => {
    expect(beforeAfterCounts([cov("P6", { found: 1 }), cov("P1")], [cov("P6"), cov("P1")])).toEqual([{ key: "P6", name: "名前P6", before: 1, after: 0, kept: false }]);
  });

  it("SHA-256 は 16進の小文字 64 字", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

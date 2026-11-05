// SPDX-License-Identifier: AGPL-3.0-only
//
// 結果の欄を詰める計算（src/ui/compact.ts）：内訳を 1 行に・見た所の要約・仕切りの幅の上限と下限。

import { describe, expect, it } from "vitest";
import type { CoverageRow } from "../src/ui/coverage";
import { clampResultsWidth, compactDetail, coverageSummary, RESULTS_MIN_REM, STAGE_MIN_REM } from "../src/ui/compact";

const row = (state: CoverageRow["state"], found = 0, check = 0): CoverageRow => ({ key: "P1", name: "文書情報", state, found, check, reasons: [] });

describe("内訳を 1 行に", () => {
  it("区切りの「／」を「・」にし、空の所を落とす", () => {
    expect(compactDetail("覆っているもの：塗りつぶした図形／残っている字：4字")).toBe("覆っているもの：塗りつぶした図形・残っている字：4字");
    expect(compactDetail("17字")).toBe("17字");
    expect(compactDetail("a／ ／b")).toBe("a・b");
  });
});

describe("見た所・見なかった所の要約", () => {
  const rows = [row("checked", 2), row("checked", 0, 1), row("checked"), row("partial"), row("not_in_version"), row("failed")];
  it("型の数・調べた数・見つかった型の数と、言い切れないものの内訳", () => {
    expect(coverageSummary(rows, "before")).toBe("6 の型のうち 4 を調べた・見つかったのは 2 つ（一部だけ 1・調べられなかった 1・この版では調べていない 1）");
  });
  it("整えたあとは「残っているのは」", () => {
    expect(coverageSummary([row("checked"), row("checked")], "after")).toBe("2 の型のうち 2 を調べた・残っているのは 0 つ");
  });
});

describe("仕切りの幅", () => {
  it("結果の欄は下限より狭くならず、PDF の欄に下限の幅を残す", () => {
    const root = 18;
    expect(clampResultsWidth(100, 1200, root)).toBe(RESULTS_MIN_REM * root);
    expect(clampResultsWidth(5000, 1200, root)).toBe(1200 - STAGE_MIN_REM * root);
    expect(clampResultsWidth(500, 1200, root)).toBe(500);
  });
  it("使える幅が狭すぎるときは、結果の欄の下限を守る", () => {
    expect(clampResultsWidth(500, 400, 18)).toBe(RESULTS_MIN_REM * 18);
  });
});

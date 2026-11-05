// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする所の計算（src/ui/picks.ts）：個人情報の候補から加える・外す、上限、一覧の名前、読み直しで止められたときの見せ方。

import { describe, expect, it } from "vitest";
import type { RedactLeftover } from "../sanitize/types.ts";
import { MAX_REDACT_AREAS } from "../src/sanitize/areas";
import type { Row } from "../src/ui/model";
import { addAllCandidates, buildBlockedView, isCandidate, pickLabel, toAreas, toggleCandidate, type PickedArea } from "../src/ui/picks";

const row = (over: Partial<Row>): Row => ({
  no: 1, severity: "medium", severityLabel: "中", patternLabel: "個人情報らしい字（P13）", pattern: "P13",
  page: 1, pageLabel: "1", hasRect: true, rect: [10, 10, 60, 22], title: "t", why: "w", detail: "d", check: false, ...over,
});

describe("個人情報の候補から選ぶ", () => {
  it("候補の型で、ページの上の場所がある行だけを選べる", () => {
    expect(isCandidate(row({}))).toBe(true);
    expect(isCandidate(row({ pattern: "P6" }))).toBe(false);
    expect(isCandidate(row({ rect: null, hasRect: false }))).toBe(false);
    expect(isCandidate(row({ page: null }))).toBe(false);
  });

  it("押すと加わり、もう一度押すと外れる。ドラッグで選んだ所は残す", () => {
    const drag: PickedArea = { page: 2, rect: [0, 0, 5, 5] };
    const on = toggleCandidate([drag], row({ no: 3 }));
    expect(on).toEqual([drag, { page: 1, rect: [10, 10, 60, 22], candidate: 3 }]);
    expect(toggleCandidate(on, row({ no: 3 }))).toEqual([drag]);
  });

  it("すべて加えるときは、もう選んだものを重ねない", () => {
    const rows = [row({ no: 1 }), row({ no: 2, rect: [10, 40, 60, 52] }), row({ no: 3, pattern: "P6" })];
    const once = addAllCandidates(toggleCandidate([], rows[0]!), rows);
    expect(once.map((p) => p.candidate)).toEqual([1, 2]);
    expect(addAllCandidates(once, rows)).toEqual(once);
  });

  it("上限を超えては加えない", () => {
    const full: PickedArea[] = Array.from({ length: MAX_REDACT_AREAS }, (_, i) => ({ page: 1, rect: [i, 0, i + 1, 1] }));
    expect(toggleCandidate(full, row({ no: 9 }))).toHaveLength(MAX_REDACT_AREAS);
  });

  it("片付けに渡すのはページと場所だけ。一覧では、候補の番号を添える", () => {
    const p = toggleCandidate([], row({ no: 4 }));
    expect(toAreas(p)).toEqual([{ page: 1, rect: [10, 10, 60, 22] }]);
    expect(pickLabel(p[0]!, 0)).toBe("選んだ所 1：ページ 1（個人情報の候補 4）");
    expect(pickLabel({ page: 2, rect: [0, 0, 1, 1] }, 1)).toBe("選んだ所 2：ページ 2");
  });
});

describe("保存の前の読み直しで止められたとき", () => {
  it("同じ文・同じページはまとめて数え、ページ番号を添える。「安全」とは言わない", () => {
    const l: RedactLeftover[] = [
      { check: "area", kind: "text", label: "選んだ所に、字が残っています", count: 1, page: 2 },
      { check: "area", kind: "text", label: "選んだ所に、字が残っています", count: 2, page: 2 },
      { check: "not_done", kind: "not_done", label: "画像を塗れませんでした", count: 1 },
    ];
    const v = buildBlockedView(l, [{ pattern: "P6", reason: "unsupported_image", label: "画像を塗れませんでした" }] as never);
    expect(v.lines).toEqual(["選んだ所に、字が残っています（ページ 2）：2 件", "画像を塗れませんでした"]);
    expect(v.headline).toMatch(/片付けられなかった所/);
    expect([v.headline, ...v.lines].join("")).not.toMatch(/安全です|問題なし/);
  });
});

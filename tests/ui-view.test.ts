// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの座標の箱を、画面のページの中の割合に直す計算（src/inspect/view.ts）。

import { describe, expect, it } from "vitest";
import type { PageBox } from "../src/inspect/report";
import { toFraction, viewSize, type Fraction } from "../src/inspect/view";

function near(got: Fraction | null, want: Fraction) {
  expect(got).not.toBeNull();
  for (const k of ["left", "top", "width", "height"] as const) expect(got![k]).toBeCloseTo(want[k], 9);
}

const box = (rotate: PageBox["rotate"]): PageBox => ({ page: 1, view: [0, 0, 200, 100], rotate });
// 左下の角の近く：x 0〜20、y 0〜10
const rect: [number, number, number, number] = [0, 0, 20, 10];

describe("ページの中の割合", () => {
  it("回していないページ：左下の箱は左下に出る", () => {
    near(toFraction(box(0), rect), { left: 0, top: 0.9, width: 0.1, height: 0.1 });
  });
  it("90 度：左下の箱は左上に来る", () => {
    near(toFraction(box(90), rect), { left: 0, top: 0, width: 0.1, height: 0.1 });
  });
  it("180 度：右上に来る", () => {
    near(toFraction(box(180), rect), { left: 0.9, top: 0, width: 0.1, height: 0.1 });
  });
  it("270 度：右下に来る", () => {
    near(toFraction(box(270), rect), { left: 0.9, top: 0.9, width: 0.1, height: 0.1 });
  });
  it("90・270 度では幅と高さが入れ替わる", () => {
    expect(viewSize(box(0))).toEqual({ width: 200, height: 100 });
    expect(viewSize(box(90))).toEqual({ width: 100, height: 200 });
  });
  it("見える範囲の外の箱は描かない。はみ出した分は切る", () => {
    expect(toFraction(box(0), [300, 0, 400, 10])).toBeNull();
    near(toFraction(box(0), [-50, 0, 20, 10]), { left: 0, top: 0.9, width: 0.1, height: 0.1 });
  });
  it("見える範囲の原点がずれていても合う", () => {
    const b: PageBox = { page: 1, view: [100, 100, 300, 200], rotate: 0 };
    near(toFraction(b, [100, 190, 120, 200]), { left: 0, top: 0, width: 0.1, height: 0.1 });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面に出す字の整え（src/ui/text.ts）。数と単位を、折らない空白でつなぐ。

import { describe, expect, it } from "vitest";
import { keepUnits } from "../src/ui/text";

describe("数と単位を分けない", () => {
  it("数と単位のあいだの空白だけを、折らない空白に替える", () => {
    expect(keepUnits("整える前 10 か所 → 読み直したあと 0 か所")).toBe("整える前 10 か所 → 読み直したあと 0 か所");
    expect(keepUnits("1 ページ・164.4 KB・0.2 秒")).toBe("1 ページ・164.4 KB・0.2 秒");
  });
  it("数のあとでない空白は変えない", () => {
    expect(keepUnits("PDF を選ぶ")).toBe("PDF を選ぶ");
  });
});

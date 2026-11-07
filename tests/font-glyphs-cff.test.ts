// SPDX-License-Identifier: AGPL-3.0-only
//
// CFF の書体に残った字形（font-glyphs-cff）の合成 PDF で、隠しありを見つけ、対照では何も出さないことを確かめる。

import { describe, expect, it } from "vitest";
import { detectFontGlyphsCff, hasOutline, readCff } from "../rules/font-glyphs-cff/index.ts";
import { buildCff, CASES, keysOf } from "../eval/cases/font-glyphs-cff.ts";

describe("font-glyphs-cff", () => {
  for (const c of CASES) {
    it(`${c.id}：${c.kind === "leak" ? "見つける" : "出さない"}`, async () => {
      const r = await detectFontGlyphsCff(await c.build());
      expect(r.status).toBe("ok");
      expect(keysOf(r)).toEqual(c.leaks);
    });
  }

  it("組み立てた CFF を読み、形のある字形と無い字形を分ける", () => {
    const cff = readCff(buildCff(3, true));
    expect(cff.count).toBe(5);
    expect(hasOutline(cff.charstring(0))).toBe(false);
    expect(hasOutline(cff.charstring(1))).toBe(true);
    expect(hasOutline(cff.charstring(4))).toBe(false);
    expect(cff.sidName(cff.charsetOf(1))).toBe("A");
  });

  it("隠しありでは、余りの数を返す（字の中身は返さない）", async () => {
    const r = await detectFontGlyphsCff(await CASES[0]!.build());
    expect(r.findings[0]).toMatchObject({ fontType: "cid", glyphs: 10, used: 3, leftover: 7 });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// XMP の元の文書・素材の一覧（xmp-derived）の合成 PDF での確かめ。

import { describe, expect, it } from "vitest";
import { CASES, keysOf } from "../eval/cases/xmp-derived.ts";
import { compare } from "../eval/cases/registry.ts";
import { detectXmpDerived } from "../rules/xmp-derived/index.ts";

describe("xmp-derived", () => {
  for (const c of CASES) {
    it(`${c.id}：${c.description}`, async () => {
      const r = await detectXmpDerived(await c.build());
      expect(r.status).toBe("ok");
      const { missed, extra } = compare(c.leaks, keysOf(r));
      expect(missed).toEqual([]);
      expect(extra).toEqual([]);
    });
  }

  it("既定では名前そのものを返さない。素材 3 件を数える", async () => {
    const c = CASES.find((x) => x.id === "xd-l02")!;
    const r = await detectXmpDerived(await c.build());
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.files).toBe(3);
    expect(r.findings[0]!.values).toBeUndefined();
  });

  it("パスの形は、ほかのルールの範囲として notCounted に回す", async () => {
    const c = CASES.find((x) => x.id === "xd-c03")!;
    const r = await detectXmpDerived(await c.build());
    expect(r.findings).toEqual([]);
    expect(r.notCounted.map((n) => n.reason).sort()).toEqual(["path", "user_folder"]);
  });
});

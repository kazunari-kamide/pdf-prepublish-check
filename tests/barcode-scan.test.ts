// SPDX-License-Identifier: AGPL-3.0-only
//
// 黒塗りのそばの記号（barcode-scan）：合成 PDF で、隠しありは見つけ、対照では何も出さないことを確かめる。

import { describe, expect, it } from "vitest";
import { detectBarcodeScan } from "../rules/barcode-scan/index.ts";
import { CASES, keysOf } from "../eval/cases/barcode-scan.ts";

describe("barcode-scan", () => {
  for (const c of CASES) {
    it(`${c.id}：${c.kind === "leak" ? "記号の列を見つける" : "何も出さない"}`, async () => {
      const r = await detectBarcodeScan(await c.build());
      expect(r.status).toBe("ok");
      expect(r.checkedImages).toBe(1);
      expect(keysOf(r)).toEqual(c.leaks);
    });
  }

  it("壊れた PDF はエラーで返す", async () => {
    const r = await detectBarcodeScan(new Uint8Array([1, 2, 3]));
    expect(r.status).toBe("error");
  });
});

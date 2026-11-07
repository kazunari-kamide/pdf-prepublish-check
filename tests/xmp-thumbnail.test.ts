// SPDX-License-Identifier: AGPL-3.0-only
//
// 文書全体の XMP に埋め込まれた縮小画像（rules/xmp-thumbnail）のテスト。合成 PDF は eval/cases/xmp-thumbnail.ts（中身はすべて架空）。

import { describe, expect, it } from "vitest";
import { decodeBase64, detectXmpThumbnail, thumbnailsIn } from "../rules/xmp-thumbnail/index.ts";
import { CASES, keysOf } from "../eval/cases/xmp-thumbnail.ts";
import { compare } from "../eval/cases/registry.ts";

describe("xmp-thumbnail", () => {
  for (const c of CASES) {
    it(`${c.id}：${c.description}`, async () => {
      const r = await detectXmpThumbnail(await c.build());
      expect(r.status).toBe("ok");
      const { missed, extra } = compare(c.leaks, keysOf(r));
      expect(missed).toEqual([]);
      expect(extra).toEqual([]);
    });
  }

  it("幅・高さを読み、中身は返さない", async () => {
    const r = await detectXmpThumbnail(await CASES.find((c) => c.id === "xt-l01")!.build());
    expect(r.findings[0]).toMatchObject({ width: 256, height: 171, format: "jpeg" });
    expect(JSON.stringify(r)).not.toContain("xmpGImg:image");
  });

  it("&#xA; と空白を外して base64 を解く", () => {
    expect([...decodeBase64("/9j/&#xA; 4A==")!]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(decodeBase64("not base64 !!")).toBeNull();
  });

  it("名前空間に結んでいない接頭辞の image は拾わない", () => {
    expect(thumbnailsIn('<rdf:Description xmlns:foo="urn:other"><foo:image>/9j/4A==</foo:image></rdf:Description>')).toEqual([]);
  });
});

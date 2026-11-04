// SPDX-License-Identifier: AGPL-3.0-only
//
// 見本の PDF（src/ui/sample.ts）。data: の URL を、通信なしでバイト列にほどけること。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeDataUrl, SAMPLE_NAME } from "../src/ui/sample";

describe("見本の PDF", () => {
  it("base64 の data: の URL を、元のバイト列にほどく", () => {
    const bytes = readFileSync("fixtures/p6/p6-t01-rect-over-name.pdf");
    const url = `data:application/pdf;base64,${bytes.toString("base64")}`;
    expect(Buffer.from(decodeDataUrl(url)!)).toEqual(bytes);
  });
  it("形の違う URL は null（取りに行かない）", () => {
    expect(decodeDataUrl("https://example.invalid/a.pdf")).toBeNull();
    expect(decodeDataUrl("data:application/pdf,%25PDF")).toBeNull();
  });
  it("名前は架空と分かる形", () => {
    expect(SAMPLE_NAME).toContain("架空");
  });
});

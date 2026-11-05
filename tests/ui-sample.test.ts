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

describe("?sample=1 で開く", () => {
  it("sample=1 のときだけ見本を読む。ほかの値・ほかの query は無視する", async () => {
    const { wantsSample } = await import("../src/ui/sample");
    expect(wantsSample("?sample=1")).toBe(true);
    expect(wantsSample("?utm=x&sample=1")).toBe(true);
    for (const s of ["", "?sample=0", "?sample=true", "?sample=", "?sample=1x", "?other=1", "?Sample=1"]) expect(wantsSample(s)).toBe(false);
  });
  it("アドレスから sample だけを外す（ほかの query と # は残す）", async () => {
    const { withoutSample } = await import("../src/ui/sample");
    expect(withoutSample("/", "?sample=1", "")).toBe("/");
    expect(withoutSample("/", "?a=2&sample=1", "#x")).toBe("/?a=2#x");
  });
});

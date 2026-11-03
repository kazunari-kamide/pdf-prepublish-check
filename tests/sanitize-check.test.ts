// SPDX-License-Identifier: AGPL-3.0-only
//
// 「片付けても壊れていない」を確かめる道具（sanitize/check/check.ts）のテスト。
// 道具が、本当に壊れたもの・変わったものを見抜けるかを、わざと変えた PDF で確かめる。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
import { checkSanitized } from "../sanitize/check/check.ts";
import { sanitizePdf } from "../sanitize/index.ts";

async function makePdf(content: string, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([300, 200]);
    page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font } }));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  }
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

const BASE = "BT /F1 12 Tf 20 100 Td (Name: TARO-XYZ end) Tj ET 0 g 57 95 64 20 re f";

describe("壊れていないかの確かめ", () => {
  it("片付けた PDF：開ける・ページ数が同じ・字が増えていない・見た目が同じ", async () => {
    const before = await makePdf(BASE);
    const r = await sanitizePdf(before);
    if (r.status !== "ok") throw new Error("片付けに失敗");
    const c = await checkSanitized(before, r.bytes);
    expect(c.problems).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.opens.render).toBe(true);
    expect(c.diffPixels).toBe(0);
    expect(c.pages[0]!.charsBefore - c.pages[0]!.charsAfter).toBe(8);
  });

  it("ページ数が変わったら見抜く", async () => {
    const c = await checkSanitized(await makePdf(BASE, 2), await makePdf(BASE, 1));
    expect(c.ok).toBe(false);
    expect(c.problems.join()).toContain("ページ数");
  });

  it("見た目が変わったら見抜く（黒い四角を足した）", async () => {
    const c = await checkSanitized(await makePdf(BASE), await makePdf(BASE + " 0 g 150 20 60 40 re f"));
    expect(c.ok).toBe(false);
    expect(c.problems.join()).toContain("見た目");
  });

  it("変わってよい所（適用した墨消し）の中の差は数えない", async () => {
    const c = await checkSanitized(await makePdf(BASE), await makePdf(BASE + " 0 g 150 20 60 40 re f"), { allowedChanges: new Map([[1, [[150, 20, 210, 60]]]]) });
    expect(c.problems).toEqual([]);
  });

  it("字が増えたら見抜く", async () => {
    const c = await checkSanitized(await makePdf(BASE), await makePdf(BASE + " BT /F1 12 Tf 20 20 Td (NEW) Tj ET"));
    expect(c.ok).toBe(false);
    expect(c.problems.join()).toContain("なかった字");
  });

  it("開けないものは開けないと返す", async () => {
    const c = await checkSanitized(await makePdf(BASE), new TextEncoder().encode("%PDF-1.7 broken"));
    expect(c.ok).toBe(false);
    expect(c.opens.pdfjs).toBe(false);
  });
});

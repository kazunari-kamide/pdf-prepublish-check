// SPDX-License-Identifier: AGPL-3.0-only
//
// 字が 1 つもないページ（スキャンした画像だけのページ）では、個人情報らしい字を探せていないと知らせ、
// 「調べた範囲では、見つかりませんでした」（緑）にしない（2026-11-06 本人の頼み）。架空の PDF をここで作る。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
import { detectPii } from "../rules/pii/index.ts";
import { inspectAll } from "../src/inspect/inspect.ts";
import { buildView } from "../src/ui/model.ts";

async function makePdf(pages: Array<"image" | "text">): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const img = ctx.register(ctx.stream(new Uint8Array(20 * 28).fill(230), { Type: "XObject", Subtype: "Image", Width: 20, Height: 28, ColorSpace: "DeviceGray", BitsPerComponent: 8 } as never));
  for (const kind of pages) {
    const page = doc.addPage([595, 842]);
    page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font }, XObject: { Im1: img } } as never));
    const content = kind === "image" ? "q 595 0 0 842 0 0 cm /Im1 Do Q" : "BT /F1 12 Tf 60 780 Td (Kasou no bunsho) Tj ET";
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  }
  return doc.save({ useObjectStreams: false });
}

describe("字のないページ", () => {
  it("字が 1 つもないページだけを数える", async () => {
    const r = await detectPii(await makePdf(["text", "image", "text", "image"]));
    expect(r.noTextPages).toEqual([2, 4]);
  });

  it("画像だけの PDF は、お知らせを出し、緑の「見つかりませんでした」にしない", async () => {
    const view = buildView(await inspectAll(await makePdf(["image"])));
    expect(view.notices.some((n) => n.startsWith("このページには、字がありません") && n.includes("（ページ 1）"))).toBe(true);
    expect(view.verdict).not.toBe("none");
    expect(view.clean).toBe(false);
  });

  it("字のあるページだけなら、お知らせは出さない", async () => {
    const view = buildView(await inspectAll(await makePdf(["text"])));
    expect(view.notices.some((n) => n.startsWith("このページには、字がありません"))).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの絵の上の印の薄い地が、重なっても濃くならないこと（2026-11-05、実物の公開 PDF 1 件で、
// 切り抜いた画像が同じ所に何枚もあるページの上半分が、暗い赤に覆われて絵が読めなくなった）。
// 同じ作りの架空の PDF を、ここで作って確かめる（実物は使わない）。

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
import { inspectAll } from "../src/inspect/inspect.ts";
import { toFraction } from "../src/inspect/view.ts";
import { uniqueFills } from "../src/ui/mark-fills.ts";
import { buildView } from "../src/ui/model.ts";

/** 同じ所に、切り抜いて大部分を隠した画像を 8 枚重ねたページ（広報紙の作りをまねたもの） */
async function stackedClippedImages(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([595, 842]);
  const img = ctx.register(ctx.stream(new Uint8Array(40 * 56).fill(200), { Type: "XObject", Subtype: "Image", Width: 40, Height: 56, ColorSpace: "DeviceGray", BitsPerComponent: 8 } as never));
  page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { Im1: img } } as never));
  const parts: string[] = [];
  for (let i = 0; i < 8; i++) parts.push("q 30 680 110 80 re W n 560 0 0 460 20 380 cm /Im1 Do Q");
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(parts.join(" "))));
  return doc.save({ useObjectStreams: false });
}

describe("印の薄い地", () => {
  it("同じ所に重なった印が何枚あっても、地は 1 枚にまとめる", async () => {
    const view = buildView(await inspectAll(await stackedClippedImages()));
    const page = view.pages.find((p) => p.box.page === 1)!;
    const fills = page.marks.filter((m) => !m.candidate).map((m) => toFraction(page.box, m.rect)!);
    // 直す前の形がそろっていること：同じ四角の印が 5 枚以上、ページの 3 割以上を覆う
    expect(fills.length).toBeGreaterThanOrEqual(5);
    expect(fills[0]!.width * fills[0]!.height).toBeGreaterThan(0.3);
    expect(uniqueFills(fills)).toHaveLength(1);
  });

  it("違う四角は残し、並びは初めに出た順", () => {
    const a = { left: 0.1, top: 0.1, width: 0.2, height: 0.2 };
    const b = { left: 0.5, top: 0.5, width: 0.1, height: 0.1 };
    expect(uniqueFills([a, b, { ...a }, b])).toEqual([a, b]);
  });

  it("地は 1 つの層にまとめて層ごと薄くし、印ごとには地を付けない（重なると濃くなるため）", () => {
    const css = readFileSync(path.join(import.meta.dirname, "../src/style.css"), "utf8");
    const rule = (sel: string) => css.match(new RegExp(`\\n${sel.replace(/[.*]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".mark")).toMatch(/background: transparent/);
    expect(rule(".mark.mark-done")).toMatch(/background: transparent/);
    expect(rule(".mark-fills")).toMatch(/opacity: 0\.1;/);
    expect(rule(".mark-fill")).toMatch(/background: var\(--color-accent\)/);
    expect(css).not.toMatch(/\.mark[^{]*\{[^}]*accent-wash/);
  });
});

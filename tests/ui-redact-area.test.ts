// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする所の座標（src/inspect/view.ts の fromFraction）と、仮のつなぎ（src/sanitize/redact.ts）。

import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PageBox, Rect } from "../src/inspect/report";
import { fromFraction, toFraction } from "../src/inspect/view";
import { addRedactAreas } from "../src/sanitize/redact";
import { sanitizePdf } from "../sanitize/index.ts";

describe("画面の箱をページの座標に戻す", () => {
  for (const rotate of [0, 90, 180, 270] as const) {
    it(`回転 ${rotate} 度でも、toFraction の逆になる`, () => {
      const box: PageBox = { page: 1, view: [10, 20, 610, 820], rotate };
      const rect: Rect = [100, 200, 300, 260];
      const back = fromFraction(box, toFraction(box, rect)!);
      back.forEach((v, i) => expect(v).toBeCloseTo(rect[i]!, 6));
    });
  }
});

describe("自分で黒塗りする所を、墨消しの注釈として足す（仮のつなぎ）", () => {
  it("選んだページに /Redact の注釈を足す。ページの範囲の外は数えない", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([600, 800]).drawText("SAMPLE", { x: 100, y: 700, font, size: 20 });
    const r = await addRedactAreas(await doc.save(), [
      { page: 1, rect: [90, 690, 200, 725] },
      { page: 9, rect: [0, 0, 10, 10] },
    ]);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.added).toBe(1);
    const out = await PDFDocument.load(r.bytes);
    const annots = out.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    const a = annots.lookup(0, PDFDict);
    expect(a.lookup(PDFName.of("Subtype"))).toEqual(PDFName.of("Redact"));
  });

  it("PDF でなければ、足さずに断る", async () => {
    const r = await addRedactAreas(new Uint8Array([1, 2, 3]), [{ page: 1, rect: [0, 0, 1, 1] }]);
    expect(r.status).toBe("refused");
  });
});

describe("仮のつなぎ＋片付けで、選んだ所の下の字が消える", () => {
  it("選んだ所の字を消し、墨消しを適用したと報告する。選んでいない所の字は残す", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 800]);
    page.drawText("HIDEME", { x: 100, y: 700, font, size: 20 });
    page.drawText("KEEP", { x: 100, y: 400, font, size: 20 });
    const r = await addRedactAreas(await doc.save(), [{ page: 1, rect: [90, 690, 200, 725] }]);
    if (r.status !== "ok") throw new Error("refused");
    const out = await sanitizePdf(r.bytes);
    if (out.status !== "ok") throw new Error("sanitize failed");
    expect(out.removed.some((x) => x.kind === "redaction_applied")).toBe(true);
    const chars = out.removed.filter((x) => x.kind === "covered_text").reduce((n, x) => n + x.count, 0);
    expect(chars).toBe(6);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// ToUnicode のない、埋め込みの CID の書体（Identity-H・Adobe-Japan1）の字を、Adobe-Japan1 の表から読む（2026-11-06）。
// 同じ字の並びを同じ所に何度も描いたものは、P7 で 1 件にする（P7 1.6.0）。どれも架空の PDF をここで作る。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { ADOBE_JAPAN1 } from "../rules/shared/cid-unicode/adobe-japan1.ts";
import { cidUnicodeFor, japan1Char } from "../rules/shared/cid-unicode.ts";
import { detectP7Hidden } from "../rules/p7-hidden/index.ts";
import { detectPii } from "../rules/pii/index.ts";

/** 表から、字 → CID を引く（テストで使う字の CID を求めるため） */
function cidOf(ch: string): number {
  const all = [...ADOBE_JAPAN1.chars];
  const i = all.indexOf(ch);
  if (i < 0) throw new Error(`表に ${ch} がありません`);
  return i;
}
const hexOf = (s: string) => [...s].map((c) => cidOf(c).toString(16).padStart(4, "0")).join("").toUpperCase();

/** Identity-H・Adobe-Japan1・ToUnicode なしの書体で、content を描いた 1 ページ */
async function makePdf(content: (hex: (s: string) => string) => string, ordering = "Japan1"): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const cid = ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "CIDFontType0",
      BaseFont: "KasouGothic",
      CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of(ordering), Supplement: 6 },
      FontDescriptor: ctx.obj({ Type: "FontDescriptor", FontName: "KasouGothic", Flags: 4, FontBBox: [0, -141, 1000, 859], ItalicAngle: 0, Ascent: 859, Descent: -141, CapHeight: 700, StemV: 80 }),
      DW: 1000,
    }),
  );
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "KasouGothic", Encoding: "Identity-H", DescendantFonts: [cid] }));
  const page = doc.addPage([595, 842]);
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font } }));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content(hexOf))));
  return doc.save({ useObjectStreams: false });
}

describe("Adobe-Japan1 の表", () => {
  it("CID から字を引ける（英数字・かな・漢字）。表のない並びは引かない", () => {
    expect(japan1Char(34)).toBe("A");
    expect(japan1Char(cidOf("あ"))).toBe("あ");
    expect(japan1Char(cidOf("山"))).toBe("山");
    expect(japan1Char(-1)).toBe("");
    expect(japan1Char(ADOBE_JAPAN1.cidCount)).toBe("");
    expect(cidUnicodeFor("Adobe", "Japan1")).toBe(japan1Char);
    expect(cidUnicodeFor("Adobe", "Identity")).toBeNull();
    expect(ADOBE_JAPAN1.mapped).toBeGreaterThan(22000);
  });
});

describe("ToUnicode のない CID の書体", () => {
  it("個人情報のルール：字を読めるので「読み取れない字」にしない", async () => {
    const r = await detectPii(await makePdf((h) => `BT /F1 14 Tf 72 700 Td <${h("申請者山田太郎様")}> Tj ET`));
    expect(r.unreadable.glyphs).toBe(0);
    expect(r.unreadable.pages).toEqual([]);
  });

  it("並びが Adobe-Japan1 でない CID の書体は、今までどおり読み取れない字に数える", async () => {
    const r = await detectPii(await makePdf((h) => `BT /F1 14 Tf 72 700 Td <${h("山田太郎")}> Tj ET`, "Identity"));
    expect(r.unreadable.glyphs).toBe(4);
  });
});

describe("P7：同じ字の並びを同じ所に何度も描いたもの", () => {
  it("同じ所・同じ字は 1 件にまとめる（切り抜きの外に 3 回描いても 1 件）", async () => {
    const once = (h: (s: string) => string) => `BT /F1 12 Tf 150 100 Td <${h("見えない字")}> Tj ET`;
    const r = await detectP7Hidden(await makePdf((h) => `q 0 0 100 200 re W n ${once(h)} ${once(h)} ${once(h)} Q`));
    expect(r.findings.map((f) => `${f.reason}:${f.chars}`)).toEqual(["clipped:5"]);
  });

  it("同じ所でも、違う字なら別の件のまま", async () => {
    const r = await detectP7Hidden(
      await makePdf((h) => `q 0 0 100 200 re W n BT /F1 12 Tf 150 100 Td <${h("見えない字")}> Tj ET BT /F1 12 Tf 150 100 Td <${h("別の五字だ")}> Tj ET Q`),
    );
    expect(r.findings.filter((f) => f.reason === "clipped").length).toBe(2);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6 1.8.0：文字の層の「覆いの上に何があるか」のテスト。
// 実物の公開 PDF で多かった型（白抜きの字・番号札・傾けた見本書類の絵）の形を、テストの中で作って確かめる。
// 黒い四角の上に「不開示」などの札を書いた本当の漏れは、確かなもの（high）のままにする（2026-11-04、人の決定）。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFOperator, StandardFonts, degrees, rgb, type PDFOperatorNames, type PDFPage, type PDFRef } from "pdf-lib";
import { LABEL_WORDS, isLabelText } from "../rules/p6-text/text-top.ts";
import { detectP6Text, type P6TextFinding } from "../rules/p6-text/index.ts";

const op = (name: string, args: (PDFNumber | PDFName | PDFHexString)[] = []) => PDFOperator.of(name as PDFOperatorNames, args);

/** 2バイトの字のフォント（字の形は持たない。ToUnicode で、字の番号 → 字の中身を決める） */
function cidFont(doc: PDFDocument, map: Record<number, string>): PDFRef {
  const hex = (n: number) => n.toString(16).padStart(4, "0").toUpperCase();
  const u16 = (s: string) => [...s].map((c) => {
    const cp = c.codePointAt(0)!;
    return cp > 0xffff ? hex(0xd800 + ((cp - 0x10000) >> 10)) + hex(0xdc00 + ((cp - 0x10000) & 0x3ff)) : hex(cp);
  }).join("");
  const entries = Object.entries(map).map(([code, s]) => `<${hex(Number(code))}> <${u16(s)}>`);
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CMapName /TestUni def 1 begincodespacerange <0000> <FFFF> endcodespacerange",
    `${entries.length} beginbfchar`,
    ...entries,
    "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  const toUnicode = doc.context.register(doc.context.flateStream(new TextEncoder().encode(cmap)));
  const descendant = doc.context.obj({
    Type: "Font",
    Subtype: "CIDFontType2",
    BaseFont: "TestCID",
    CIDSystemInfo: { Registry: PDFHexString.fromText("Adobe"), Ordering: PDFHexString.fromText("Identity"), Supplement: 0 },
    DW: 1000,
  });
  return doc.context.register(
    doc.context.obj({ Type: "Font", Subtype: "Type0", BaseFont: "TestCID", Encoding: "Identity-H", DescendantFonts: [descendant], ToUnicode: toUnicode }),
  );
}

/** 2バイトの字を描く（字の番号の並び） */
function showCodes(page: PDFPage, font: string, size: number, x: number, y: number, codes: number[], gray = 0) {
  const hex = codes.map((c) => c.toString(16).padStart(4, "0")).join("");
  page.pushOperators(
    op("q"),
    op("g", [PDFNumber.of(gray)]),
    op("BT"),
    op("Tf", [PDFName.of(font), PDFNumber.of(size)]),
    op("Td", [PDFNumber.of(x), PDFNumber.of(y)]),
    op("Tj", [PDFHexString.of(hex)]),
    op("ET"),
    op("Q"),
  );
}

async function makePdf(draw: (doc: PDFDocument, page: PDFPage) => Promise<void> | void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  await draw(doc, page);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}
const textHits = (r: Awaited<ReturnType<typeof detectP6Text>>) => r.findings.filter((f): f is P6TextFinding => f.layer === "text");

describe("P6 1.8.0：札の言葉", () => {
  it("記号・括弧・空白を除いて、札の言葉を含むかで見る", () => {
    expect(isLabelText("（不開示）")).toBe(true);
    expect(isLabelText("【 黒塗り 】")).toBe(true);
    expect(isLabelText("非開示（第5条第1号）")).toBe(true);
    expect(isLabelText("[REDACTED]")).toBe(true);
    expect(isLabelText("ｍａｓｋｉｎｇ")).toBe(false);
    expect(isLabelText("マスキング")).toBe(true);
    expect(isLabelText("お知らせ")).toBe(false);
    expect(isLabelText("")).toBe(false);
    for (const w of ["不開示", "非開示", "非公開", "黒塗り", "マスキング", "墨消し"]) expect(LABEL_WORDS).toContain(w);
  });
});

describe("P6 1.8.0：覆いの上のあり方と確からしさ", () => {
  it("覆いの上に何もない黒塗りは、確かなもの（high）", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("SECRET", { x: 20, y: 200, size: 12, font });
      page.drawRectangle({ x: 15, y: 195, width: 60, height: 20, color: rgb(0, 0, 0) });
    });
    expect(textHits(await detectP6Text(pdf)).map((f) => f.confidence)).toEqual(["high"]);
  });

  it("黒い帯の上に、下と違う字を描いたもの（見出しの帯・番号札）は「確かめてください」（check）", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("OLD 12", { x: 20, y: 200, size: 12, font });
      page.drawRectangle({ x: 15, y: 195, width: 60, height: 20, color: rgb(0, 0, 0) });
      page.drawText("NEW 13", { x: 20, y: 200, size: 12, font, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(textHits(r).map((f) => [f.confidence, f.metrics!.textOnTop])).toEqual([["check", "different"]]);
  });

  it("黒い四角の上に「[REDACTED]」の札を書いたものは、確かなもの（high）のまま", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("YAMADA TARO", { x: 20, y: 200, size: 12, font });
      page.drawRectangle({ x: 15, y: 195, width: 90, height: 20, color: rgb(0, 0, 0) });
      page.drawText("[REDACTED]", { x: 25, y: 200, size: 10, font, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(textHits(r).map((f) => [f.confidence, f.metrics!.textOnTop])).toEqual([["high", "label"]]);
  });

  it("黒い四角の上に「（不開示）」「【黒塗り】」の札を書いたものも、確かなもの（high）のまま", async () => {
    // 字の番号：1〜4 が下の名前（山田太郎）、10〜 が札の字
    const map: Record<number, string> = { 1: "山", 2: "田", 3: "太", 4: "郎", 10: "（", 11: "不", 12: "開", 13: "示", 14: "）", 20: "【", 21: "黒", 22: "塗", 23: "り", 24: "】" };
    const pdf = await makePdf((doc, page) => {
      page.node.setFontDictionary(PDFName.of("FC"), cidFont(doc, map));
      showCodes(page, "FC", 12, 20, 200, [1, 2, 3, 4]);
      page.drawRectangle({ x: 15, y: 194, width: 60, height: 22, color: rgb(0, 0, 0) });
      showCodes(page, "FC", 9, 18, 201, [10, 11, 12, 13, 14], 1);
      showCodes(page, "FC", 12, 20, 100, [1, 2, 3, 4]);
      page.drawRectangle({ x: 15, y: 94, width: 60, height: 22, color: rgb(0, 0, 0) });
      showCodes(page, "FC", 9, 18, 101, [20, 21, 22, 23, 24], 1);
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(textHits(r).map((f) => [f.confidence, f.metrics!.textOnTop])).toEqual([
      ["high", "label"],
      ["high", "label"],
    ]);
  });

  it("下の字が、どれも上の字の中にある（並びが違う）ものは数えない（same_chars_on_top）", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("AB", { x: 20, y: 200, size: 12, font });
      page.drawRectangle({ x: 15, y: 195, width: 40, height: 20, color: rgb(0, 0, 0) });
      page.drawText("BA", { x: 20, y: 200, size: 12, font, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(textHits(r)).toHaveLength(0);
    expect(r.excluded).toEqual({ "text:same_chars_on_top": 1 });
  });

  it("康熙部首の字の上に、ふつうの字を描き直したものは、同じ字として数えない（NFKC でそろえる）", async () => {
    const pdf = await makePdf((doc, page) => {
      page.node.setFontDictionary(PDFName.of("FA"), cidFont(doc, { 1: "⾏" })); // ⾏（康熙部首）
      page.node.setFontDictionary(PDFName.of("FB"), cidFont(doc, { 7: "行" })); // 行
      showCodes(page, "FA", 14, 20, 200, [1]);
      page.drawRectangle({ x: 15, y: 194, width: 30, height: 24, color: rgb(0, 0, 0) });
      showCodes(page, "FB", 14, 20, 200, [7], 1);
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(textHits(r)).toHaveLength(0);
    expect(r.excluded).toEqual({ "text:same_text_on_top": 1 });
  });

  it("下の字が印字できない字（幅のない空白）で、上に字があるものは「確かめてください」（unknown_hidden）", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.node.setFontDictionary(PDFName.of("FZ"), cidFont(doc, { 2: "​" }));
      showCodes(page, "FZ", 14, 20, 200, [2, 2, 2]);
      page.drawRectangle({ x: 15, y: 194, width: 60, height: 24, color: rgb(0, 0, 0) });
      page.drawText("TITLE", { x: 20, y: 200, size: 12, font, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(textHits(r).map((f) => [f.confidence, f.metrics!.textOnTop, f.metrics!.hiddenNonPrintable])).toEqual([["check", "unknown_hidden", 3]]);
    expect(r.diagnostics?.["text:hidden_nonprintable"]).toBe(1);
  });

  it("黒い帯の上に、白い字の形の塗り（アウトライン化した白抜きの字）があるものは「確かめてください」（shapes）", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("OLD", { x: 20, y: 200, size: 12, font });
      page.drawRectangle({ x: 15, y: 195, width: 60, height: 20, color: rgb(0, 0, 0) });
      page.drawEllipse({ x: 30, y: 205, xScale: 5, yScale: 6, color: rgb(1, 1, 1) }); // 字の「O」の形の代わり
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(textHits(r).map((f) => [f.confidence, f.metrics!.textOnTop])).toEqual([["check", "shapes"]]);
  });

  it("黒い帯の上でも、帯の外にある白い塗り・帯より前の白い塗りは、上のあり方に数えない", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawEllipse({ x: 30, y: 205, xScale: 5, yScale: 6, color: rgb(1, 1, 1) }); // 帯より前
      page.drawText("SECRET", { x: 20, y: 200, size: 12, font });
      page.drawRectangle({ x: 15, y: 195, width: 60, height: 20, color: rgb(0, 0, 0) });
      page.drawEllipse({ x: 200, y: 205, xScale: 5, yScale: 6, color: rgb(1, 1, 1) }); // 帯の外
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(textHits(r).map((f) => [f.confidence, f.metrics!.textOnTop])).toEqual([["high", "none"]]);
  });

  it("とても小さい字（箱の高さ 2pt 未満）の上の黒塗りは「確かめてください」。12pt の字は確かなもの", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("TINY TEXT", { x: 20, y: 200, size: 1.5, font, rotate: degrees(10) }); // 傾けた見本書類の絵の中の字の代わり
      page.drawRectangle({ x: 18, y: 198, width: 12, height: 6, color: rgb(0, 0, 0) });
      page.drawText("NAME", { x: 20, y: 100, size: 12, font });
      page.drawRectangle({ x: 15, y: 95, width: 50, height: 20, color: rgb(0, 0, 0) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    const byY = textHits(r).sort((a, b) => b.rect[1] - a.rect[1]);
    expect(byY.map((f) => f.confidence)).toEqual(["check", "high"]);
    expect(byY[0]!.metrics!.glyphHeightMax).toBeLessThan(2);
    expect(byY[0]!.metrics!.hiddenRotated).toBe(true);
    expect(byY[1]!.metrics!.hiddenRotated).toBe(false);
    expect(r.diagnostics?.["text:check_tiny"]).toBe(1);
  });
});

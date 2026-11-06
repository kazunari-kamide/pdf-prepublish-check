// SPDX-License-Identifier: AGPL-3.0-only
//
// P7（隠れたテキスト）の縦書き（1.7.0 から。2026-11-06）。
// 前は、縦書きの書体（Identity-V）の字も右へ送っていたので、縦の列の字が横に並び、隣の列の字と同じ所に来て
// 「同じ所に、違う字が重ねて描かれています」（overdrawn）になり、右の端の列は「ページの見える範囲の外」（off_page）になっていた。
// 箱と送りを P6 と同じもの（rules/shared/fonts.ts の glyphExtent・glyphAdvance・tjShift）にした。
// 書体は Identity-V・Adobe-Japan1・ToUnicode なしの CID の書体（字は Adobe-Japan1 の表から読む）。どれも架空の PDF をここで作る。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { ADOBE_JAPAN1 } from "../rules/shared/cid-unicode/adobe-japan1.ts";
import { detectP7Hidden } from "../rules/p7-hidden/index.ts";
import { glyphAdvance, glyphExtent, tjShift, type FontInfo } from "../rules/shared/fonts.ts";

const CHARS = [...ADOBE_JAPAN1.chars];
function cidOf(ch: string): number {
  const i = CHARS.indexOf(ch);
  if (i < 0) throw new Error(`表に ${ch} がありません`);
  return i;
}
const hex = (s: string) => `<${[...s].map((c) => cidOf(c).toString(16).padStart(4, "0")).join("").toUpperCase()}>`;

/** Identity-V（縦）または Identity-H（横）・Adobe-Japan1・ToUnicode なしの書体 /F1 で、content を描いた A4 の 1 ページ */
async function makePdf(content: string, encoding: "Identity-V" | "Identity-H" = "Identity-V"): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const cid = ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "CIDFontType0",
      BaseFont: "KasouMincho",
      CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Japan1"), Supplement: 6 },
      FontDescriptor: ctx.obj({ Type: "FontDescriptor", FontName: "KasouMincho", Flags: 4, FontBBox: [0, -141, 1000, 859], ItalicAngle: 0, Ascent: 859, Descent: -141, CapHeight: 700, StemV: 80 }),
      DW: 1000,
    }),
  );
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "KasouMincho", Encoding: encoding, DescendantFonts: [cid] }));
  const page = doc.addPage([595, 842]);
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font } }));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  return doc.save({ useObjectStreams: false });
}

const findings = async (content: string, encoding?: "Identity-V" | "Identity-H") => {
  const r = await detectP7Hidden(await makePdf(content, encoding));
  expect(r.status).toBe("ok");
  return r.findings.map((f) => `${f.reason}:${f.chars}`);
};

/** 14pt の縦の列を、右から左へ 1em（14pt）ずつ並べる。右の端の列は、ページの右の端（595）のすぐ内側 */
const COLUMNS = ["申請書類の提出期", "限は来月末日まで", "窓口で受け付けま", "郵送でも構いませ", "ご不明な点は係へ"];
const columnsContent = (tj = false) =>
  COLUMNS.map((s, i) => {
    const x = 570 - i * 14;
    // TJ の数で、字の間を少し詰める列も混ぜる（縦書きの TJ の数は、下へ詰める）
    const body = tj && i % 2 === 1 ? `[${[...s].map((c) => hex(c)).join(" 20 ")}] TJ` : `${hex(s)} Tj`;
    return `BT /F1 14 Tf 1 0 0 1 ${x} 800 Tm ${body} ET`;
  }).join("\n");

describe("P7 の縦書き（Identity-V・Adobe-Japan1・ToUnicode なし）", () => {
  it("1em 間隔の縦の列が並ぶふつうの紙面：報告 0 件（重ね描き・ページの外にしない）", async () => {
    expect(await findings(columnsContent())).toEqual([]);
  });

  it("TJ の数で字の間を詰めた縦の列が混ざっても：報告 0 件", async () => {
    expect(await findings(columnsContent(true))).toEqual([]);
  });

  it("対照：横書きで、同じ所に本当に違う字を重ねたもの → 1 件（overdrawn）", async () => {
    const c = `BT /F1 14 Tf 1 0 0 1 72 700 Tm ${hex("山田太郎")} Tj ET BT /F1 14 Tf 1 0 0 1 72 700 Tm ${hex("公開資料")} Tj ET`;
    expect(await findings(c, "Identity-H")).toEqual(["overdrawn:4"]);
  });

  it("対照：縦書きで、同じ所に本当に違う字を重ねたもの → 1 件（overdrawn）", async () => {
    const c = `BT /F1 14 Tf 1 0 0 1 300 700 Tm ${hex("山田太郎")} Tj ET BT /F1 14 Tf 1 0 0 1 300 700 Tm ${hex("公開資料")} Tj ET`;
    expect(await findings(c)).toEqual(["overdrawn:4"]);
  });

  it("対照：縦書きの列が、本当にページの外（右の外）にあるもの → 1 件（off_page）", async () => {
    const c = `${columnsContent()}\nBT /F1 14 Tf 1 0 0 1 640 800 Tm ${hex("隠した氏名と住所")} Tj ET`;
    expect(await findings(c)).toEqual(["off_page:8"]);
  });

  it("対照：縦書きの列の下の端だけがページの外へ出るもの → 下の外の字だけを 1 件（off_page）", async () => {
    // 原点の高さ 40pt から 1em ずつ下へ。1 字目（40）・2 字目（26）・3 字目（12）は中、4 字目（−2）からは箱の大半が外
    const c = `BT /F1 14 Tf 1 0 0 1 300 40 Tm ${hex("見える字外の字")} Tj ET`;
    const got = await findings(c);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/^off_page:[34]$/);
  });
});

describe("字の箱と送り（P6 と P7 で共通。rules/shared/fonts.ts）", () => {
  const base = { twoByte: true, ascent: 0.859, descent: -0.141, decode: () => [] } satisfies FontInfo;
  const vert: FontInfo = { ...base, vertical: { vy: 0.88, w1: -1 } };

  it("横書き：原点から右へ幅、送りは右へ（字の幅×大きさ＋Tc＋Tw）×Th。TJ の数は左へ詰める", () => {
    expect(glyphExtent(base, 1)).toEqual({ x0: 0, x1: 1, y0: -0.141, y1: 0.859 });
    expect(glyphAdvance(base, { width: 0.5, isWordSpace: true }, 10, 1, 2, 0.5)).toEqual([4, 0]);
    expect(tjShift(base, 100, 10, 1)).toEqual([-1, 0]);
  });

  it("縦書き：横は幅の半分ずつ左右に、縦は縦の原点から下へ。送りは下へ（w1×大きさ − Tc）。TJ の数は下へ詰める", () => {
    const e = glyphExtent(vert, 1);
    expect(e.x0).toBe(-0.5);
    expect(e.x1).toBe(0.5);
    expect(e.y0).toBeCloseTo(-1.021, 9);
    expect(e.y1).toBeCloseTo(-0.021, 9);
    expect(glyphAdvance(vert, { width: 1, isWordSpace: false }, 14, 1, 5, 1)).toEqual([0, -15]);
    expect(tjShift(vert, 100, 10, 0.5)).toEqual([0, -1]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付け 0.8.0 で足した覆いの型と、書体の字形の片付けのテスト。合成 PDF はテストの中で作る（字はすべて架空。目印は KAKUSHI…）。
// 片付けたあとに、目印が次の 3 つのどれにも残らないことを確かめる：
//   1. ファイルのバイト列と、解けるストリームの中身（そのまま・UTF-16・16 進）
//   2. PDF.js で取り出せる字
//   3. 読み直し（作品の検査の P6・P7・P8 の行と、検証器 P6）
// 決まりごとに、消してはいけない対照も置く。

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fontkit from "@pdf-lib/fontkit";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream, rgb, type PDFContext } from "pdf-lib";
import { detectFontGlyphs } from "../rules/font-glyphs/index.ts";
import { parseSfnt, glyphBox } from "../sanitize/font-prune.ts";
import { redact, sanitizePdf, type SanitizeResult } from "../sanitize/index.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";
import { inspectAll } from "../src/inspect/inspect";
import { verifierP6 } from "./helpers/redact-checks.ts";
import { buildPdf, latinAt } from "./helpers/redact-pdfs.ts";
import { HEAVY_TIMEOUT } from "./helpers/timeout.ts";

const codec = createNodeImageCodec();
const FONT = path.resolve(import.meta.dirname, "..", "fixtures", "p6", "fonts", "BIZUDGothic-Regular.ttf");

function forms(s: string): Buffer[] {
  const ascii = Buffer.from(s, "latin1");
  const u16 = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) u16.writeUInt16BE(s.charCodeAt(i), i * 2);
  return [ascii, u16, ...[ascii, u16].flatMap((b) => [Buffer.from(b.toString("hex").toUpperCase()), Buffer.from(b.toString("hex"))])];
}

/** 1. バイト列と、解けるストリームの中身 */
async function inFile(bytes: Uint8Array, s: string): Promise<boolean> {
  const f = forms(s);
  const has = (b: Uint8Array) => f.some((x) => Buffer.from(b).includes(x));
  if (has(bytes)) return true;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) continue;
    try {
      if (has(decodePDFRawStream(o).decode())) return true;
    } catch {
      if (has(o.contents)) return true;
    }
  }
  return false;
}

/** 2. PDF.js で取り出せる字 */
async function textOf(bytes: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  let t = "";
  for (let p = 1; p <= doc.numPages; p++) t += (await (await doc.getPage(p)).getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join("");
  await task.destroy();
  return t;
}

/** 3. 読み直し：作品の検査の P6・P7・P8 の行と、検証器 P6 の残り */
async function reinspect(bytes: Uint8Array): Promise<string[]> {
  const r = await inspectAll(bytes);
  const out = r.rules.filter((x) => ["P6", "P7", "P8"].includes(x.pattern)).flatMap((x) => x.items.map(() => `${x.ruleId}`));
  for (const l of await verifierP6.run(bytes, [])) out.push(`verifier:${l.kind}`);
  return out;
}

async function expectGone(bytes: Uint8Array, marker: string) {
  expect(await inFile(bytes, marker), "バイト列").toBe(false);
  expect(await textOf(bytes), "PDF.js の字").not.toContain(marker);
  expect(await reinspect(bytes), "読み直し").toEqual([]);
}

async function clean(bytes: Uint8Array): Promise<Extract<SanitizeResult, { status: "ok" }>> {
  const r = await sanitizePdf(bytes, { codec });
  expect(r.status).toBe("ok");
  if (r.status !== "ok") throw new Error(r.status);
  return r;
}

/** 作った PDF の 1 ページめの資源に、書き足す */
async function withResources(bytes: Uint8Array, edit: (ctx: PDFContext, res: PDFDict) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  edit(doc.context, doc.getPage(0).node.Resources()!);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe("埋め込み画像（BI … EI）の覆い", () => {
  it("黒い埋め込み画像の下の字を消す。埋め込み画像の上に描いた字は残す", { timeout: HEAVY_TIMEOUT }, async () => {
    const black = "BI /W 4 /H 2 /CS /G /BPC 8 ID \x00\x00\x00\x00\x00\x00\x00\x00 EI";
    const r = await clean(await buildPdf(() => ({
      pages: [{ content: latinAt(40, 200, "KAKUSHI-INLINE") + `q 140 0 0 20 36 195 cm ${black} Q\n` + `q 140 0 0 20 36 95 cm ${black} Q\n` + "BT /H1 12 Tf 1 g 40 100 Td (SHOWN-ON-INLINE) Tj ET\n" }],
    })));
    expect(r.removed.some((x) => x.kind === "covered_text")).toBe(true);
    await expectGone(r.bytes, "KAKUSHI");
    expect(await textOf(r.bytes)).toContain("SHOWN-ON-INLINE");
  });

  it("自分で黒塗りでも、埋め込み画像のあるページの字を消して保存できる", { timeout: HEAVY_TIMEOUT }, async () => {
    const r = await redact(await buildPdf(() => ({
      pages: [{ content: "q 100 0 0 50 30 150 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x10\x20\x30\x40 EI Q\n" + latinAt(40, 220, "KAKUSHI-PICKED") + latinAt(40, 60, "SHOWN-NOT-PICKED") }],
    })), [{ page: 1, rect: [38, 215, 160, 232] }], { codec });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(await inFile(r.bytes, "KAKUSHI")).toBe(false);
    expect(await textOf(r.bytes)).toContain("SHOWN-NOT-PICKED");
  });
});

describe("模様（パターン）で塗った覆い", () => {
  const page = (pattern: string) => latinAt(40, 200, "KAKUSHI-UNDER-PATTERN") + latinAt(40, 100, "SHOWN-OUTSIDE") + `q /Pattern cs /P1 scn 36 195 170 20 re f Q\n` + (pattern ? "" : "");

  it("両端を伸ばした色の移り変わりで塗った覆いの下の字を消す", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await withResources(await buildPdf(() => ({ pages: [{ content: page("") }] })), (ctx, res) => {
      const sh = ctx.obj({ ShadingType: 2, ColorSpace: "DeviceGray", Coords: [0, 0, 300, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [0], C1: [0.2], N: 1 }, Extend: [true, true] });
      res.set(PDFName.of("Pattern"), ctx.obj({ P1: ctx.obj({ PatternType: 2, Shading: sh }) }));
    });
    const r = await clean(bytes);
    expect(r.removed.some((x) => x.kind === "covered_text")).toBe(true);
    await expectGone(r.bytes, "KAKUSHI");
    expect(await textOf(r.bytes)).toContain("SHOWN-OUTSIDE");
  });

  it("中に字のある模様で塗った覆いは、黒一色で塗り直し、模様の中の字と覆いの下の字を消す", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await withResources(await buildPdf(() => ({ pages: [{ content: page("") }] })), (ctx, res) => {
      const font = ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
      const cell = ctx.register(ctx.stream("0 g 0 0 20 10 re f 1 g BT /F9 4 Tf 1 3 Td (KAKUSHI-IN-CELL) Tj ET", { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 20, 10], XStep: 20, YStep: 10, Resources: { Font: { F9: font } } }));
      res.set(PDFName.of("Pattern"), ctx.obj({ P1: cell }));
    });
    const r = await clean(bytes);
    expect(r.removed.some((x) => x.kind === "pattern_repainted")).toBe(true);
    await expectGone(r.bytes, "KAKUSHI");
    expect(await textOf(r.bytes)).toContain("SHOWN-OUTSIDE");
  });

  it("すきまのある模様（下が見える）の下の字は残す", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await withResources(await buildPdf(() => ({ pages: [{ content: latinAt(40, 200, "SHOWN-UNDER-DOTS") + `q /Pattern cs /P1 scn 36 195 170 20 re f Q\n` }] })), (ctx, res) => {
      const cell = ctx.register(ctx.stream("0 g 0 0 2 2 re f", { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 2, 2], XStep: 8, YStep: 8, Resources: {} }));
      res.set(PDFName.of("Pattern"), ctx.obj({ P1: cell }));
    });
    const r = await clean(bytes);
    expect(await textOf(r.bytes)).toContain("SHOWN-UNDER-DOTS");
  });
});

describe("黒い四角の形の字で覆った字", () => {
  async function build(coverY: number): Promise<Uint8Array> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.registerFontkit(fontkit);
    const sym = await doc.embedFont(readFileSync(FONT), { subset: true });
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText("KAKUSHI-BLOCK", { x: 40, y: 200, size: 10, font: helv, color: rgb(0, 0, 0) });
    page.drawText("SHOWN-ELSEWHERE", { x: 40, y: 100, size: 10, font: helv, color: rgb(0, 0, 0) });
    page.drawText("■■■■■", { x: 36, y: coverY, size: 22, font: sym, color: rgb(0, 0, 0) });
    return new Uint8Array(await doc.save({ useObjectStreams: false }));
  }

  it("黒い四角の字を並べて覆った字を消す", { timeout: HEAVY_TIMEOUT }, async () => {
    const r = await clean(await build(196));
    expect(r.removed.some((x) => x.kind === "covered_text")).toBe(true);
    await expectGone(r.bytes, "KAKUSHI");
    expect(await textOf(r.bytes)).toContain("SHOWN-ELSEWHERE");
    expect(await textOf(r.bytes)).toContain("■■■■■");
  });

  it("離れた所に並べた黒い四角の字は、ほかの字を消さない", { timeout: HEAVY_TIMEOUT }, async () => {
    const r = await clean(await build(20));
    const t = await textOf(r.bytes);
    expect(t).toContain("KAKUSHI-BLOCK");
    expect(t).toContain("SHOWN-ELSEWHERE");
  });
});

describe("黒い注釈の下の、注釈の見た目の中の字", () => {
  it("あとの黒い注釈に隠れた、注釈の見た目の中の字を消す。隠れていない注釈の見た目の字は残す", { timeout: HEAVY_TIMEOUT }, async () => {
    const r = await clean(await buildPdf((doc) => {
      const ctx = doc.context;
      const font = ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
      const ap = (s: string) => ctx.register(ctx.stream(`BT /F9 10 Tf 2 5 Td (${s}) Tj ET`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 140, 20], Resources: { Font: { F9: font } } }));
      const black = ctx.register(ctx.stream("0 g 0 0 150 24 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 150, 24] }));
      return {
        pages: [{
          content: latinAt(40, 250, "Body"),
          annots: [
            { Subtype: "Stamp", Rect: [40, 150, 180, 170], F: 4, AP: { N: ap("KAKUSHI-IN-STAMP") } },
            { Subtype: "Stamp", Rect: [40, 80, 180, 100], F: 4, AP: { N: ap("SHOWN-STAMP") } },
            { Subtype: "Square", Rect: [36, 148, 186, 172], F: 4, IC: [0, 0, 0], AP: { N: black } },
          ],
        }],
      };
    }));
    expect(r.removed.some((x) => x.kind === "covered_text")).toBe(true);
    expect(await inFile(r.bytes, "KAKUSHI")).toBe(false);
    expect(await inFile(r.bytes, "SHOWN-STAMP")).toBe(true);
  });
});

describe("描かれていない字形を書体から外す", () => {
  async function build(drawn: string, extra: string, opts: { tag?: boolean } = {}): Promise<Uint8Array> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(FONT), { subset: true });
    const page = doc.addPage([300, 200]);
    if (drawn) page.drawText(drawn, { x: 20, y: 100, size: 14, font, color: rgb(0, 0, 0) });
    if (extra) font.encodeText(extra);
    const first = new Uint8Array(await doc.save({ useObjectStreams: false }));
    if (opts.tag === false) return first;
    const again = await PDFDocument.load(first, { updateMetadata: false });
    for (const [, o] of again.context.enumerateIndirectObjects()) {
      if (!(o instanceof PDFDict)) continue;
      for (const key of ["BaseFont", "FontName"]) {
        const v = o.get(PDFName.of(key));
        if (v instanceof PDFName && v.decodeText().startsWith("BIZUDGothic")) o.set(PDFName.of(key), PDFName.of(`KAKUUA+${v.decodeText()}`));
      }
    }
    return new Uint8Array(await again.save({ useObjectStreams: false }));
  }
  /** 書体のファイルの、中身のある字形の数 */
  async function glyphsWithOutline(bytes: Uint8Array): Promise<number> {
    const doc = await PDFDocument.load(bytes);
    for (const [, o] of doc.context.enumerateIndirectObjects()) {
      if (!(o instanceof PDFDict) || !o.has(PDFName.of("FontFile2"))) continue;
      const s = parseSfnt(decodePDFRawStream(doc.context.lookup(o.get(PDFName.of("FontFile2"))) as PDFRawStream).decode())!;
      let n = 0;
      for (let g = 0; g < s.numGlyphs; g++) if (glyphBox(s, g)) n++;
      return n;
    }
    return -1;
  }

  for (const tag of [true, false]) {
    it(`描かれていない字の字形を外し、描いた字は残す（部分埋め込みの印 ${tag ? "あり" : "なし"}）`, { timeout: HEAVY_TIMEOUT }, async () => {
      const bytes = await build("お知らせ", "架空申請者", { tag });
      const before = await glyphsWithOutline(bytes);
      const r = await clean(bytes);
      expect(r.removed.some((x) => x.kind === "font_glyphs")).toBe(true);
      expect((await detectFontGlyphs(r.bytes)).findings).toEqual([]);
      expect(await glyphsWithOutline(r.bytes)).toBe(5); // 描いた 4 字と、字形 0（.notdef）
      expect(before).toBeGreaterThan(4);
      expect(await textOf(r.bytes)).toContain("お知らせ");
    });
  }

  it("自分で黒塗りで消した字の字形も外す", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await build("お知らせ架空", "");
    const r = await redact(bytes, [{ page: 1, rect: [74, 95, 120, 118] }], { codec });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect((await detectFontGlyphs(r.bytes)).findings).toEqual([]);
    const t = await textOf(r.bytes);
    expect(t).toContain("お知ら");
    expect(t).not.toContain("架空");
  });

  it("フォームの既定の書体（/DR）にも使う書体は、外さない", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await build("お知らせ", "架空申請者");
    const doc = await PDFDocument.load(bytes);
    const fontRef = (doc.getPage(0).node.Resources()!.lookup(PDFName.of("Font"), PDFDict)).values()[0]!;
    doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [], DR: { Font: { F1: fontRef } } }));
    const withDr = new Uint8Array(await doc.save({ useObjectStreams: false }));
    const r = await clean(withDr);
    expect(r.removed.some((x) => x.kind === "font_glyphs")).toBe(false);
    expect(await glyphsWithOutline(r.bytes)).toBe(await glyphsWithOutline(withDr));
  });
});


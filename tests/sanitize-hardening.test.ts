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
import { PDFArray as PDFArrayType, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream, rgb, type PDFContext } from "pdf-lib";
import { detectFontGlyphs } from "../rules/font-glyphs/index.ts";
import { parseSfnt, glyphBox, rebuildSfnt } from "../sanitize/font-prune.ts";
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


describe("攻撃する人の目の形（11/5 の確かめで残ったもの）", () => {
  /** 字の入った模様で塗った四角を、黒い覆いの下に置いた PDF */
  async function patternUnderCover(): Promise<Uint8Array> {
    return withResources(await buildPdf(() => ({
      pages: [{ content: "q /Pattern cs /P1 scn 36 195 170 20 re f Q\n" + "0 g 36 195 170 20 re f\n" + latinAt(40, 100, "SHOWN-OUTSIDE") }],
    })), (ctx, res) => {
      const font = ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
      const cell = ctx.register(ctx.stream("BT /F9 4 Tf 1 3 Td (KAKUSHI-IN-PATTERN) Tj ET", { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 60, 10], XStep: 60, YStep: 10, Resources: { Font: { F9: font } } }));
      res.set(PDFName.of("Pattern"), ctx.obj({ P1: cell }));
    });
  }

  it("(1) 覆いの下の、字の入った模様：片付けで黒一色に塗り直し、模様の中の字を消す", { timeout: HEAVY_TIMEOUT }, async () => {
    const r = await clean(await patternUnderCover());
    expect(r.removed.some((x) => x.kind === "pattern_repainted")).toBe(true);
    await expectGone(r.bytes, "KAKUSHI");
    expect(await textOf(r.bytes)).toContain("SHOWN-OUTSIDE");
  });

  it("(1) 自分で黒塗り：選んだ所の、字の入った模様も消してから保存する", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await withResources(await buildPdf(() => ({
      pages: [{ content: "q /Pattern cs /P1 scn 36 195 170 20 re f Q\n" + latinAt(40, 100, "SHOWN-OUTSIDE") }],
    })), (ctx, res) => {
      const font = ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
      const cell = ctx.register(ctx.stream("BT /F9 4 Tf 1 3 Td (KAKUSHI-IN-PATTERN) Tj ET", { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 60, 10], XStep: 60, YStep: 10, Resources: { Font: { F9: font } } }));
      res.set(PDFName.of("Pattern"), ctx.obj({ P1: cell }));
    });
    const { checkAreas } = await import("../sanitize/redact-check.ts");
    // 消す前の PDF では、選んだ所の確かめが「字の入った模様」を数える（確かめが空振りしていない）
    expect((await checkAreas(bytes, [{ page: 1, rect: [36, 195, 206, 215] }])).some((l) => l.kind === "pattern_text")).toBe(true);
    const r = await redact(bytes, [{ page: 1, rect: [36, 195, 206, 215] }], { codec });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    await expectGone(r.bytes, "KAKUSHI");
    expect(await textOf(r.bytes)).toContain("SHOWN-OUTSIDE");
  });

  /** 秘密の字（埋め込んだ書体。字の対応表あり）の上に、黒い四角の形の字を並べた PDF。cover：Type3 の n か、対応表を外した TrueType の ■ */
  async function blockOver(cover: "type3" | "truetype", y: number): Promise<Uint8Array> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(FONT), { subset: true });
    const page = doc.addPage([400, 300]);
    page.drawText("KAKUSHI-SECRET", { x: 40, y: 200, size: 10, font, color: rgb(0, 0, 0) });
    page.drawText("SHOWN", { x: 40, y: 100, size: 10, font, color: rgb(0, 0, 0) });
    if (cover === "truetype") {
      // @pdf-lib/fontkit 1.1.1 は、奇数バイトの字形があると、絞った書体の位置の表がずれる（fixtures/p6/build.mjs の注）。
      // 埋め込む前に、字形を 4 バイトにそろえた書体にする（字の形は変わらない）
      const src = parseSfnt(new Uint8Array(readFileSync(FONT)))!;
      const padded = rebuildSfnt(src, new Set(Array.from({ length: src.numGlyphs }, (_, i) => i))).data;
      const sym = await doc.embedFont(padded, { subset: true });
      // BIZ UDゴシックの ■ は字の幅より小さく、並べると間にすきまが空く。半字ずらしてもう 1 列重ね、すきまなく覆う
      page.drawText("■■■■■■", { x: 36, y, size: 20, font: sym, color: rgb(0, 0, 0) });
      page.drawText("■■■■■■", { x: 46, y, size: 20, font: sym, color: rgb(0, 0, 0) });
      const saved = await doc.save({ useObjectStreams: false });
      // 黒い四角の書体の字の対応表を外す（字の対応表では黒い四角と分からない形）
      const again = await PDFDocument.load(saved, { updateMetadata: false });
      const fonts = again.getPage(0).node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
      const keys = fonts.keys();
      (again.context.lookup(fonts.get(keys[keys.length - 1]!)) as PDFDict).delete(PDFName.of("ToUnicode"));
      return new Uint8Array(await again.save({ useObjectStreams: false }));
    }
    const ctx = doc.context;
    const proc = ctx.register(ctx.stream("1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f"));
    const t3 = ctx.register(ctx.obj({
      Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { n: proc }, Encoding: { Type: "Encoding", Differences: [110, "n"] }, FirstChar: 110, LastChar: 110, Widths: [1000], Resources: {},
    }));
    page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict).set(PDFName.of("T3"), t3);
    const extra = ctx.register(ctx.stream(`BT /T3 14 Tf 0 g 36 ${y} Td (nnnnnnnnnnn) Tj ET`));
    const contents = page.node.Contents();
    page.node.set(PDFName.of("Contents"), ctx.obj([...(contents instanceof PDFArrayType ? contents.asArray() : [page.node.get(PDFName.of("Contents"))!]), extra]));
    return new Uint8Array(await doc.save({ useObjectStreams: false }));
  }

  for (const cover of ["type3", "truetype"] as const) {
    it(`(2) 黒い四角の形の字（${cover === "type3" ? "Type3 の n" : "字の対応表のない ■"}）で覆った字を消す。字の対応表からも消える`, { timeout: HEAVY_TIMEOUT }, async () => {
      const r = await clean(await blockOver(cover, 196));
      expect(r.removed.some((x) => x.kind === "covered_text")).toBe(true);
      await expectGone(r.bytes, "KAKUSHI");
      expect(await textOf(r.bytes)).toContain("SHOWN");
      // 秘密の字だけで使っていた字（K・I・E・C・R・T）の読みが、字の対応表に残らない
      const doc = await PDFDocument.load(r.bytes);
      let cmaps = "";
      for (const [, o] of doc.context.enumerateIndirectObjects()) {
        if (o instanceof PDFDict && o.has(PDFName.of("ToUnicode"))) cmaps += Buffer.from(decodePDFRawStream(doc.context.lookup(o.get(PDFName.of("ToUnicode"))) as PDFRawStream).decode()).toString("latin1");
      }
      for (const ch of "KICRT") expect(cmaps, ch).not.toMatch(new RegExp(`<00${ch.charCodeAt(0).toString(16).toUpperCase()}>`));
    });

    it(`(2) 対照：離れた所の黒い四角の形の字（${cover}）は、ほかの字を消さない`, { timeout: HEAVY_TIMEOUT }, async () => {
      const r = await clean(await blockOver(cover, 20));
      expect(await textOf(r.bytes)).toContain("KAKUSHI-SECRET");
    });
  }
});

describe("部品の中の資源に残る、描かれない画像", () => {
  it("描く部品の資源の中の、描かれない画像を外す。部品の中で描く画像（と、部品の中の部品で描く画像）は残す", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await withResources(await buildPdf(() => ({ pages: [{ content: latinAt(40, 250, "Body") + "q /Fm1 Do Q\n" }] })), (ctx, res) => {
      // 画像の中身に目印の字を入れる（8 × 2 の灰色。そのままのバイト列）
      const img = (s: string) => ctx.register(ctx.stream(s.padEnd(16, "_").slice(0, 16), { Type: "XObject", Subtype: "Image", Width: 8, Height: 2, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
      const inner = ctx.register(ctx.stream("q 50 0 0 20 40 40 cm /ImIn Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 400, 300], Resources: { XObject: { ImIn: img("SHOWN-INNER-IMG") } } }));
      const form = ctx.register(ctx.stream("q 50 0 0 20 40 100 cm /Im1 Do Q /Fm2 Do", {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, 400, 300],
        Resources: { XObject: { Im1: img("SHOWN-FORM-IMG"), Im2: img("KAKUSHI-OLD-IMG"), Fm2: inner } },
      }));
      res.set(PDFName.of("XObject"), ctx.obj({ Fm1: form }));
    });
    // 片付ける前は、描かれない画像がファイルにある（確かめが空振りしていない）
    expect(await inFile(bytes, "KAKUSHI-OLD")).toBe(true);
    const r = await clean(bytes);
    expect(r.removed.find((x) => x.kind === "unused_xobject")?.count).toBe(1);
    expect(await inFile(r.bytes, "KAKUSHI")).toBe(false);
    expect(await inFile(r.bytes, "SHOWN-FORM")).toBe(true);
    expect(await inFile(r.bytes, "SHOWN-INNER")).toBe(true);
  });
});

describe("埋め込んでいない標準の記号の書体（ZapfDingbats）の黒い四角で覆った字", () => {
  /** 秘密の字の上に、ZapfDingbats の字（code）を横の伸縮 6% で詰めて並べ、黒い帯にした PDF */
  async function dingbats(chars: string, y: number): Promise<Uint8Array> {
    return withResources(await buildPdf(() => ({
      pages: [{ size: [595, 842], content: "BT /H1 14 Tf 72 700 Td (KAKUSHI-DINGBATS) Tj ET\n" + `q BT /Z1 30 Tf 0 g 70 ${y} Td 6 Tz (${chars.repeat(120)}) Tj ET Q\n` + latinAt(72, 400, "SHOWN-ELSEWHERE") }],
    })), (ctx, res) => {
      (res.lookup(PDFName.of("Font"), PDFDict)).set(PDFName.of("Z1"), ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "ZapfDingbats" }));
    });
  }

  it("ZapfDingbats の n（黒い四角）を詰めて並べた帯の下の字を消す。帯は残る", { timeout: HEAVY_TIMEOUT }, async () => {
    const r = await clean(await dingbats("n", 692));
    expect(r.removed.some((x) => x.kind === "covered_text")).toBe(true);
    await expectGone(r.bytes, "KAKUSHI");
    expect(await textOf(r.bytes)).toContain("SHOWN-ELSEWHERE");
    // 黒い帯の字（横につぶれた字）は、見えない字として数えず、同じ所の黒い四角に描き直す
    expect(r.removed.some((x) => x.reason === "squashed")).toBe(false);
    expect(r.removed.find((x) => x.kind === "glyph_cover_box")?.count).toBe(120);
    // 秘密の字の後ろの部分（帯の右の端の近く）も残らない
    expect(await textOf(r.bytes)).not.toMatch(/DING|ATS/);
    expect(await inFile(r.bytes, "DINGBATS")).toBe(false);
  });

  it("自分で黒塗りでも、帯の下の字を消して保存できる", { timeout: HEAVY_TIMEOUT }, async () => {
    const r = await redact(await dingbats("n", 692), [{ page: 1, rect: [70, 690, 250, 720] }], { codec });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(await inFile(r.bytes, "KAKUSHI")).toBe(false);
  });

  it("対照：離れた所の帯・黒い四角でない字（o）の帯は、ほかの字を消さない", { timeout: HEAVY_TIMEOUT }, async () => {
    expect(await textOf((await clean(await dingbats("n", 300))).bytes)).toContain("KAKUSHI-DINGBATS");
    expect(await textOf((await clean(await dingbats("o", 692))).bytes)).toContain("KAKUSHI-DINGBATS");
  });
});

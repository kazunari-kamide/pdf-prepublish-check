// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P7 1.1.0 で足した、見える字の中の隠しのテスト（取りこぼし 26 項目の 15〜18）。
// 15 見えない文字コード、16 字の対応表の書き換え、17 違う字の重ね描き、18 文字認識の層のお知らせ。
// 型ごとに、隠しのある合成 PDF と、何も隠していない対照の両方を、テストの中で作る。名前・番号はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
import { detectP7Hidden } from "../rules/p7-hidden/index.ts";
import { unicodeOfGlyphName } from "../rules/p7-hidden/remap.ts";

const hex4 = (s: string) => [...s].map((ch) => ch.codePointAt(0)!).flatMap((cp) => {
  if (cp <= 0xffff) return [cp.toString(16).padStart(4, "0")];
  const v = cp - 0x10000;
  return [(0xd800 + (v >> 10)).toString(16), (0xdc00 + (v & 0x3ff)).toString(16)];
}).join("").toUpperCase();

/** ToUnicode の CMap（bfchar だけ）。codeBytes は1バイトなら 1、2バイトなら 2 */
function toUnicodeCMap(map: Array<[number, string]>, codeBytes: 1 | 2): string {
  const w = codeBytes * 2;
  const lo = "0".repeat(w);
  const hi = "F".repeat(w);
  return [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CMapName /Test-UCS def /CMapType 2 def",
    `1 begincodespacerange <${lo}> <${hi}> endcodespacerange`,
    `${map.length} beginbfchar`,
    ...map.map(([code, s]) => `<${code.toString(16).toUpperCase().padStart(w, "0")}> <${hex4(s)}>`),
    "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
}

type FontSpec =
  | { kind: "simple"; baseFont?: string; encoding?: unknown; toUnicode?: Array<[number, string]>; flags?: number }
  | { kind: "cid"; toUnicode: Array<[number, string]> };

async function makePdf(content: string, font: FontSpec, opts: { image?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  let fontRef;
  if (font.kind === "simple") {
    const dict: Record<string, unknown> = { Type: "Font", Subtype: "Type1", BaseFont: font.baseFont ?? "Helvetica" };
    if (font.encoding !== undefined) dict.Encoding = font.encoding;
    if (font.toUnicode) dict.ToUnicode = ctx.register(ctx.stream(toUnicodeCMap(font.toUnicode, 1)));
    if (font.flags !== undefined) {
      dict.FontDescriptor = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: font.baseFont ?? "Helvetica", Flags: font.flags, FontBBox: [0, -200, 1000, 800], Ascent: 800, Descent: -200 }));
    }
    fontRef = ctx.register(ctx.obj(dict as never));
  } else {
    const desc = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "TestMincho", Flags: 4, FontBBox: [0, -120, 1000, 880], Ascent: 880, Descent: -120 }));
    const cid = ctx.register(ctx.obj({ Type: "Font", Subtype: "CIDFontType2", BaseFont: "TestMincho", CIDSystemInfo: { Registry: ctx.obj("Adobe") as never, Ordering: ctx.obj("Japan1") as never, Supplement: 6 }, FontDescriptor: desc, DW: 1000 }));
    fontRef = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "TestMincho", Encoding: "Identity-H", DescendantFonts: [cid], ToUnicode: ctx.register(ctx.stream(toUnicodeCMap(font.toUnicode, 2))) }));
  }
  const res: Record<string, unknown> = { Font: { F1: fontRef } };
  if (opts.image) {
    res.XObject = { Im1: ctx.register(ctx.stream(new Uint8Array([0, 255, 255, 0]), { Type: "XObject", Subtype: "Image", Width: 2, Height: 2, ColorSpace: "DeviceGray", BitsPerComponent: 8 })) };
  }
  page.node.set(PDFName.of("Resources"), ctx.obj(res as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

const run = async (content: string, font: FontSpec, opts?: { image?: boolean }) => {
  const r = await detectP7Hidden(await makePdf(content, font, opts));
  expect(r.status).toBe("ok");
  return r;
};
const reasons = async (content: string, font: FontSpec, opts?: { image?: boolean }) => (await run(content, font, opts)).findings.map((f) => `${f.reason}:${f.chars}`);

/** ASCII の字をそのまま取り出す ToUnicode（対照のふつうの書体） */
const asciiMap = (s: string): Array<[number, string]> => [...new Set(s)].map((ch) => [ch.charCodeAt(0), ch]);
const WIN = "WinAnsiEncoding";

describe("15. 見えない文字コード（hidden_codepoint）", () => {
  it("幅 0 の字・タグ文字・向きの制御の字が取り出されれば出す。数は文字コードの数", async () => {
    const font: FontSpec = { kind: "simple", encoding: WIN, toUnicode: [...asciiMap("Notice"), [0x7e, "​​"], [0x7c, "\u{E0041}\u{E0042}\u{E0043}"], [0x5e, "‮"]] };
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (Notice~) Tj ET", font)).toEqual(["hidden_codepoint:2"]);
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (Notice|) Tj ET", font)).toEqual(["hidden_codepoint:3"]);
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (Notice^) Tj ET", font)).toEqual(["hidden_codepoint:1"]);
  });

  it("BOM（U+FEFF）だけの字も数える（空白として読まれても落とさない）", async () => {
    const font: FontSpec = { kind: "simple", encoding: WIN, toUnicode: [...asciiMap("Memo"), [0x7e, "﻿"]] };
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (Memo~) Tj ET", font)).toEqual(["hidden_codepoint:1"]);
  });

  it("対照：日本語の書体（Identity-H）の、ふつうの字・全角の空白・長音・やわらかいハイフンは返さない", async () => {
    const map: Array<[number, string]> = [[1, "申"], [2, "請"], [3, "書"], [4, "　"], [5, "ー"], [6, "­"], [7, "①"]];
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td <0001000200030004000500060007> Tj ET", { kind: "cid", toUnicode: map })).toEqual([]);
  });

  it("対照：ToUnicode のない書体（ASCII だけを取り出す）は返さない", async () => {
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (Plain text) Tj ET", { kind: "simple" })).toEqual([]);
  });
});

describe("16. 字の対応表の書き換え（remapped）", () => {
  it("見た目は A・B なのに、取り出すと別の字になる対応表は remapped", async () => {
    const font: FontSpec = { kind: "simple", encoding: WIN, toUnicode: [[0x41, "X"], [0x42, "Y"], [0x43, "C"]] };
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (ABC) Tj ET", font)).toEqual(["remapped:2"]);
  });

  it("/Differences で名前を付けた字形も、名前から見た目の字を引いて比べる", async () => {
    const font: FontSpec = { kind: "simple", encoding: { Differences: [1, "T", "a", "r", "o"] }, toUnicode: [[1, "J"], [2, "i"], [3, "r"], [4, "o"]] };
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td <01020304> Tj ET", font)).toEqual(["remapped:2"]);
  });

  it("対照：合字（fi・f_f_i）・異体字（a.sc・one.oldstyle）・uniXXXX の名前は、同じ字として返さない", async () => {
    const font: FontSpec = {
      kind: "simple",
      encoding: { Differences: [1, "fi", "f_f_i", "a.sc", "one.oldstyle", "uni3042"] },
      toUnicode: [[1, "fi"], [2, "ffi"], [3, "a"], [4, "1"], [5, "あ"]],
    };
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td <0102030405> Tj ET", font)).toEqual([]);
  });

  it("対照：素直な対応表、記号の書体、2バイトの書体、空白や記号にずれただけの対応表は返さない", async () => {
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (Taro) Tj ET", { kind: "simple", encoding: WIN, toUnicode: asciiMap("Taro") })).toEqual([]);
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (abc) Tj ET", { kind: "simple", baseFont: "Symbol", toUnicode: [[0x61, "α"], [0x62, "β"], [0x63, "χ"]] })).toEqual([]);
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (abc) Tj ET", { kind: "simple", baseFont: "ABCDEF+Custom", encoding: undefined, flags: 4, toUnicode: [[0x61, "Q"]] })).toEqual([]);
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td <00010002> Tj ET", { kind: "cid", toUnicode: [[1, "東"], [2, "京"]] })).toEqual([]);
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (AB) Tj ET", { kind: "simple", encoding: WIN, toUnicode: [[0x41, " "], [0x42, "-"]] })).toEqual([]);
  });

  it("字形の名前から字を引く", () => {
    expect(unicodeOfGlyphName("A")).toBe("A");
    expect(unicodeOfGlyphName("seven")).toBe("7");
    expect(unicodeOfGlyphName("uni00410042")).toBe("AB");
    expect(unicodeOfGlyphName("u1F600")).toBe("\u{1F600}");
    expect(unicodeOfGlyphName("g123")).toBeNull();
  });
});

describe("17. 違う字の重ね描き（overdrawn）", () => {
  const plain: FontSpec = { kind: "simple" };

  it("同じ所に違う字を重ねて描くと、先の字を overdrawn にする", async () => {
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (SECRET) Tj ET BT /F1 12 Tf 20 100 Td (PUBLIC) Tj ET", plain)).toEqual(["overdrawn:5"]);
  });

  it("対照：太字のための同じ字の2度描き（少しずらす）は返さない", async () => {
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (Bold) Tj ET BT /F1 12 Tf 20.3 100 Td (Bold) Tj ET", plain)).toEqual([]);
  });

  it("対照：記号の重ね打ち（字の上の '）・大きさの違うふりがな・ふつうの2行は返さない", async () => {
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (e) Tj ET BT /F1 12 Tf 20 100 Td (') Tj ET", plain)).toEqual([]);
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (Kanji) Tj ET BT /F1 5 Tf 20 100 Td (kana) Tj ET", plain)).toEqual([]);
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (Line one) Tj 0 -14 Td (Line two) Tj ET", plain)).toEqual([]);
  });
});

describe("18. 文字認識の層は、危険の発見に数えず、ページ番号だけを返す", () => {
  it("スキャン画像の上の見えない字があるページを ocrLayerPages に返す。findings には入れない", async () => {
    const r = await run("q 300 0 0 200 0 0 cm /Im1 Do Q 3 Tr BT /F1 12 Tf 20 100 Td (Scanned words) Tj ET", { kind: "simple" }, { image: true });
    expect(r.findings).toEqual([]);
    expect(r.ocrLayerPages).toEqual([1]);
  });

  it("対照：文字認識の層のないページは返さない", async () => {
    const r = await run("q 300 0 0 200 0 0 cm /Im1 Do Q 0 g BT /F1 12 Tf 20 100 Td (Visible) Tj ET", { kind: "simple" }, { image: true });
    expect(r.ocrLayerPages).toEqual([]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 整えない種類（keep。2026-11-06 本人が決定。D168）のテスト。
// 1 つの合成 PDF に、注釈（P8）・添付（P9）・写真の撮影の情報（P10）・隠したフォームの値（P11）・JavaScript と外の動作（P12）を入れ、
// 種類ごとに「整えない」にして、その種類の目印だけが残り、ほかの目印は消えることを、ファイルのバイト列とストリームの中身で確かめる。
// 何も外さない既定は、今までと同じ結果であること（eval・見ないで作るテスト集の数を変えないため）。中身はすべて架空。

import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from "pdf-lib";
import { KEEPABLE_PATTERNS, sanitizePdf, type SanitizeResult } from "../sanitize/index.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";

const codec = createNodeImageCodec();

/** 種類ごとの目印（この字が残っているかで、整えたかを見る） */
const MARKS: Record<(typeof KEEPABLE_PATTERNS)[number], string[]> = {
  P8: ["KEEP-NOTE", "KEEP-AUTHOR"],
  P9: ["KEEP-ATTACH-BODY"],
  P10: ["KEEP-GPS"],
  P11: ["KEEP-FIELD", "KEEP-TM"],
  P12: ["KEEP-JS", "KEEP-LAUNCH"],
};
const ALL_MARKS = Object.values(MARKS).flat();

function forms(s: string): Buffer[] {
  const ascii = Buffer.from(s, "latin1");
  const u16 = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) u16.writeUInt16BE(s.charCodeAt(i), i * 2);
  return [ascii, u16, ...[ascii, u16].flatMap((b) => [Buffer.from(b.toString("hex").toUpperCase()), Buffer.from(b.toString("hex"))])];
}

/** ファイルのバイト列と、解けるストリームの中身のどこかに、字があるか（どの書き方でも） */
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

async function jpegWithExif(): Promise<Uint8Array> {
  const canvas = createCanvas(8, 8);
  const g = canvas.getContext("2d");
  g.fillStyle = "#808080";
  g.fillRect(0, 0, 8, 8);
  const base = new Uint8Array(await canvas.encode("jpeg", 90));
  const body = Buffer.from("Exif\0\0KEEP-GPS-35.0N", "latin1");
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  let at = 2;
  if (base[2] === 0xff && base[3] === 0xe0) at = 4 + ((base[4]! << 8) | base[5]!);
  return new Uint8Array(Buffer.concat([Buffer.from(base.subarray(0, at)), seg, Buffer.from(base.subarray(at))]));
}

/** 外せる種類を全部入れた合成 PDF */
async function allKinds(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 300]);
  await doc.attach(new TextEncoder().encode("KEEP-ATTACH-BODY"), "kakuu.txt", { mimeType: "text/plain" });
  doc.addJavaScript("kakuu", "app.alert('KEEP-JS');");
  doc.catalog.set(PDFName.of("OpenAction"), ctx.obj({ S: "Launch", F: PDFString.of("KEEP-LAUNCH.exe") }));
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const image = ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: 8, Height: 8, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" }), await jpegWithExif()));
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font }, XObject: { Im1: image } }));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("BT /F1 12 Tf 20 250 Td (Body) Tj ET q 80 0 0 80 40 100 cm /Im1 Do Q\n")));
  const note = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [200, 200, 220, 220], Contents: PDFString.of("KEEP-NOTE"), T: PDFString.of("KEEP-AUTHOR") }));
  const widget = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: PDFString.of("hidden"), TM: PDFString.of("KEEP-TM"), V: PDFString.of("KEEP-FIELD"), Rect: [40, 40, 140, 60], F: 2, P: page.ref }),
  );
  page.node.set(PDFName.of("Annots"), ctx.obj([note, widget]));
  doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [widget] }));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

async function clean(bytes: Uint8Array, keep?: string[]): Promise<Extract<SanitizeResult, { status: "ok" }>> {
  const r = await sanitizePdf(bytes, { codec, ...(keep ? { keep } : {}) });
  if (r.status !== "ok") throw new Error(`整えられませんでした：${r.status}`);
  return r;
}
const patterns = (r: { removed: Array<{ pattern: string }> }) => [...new Set(r.removed.map((x) => x.pattern))].sort();

describe("整えない種類（keep。D168）", () => {
  it("合成 PDF の目印は、整える前には全部ある", async () => {
    const before = await allKinds();
    for (const m of ALL_MARKS) expect(await inFile(before, m), m).toBe(true);
  });

  it("何も外さない既定は、全部の目印を消す（keep なしと keep: [] は同じバイト列）", async () => {
    const before = await allKinds();
    const a = await clean(before);
    const b = await clean(before, []);
    for (const m of ALL_MARKS) expect(await inFile(a.bytes, m), m).toBe(false);
    expect(Buffer.from(b.bytes).equals(Buffer.from(a.bytes))).toBe(true);
    expect(b.removed).toEqual(a.removed);
  });

  for (const p of KEEPABLE_PATTERNS) {
    it(`${p} を整えないと、${p} の目印だけが残り、ほかは消える`, async () => {
      const r = await clean(await allKinds(), [p]);
      for (const m of MARKS[p]) expect(await inFile(r.bytes, m), m).toBe(true);
      for (const m of ALL_MARKS.filter((x) => !MARKS[p].includes(x))) expect(await inFile(r.bytes, m), m).toBe(false);
      // 外した種類は「消したもの」に入らない
      expect(r.removed.filter((x) => x.pattern === p)).toEqual([]);
    });
  }

  it("全部を外しても、ほかの片付け（文書情報・前の版など）は今までどおり", async () => {
    const r = await clean(await allKinds(), [...KEEPABLE_PATTERNS]);
    for (const m of ALL_MARKS) expect(await inFile(r.bytes, m), m).toBe(true);
    expect(patterns(r)).not.toContain("P8");
    expect(patterns(r)).not.toContain("P9");
    expect(patterns(r)).not.toContain("P12");
  });

  it("外せない種類（P6・P7・P5・P2・P1）と知らない値は無視する（既定と同じ結果）", async () => {
    const before = await allKinds();
    const a = await clean(before);
    const b = await clean(before, ["P6", "P7", "P5", "P2", "P1", "PX", ""]);
    expect(Buffer.from(b.bytes).equals(Buffer.from(a.bytes))).toBe(true);
  });

  it("注釈を外しても、適用した墨消しの注釈は外す（P6 の片付けの一部）", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const page = doc.addPage([300, 300]);
    const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
    page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font } }));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("BT /F1 12 Tf 40 150 Td (KAKUU-UNDER) Tj ET\n")));
    const redactAnnot = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Redact", Rect: [30, 140, 200, 170] }));
    const note = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [200, 200, 220, 220], Contents: PDFString.of("KEEP-NOTE") }));
    page.node.set(PDFName.of("Annots"), ctx.obj([redactAnnot, note]));
    const r = await clean(new Uint8Array(await doc.save({ useObjectStreams: false })), ["P8"]);
    expect(await inFile(r.bytes, "KAKUU-UNDER")).toBe(false);
    expect(await inFile(r.bytes, "KEEP-NOTE")).toBe(true);
    expect(Buffer.from(r.bytes).toString("latin1")).not.toContain("/Redact");
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6 1.5.0：画像の層（スキャン画像の上に、覆いを重ねただけ）のテスト。
// 採点用の合成 PDF は使わず、ここではテストの中で小さな PDF を作って確かめる。
// JPEG（DCTDecode）と CCITT（CCITTFaxDecode）の画像は、PDF.js（pdfjs-dist）で解く。

import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  PDFDocument,
  PDFName,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import { CHECKED_LAYERS, detectP6Text, type P6ImageFinding } from "../rules/p6-text/index.ts";
import { createNodeImageDecoder } from "../eval/image-decoder.ts";

const imageDecoder = createNodeImageDecoder();

const W = 200;
const H = 100;
/** スキャン画像らしいもの：白地に、字の行のような黒い短い線を並べた灰色 8 ビットの画素 */
function scanPixels(): Uint8Array {
  const px = new Uint8Array(W * H).fill(255);
  for (let row = 10; row < H - 10; row += 20) {
    for (let x = 10; x < W - 10; x++) {
      if ((x * 7) % 11 < 5) for (let y = row; y < row + 8; y++) px[y * W + x] = 20;
    }
  }
  return px;
}

/** 画像を、ページの (0,0)〜(400,200) に置く（1 画素 ＝ 2pt）。画像の上から y=180〜188pt あたりが最初の字の行 */
function drawScan(page: PDFPage, ref: PDFRef, m: [number, number, number, number, number, number] = [400, 0, 0, 200, 0, 0]) {
  const name = page.node.newXObject("Scan", ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), drawObject(name), popGraphicsState());
}

async function makePdf(draw: (doc: PDFDocument, page: PDFPage) => Promise<void> | void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 200]);
  await draw(doc, page);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

function flateScan(doc: PDFDocument, px = scanPixels()): PDFRef {
  return doc.context.register(
    doc.context.flateStream(px, { Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceGray", BitsPerComponent: 8 }),
  );
}

const imageFindings = (r: Awaited<ReturnType<typeof detectP6Text>>) => r.findings.filter((f): f is P6ImageFinding => f.layer === "image");

// 最初の字の行は、画素の 10〜17 行目 → ページの y = 200 − 2×18 = 164 〜 180
const OVER_TEXT = { x: 30, y: 160, width: 150, height: 24 };
// 字のない余白：画素の 0〜9 行目 → ページの y = 182〜200（上の端）。余白だけの所に置く
const OVER_BLANK = { x: 30, y: 183, width: 150, height: 15 };

describe("P6 の画像の層（1.5.0）", () => {
  it("この版は、文字の層と画像の層を調べる", () => {
    expect(CHECKED_LAYERS).toEqual(["text", "image", "vector"]);
  });

  it("スキャン画像の字の上の黒い四角を見つける", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      page.drawRectangle({ ...OVER_TEXT, color: rgb(0, 0, 0) });
    });
    const r = await detectP6Text(pdf);
    const hits = imageFindings(r);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ pattern: "P6", layer: "image", cover: "fill", tone: "dark", page: 1, rect: [30, 160, 180, 184] });
    expect(hits[0]!.spread).toBeGreaterThan(0.2);
    expect(r.findings.filter((f) => f.layer === "text")).toHaveLength(0);
  });

  it("スキャン画像の字の上の白い四角も見つける（tone: light）", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      page.drawRectangle({ ...OVER_TEXT, color: rgb(1, 1, 1) });
    });
    const hits = imageFindings(await detectP6Text(pdf));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ cover: "fill", tone: "light" });
  });

  it("白い四角の上に、あとから字を書いたもの（直したもの）は数えない", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      drawScan(page, flateScan(doc));
      page.drawRectangle({ ...OVER_TEXT, color: rgb(1, 1, 1) });
      page.drawText("2026", { x: 40, y: 166, size: 14, font });
    });
    expect(imageFindings(await detectP6Text(pdf))).toHaveLength(0);
  });

  it("黒い四角は、上に字があっても数える（直しではなく、黒塗りの上の札のことがあるため）", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      drawScan(page, flateScan(doc));
      page.drawRectangle({ ...OVER_TEXT, color: rgb(0, 0, 0) });
      page.drawText("X", { x: 40, y: 166, size: 14, font, color: rgb(1, 1, 1) });
    });
    expect(imageFindings(await detectP6Text(pdf))).toHaveLength(1);
  });

  it("中間の色（灰色・色つき）の四角は、画像の層の覆いにしない", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      page.drawRectangle({ ...OVER_TEXT, color: rgb(0.2, 0.6, 0.9) });
    });
    expect(imageFindings(await detectP6Text(pdf))).toHaveLength(0);
  });

  it("余白（一様な所）の上の四角と、下の画素も黒く塗った正しい墨消しは数えない", async () => {
    const burned = scanPixels();
    for (let y = 9; y < 22; y++) for (let x = 10; x < 95; x++) burned[y * W + x] = 0; // 画素を黒く塗る
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc, burned));
      page.drawRectangle({ ...OVER_BLANK, color: rgb(0, 0, 0) });
      page.drawRectangle({ x: 24, y: 160, width: 160, height: 22, color: rgb(0, 0, 0) }); // 黒く塗った画素の上
    });
    const r = await detectP6Text(pdf);
    expect(imageFindings(r)).toHaveLength(0);
  });

  it("半透明の四角は、覆いにしない", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      page.drawRectangle({ ...OVER_TEXT, color: rgb(0, 0, 0), opacity: 0.5 });
    });
    expect(imageFindings(await detectP6Text(pdf))).toHaveLength(0);
  });

  it("画像より前に描いた四角は、覆いではない（画像の下にある）", async () => {
    const pdf = await makePdf((doc, page) => {
      page.drawRectangle({ ...OVER_TEXT, color: rgb(0, 0, 0) });
      drawScan(page, flateScan(doc));
    });
    expect(imageFindings(await detectP6Text(pdf))).toHaveLength(0);
  });

  it("見た目のない白い四角の注釈（/IC が白）を見つける", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      const annot = doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [30, 160, 180, 184], IC: [1, 1, 1], F: 4 });
      page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(annot)]));
    });
    const hits = imageFindings(await detectP6Text(pdf));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ cover: "annotation", tone: "light" });
  });

  it("JPEG のスキャン画像は、PDF.js で解いて調べる（imageDecoder を渡したとき）", async () => {
    const canvas = createCanvas(W, H);
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#111";
    for (let row = 10; row < H - 10; row += 20) for (let x = 10; x < W - 10; x += 11) g.fillRect(x, row, 5, 8);
    const jpg = await canvas.encode("jpeg", 90);
    const pdf = await makePdf(async (doc, page) => {
      const img = await doc.embedJpg(jpg);
      page.drawImage(img, { x: 0, y: 0, width: 400, height: 200 });
      page.drawRectangle({ ...OVER_TEXT, color: rgb(0, 0, 0) });
      page.drawRectangle({ ...OVER_BLANK, color: rgb(1, 1, 1) }); // 余白の上（JPEG のざらつきがあっても数えない）
    });

    const without = await detectP6Text(pdf);
    expect(imageFindings(without)).toHaveLength(0);
    expect(without.uncheckedImages).toEqual([{ page: 1, reason: "unsupported_filter" }]);

    const withDecoder = await detectP6Text(pdf, { imageDecoder });
    const hits = imageFindings(withDecoder);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rect).toEqual([30, 160, 180, 184]);
    expect(withDecoder.uncheckedImages).toEqual([]);
  });

  it("黒い JPEG を字の上に貼った型（文字の層）も、PDF.js で解けば見つける", async () => {
    const canvas = createCanvas(40, 10);
    const g = canvas.getContext("2d");
    g.fillStyle = "#000";
    g.fillRect(0, 0, 40, 10);
    const jpg = await canvas.encode("jpeg", 90);
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
      page.drawImage(await doc.embedJpg(jpg), { x: 15, y: 95, width: 120, height: 20 });
    });
    // 1.11.0 から：解けなくても、型抜きのない不透明な画像として見つける（濃いかは分からないので coverTone: opaque）
    expect((await detectP6Text(pdf)).findings).toMatchObject([{ layer: "text", cover: "image", coverTone: "opaque" }]);
    const r = await detectP6Text(pdf, { imageDecoder });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ layer: "text", cover: "image" });
    expect(r.findings[0]).not.toHaveProperty("coverTone"); // PDF.js で解けば、濃い覆いとして出す
  });

  it("CCITT（G4）のスキャン画像も、PDF.js で解いて調べる（一様な白なので、漏れにはしない）", async () => {
    // 全部白の行は、G4 では「V0」（ビット 1）が1つ。最後に EOFB（000000000001 を2回）
    const w = 64;
    const h = 32;
    const bits = "1".repeat(h) + "000000000001000000000001";
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) if (bits[i] === "1") bytes[i >> 3]! |= 0x80 >> (i & 7);
    const pdf = await makePdf((doc, page) => {
      const parms = doc.context.obj({ K: -1, Columns: w, Rows: h });
      const ref = doc.context.register(
        doc.context.stream(bytes, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 1, Filter: "CCITTFaxDecode", DecodeParms: parms }),
      );
      drawScan(page, ref);
      page.drawRectangle({ ...OVER_TEXT, color: rgb(0, 0, 0) });
    });
    const without = await detectP6Text(pdf);
    expect(without.uncheckedImages).toHaveLength(1);
    const r = await detectP6Text(pdf, { imageDecoder });
    expect(r.uncheckedImages).toEqual([]);
    expect(imageFindings(r)).toHaveLength(0);
  });

  it("CCITT（G4）のスキャン画像の、黒い線の上の覆いを見つける", async () => {
    // 幅 64・高さ 32。画素の 8〜15 行目だけ、8〜15 列目が黒（G4 の符号を手で並べる。白 8＝10011、黒 8＝000101）
    const w = 64;
    const h = 32;
    let bits = "";
    let prev: "white" | "ink" = "white";
    for (let row = 0; row < h; row++) {
      const now = row >= 8 && row < 16 ? "ink" : "white";
      if (now === "white") bits += prev === "white" ? "1" : "0001" + "1"; // 前の行に黒があれば、まず「とばし」
      else bits += prev === "white" ? "001" + "10011" + "000101" + "1" : "111";
      prev = now;
    }
    bits += "000000000001000000000001";
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) if (bits[i] === "1") bytes[i >> 3]! |= 0x80 >> (i & 7);
    const pdf = await makePdf((doc, page) => {
      const parms = doc.context.obj({ K: -1, Columns: w, Rows: h });
      const ref = doc.context.register(
        doc.context.stream(bytes, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 1, Filter: "CCITTFaxDecode", DecodeParms: parms }),
      );
      drawScan(page, ref);
      // 黒の所は、ページの x = 50〜100、y = 200 − 6.25×16 = 100 〜 150
      page.drawRectangle({ x: 40, y: 95, width: 70, height: 60, color: rgb(1, 1, 1) }); // 黒い線の上の白い四角（漏れ）
      page.drawRectangle({ x: 40, y: 5, width: 300, height: 60, color: rgb(0, 0, 0) }); // 白い所の上の黒い四角（漏れでない）
    });
    const r = await detectP6Text(pdf, { imageDecoder });
    expect(r.uncheckedImages).toEqual([]);
    const hits = imageFindings(r);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ tone: "light", rect: [40, 95, 110, 155] });
  });

  it("PDF.js でも解けない画像は、調べられなかった画像として残す", async () => {
    const pdf = await makePdf((doc, page) => {
      const ref = doc.context.register(
        doc.context.stream(new Uint8Array([1, 2, 3, 4]), { Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "DCTDecode" }),
      );
      drawScan(page, ref);
      page.drawRectangle({ ...OVER_TEXT, color: rgb(0, 0, 0) });
    });
    const r = await detectP6Text(pdf, { imageDecoder });
    expect(r.uncheckedImages).toHaveLength(1);
    expect(imageFindings(r)).toHaveLength(0);
  });

  it("大きすぎる画像は、PDF.js に渡さない", async () => {
    const pdf = await makePdf((doc, page) => {
      const ref = doc.context.register(
        doc.context.stream(new Uint8Array([0]), { Type: "XObject", Subtype: "Image", Width: 100000, Height: 100000, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "DCTDecode" }),
      );
      drawScan(page, ref);
      page.drawRectangle({ ...OVER_TEXT, color: rgb(0, 0, 0) });
    });
    const r = await detectP6Text(pdf, { imageDecoder });
    expect(r.uncheckedImages).toEqual([{ page: 1, reason: "too_large" }]);
  });

  it("画像の上の覆いが多すぎるページは、省いたと返す", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      page.drawRectangle({ ...OVER_TEXT, color: rgb(0, 0, 0) });
      page.drawRectangle({ ...OVER_BLANK, color: rgb(0, 0, 0) });
    });
    const r = await detectP6Text(pdf, { settings: { maxImageCoversPerPage: 1 } });
    expect(r.skippedPages).toEqual([{ page: 1, reason: "too_many_covers" }]);
  });

  it("回して置いたスキャン画像でも、下の画素を読む", async () => {
    const pdf = await makePdf((doc, page) => {
      // 90 度回して置く：幅 200pt・高さ 400pt。ページの外にはみ出す所は見ない
      drawScan(page, flateScan(doc), [0, 400, -200, 0, 200, 0]);
      // 画像の上端（画素の 0 行目）は、ページの x=0 の側。最初の字の行（画素の 10〜17 行目）は x = 20 〜 36
      page.drawRectangle({ x: 18, y: 30, width: 20, height: 150, color: rgb(0, 0, 0) });
    });
    const hits = imageFindings(await detectP6Text(pdf));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.spread).toBeGreaterThan(0.2);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6 1.9.0 のテスト。
// - 大きな画像：要る画像だけを解く。注釈の覆いの下の画像を解けなかったときは「確かめてください」で報告する
// - 色のある地（地図・航空写真）の上の塗り・黒い画像は「確かめてください」。紙（灰色・カラーで読み取った紙）の上は確かなもの
// - 字1つ分の大きさの黒い画像を字の上に重ねたものは「確かめてください」
// 実物の大きな画像（600dpi の A4 のカラー JPEG）でのメモリと時間は、テストの外で測った（rules/p6-text/README.md）。

import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, PDFName, StandardFonts, rgb, type PDFPage, type PDFRef } from "pdf-lib";
import { detectP6Text, type P6ImageFinding, type P6TextFinding } from "../rules/p6-text/index.ts";
import { createNodeImageDecoder } from "../eval/image-decoder.ts";
import type { ExternalImageDecoder } from "../rules/shared/pdfjs-images.ts";

const W = 200;
const H = 100;

async function makePdf(draw: (doc: PDFDocument, page: PDFPage) => Promise<void> | void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 200]);
  await draw(doc, page);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}
const imageHits = (r: Awaited<ReturnType<typeof detectP6Text>>) => r.findings.filter((f): f is P6ImageFinding => f.layer === "image");
const textHits = (r: Awaited<ReturnType<typeof detectP6Text>>) => r.findings.filter((f): f is P6TextFinding => f.layer === "text");

/** 解いた回数を数える、PDF.js の道具 */
function countingDecoder(): { decoder: ExternalImageDecoder; calls: () => number } {
  const inner = createNodeImageDecoder();
  let n = 0;
  return {
    decoder: (ctx, stream, opts) => {
      n++;
      return inner(ctx, stream, opts);
    },
    calls: () => n,
  };
}

/** スキャンした書類らしい JPEG（白っぽい紙に、字の行のような黒い短い線） */
async function scanJpeg(paper = "#fff"): Promise<Buffer> {
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = paper;
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#111";
  for (let row = 10; row < H - 10; row += 20) for (let x = 10; x < W - 10; x += 11) g.fillRect(x, row, 2, 8);
  return canvas.encode("jpeg", 92);
}

/** 地図らしい RGB の画像（色分けした地の上に、黒い線と字のような線）。Flate で pdf-lib が解ける */
function mapPixels(): Uint8Array {
  const px = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const zone = ((x >> 5) + (y >> 4)) % 3;
      const [r, g, b] = zone === 0 ? [170, 215, 140] : zone === 1 ? [150, 190, 235] : [240, 220, 150]; // 緑の地・青い川・黄色い区画
      const line = x % 13 < 2 || (y % 20 >= 10 && y % 20 < 14 && x % 7 < 3);
      px[i] = line ? 30 : r;
      px[i + 1] = line ? 30 : g;
      px[i + 2] = line ? 30 : b;
    }
  }
  return px;
}
function flateRgb(doc: PDFDocument, px: Uint8Array): PDFRef {
  return doc.context.register(doc.context.flateStream(px, { Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
}
function squareAnnot(doc: PDFDocument, page: PDFPage, rect: number[], ic: number[]) {
  const annot = doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: rect, IC: ic, F: 4 });
  page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(annot)]));
}

describe("P6 1.9.0：大きな画像", () => {
  it("覆いの候補のない JPEG のスキャンは、PDF.js を渡しても解かない（調べられなかった画像にも入れない）", async () => {
    const jpg = await scanJpeg();
    const pdf = await makePdf(async (doc, page) => {
      page.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: 400, height: 200 });
    });
    const d = countingDecoder();
    const r = await detectP6Text(pdf, { imageDecoder: d.decoder });
    expect(d.calls()).toBe(0);
    expect(r.findings).toHaveLength(0);
    expect(r.uncheckedImages).toEqual([]);
    // PDF.js を渡さなければ、今までどおり「調べられなかった画像」
    expect((await detectP6Text(pdf)).uncheckedImages).toEqual([{ page: 1, reason: "unsupported_filter" }]);
  });

  it("白い四角の注釈の下の JPEG のスキャンは、解いて調べる（1回だけ）", async () => {
    const jpg = await scanJpeg();
    const pdf = await makePdf(async (doc, page) => {
      page.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: 400, height: 200 });
      squareAnnot(doc, page, [30, 160, 180, 184], [1, 1, 1]);
    });
    const d = countingDecoder();
    const r = await detectP6Text(pdf, { imageDecoder: d.decoder });
    expect(d.calls()).toBe(1);
    expect(imageHits(r).map((f) => [f.cover, f.tone, f.confidence])).toEqual([["annotation", "light", "high"]]);
  });

  it("注釈の覆いの下の画像が大きすぎて解けないときは、「確かめてください」（under_unreadable）で報告する", async () => {
    const jpg = await scanJpeg();
    const pdf = await makePdf(async (doc, page) => {
      page.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: 400, height: 200 });
      squareAnnot(doc, page, [30, 160, 180, 184], [1, 1, 1]);
    });
    const r = await detectP6Text(pdf, { imageDecoder: createNodeImageDecoder(), settings: { maxImagePixels: 10_000 } });
    const hits = imageHits(r);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ cover: "annotation", confidence: "check", reason: "under_unreadable", spread: null });
    expect(r.uncheckedImages).toEqual([{ page: 1, reason: "too_large" }]);
  });

  it("PDF.js を渡さないとき（JPEG を解けない）も、注釈の覆いは「確かめてください」で報告する", async () => {
    const jpg = await scanJpeg();
    const pdf = await makePdf(async (doc, page) => {
      page.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: 400, height: 200 });
      squareAnnot(doc, page, [30, 160, 180, 184], [0, 0, 0]);
    });
    const r = await detectP6Text(pdf);
    expect(imageHits(r).map((f) => [f.cover, f.confidence, f.reason])).toEqual([["annotation", "check", "under_unreadable"]]);
  });

  it("ページの中身の塗りの下の画像を解けないときは、今までどおり報告しない（調べられなかった画像として残す）", async () => {
    const jpg = await scanJpeg();
    const pdf = await makePdf(async (doc, page) => {
      page.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: 400, height: 200 });
      page.drawRectangle({ x: 30, y: 160, width: 150, height: 24, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf);
    expect(imageHits(r)).toHaveLength(0);
    expect(r.uncheckedImages).toEqual([{ page: 1, reason: "unsupported_filter" }]);
  });

  it("画素の数の上限は、既定で 7,200 万画素", async () => {
    const { DEFAULT_SETTINGS } = await import("../rules/p6-text/settings.ts");
    expect(DEFAULT_SETTINGS.maxImagePixels).toBe(72_000_000);
  });
});

describe("P6 1.9.0：色のある地の上", () => {
  it("地図らしい色のある画像の上の白い四角・黒い四角は「確かめてください」", async () => {
    const pdf = await makePdf((doc, page) => {
      const name = page.node.newXObject("Map", flateRgb(doc, mapPixels()));
      const ops = `q 400 0 0 200 0 0 cm /${name.decodeText()} Do Q`;
      page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(ops)));
    });
    // 塗りを足す（中身の命令のあと）
    const doc = await PDFDocument.load(pdf);
    const page = doc.getPage(0);
    page.drawRectangle({ x: 40, y: 140, width: 60, height: 20, color: rgb(0, 0, 0) });
    page.drawRectangle({ x: 200, y: 60, width: 60, height: 20, color: rgb(1, 1, 1) });
    const r = await detectP6Text(new Uint8Array(await doc.save()), { explain: true });
    const hits = imageHits(r);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    for (const f of hits) {
      expect(f.confidence).toBe("check");
      expect(f.metrics!.colored!).toBeGreaterThanOrEqual(0.2);
    }
  });

  it("地図らしい画像の上でも、白い四角の注釈は確かなもの（注釈には色の条件をかけない）", async () => {
    const pdf = await makePdf((doc, page) => {
      const name = page.node.newXObject("Map", flateRgb(doc, mapPixels()));
      page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(`q 400 0 0 200 0 0 cm /${name.decodeText()} Do Q`)));
      squareAnnot(doc, page, [200, 60, 260, 80], [1, 1, 1]);
    });
    expect(imageHits(await detectP6Text(pdf)).map((f) => [f.cover, f.confidence])).toEqual([["annotation", "high"]]);
  });

  it("カラーで読み取った紙（薄い黄ばみ）の上の白い四角・黒い四角は、確かなもの", async () => {
    const jpg = await scanJpeg("#f4efe2");
    const pdf = await makePdf(async (doc, page) => {
      page.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: 400, height: 200 });
      page.drawRectangle({ x: 30, y: 164, width: 120, height: 16, color: rgb(1, 1, 1) });
      page.drawRectangle({ x: 30, y: 124, width: 120, height: 16, color: rgb(0, 0, 0) });
    });
    const r = await detectP6Text(pdf, { imageDecoder: createNodeImageDecoder(), explain: true });
    const hits = imageHits(r);
    expect(hits).toHaveLength(2);
    for (const f of hits) {
      expect(f.confidence).toBe("high");
      expect(f.metrics!.colored!).toBeLessThan(0.2);
    }
  });
});

describe("P6 1.9.0：字1つ分の黒い画像", () => {
  it("字1つ分の大きさの黒い画像を字の上に重ねたものは「確かめてください」。何文字も覆う黒い画像は確かなもの", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const black = doc.context.register(
        doc.context.flateStream(new Uint8Array(16 * 16), { Type: "XObject", Subtype: "Image", Width: 16, Height: 16, ColorSpace: "DeviceGray", BitsPerComponent: 8 }),
      );
      const name = page.node.newXObject("Blk", black);
      page.drawText("A", { x: 20, y: 150, size: 14, font });
      page.drawText("SECRET", { x: 20, y: 100, size: 14, font });
      const ops = `q 9 0 0 11 20.2 148 cm /${name.decodeText()} Do Q q 60 0 0 16 18 96 cm /${name.decodeText()} Do Q`;
      const cs = page.node.Contents();
      const extra = doc.context.register(doc.context.stream(ops));
      page.node.set(PDFName.of("Contents"), doc.context.obj([...(cs && "asArray" in cs ? (cs as unknown as { asArray(): PDFRef[] }).asArray() : cs ? [cs as unknown as PDFRef] : []), extra]));
    });
    const r = await detectP6Text(pdf, { explain: true, includeText: true });
    const hits = textHits(r).sort((a, b) => b.rect[1] - a.rect[1]);
    expect(hits.map((f) => [f.text, f.cover, f.confidence])).toEqual([
      ["A", "image", "check"],
      ["SECRET", "image", "high"],
    ]);
    expect(r.diagnostics?.["text:check_glyph_image"]).toBe(1);
  });
});

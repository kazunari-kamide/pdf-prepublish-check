// SPDX-License-Identifier: AGPL-3.0-only
//
// 整える 0.10.0：A の #92 で見つけるようにした 2 つの型を、整えるときに消す。
// 1. 白い不透明な四角の注釈の下の図形（P6 1.13.0 の図形の層）：注釈の箱の中だけ消す・切り詰める
// 2. ページの外にはみ出した画像（P7 1.4.0 の image_off_page）：見える所だけに切り詰める
// 整えたあとの PDF を検出ルールで読み直し、見た目が変わっていないことを PDF.js で描いて比べる（sanitize/check/check.ts）。
// 字・模様はすべて架空。

import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, PDFName, PDFNumber, PDFStream, type PDFRef } from "pdf-lib";
import { CASES as P6_VECTOR, keysOf as p6Keys } from "../eval/cases/p6-vector.ts";
import { CASES as P7_IMAGES, keysOf as p7Keys } from "../eval/cases/p7-images.ts";
import { detectP6Text } from "../rules/p6-text/index.ts";
import { detectP7Hidden } from "../rules/p7-hidden/index.ts";
import { checkSanitized } from "../sanitize/check/check.ts";
import { sanitizePdf } from "../sanitize/index.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";
import type { SanitizeResult } from "../sanitize/types.ts";

const codec = createNodeImageCodec();

async function clean(bytes: Uint8Array): Promise<Extract<SanitizeResult, { status: "ok" }>> {
  const r = await sanitizePdf(bytes, { codec });
  if (r.status !== "ok") throw new Error(`整えられなかった：${r.status}`);
  return r;
}

async function looksSame(before: Uint8Array, after: Uint8Array, maxDiffFraction?: number) {
  const c = await checkSanitized(before, after, maxDiffFraction === undefined ? {} : { maxDiffFraction });
  expect(c.problems).toEqual([]);
  expect(c.ok).toBe(true);
}

/** 白い四角の注釈の下の道の数（検出ルール P6 の図形の層を、道 1 本から出す設定で読む） */
async function pathsUnderWhite(bytes: Uint8Array): Promise<number> {
  const r = await detectP6Text(bytes, { settings: { vectorMinPaths: 1, vectorMinSegments: 1 } });
  return r.findings.filter((f) => f.layer === "vector").reduce((n, f) => n + (f.layer === "vector" ? f.paths : 0), 0);
}

describe("A の合成 PDF（eval/cases の p6-vector・p7-images）を整えて読み直す", () => {
  for (const c of P6_VECTOR) {
    it(`${c.id}（${c.kind}）：図形の層が 0 件・見た目は同じ`, async () => {
      const before = await c.build();
      const r = await clean(before);
      expect(p6Keys(await detectP6Text(r.bytes))).toEqual([]);
      expect(r.notDone).toEqual([]);
      if (c.kind === "leak") expect(r.removed.some((x) => x.kind === "covered_vector")).toBe(true);
      await looksSame(before, r.bytes);
    });
  }
  for (const c of P7_IMAGES) {
    it(`${c.id}（${c.kind}）：ページの外にはみ出した画像が 0 件・見た目は同じ`, async () => {
      const before = await c.build();
      const r = await clean(before);
      const after = p7Keys(await detectP7Hidden(r.bytes));
      if (c.id === "p7i-l04") {
        // 画素を読めない画像（壊れた JPEG）：切り詰められないので残る。黙らずに片付けられなかった所にする
        expect(after).toEqual(["image_off_page"]);
        expect(r.notDone.map((x) => x.reason)).toContain("unsupported_image");
      } else {
        expect(after).toEqual([]);
        expect(r.notDone).toEqual([]);
      }
      await looksSame(before, r.bytes);
    });
  }
});

// ---------------------------------------------------------------- 図形：箱にまたがる道

const BOX: [number, number, number, number] = [100, 60, 200, 140];

/** 白い四角の注釈（見た目つき）を BOX に置いた、1 ページの PDF */
async function withWhiteSquare(content: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  const w = BOX[2] - BOX[0];
  const h = BOX[3] - BOX[1];
  const ap = ctx.register(ctx.stream(`1 g 0 0 ${w} ${h} re f`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h] } as never));
  const annot: PDFRef = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Square", Rect: BOX, F: 4, C: [1, 1, 1], IC: [1, 1, 1], AP: { N: ap } } as never));
  page.node.set(PDFName.of("Annots"), ctx.obj([annot]));
  return doc.save({ useObjectStreams: false });
}

describe("図形：箱にまたがる道を、箱の外の部分だけに切り詰める", () => {
  it("塗りの多角形が箱の左のふちにまたがる：箱の中は消え、外は同じに見える", async () => {
    const before = await withWhiteSquare("q 0 g 60 80 m 150 80 l 150 120 l 60 120 l h f Q");
    expect(await pathsUnderWhite(before)).toBe(1);
    const r = await clean(before);
    expect(r.notDone).toEqual([]);
    expect(await pathsUnderWhite(r.bytes)).toBe(0);
    await looksSame(before, r.bytes);
  });

  it("穴のある形（evenodd）が箱の角にまたがる：穴も含めて同じに見える", async () => {
    const before = await withWhiteSquare("q 0 g 60 30 m 160 30 l 160 100 l 60 100 l h 75 45 m 145 45 l 145 85 l 75 85 l h f* Q");
    const r = await clean(before);
    expect(r.notDone).toEqual([]);
    expect(await pathsUnderWhite(r.bytes)).toBe(0);
    await looksSame(before, r.bytes);
  });

  it("箱を横切る罫線（線）：箱の左右に分かれて残る", async () => {
    const before = await withWhiteSquare("q 0 G 2 w 20 100 m 280 100 l S Q");
    const r = await clean(before);
    expect(r.notDone).toEqual([]);
    expect(r.removed.find((x) => x.kind === "covered_vector")?.count).toBe(1);
    expect(await pathsUnderWhite(r.bytes)).toBe(0);
    await looksSame(before, r.bytes);
  });

  it("閉じて描く線（s）の最後の部分道だけが箱の中：残す部分道は閉じない", async () => {
    const before = await withWhiteSquare("q 0 G 1 w 20 20 m 80 20 l 80 50 l 120 80 m 180 80 l 180 120 l s Q");
    const r = await clean(before);
    expect(r.notDone).toEqual([]);
    expect(await pathsUnderWhite(r.bytes)).toBe(0);
    await looksSame(before, r.bytes);
  });

  it("回した行列の中で描いた道も、ページの座標で切って戻す", async () => {
    // 90 度回して (300, 0) に動かした座標：(x, y) → (300 - y, x)
    const before = await withWhiteSquare("q 0 1 -1 0 300 0 cm 0 g 80 60 m 120 60 l 120 250 l 80 250 l h f Q");
    const r = await clean(before);
    expect(r.notDone).toEqual([]);
    expect(await pathsUnderWhite(r.bytes)).toBe(0);
    await looksSame(before, r.bytes);
  });

  it("箱にまたがる曲線は切らず、片付けられなかった所にする（vector_partial）", async () => {
    const before = await withWhiteSquare("q 0 g 60 100 m 60 140 120 140 150 100 c 120 60 60 60 60 100 c f Q");
    const r = await clean(before);
    expect(r.notDone.map((x) => x.reason)).toEqual(["vector_partial"]);
    expect(await pathsUnderWhite(r.bytes)).toBe(1);
    await looksSame(before, r.bytes);
  });

  it("箱にまたがる破線は切らず、片付けられなかった所にする（vector_partial）", async () => {
    const before = await withWhiteSquare("q 0 G 1 w [3 2] 0 d 20 100 m 280 100 l S Q");
    const r = await clean(before);
    expect(r.notDone.map((x) => x.reason)).toEqual(["vector_partial"]);
  });

  it("箱の中だけの曲線は消す（切らないので形は変わらない）", async () => {
    const before = await withWhiteSquare("q 0 g 120 100 m 120 130 180 130 180 100 c 180 70 120 70 120 100 c f Q");
    const r = await clean(before);
    expect(r.notDone).toEqual([]);
    expect(await pathsUnderWhite(r.bytes)).toBe(0);
    await looksSame(before, r.bytes);
  });

  it("切り抜き（W）に使う道には触らない", async () => {
    const before = await withWhiteSquare("q 120 80 40 40 re W n 0 g 0 0 300 200 re f Q");
    const r = await clean(before);
    expect(r.notDone).toEqual([]);
    await looksSame(before, r.bytes);
  });
});

// ---------------------------------------------------------------- 画像：切り詰め

/** ばらつきのある灰色の模様の、本物の JPEG（W×H） */
async function patternJpeg(w: number, h: number): Promise<Uint8Array> {
  const canvas = createCanvas(w, h);
  const g = canvas.getContext("2d");
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
    const v = 40 + ((x * 11 + y * 17) % 180);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, y, 4, 4);
  }
  return new Uint8Array(await canvas.encode("jpeg", 90));
}

async function offPage(opts: { jpeg?: boolean; smask?: boolean; draw: string }): Promise<Uint8Array> {
  const W = 64, H = 40;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 424]);
  const px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = 40 + ((x * 11 + y * 17) % 180);
  let im: PDFRef;
  if (opts.jpeg) {
    im = ctx.register(ctx.stream(await patternJpeg(W, H), { Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" } as never));
  } else {
    const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceGray", BitsPerComponent: 8 };
    if (opts.smask) {
      const a = new Uint8Array(W * H).fill(255);
      for (let i = 0; i < a.length; i += 7) a[i] = 128;
      dict.SMask = ctx.register(ctx.flateStream(a, { Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceGray", BitsPerComponent: 8 } as never));
    }
    im = ctx.register(ctx.flateStream(px, dict as never));
  }
  page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: ctx.obj({ Im1: im } as never) } as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(opts.draw)));
  return doc.save({ useObjectStreams: false });
}

const offKeys = async (b: Uint8Array) => p7Keys(await detectP7Hidden(b));

describe("画像：ページの外にはみ出した所を切り詰める", () => {
  it("JPEG の画像（見える所 20%）：解いて切り、JPEG に書き直す", async () => {
    const before = await offPage({ jpeg: true, draw: "q 240 0 0 150 252 200 cm /Im1 Do Q" });
    expect(await offKeys(before)).toEqual(["image_off_page"]);
    const r = await clean(before);
    expect(r.notDone).toEqual([]);
    expect(await offKeys(r.bytes)).toEqual([]);
    await looksSame(before, r.bytes);
  });

  it("透明の型（/SMask）のある画像：型も同じ範囲で切る", async () => {
    const before = await offPage({ smask: true, draw: "q 240 0 0 150 226 200 cm /Im1 Do Q" });
    const r = await clean(before);
    expect(r.notDone).toEqual([]);
    expect(await offKeys(r.bytes)).toEqual([]);
    // PDF.js は画像の箱を画面の画素の整数に丸めて描く（pdfjs-dist の drawImageAtIntegerCoords）。切り詰めた画像の箱は
    // 1.5 倍で幅 112.5 画素になり、丸めで画素の境が 1 画素未満ずれる。透明の型があると、そのずれで色の差が出る画素が
    // 0.058% あった（2026-11-05 測定）。中身が消えたのではないので、この試験だけ上限を 0.2% にする
    await looksSame(before, r.bytes, 0.002);
  });

  it("回して置いた画像（下にはみ出す）も、画像の座標に戻して切る", async () => {
    // 90 度回して置く：画像の箱は x 100〜250・y -170〜70（ページの中は 70/240）
    const before = await offPage({ draw: "q 0 240 -150 0 250 -170 cm /Im1 Do Q" });
    expect(await offKeys(before)).toEqual(["image_off_page"]);
    const r = await clean(before);
    expect(r.notDone).toEqual([]);
    expect(await offKeys(r.bytes)).toEqual([]);
    await looksSame(before, r.bytes);
  });

  it("切り詰めたあと、元の画像はファイルに残らない（描く所がなくなるため）", async () => {
    const before = await offPage({ draw: "q 240 0 0 150 252 200 cm /Im1 Do Q" });
    const r = await clean(before);
    const doc = await PDFDocument.load(r.bytes);
    let maxPixels = 0;
    for (const [, o] of doc.context.enumerateIndirectObjects()) {
      if (!(o instanceof PDFStream)) continue;
      const st = o.dict.lookup(PDFName.of("Subtype"));
      if (!(st instanceof PDFName) || st.decodeText() !== "Image") continue;
      const w = o.dict.lookup(PDFName.of("Width"), PDFNumber).asNumber();
      const h = o.dict.lookup(PDFName.of("Height"), PDFNumber).asNumber();
      maxPixels = Math.max(maxPixels, w * h);
    }
    expect(maxPixels).toBeLessThan(64 * 40);
  });
});

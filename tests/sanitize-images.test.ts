// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付け（sanitize/）の画像の層のテスト（0.4.0 から）：
// - 白い不透明な覆い（注釈・ページの中の白い四角）の下の画素を、白く塗る。塗った数を確かめる（検証器は白い覆いを数えないため。2026-11-04 人が決めた）
// - 大きな Flate の画像を、流して塗る（丸ごと解く道と同じ画素になる）
// - 塗れない画像は、覆いごとに「片付けられなかった所」にする（大きすぎる・JPEG の道具がない・壊れている）
// - JPEG の画像を、PDF.js で解いて塗り、JPEG に書き直す（Node の道具：sanitize/node/image-codec.ts）
// 合成した画像だけを使う（実在の PDF は使わない）。

import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from "pdf-lib";
import { sanitizePdf, type SanitizeOptions, type SanitizeResult } from "../sanitize/index.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";

type ImageSpec =
  | { kind: "flate"; w: number; h: number; comps: 1 | 3; pixels: Uint8Array; predictor?: "png-up"; garbage?: boolean }
  | { kind: "jpeg"; w: number; h: number; bytes: Uint8Array }
  | { kind: "ccitt"; w: number; h: number; bytes: Uint8Array };

/** 300×200 のページに、画像を (50,50)–(150,150) に置き、そのあとに after の命令を描く。annots は注釈 */
async function imagePdf(image: ImageSpec, after: string, opts: { annots?: Record<string, unknown>[]; apAnnot?: { rect: number[]; content: string }; ocgOff?: boolean; before?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  let stream: PDFRawStream;
  if (image.kind === "flate") {
    let raw = image.pixels;
    const parms: Record<string, unknown> = {};
    if (image.predictor === "png-up") {
      const rowLen = image.w * image.comps;
      raw = new Uint8Array((rowLen + 1) * image.h);
      for (let y = 0; y < image.h; y++) {
        raw[y * (rowLen + 1)] = 2; // Up
        for (let i = 0; i < rowLen; i++) {
          const cur = image.pixels[y * rowLen + i]!;
          const up = y > 0 ? image.pixels[(y - 1) * rowLen + i]! : 0;
          raw[y * (rowLen + 1) + 1 + i] = (cur - up) & 0xff;
        }
      }
      Object.assign(parms, { Predictor: 12, Colors: image.comps, BitsPerComponent: 8, Columns: image.w });
    }
    const data = image.garbage ? new Uint8Array([0x78, 0x9c, 1, 2, 3, 4, 5, 6, 7, 8]) : new Uint8Array(deflateSync(raw));
    const dict = ctx.obj({
      Type: "XObject", Subtype: "Image", Width: image.w, Height: image.h, ColorSpace: image.comps === 1 ? "DeviceGray" : "DeviceRGB", BitsPerComponent: 8,
      Filter: "FlateDecode",
    });
    if (image.predictor) dict.set(PDFName.of("DecodeParms"), ctx.obj(parms as never));
    stream = PDFRawStream.of(dict, data);
  } else {
    stream = image.kind === "ccitt"
      ? PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: image.w, Height: image.h, ColorSpace: "DeviceGray", BitsPerComponent: 1, Filter: "CCITTFaxDecode", DecodeParms: { K: -1, Columns: image.w, Rows: image.h } }), image.bytes)
      : PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: image.w, Height: image.h, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" }), image.bytes);
  }
  const res: Record<string, unknown> = { XObject: { Im1: ctx.register(stream) } };
  if (opts.ocgOff) {
    const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("Layer") }));
    res.Properties = { L1: ocg };
    doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg] } }));
  }
  page.node.set(PDFName.of("Resources"), ctx.obj(res as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(`${opts.before ?? ""} q 100 0 0 100 50 50 cm /Im1 Do Q ${after}`)));
  const annots = (opts.annots ?? []).map((a) => ctx.register(ctx.obj(a as never)));
  if (opts.apAnnot) {
    // 見た目（/AP）で塗る Square 注釈。/IC はつけない
    const [x0, y0, x1, y1] = opts.apAnnot.rect as [number, number, number, number];
    const n = ctx.register(ctx.stream(opts.apAnnot.content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, x1 - x0, y1 - y0] }));
    annots.push(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Square", Rect: [x0, y0, x1, y1], F: 4, AP: { N: n } })));
  }
  if (annots.length) page.node.set(PDFName.of("Annots"), ctx.obj(annots));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

/** 片付けたあと、ページに描かれる画像（Do で呼ぶもの） */
async function drawnImage(bytes: Uint8Array): Promise<PDFRawStream> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[0]!;
  const xo = page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
  const content = page.node.lookup(PDFName.of("Contents"));
  const text = content instanceof PDFRawStream ? new TextDecoder("latin1").decode(decodePDFRawStream(content).decode()) : "";
  const name = /\/([A-Za-z0-9]+)\s+Do/.exec(text)?.[1] ?? "Im1";
  return doc.context.lookup(xo.get(PDFName.of(name))) as PDFRawStream;
}

const pixelsOf = (s: PDFRawStream) => decodePDFRawStream(s).decode();

function ok(r: SanitizeResult): Extract<SanitizeResult, { status: "ok" }> {
  if (r.status !== "ok") throw new Error(`片付けに失敗：${r.code}`);
  return r;
}

const gray = (v = 180) => ({ kind: "flate" as const, w: 10, h: 10, comps: 1 as const, pixels: new Uint8Array(100).fill(v) });
const WHITE_SQUARE = { Type: "Annot", Subtype: "Square", Rect: [50, 50, 100, 150], IC: [1, 1, 1], C: [1, 1, 1], F: 4 };

describe("白い不透明な覆いの下の画像を、白く塗る", () => {
  it("白い Square 注釈（見た目なし・/IC が白）の下の画素を白く塗る。塗った数・箱・説明を返し、注釈は残す", async () => {
    const r = ok(await sanitizePdf(await imagePdf(gray(), "", { annots: [WHITE_SQUARE] })));
    const items = r.removed.filter((x) => x.kind === "covered_pixels");
    expect(items).toEqual([expect.objectContaining({ pattern: "P6", page: 1, count: 50, rect: [50, 50, 100, 150] })]);
    expect(items[0]!.label).toContain("白く塗りました");
    expect(r.notDone).toEqual([]);
    const data = pixelsOf(await drawnImage(r.bytes));
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) expect(data[y * 10 + x]).toBe(x < 5 ? 255 : 180);
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getPages()[0]!.node.lookup(PDFName.of("Annots"), PDFArray).size()).toBe(1);
  });

  it("白い Square 注釈（見た目 /AP で白く塗るもの）の下の画素も白く塗る", async () => {
    const r = ok(await sanitizePdf(await imagePdf(gray(), "", { apAnnot: { rect: [50, 50, 100, 150], content: "1 1 1 rg 0 0 50 100 re f" } })));
    expect(r.removed.filter((x) => x.kind === "covered_pixels").map((x) => ({ count: x.count, rect: x.rect }))).toEqual([{ count: 50, rect: [50, 50, 100, 150] }]);
    expect(pixelsOf(await drawnImage(r.bytes))[0]).toBe(255);
  });

  it("ページの中の白い不透明な四角（画像のあと）の下の画素を白く塗る", async () => {
    const r = ok(await sanitizePdf(await imagePdf(gray(), "1 g 50 50 50 100 re f")));
    expect(r.removed.filter((x) => x.kind === "covered_pixels").map((x) => x.count)).toEqual([50]);
    const data = pixelsOf(await drawnImage(r.bytes));
    expect(data[0]).toBe(255);
    expect(data[9]).toBe(180);
  });

  it("画像より前に描いた白い四角・ほとんど透明な白い四角（不透明さ 0.3）・薄い灰色の四角では、塗らない（覆いでないので、片付けられなかった所にも出さない）", async () => {
    for (const [after, opts] of [
      ["", { before: "1 g 50 50 50 100 re f" }],
      ["/GS1 gs 1 g 50 50 50 100 re f", {}],
      ["0.7 g 50 50 50 100 re f", {}],
    ] as const) {
      const pdf = await imagePdf(gray(), after, opts);
      // 半透明の場合：ExtGState を足す
      const fixed = after.includes("/GS1") ? await withAlpha(pdf) : pdf;
      const r = ok(await sanitizePdf(fixed));
      expect(r.removed.filter((x) => x.kind === "covered_pixels"), after).toEqual([]);
      expect(r.notDone, after).toEqual([]);
    }
  });

  it("黒と白の覆いが1つの画像に重なれば、それぞれの色で塗り、覆いごとに返す", async () => {
    const r = ok(await sanitizePdf(await imagePdf(gray(), "0 g 50 50 30 100 re f 1 g 120 50 30 100 re f")));
    const items = r.removed.filter((x) => x.kind === "covered_pixels");
    expect(items.map((x) => ({ rect: x.rect, count: x.count, white: x.label.includes("白く") }))).toEqual([
      { rect: [50, 50, 80, 150], count: 30, white: false },
      { rect: [120, 50, 150, 150], count: 30, white: true },
    ]);
    const data = pixelsOf(await drawnImage(r.bytes));
    expect([data[0], data[4], data[9]]).toEqual([0, 180, 255]);
  });
});

/** /GS1（不透明さ 0.3）を足した PDF にする */
async function withAlpha(pdf: Uint8Array): Promise<Uint8Array> {
  return withExtGState(pdf, { Type: "ExtGState", ca: 0.3 });
}

/** /GS1 に gs の中身を入れた PDF にする */
async function withExtGState(pdf: Uint8Array, gs: Record<string, unknown>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  const res = doc.getPages()[0]!.node.Resources()!;
  res.set(PDFName.of("ExtGState"), doc.context.obj({ GS1: gs } as never));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe("白い塗りの重ね方（/BM）と、表示しないレイヤー（0.4.0 の実物の確かめから）", () => {
  // 実物で、JPEG の上のページの中の白い塗りを、片付けが塗らず、片付けられなかった所にも出さなかった（2026-11-04）。
  // 合成 PDF で再現した形：白い塗りの重ね方が Normal でないと、覆いにも、片付けられなかった所にもしていなかった
  it("白を重ねると白になる重ね方（Screen・Lighten・ColorDodge・HardLight・Luminosity）なら、下の画素を白く塗る", async () => {
    for (const bm of ["Screen", "Lighten", "ColorDodge", "HardLight", "Luminosity", "Normal"]) {
      const pdf = await withExtGState(await imagePdf(gray(), "/GS1 gs 1 g 50 50 50 100 re f"), { Type: "ExtGState", BM: bm });
      const r = ok(await sanitizePdf(pdf));
      expect(r.removed.filter((x) => x.kind === "covered_pixels").map((x) => x.count), bm).toEqual([50]);
      expect(r.notDone, bm).toEqual([]);
    }
  });

  it("下が見えたままの重ね方（Multiply・Darken など）なら塗らず、片付けられなかった所（uncertain_cover）にする（黙って残さない）", async () => {
    for (const bm of ["Multiply", "Darken", "Overlay", "Difference"]) {
      const pdf = await withExtGState(await imagePdf(gray(), "/GS1 gs 1 g 50 50 50 100 re f"), { Type: "ExtGState", BM: [bm] });
      const r = ok(await sanitizePdf(pdf));
      expect(r.removed.filter((x) => x.kind === "covered_pixels"), bm).toEqual([]);
      expect(r.notDone.map((x) => ({ reason: x.reason, rect: x.rect, page: x.page })), bm).toEqual([{ reason: "uncertain_cover", rect: [50, 50, 100, 150], page: 1 }]);
      expect(r.notDone[0]!.label).toContain("乗算");
      expect(pixelsOf(await drawnImage(r.bytes)).every((v) => v === 180)).toBe(true);
    }
  });

  it("半透明（不透明さ 0.5 以上 0.9 未満）の白い四角・白い注釈の下は塗らず、片付けられなかった所（uncertain_cover）にする", async () => {
    const fill = ok(await sanitizePdf(await withExtGState(await imagePdf(gray(), "/GS1 gs 1 g 50 50 50 100 re f"), { Type: "ExtGState", ca: 0.6 })));
    const annot = ok(await sanitizePdf(await imagePdf(gray(), "", { annots: [{ ...WHITE_SQUARE, CA: 0.6 }] })));
    for (const r of [fill, annot]) {
      expect(r.removed.filter((x) => x.kind === "covered_pixels")).toEqual([]);
      expect(r.notDone.map((x) => ({ reason: x.reason, rect: x.rect }))).toEqual([{ reason: "uncertain_cover", rect: [50, 50, 100, 150] }]);
      expect(r.notDone[0]!.label).toContain("半透明");
    }
  });

  it("見た目（/AP）を読めない注釈が画像の上にあれば、片付けられなかった所（uncertain_cover）にする", async () => {
    // /AP の /N が、読めない圧縮（壊れた Flate）のストリーム
    const doc = await PDFDocument.load(await imagePdf(gray(), ""));
    const ctx = doc.context;
    const n = ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Form", BBox: [0, 0, 50, 100], Filter: "FlateDecode" }), new Uint8Array([1, 2, 3, 4])));
    doc.getPages()[0]!.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(ctx.obj({ Type: "Annot", Subtype: "Square", Rect: [50, 50, 100, 150], F: 4, AP: { N: n } }))]));
    const r = ok(await sanitizePdf(new Uint8Array(await doc.save({ useObjectStreams: false }))));
    expect(r.notDone.map((x) => ({ reason: x.reason, rect: x.rect }))).toEqual([{ reason: "uncertain_cover", rect: [50, 50, 100, 150] }]);
    expect(r.notDone[0]!.label).toContain("読めなかった");
  });

  it("表示しないレイヤーの白い四角の下は塗らず、片付けられなかった所（uncertain_cover）にする", async () => {
    const r = ok(await sanitizePdf(await imagePdf(gray(), "/OC /L1 BDC 1 g 50 50 50 100 re f EMC", { ocgOff: true })));
    expect(r.removed.filter((x) => x.kind === "covered_pixels")).toEqual([]);
    expect(r.notDone.map((x) => x.reason)).toEqual(["uncertain_cover"]);
    expect(r.notDone[0]!.label).toContain("表示しないレイヤー");
  });

  it("ページに直接埋め込んだ画像の上の白い四角は、画像の部品に移し替えて白く塗る（0.8.0 から）", async () => {
    const good = ok(await sanitizePdf(await imagePdf(gray(), "q 100 0 0 100 50 50 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x10\x20\x30\x40 EI Q 1 g 50 50 50 100 re f")));
    expect(good.notDone).toEqual([]);
    expect(good.removed.some((x) => x.kind === "covered_pixels" && x.label.includes("白く"))).toBe(true);
  });
});

describe("大きな画像", () => {
  const rgb = () => {
    const p = new Uint8Array(10 * 10 * 3);
    for (let i = 0; i < p.length; i++) p[i] = (i * 37) & 0xff;
    return { kind: "flate" as const, w: 10, h: 10, comps: 3 as const, pixels: p, predictor: "png-up" as const };
  };

  it("丸ごと解く上限を超えた Flate の画像は、流して塗る。丸ごと解いたときと同じ画素・同じ数になる（PNG の予測つき）", async () => {
    const pdf = await imagePdf(rgb(), "0 g 50 50 50 100 re f 1 g 120 120 30 30 re f");
    const whole = ok(await sanitizePdf(pdf));
    const streamed = ok(await sanitizePdf(pdf, { maxImageBytes: 100 }));
    const counts = (r: typeof whole) => r.removed.filter((x) => x.kind === "covered_pixels").map((x) => x.count);
    expect(counts(streamed)).toEqual(counts(whole));
    expect(counts(whole)).toEqual([50, 9]);
    const a = pixelsOf(await drawnImage(whole.bytes));
    const b = pixelsOf(await drawnImage(streamed.bytes));
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    // 流して塗った画像は、予測なしで書き直す
    expect((await drawnImage(streamed.bytes)).dict.get(PDFName.of("DecodeParms"))).toBeUndefined();
  });

  it("画素の数が上限を超える画像は塗らず、覆いごとに「片付けられなかった所」（image_too_large）にする。注釈は外さない", async () => {
    const pdf = await imagePdf(gray(), "0 g 120 50 30 30 re f", { annots: [WHITE_SQUARE] });
    const r = ok(await sanitizePdf(pdf, { maxImagePixels: 99 }));
    expect(r.removed.filter((x) => x.kind === "covered_pixels")).toEqual([]);
    expect(r.notDone.map((x) => ({ reason: x.reason, rect: x.rect, page: x.page }))).toEqual([
      { reason: "image_too_large", rect: [120, 50, 150, 80], page: 1 },
      { reason: "image_too_large", rect: [50, 50, 100, 150], page: 1 },
    ]);
    expect(r.notDone[1]!.label).toContain("白い四角・注釈の下の画像が大きすぎる");
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getPages()[0]!.node.lookup(PDFName.of("Annots"), PDFArray).size()).toBe(1);
    expect(pixelsOf(await drawnImage(r.bytes)).every((v) => v === 180)).toBe(true);
  });

  it("流して塗る画像の圧縮が壊れていれば、止まらずに「片付けられなかった所」にする", async () => {
    const pdf = await imagePdf({ ...gray(), garbage: true }, "0 g 50 50 50 100 re f");
    const r = ok(await sanitizePdf(pdf, { maxImageBytes: 10 }));
    expect(r.notDone.map((x) => x.reason)).toEqual(["unsupported_image"]);
    expect(r.notDone[0]!.label).toContain("読めなかった");
  });
});

describe("JPEG の画像", () => {
  /** 40×40 の JPEG：明るい灰色の地に、濃い横の線（字の代わり） */
  const jpeg = (): ImageSpec => {
    const cv = createCanvas(40, 40);
    const g = cv.getContext("2d");
    g.fillStyle = "#c8c8c8";
    g.fillRect(0, 0, 40, 40);
    g.fillStyle = "#101010";
    for (let y = 4; y < 40; y += 8) g.fillRect(2, y, 36, 3);
    return { kind: "jpeg", w: 40, h: 40, bytes: new Uint8Array(cv.encodeSync("jpeg", 95)) };
  };
  const rgbaOf = async (s: PDFRawStream) => {
    const im = await loadImage(Buffer.from(s.contents));
    const cv = createCanvas(im.width, im.height);
    cv.getContext("2d").drawImage(im, 0, 0);
    return { w: im.width, data: cv.getContext("2d").getImageData(0, 0, im.width, im.height).data };
  };
  const opts = (): SanitizeOptions => ({ codec: createNodeImageCodec() });

  it("白い注釈の下の画素を白く塗り、JPEG に書き直す（DeviceRGB）", async () => {
    const r = ok(await sanitizePdf(await imagePdf(jpeg(), "", { annots: [WHITE_SQUARE] }), opts()));
    // 40×40 の画像を 100pt に置いたので、1画素 2.5pt。覆いの幅 50pt に中心が入るのは 20 列
    expect(r.removed.filter((x) => x.kind === "covered_pixels").map((x) => x.count)).toEqual([800]);
    expect(r.notDone).toEqual([]);
    const out = await drawnImage(r.bytes);
    expect(out.dict.get(PDFName.of("Filter"))?.toString()).toBe("/DCTDecode");
    expect(out.dict.get(PDFName.of("ColorSpace"))?.toString()).toBe("/DeviceRGB");
    const { w, data } = await rgbaOf(out);
    let minLeft = 255, minRight = 255;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const v = data[(y * w + x) * 4]!;
      if (x < 18) minLeft = Math.min(minLeft, v); // ふちの JPEG のにじみを避けて、2 列内側を見る
      if (x >= 22) minRight = Math.min(minRight, v);
    }
    expect(minLeft).toBeGreaterThanOrEqual(240); // 塗った所：線が残っていない
    expect(minRight).toBeLessThan(60); // 塗っていない所：線が残っている
  });

  it("黒い四角の下の画素を黒く塗る", async () => {
    const r = ok(await sanitizePdf(await imagePdf(jpeg(), "0 g 50 50 50 100 re f"), opts()));
    expect(r.removed.filter((x) => x.kind === "covered_pixels").map((x) => x.count)).toEqual([800]);
    const { w, data } = await rgbaOf(await drawnImage(r.bytes));
    let maxLeft = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 18; x++) maxLeft = Math.max(maxLeft, data[(y * w + x) * 4]!);
    expect(maxLeft).toBeLessThanOrEqual(15);
  });

  it("JPEG の道具を渡さなければ、塗らずに覆いごとに「片付けられなかった所」にする（白い注釈も）", async () => {
    const r = ok(await sanitizePdf(await imagePdf(jpeg(), "", { annots: [WHITE_SQUARE] })));
    expect(r.removed.filter((x) => x.kind === "covered_pixels")).toEqual([]);
    expect(r.notDone).toEqual([expect.objectContaining({ reason: "unsupported_image", page: 1, rect: [50, 50, 100, 150] })]);
    expect(r.notDone[0]!.label).toContain("JPEG");
  });

  it("画素の数が上限を超える JPEG は、解かずに image_too_large にする", async () => {
    const r = ok(await sanitizePdf(await imagePdf(jpeg(), "", { annots: [WHITE_SQUARE] }), { ...opts(), maxImagePixels: 1000 }));
    expect(r.notDone.map((x) => x.reason)).toEqual(["image_too_large"]);
  });
});

describe("CCITT（FAX 形式）の白黒画像", () => {
  /**
   * 幅 64・高さ 32 の G4（K = -1）の白黒画像。8〜15 行目の 8〜15 列目だけ黒。符号は手で並べる：
   * 全部白の行＝垂直 V0「1」。黒が始まる行＝水平「001」＋白の長さ 8「10011」＋黒の長さ 8「000101」＋V0「1」。
   * 黒が続く行＝V0 を3回「111」。黒が終わった行＝とばし「0001」＋V0「1」。最後に EOFB（000000000001 を2回）
   */
  const ccitt = (): ImageSpec => {
    let bits = "";
    let prev = "white";
    for (let row = 0; row < 32; row++) {
      const now = row >= 8 && row < 16 ? "ink" : "white";
      if (now === "white") bits += prev === "white" ? "1" : "0001" + "1";
      else bits += prev === "white" ? "001" + "10011" + "000101" + "1" : "111";
      prev = now;
    }
    bits += "000000000001000000000001";
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) if (bits[i] === "1") bytes[i >> 3]! |= 0x80 >> (i & 7);
    return { kind: "ccitt", w: 64, h: 32, bytes };
  };
  // 64×32 の画像を 100pt 四方に置くので、1画素は横 1.5625pt・縦 3.125pt。黒の所はページの x 62.5〜75、y 100〜125
  const OVER_INK = { Type: "Annot", Subtype: "Square", Rect: [60, 95, 80, 130], IC: [1, 1, 1], F: 4 };
  const bitAt = (data: Uint8Array, x: number, y: number) => (data[y * 8 + (x >> 3)]! >> (7 - (x & 7))) & 1;

  it("白い注釈の下の画素を白く塗り、1 ビットのまま Flate で書き直す", async () => {
    const r = ok(await sanitizePdf(await imagePdf(ccitt(), "", { annots: [OVER_INK] }), { codec: createNodeImageCodec() }));
    // 中心が注釈の中に入るのは、6〜18 列目の 13 列 × 6〜17 行目の 12 行
    expect(r.removed.filter((x) => x.kind === "covered_pixels").map((x) => ({ count: x.count, rect: x.rect }))).toEqual([{ count: 156, rect: [60, 95, 80, 130] }]);
    expect(r.notDone).toEqual([]);
    const out = await drawnImage(r.bytes);
    expect(out.dict.get(PDFName.of("Filter"))?.toString()).toBe("/FlateDecode");
    expect(out.dict.get(PDFName.of("BitsPerComponent"))?.toString()).toBe("1");
    expect(out.dict.get(PDFName.of("ColorSpace"))?.toString()).toBe("/DeviceGray");
    const data = pixelsOf(out);
    expect(data.length).toBe(8 * 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
      const inkBefore = y >= 8 && y < 16 && x >= 8 && x < 16;
      const painted = x >= 6 && x <= 18 && y >= 6 && y <= 17;
      expect(bitAt(data, x, y), `${x},${y}`).toBe(inkBefore && !painted ? 0 : 1); // 1 が白
    }
  });

  it("黒い四角の下は黒く塗る", async () => {
    const r = ok(await sanitizePdf(await imagePdf(ccitt(), "0 g 120 50 30 30 re f"), { codec: createNodeImageCodec() }));
    const data = pixelsOf(await drawnImage(r.bytes));
    expect(bitAt(data, 50, 30)).toBe(0); // 塗った所（もとは白）
    expect(bitAt(data, 50, 0)).toBe(1); // 塗っていない所
  });

  it("CCITT を解く部品がない道具・道具なしでは、塗らずに片付けられなかった所にする", async () => {
    for (const opts of [{ codec: { ...createNodeImageCodec(), bitonal: false } }, {}]) {
      const r = ok(await sanitizePdf(await imagePdf(ccitt(), "", { annots: [OVER_INK] }), opts));
      expect(r.removed.filter((x) => x.kind === "covered_pixels")).toEqual([]);
      expect(r.notDone).toEqual([expect.objectContaining({ reason: "unsupported_image", rect: [60, 95, 80, 130] })]);
      expect(r.notDone[0]!.label).toContain("FAX 形式");
    }
  });
});

describe("実物の形の再現：上下反転のページに置いた JPEG の上の、ごく薄いクリーム色の塗り（2026-11-04）", () => {
  // 人から聞いた形（中身は合成）：ページの最初の cm が上下反転、偶奇の切り抜き（W* n）を2回したあと画像を置く。
  // 画像のあと、q の中で 1 1 0.976471 rg（明るさ約 0.997）にして、m l … h f で四角を塗り、同じ色の線で re S で縁取る
  const content = (fillPath: string) => [
    "0.75 0 0 -0.75 0 200 cm",
    "q 0 0 400 266.67 re W* n",
    "q 66.67 66.67 133.33 133.33 re W* n",
    "q 133.33 0 0 -133.33 66.67 200 cm /Im1 Do Q Q",
    "Q",
    `q 1 1 0.976471 rg ${fillPath} h f Q`,
    "q 1 1 0.976471 RG 66.67 66.67 66.67 133.33 re S Q",
  ].join("\n");
  // ページ上の四角 x 50〜100、y 50〜150 を、上下反転の座標（u = x / 0.75、v = (200 − y) / 0.75）で
  const FOUR = "66.667 66.667 m 133.333 66.667 l 133.333 200 l 66.667 200 l";
  const FIVE = FOUR + " 66.667 66.667 l";

  for (const [name, path] of [["4 点の四角（m l l l h f）", FOUR], ["閉じる点を重ねた 5 点の四角（m l l l l h f）", FIVE]] as const) {
    it(`${name}：覆いにして、下の画素を白く塗る（Flate・JPEG）`, async () => {
      for (const image of [gray(), null]) {
        const doc = await PDFDocument.load(await imagePdf(image ?? gray(), ""));
        const page = doc.getPages()[0]!;
        page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(content(path))));
        let bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
        if (!image) {
          // JPEG の画像に差し替える
          const cv = createCanvas(40, 40);
          const g = cv.getContext("2d");
          g.fillStyle = "#e0e0e0";
          g.fillRect(0, 0, 40, 40);
          g.fillStyle = "#101010";
          for (let y = 4; y < 40; y += 8) g.fillRect(2, y, 36, 3);
          const d2 = await PDFDocument.load(bytes);
          const xo = d2.getPages()[0]!.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
          xo.set(PDFName.of("Im1"), d2.context.register(PDFRawStream.of(d2.context.obj({ Type: "XObject", Subtype: "Image", Width: 40, Height: 40, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" }), new Uint8Array(cv.encodeSync("jpeg", 95)))));
          bytes = new Uint8Array(await d2.save({ useObjectStreams: false }));
        }
        const r = ok(await sanitizePdf(bytes, { codec: createNodeImageCodec() }));
        const items = r.removed.filter((x) => x.kind === "covered_pixels");
        expect(items.map((x) => x.rect), name).toEqual([[50, 50, 100, 150]]);
        expect(items[0]!.count).toBe(image ? 50 : 800);
        expect(r.notDone).toEqual([]);
      }
    });
  }
});

describe("塗り損ねの安全網", () => {
  // 塗れるはずの覆いで 1 画素も塗れなかったときに notDone にする安全網は、片付けの不具合のときだけ働く（ふつうの PDF では起きない）。
  // ここでは、安全網がまちがって出ないことを確かめる（画素の中心が入らない細い覆い・ふつうの覆い）
  it("画素 1 列より細い覆い（画素の中心が入らない）では、塗らず、安全網も出さない", async () => {
    // 1 画素は 10pt。x 51〜54 の覆いには、どの画素の中心（55・65 …）も入らない
    const r = ok(await sanitizePdf(await imagePdf(gray(), "0 g 51 50 3 100 re f 1 g 81 50 3 100 re f")));
    expect(r.removed.filter((x) => x.kind === "covered_pixels")).toEqual([]);
    expect(r.notDone).toEqual([]);
  });
  it("ふつうの覆いでは、安全網は出ない", async () => {
    const r = ok(await sanitizePdf(await imagePdf(gray(), "1 g 50 50 50 100 re f")));
    expect(r.notDone).toEqual([]);
  });
});

describe("重なった覆いは、描いた順に塗る（あとの覆いの色が勝つ。2026-11-04、実物の trace から）", () => {
  // 実物：画像の上に、小さな濃い塗り → そのあと、それを含む小さな白い塗り。片付けが先の濃い塗りの色で塗っていたため、
  // 白い塗りの下に黒が残り、読み直しで「白い覆いの下に何かある」と出た
  const big = () => ({ kind: "flate" as const, w: 40, h: 40, comps: 1 as const, pixels: new Uint8Array(1600).fill(180) });
  /** 中心が箱 [x0, y0, x1, y1] に入る画素の値を数える（画像は 40×40 を (50,50)–(150,150) に置いたもの。1 画素 2.5pt） */
  const countIn = (data: Uint8Array, box: number[]) => {
    const c = { white: 0, black: 0, other: 0 };
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const cx = 50 + (x + 0.5) * 2.5, cy = 150 - (y + 0.5) * 2.5;
      if (cx < box[0]! || cx > box[2]! || cy < box[1]! || cy > box[3]!) continue;
      const v = data[y * 40 + x];
      if (v === 255) c.white++; else if (v === 0) c.black++; else c.other++;
    }
    return c;
  };

  it("濃い塗りのあと、それを含む白い塗り：白い塗りの下は全部白。下の濃い塗りの項目は出さず、安全網も出さない", async () => {
    const r = ok(await sanitizePdf(await imagePdf(big(), "0 g 70 90 10 20 re f 1 g 65 85 30 35 re f")));
    expect(r.removed.filter((x) => x.kind === "covered_pixels").map((x) => ({ rect: x.rect, count: x.count, white: x.label.includes("白く") }))).toEqual([
      { rect: [65, 85, 95, 120], count: 168, white: true },
    ]);
    expect(r.notDone).toEqual([]);
    expect(countIn(pixelsOf(await drawnImage(r.bytes)), [65, 85, 95, 120])).toEqual({ white: 168, black: 0, other: 0 });
  });

  it("白い塗りのあと、その中にすっかり入った濃い塗り：重なった所も白で塗り、白い塗りで数える（2026-11-04、実物の trace 2 回目から）", async () => {
    const r = ok(await sanitizePdf(await imagePdf(big(), "1 g 65 85 30 35 re f 0 g 70 90 10 20 re f")));
    const items = r.removed.filter((x) => x.kind === "covered_pixels").map((x) => ({ rect: x.rect, count: x.count, white: x.label.includes("白く") }));
    expect(items).toEqual([{ rect: [65, 85, 95, 120], count: 168, white: true }]);
    const data = pixelsOf(await drawnImage(r.bytes));
    expect(countIn(data, [70, 90, 80, 110])).toEqual({ white: 32, black: 0, other: 0 });
    expect(countIn(data, [65, 85, 95, 120])).toEqual({ white: 168, black: 0, other: 0 });
    expect(r.notDone).toEqual([]);
  });
});

describe("白い覆いの上に書いた濃い字や線（2026-11-04、実物の trace 2 回目から）", () => {
  // 実物：CCITT のスキャンの上の白い注釈のあとに、その中へ濃い注釈（字や線）を書いたもの。
  // 「あとの覆いの色が勝つ」だけだと、白い注釈の下に黒い模様が残り、読み直しで「白い覆いの下に何かある」と出た
  const big = () => ({ kind: "flate" as const, w: 40, h: 40, comps: 1 as const, pixels: new Uint8Array(1600).fill(180) });
  const countIn = (data: Uint8Array, inside: (x: number, y: number) => boolean) => {
    const c = { white: 0, black: 0, other: 0 };
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const cx = 50 + (x + 0.5) * 2.5, cy = 150 - (y + 0.5) * 2.5;
      if (!inside(cx, cy)) continue;
      const v = data[y * 40 + x];
      if (v === 255) c.white++; else if (v === 0) c.black++; else c.other++;
    }
    return c;
  };
  const inWhite = (x: number, y: number) => x >= 60 && x <= 120 && y >= 80 && y <= 120;
  const onHLine = (x0: number, x1: number, y0: number) => (x: number, y: number) => Math.abs(y - y0) <= 1.5 && x >= x0 && x <= x1;

  it("白い覆いの中にすっかり入った濃い線の所は、白で塗る（白い覆いの下も、濃い線の下も一様になる）", async () => {
    const r = ok(await sanitizePdf(await imagePdf(big(), "1 g 60 80 60 40 re f 0 G 3 w 70 100 m 110 100 l S 90 85 m 90 115 l S")));
    const data = pixelsOf(await drawnImage(r.bytes));
    expect(countIn(data, inWhite)).toEqual({ white: 384, black: 0, other: 0 });
    expect(countIn(data, onHLine(70, 110, 100))).toEqual({ white: 32, black: 0, other: 0 });
    expect(r.notDone).toEqual([]);
    // 塗った画素は、白い覆いで数える（濃い線の項目は出ない）
    expect(r.removed.filter((x) => x.kind === "covered_pixels").map((x) => ({ rect: x.rect, count: x.count, white: x.label.includes("白く") }))).toEqual([
      { rect: [60, 80, 120, 120], count: 384, white: true },
    ]);
  });

  it("白い覆いからはみ出す濃い線は、上にある濃い線の色で塗る（濃い線の下を白と黒の混ざりにしない。検証器が数えるため）", async () => {
    const r = ok(await sanitizePdf(await imagePdf(big(), "1 g 60 80 60 40 re f 0 G 3 w 70 100 m 140 100 l S")));
    const data = pixelsOf(await drawnImage(r.bytes));
    expect(countIn(data, onHLine(70, 140, 100))).toEqual({ white: 0, black: 56, other: 0 });
    expect(r.notDone).toEqual([]);
  });

  it("前の形（濃い塗りのあと、それを含む白い塗り）も、白い塗りの下は全部白のまま", async () => {
    const r = ok(await sanitizePdf(await imagePdf(big(), "0 g 70 90 10 20 re f 1 g 65 85 30 35 re f")));
    expect(countIn(pixelsOf(await drawnImage(r.bytes)), (x, y) => x >= 65 && x <= 95 && y >= 85 && y <= 120)).toEqual({ white: 168, black: 0, other: 0 });
  });
});

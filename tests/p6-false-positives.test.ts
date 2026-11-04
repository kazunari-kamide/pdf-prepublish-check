// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6 1.6.0：実物の公開 PDF で反応した「隠したものではない」型を、数えないことのテスト。
// 型の一覧は見つける段から受け取った（種類と件数だけ）。実物の PDF は使わず、テストの中で形だけを作る。
// あわせて、本当の漏れの型（紙の画像の上の字の行の高さの白い四角・注釈の覆い・表の列を隠した同じ大きさの四角）を、
// 数え続けることも確かめる。

import { describe, expect, it } from "vitest";
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFHexString,
  PDFOperator,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFOperatorNames,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import { detectP6Text, type P6ImageFinding, type P6TextFinding } from "../rules/p6-text/index.ts";

const W = 200;
const H = 100;
/**
 * スキャン画像らしいもの：白地に、字の行のような黒い短い線を並べた灰色 8 ビットの画素（4 行）。
 * 字の行の中の黒い点は約 18%（1.7.0 から。まわりの帯の明るさを測るので、実物の書類に近い字の濃さにした。推測の値）
 */
function scanPixels(): Uint8Array {
  const px = new Uint8Array(W * H).fill(255);
  for (let row = 10; row < H - 10; row += 20) {
    for (let x = 10; x < W - 10; x++) {
      if ((x * 7) % 11 < 2) for (let y = row; y < row + 8; y++) px[y * W + x] = 20;
    }
  }
  return px;
}
// 画像をページの (0,0)〜(400,200) に置く。字の行はページの y = 164〜180・124〜140・84〜100・44〜60、x = 20〜378
const ROWS_Y = [168, 128, 88, 48];

/** 写真らしいもの：場所ごとに明るさの変わる、濃淡の画素（明るい点は少ない） */
function photoPixels(): Uint8Array {
  const px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = 40 + ((x * 13 + y * 29 + ((x * y) % 17) * 7) % 120);
  return px;
}

function flateScan(doc: PDFDocument, px: Uint8Array = scanPixels()): PDFRef {
  return doc.context.register(
    doc.context.flateStream(px, { Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceGray", BitsPerComponent: 8 }),
  );
}
function drawScan(page: PDFPage, ref: PDFRef) {
  const name = page.node.newXObject("Scan", ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(400, 0, 0, 200, 0, 0), drawObject(name), popGraphicsState());
}
/** 命令の列を、そのままページに足す（数と命令だけの簡単なもの） */
function raw(page: PDFPage, src: string) {
  const ops: PDFOperator[] = [];
  let args: PDFNumber[] = [];
  for (const t of src.trim().split(/\s+/)) {
    const n = Number(t);
    if (Number.isFinite(n)) args.push(PDFNumber.of(n));
    else {
      ops.push(PDFOperator.of(t as PDFOperatorNames, args));
      args = [];
    }
  }
  page.pushOperators(...ops);
}
async function makePdf(draw: (doc: PDFDocument, page: PDFPage) => Promise<void> | void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 200]);
  await draw(doc, page);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}
const imageHits = (r: Awaited<ReturnType<typeof detectP6Text>>) => r.findings.filter((f): f is P6ImageFinding => f.layer === "image");
const textHits = (r: Awaited<ReturnType<typeof detectP6Text>>) => r.findings.filter((f): f is P6TextFinding => f.layer === "text");

/** 箱の中の、上の真ん中を大きく欠いた形（字の形の塗りの代わり。詰まり具合 0.6） */
function notchedShape(x: number, y: number, w: number, h: number): string {
  const a = x + w / 4;
  const b = x + (3 * w) / 4;
  const d = y + h * 0.2;
  return `${x} ${y} m ${x + w} ${y} l ${x + w} ${y + h} l ${b} ${y + h} l ${b} ${d} l ${a} ${d} l ${a} ${y + h} l ${x} ${y + h} l h f`;
}

describe("P6 1.6.0〜1.7.0：画像の層の、数えない型", () => {
  it("見える範囲（CropBox）の外の覆いは数えず、中の同じ覆いは数える", async () => {
    const pdf = await makePdf((doc, page) => {
      page.setCropBox(0, 0, 200, 200);
      drawScan(page, flateScan(doc));
      page.drawRectangle({ x: 250, y: 164, width: 80, height: 16, color: rgb(1, 1, 1) }); // 見える範囲の外
      page.drawRectangle({ x: 30, y: 164, width: 80, height: 16, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(imageHits(r).map((f) => f.rect)).toEqual([[30, 164, 110, 180]]);
    expect(r.excluded).toEqual({ "image:outside_view": 1 });
  });

  it("MediaBox の外にはみ出した部分は測らない（見える部分の下が一様なら数えない）", async () => {
    const pdf = await makePdf((doc, page) => {
      page.setMediaBox(0, 0, 400, 162); // 一番上の字の行（164〜180）は、ページの外
      drawScan(page, flateScan(doc));
      // 見える部分（158〜162）は字の行の間の余白。外の部分（162〜184）には字の行がある
      page.drawRectangle({ x: 30, y: 158, width: 80, height: 26, color: rgb(1, 1, 1) });
    });
    expect(imageHits(await detectP6Text(pdf))).toHaveLength(0);
  });

  it("切り抜き（W）で見えない覆いと、切り抜きで見えない画像の上の覆いは数えない", async () => {
    const pdf = await makePdf((doc, page) => {
      raw(page, "q 0 0 100 200 re W n");
      drawScan(page, flateScan(doc)); // 画像は x < 100 だけ見える
      raw(page, "Q");
      page.drawRectangle({ x: 200, y: 164, width: 80, height: 16, color: rgb(1, 1, 1) }); // 下の画像は切り抜きの外
      raw(page, "q 0 0 10 10 re W n 1 g 30 164 60 16 re f Q"); // 覆いそのものが切り抜きの外
      page.drawRectangle({ x: 30, y: 124, width: 60, height: 16, color: rgb(1, 1, 1) }); // 見える所：数える
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(imageHits(r).map((f) => f.rect)).toEqual([[30, 124, 90, 140]]);
    expect(r.excluded).toEqual({ "image:outside_view": 1 });
  });

  it("字の形の塗り（詰まり具合の低い形）は数えず、ふつうの四角は数える", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      raw(page, `1 g ${notchedShape(30, 164, 20, 16)}`);
      raw(page, `0 g ${notchedShape(80, 164, 20, 16)}`);
      page.drawRectangle({ x: 150, y: 164, width: 20, height: 16, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(imageHits(r).map((f) => f.rect)).toEqual([[150, 164, 170, 180]]);
    expect(r.excluded).toEqual({ "image:not_rect": 2 }); // 1.7.0 から：縦横の四角でない塗りは、詰まり具合より先に除く
  });

  it("短い辺が 4pt より細い塗りは数えず、字の行の高さ（6〜10pt）の白い四角は数える", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      page.drawRectangle({ x: 30, y: 170, width: 100, height: 3, color: rgb(1, 1, 1) });
      page.drawRectangle({ x: 30, y: 130, width: 100, height: 6, color: rgb(1, 1, 1) });
      page.drawRectangle({ x: 30, y: 88, width: 100, height: 10, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(imageHits(r).map((f) => f.rect)).toEqual([
      [30, 130, 130, 136],
      [30, 88, 130, 98],
    ]);
    expect(r.excluded).toEqual({ "image:too_small": 1 });
  });

  it("同じ大きさの小さな正方形が 20 個並ぶ模様（装飾の格子）は数えない", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      for (let i = 0; i < 20; i++) page.drawRectangle({ x: 22 + i * 17.5, y: 168, width: 8, height: 8, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(imageHits(r)).toHaveLength(0);
    expect(r.excluded).toEqual({ "image:repeated": 20 });
  });

  it("同じ大きさの正方形でも 19 個までは、くり返しの模様とみなさない", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      for (let i = 0; i < 19; i++) page.drawRectangle({ x: 22 + i * 17.5, y: 168, width: 8, height: 8, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    // 字の線の間の白い所だけに乗った四角は、下が一様なので数えない。くり返しの条件では、1つも除かない
    expect(r.excluded?.["image:repeated"]).toBeUndefined();
    expect(imageHits(r).length).toBeGreaterThanOrEqual(10);
  });

  it("表の列を隠した、同じ大きさの横長の四角 20 個は、すべて数える（縦横の比で、模様と分ける）", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      for (const y of ROWS_Y) for (const x of [25, 95, 165, 235, 305]) page.drawRectangle({ x, y, width: 40, height: 8, color: rgb(1, 1, 1) });
    });
    expect(imageHits(await detectP6Text(pdf))).toHaveLength(20);
  });

  it("注釈の覆いには、細さ・形の条件をかけない（高さ 3pt の白い四角の注釈も数える）", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      const annot = doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [30, 170, 130, 173], IC: [1, 1, 1], F: 4 });
      page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(annot)]));
    });
    const hits = imageHits(await detectP6Text(pdf));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ cover: "annotation", tone: "light" });
  });

  it("explain を渡さなければ、excluded は報告に入らない", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      page.drawRectangle({ x: 30, y: 170, width: 100, height: 3, color: rgb(1, 1, 1) });
    });
    expect((await detectP6Text(pdf)).excluded).toBeUndefined();
  });
});

describe("P6 1.7.0：画像の層の、まわりの帯と確からしさ", () => {
  it("回した四角の塗りは、画像の層では数えない（1.7.0 から。注釈なら数える）", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      raw(page, "1 g 30 164 m 110 166 l 109 182 l 29 180 l h f"); // 少し回した四角
      const annot = doc.context.obj({ Type: "Annot", Subtype: "Polygon", Rect: [150, 164, 230, 180], IC: [1, 1, 1], F: 4 });
      page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(annot)]));
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(imageHits(r).map((f) => f.cover)).toEqual(["annotation"]);
    expect(r.excluded).toEqual({ "image:not_rect": 1 });
  });

  it("写真の上の白い札（まわりが写真で、溶け込まない）は数えず、紙の上の白い四角は数える", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc, photoPixels()));
      page.drawRectangle({ x: 100, y: 80, width: 80, height: 16, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(imageHits(r)).toHaveLength(0);
    expect(r.excluded).toEqual({ "image:not_blending": 1 });

    const paper = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      page.drawRectangle({ x: 100, y: 168, width: 80, height: 8, color: rgb(1, 1, 1) }); // 字の行の中（まわりも字の行）
      page.drawRectangle({ x: 100, y: 124, width: 80, height: 16, color: rgb(1, 1, 1) }); // 字の行ちょうど
    });
    const r2 = await detectP6Text(paper, { explain: true });
    expect(imageHits(r2)).toHaveLength(2);
    for (const f of imageHits(r2)) {
      expect(f.confidence).toBe("high");
      expect(f.metrics!.ringLight).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("写真の上の黒い四角は、落とさずに「確かめてください」（confidence: check）にする", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc, photoPixels()));
      page.drawRectangle({ x: 100, y: 80, width: 80, height: 16, color: rgb(0, 0, 0) });
    });
    const hits = imageHits(await detectP6Text(pdf, { explain: true }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ tone: "dark", confidence: "check" });
    expect(hits[0]!.metrics!.underLight).toBeLessThan(0.4);
  });

  it("紙の上の黒い四角と、写真の上の黒い四角の注釈は、確かなもの（high）", async () => {
    const paper = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc));
      page.drawRectangle({ x: 30, y: 160, width: 150, height: 24, color: rgb(0, 0, 0) });
    });
    expect(imageHits(await detectP6Text(paper)).map((f) => f.confidence)).toEqual(["high"]);
    const annot = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc, photoPixels()));
      const a = doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [100, 80, 180, 96], IC: [0, 0, 0], F: 4 });
      page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(a)]));
    });
    expect(imageHits(await detectP6Text(annot)).map((f) => [f.cover, f.confidence])).toEqual([["annotation", "high"]]);
  });

  it("写真の上の白い四角の注釈は、まわりが写真でも数える（注釈には条件をかけない）", async () => {
    const pdf = await makePdf((doc, page) => {
      drawScan(page, flateScan(doc, photoPixels()));
      const a = doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [100, 80, 180, 96], IC: [1, 1, 1], F: 4 });
      page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(a)]));
    });
    expect(imageHits(await detectP6Text(pdf))).toHaveLength(1);
  });
});

describe("P6 1.6.0〜1.7.0：文字の層の、数えない型", () => {
  it("黒い帯の上に、同じ字を白抜きで描き直したものは数えず、違う字なら数える", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("ABC", { x: 20, y: 150, size: 14, font });
      page.drawText("OLD", { x: 20, y: 100, size: 14, font });
      page.drawRectangle({ x: 15, y: 145, width: 50, height: 20, color: rgb(0, 0, 0) });
      page.drawRectangle({ x: 15, y: 95, width: 50, height: 20, color: rgb(0, 0, 0) });
      page.drawText("ABC", { x: 20, y: 150, size: 14, font, color: rgb(1, 1, 1) });
      page.drawText("NEW", { x: 20, y: 100, size: 14, font, color: rgb(1, 1, 1) });
    });
    const r = await detectP6Text(pdf, { explain: true, includeText: true });
    expect(textHits(r).map((f) => f.text)).toEqual(["OLD"]);
    expect(r.excluded).toEqual({ "text:same_text_on_top": 1 });
  });

  it("少しずらして同じ字を描き直したもの（影・縁取りの飾り文字）も数えない", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("ABC", { x: 20, y: 150, size: 14, font });
      page.drawRectangle({ x: 15, y: 145, width: 50, height: 20, color: rgb(0, 0, 0) });
      page.drawText("ABC", { x: 21, y: 151, size: 14, font, color: rgb(1, 1, 1) });
    });
    expect(textHits(await detectP6Text(pdf))).toHaveLength(0);
  });

  it("字の輪郭の形（詰まり具合の低い形）を字の上に重ねたものは数えない", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("H", { x: 20, y: 150, size: 20, font });
      raw(page, "0 g 18 144 m 90 144 l 90 148 l 36 148 l 36 166 l 18 166 l h f"); // L の形：字は全部隠すが、詰まり具合は 0.6 くらい
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(textHits(r)).toHaveLength(0);
    expect(r.excluded).toEqual({ "text:not_solid": 1 });
  });

  it("見える範囲（CropBox）の外の字と覆いは数えない", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.setCropBox(0, 0, 200, 200);
      page.drawText("SECRET", { x: 250, y: 150, size: 14, font });
      page.drawRectangle({ x: 245, y: 145, width: 70, height: 20, color: rgb(0, 0, 0) });
      page.drawText("SECRET", { x: 20, y: 150, size: 14, font });
      page.drawRectangle({ x: 15, y: 145, width: 70, height: 20, color: rgb(0, 0, 0) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(textHits(r).map((f) => f.rect)).toEqual([[15, 145, 85, 165]]);
    expect(r.excluded).toEqual({ "text:outside_view": 1 });
  });

  it("字の中身が読めないフォントでも、同じフォントの同じ字を上に描き直したものは数えない（1.7.0 から）", async () => {
    const pdf = await makePdf((doc, page) => {
      // 字の形を読めないフォント（辞書が足りない）：字の中身は空になる
      const font = doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type0", BaseFont: "Broken" }));
      page.node.setFontDictionary(PDFName.of("FX"), font);
      const show = () =>
        page.pushOperators(
          PDFOperator.of("BT" as PDFOperatorNames),
          PDFOperator.of("Tf" as PDFOperatorNames, [PDFName.of("FX"), PDFNumber.of(14)]),
          PDFOperator.of("Td" as PDFOperatorNames, [PDFNumber.of(20), PDFNumber.of(150)]),
          PDFOperator.of("Tj" as PDFOperatorNames, [PDFHexString.of("414243")]),
          PDFOperator.of("ET" as PDFOperatorNames),
        );
      show();
      raw(page, "0 g 15 140 60 30 re f");
      show();
    });
    const r = await detectP6Text(pdf, { explain: true });
    expect(textHits(r)).toHaveLength(0);
    expect(r.excluded).toEqual({ "text:same_text_on_top": 1 });
  });

  it("字1つ分の大きさの形のある塗りは数えず、何文字も覆う楕円・字1つの上の縦横の四角は数える（1.7.0 から）", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("O", { x: 20, y: 150, size: 20, font });
      page.drawEllipse({ x: 27.5, y: 157, xScale: 7.5, yScale: 9, color: rgb(0, 0, 0) }); // 字1つ分の楕円
      page.drawText("NAME", { x: 20, y: 100, size: 14, font });
      page.drawEllipse({ x: 38, y: 105, xScale: 26, yScale: 10, color: rgb(0, 0, 0) }); // 何文字も覆う楕円
      page.drawText("X", { x: 20, y: 50, size: 14, font });
      page.drawRectangle({ x: 19, y: 46, width: 11, height: 14, color: rgb(0, 0, 0) }); // 字1つの上の縦横の四角
    });
    const r = await detectP6Text(pdf, { explain: true, includeText: true });
    expect(textHits(r).map((f) => f.text).sort()).toEqual(["NAME", "X"]);
    expect(r.excluded).toEqual({ "text:glyph_sized": 1 });
  });

  it("explain のとき、文字の層の報告に測った値と、覆いの上の字のあり方の数を返す", async () => {
    const pdf = await makePdf(async (doc, page) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText("OLD", { x: 20, y: 100, size: 14, font });
      page.drawRectangle({ x: 15, y: 95, width: 50, height: 20, color: rgb(0, 0, 0) });
      page.drawText("NEW", { x: 20, y: 100, size: 14, font, color: rgb(1, 1, 1) });
      page.drawText("SECRET", { x: 20, y: 150, size: 14, font });
      page.drawRectangle({ x: 15, y: 145, width: 70, height: 20, color: rgb(0, 0, 0) });
    });
    const r = await detectP6Text(pdf, { explain: true });
    const m = textHits(r).map((f) => f.metrics!);
    expect(m.map((x) => x.textOnTop).sort()).toEqual(["different", "none"]);
    expect(m.every((x) => x.how === "fill" && x.coverMinSide === 20 && x.glyphHeightMin > 10)).toBe(true);
    expect(r.diagnostics).toEqual({ "text:on_top_different": 1, "text:on_top_none": 1 });
    expect((await detectP6Text(pdf)).findings.every((f) => !("metrics" in f))).toBe(true);
  });
});

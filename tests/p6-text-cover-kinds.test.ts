// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6（見せかけの黒塗り）の文字の層 1.1.0：濃い画像（text/image）と注釈（text/annotation）で覆った型のテスト。
// fixtures/ の合成 PDF は採点に使うので、ここではテストの中で小さな PDF を作って確かめる。

import { describe, expect, it } from "vitest";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import { detectP6Text, type P6TextFinding } from "../rules/p6-text/index.ts";

type Ctx = { doc: PDFDocument; page: PDFPage };

async function makePdf(draw: (c: Ctx) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
  draw({ doc, page });
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

/** 画像を、字「Taro Yamada」の上（15,95 から 120×20）に描く */
function placeImage({ page }: Ctx, ref: PDFRef) {
  const name = page.node.newXObject("Im", ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(120, 0, 0, 20, 15, 95), drawObject(name), popGraphicsState());
}

function grayImage({ doc }: Ctx, pixels: number[], w: number, h: number, extra: Record<string, unknown> = {}): PDFRef {
  const stream = doc.context.flateStream(new Uint8Array(pixels), {
    Type: "XObject",
    Subtype: "Image",
    Width: w,
    Height: h,
    ColorSpace: "DeviceGray",
    BitsPerComponent: 8,
    ...extra,
  });
  return doc.context.register(stream);
}

function addAnnot({ doc, page }: Ctx, dict: Record<string, unknown>) {
  const ref = doc.context.register(doc.context.obj({ Type: "Annot", ...dict }));
  page.node.addAnnot(ref);
}

describe("濃い画像で覆った字（text/image）", () => {
  it("字のあとに黒い画像を貼ったら、見つける", async () => {
    const pdf = await makePdf((c) => placeImage(c, grayImage(c, new Array(16).fill(0), 4, 4)));
    const r = await detectP6Text(pdf);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.cover).toBe("image");
    expect((r.findings[0] as P6TextFinding).chars).toBe(10);
  });

  it("黒い画像のあとに字を描いたら、見つけない", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    placeImage({ doc, page }, grayImage({ doc, page }, new Array(16).fill(0), 4, 4));
    page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
    const r = await detectP6Text(new Uint8Array(await doc.save({ useObjectStreams: false })));
    expect(r.findings).toHaveLength(0);
  });

  it("濃い所と明るい所が混ざった写真のような画像は、覆いとみなさない", async () => {
    // 16 画素のうち 4 画素が明るい（濃い画素は 75%）
    const px = [0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0];
    const pdf = await makePdf((c) => placeImage(c, grayImage(c, px, 4, 4)));
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });

  it("PNG の予測（Predictor 15）をかけた黒い画像も、見つける", async () => {
    // 1行ごとに、予測の種類（0：なし、2：上と同じ）の1バイトを先に置く
    const rows = [0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0];
    const pdf = await makePdf((c) =>
      placeImage(c, grayImage(c, rows, 4, 4, { DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: 4 } })),
    );
    expect((await detectP6Text(pdf)).findings).toHaveLength(1);
  });

  it("色の表（Indexed）で黒を指す画像も、見つける", async () => {
    const pdf = await makePdf((c) => {
      const ref = c.doc.context.register(
        c.doc.context.flateStream(new Uint8Array(16).fill(1), {
          Type: "XObject",
          Subtype: "Image",
          Width: 4,
          Height: 4,
          ColorSpace: [PDFName.of("Indexed"), PDFName.of("DeviceRGB"), 1, PDFHexString.of("FFFFFF000000")],
          BitsPerComponent: 8,
        }),
      );
      placeImage(c, ref);
    });
    expect((await detectP6Text(pdf)).findings).toHaveLength(1);
  });

  it("黒で塗る型抜き（ImageMask）も、見つける", async () => {
    const pdf = await makePdf((c) => {
      const ref = c.doc.context.register(
        c.doc.context.flateStream(new Uint8Array(4).fill(0), { Type: "XObject", Subtype: "Image", Width: 8, Height: 4, ImageMask: true }),
      );
      placeImage(c, ref);
    });
    expect((await detectP6Text(pdf)).findings).toHaveLength(1);
  });

  it("透明（SMask がすべて 0）な黒い画像は、隠していないので見つけない", async () => {
    const pdf = await makePdf((c) => {
      const mask = grayImage(c, new Array(16).fill(0), 4, 4);
      placeImage(c, grayImage(c, new Array(16).fill(0), 4, 4, { SMask: mask }));
    });
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });

  it("解けない圧縮（JPEG）の画像は、覆いとみなさず「調べられなかった画像」に数える", async () => {
    const pdf = await makePdf((c) => {
      const ref = c.doc.context.register(
        c.doc.context.stream(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          Type: "XObject",
          Subtype: "Image",
          Width: 4,
          Height: 4,
          ColorSpace: "DeviceGray",
          BitsPerComponent: 8,
          Filter: "DCTDecode",
        }),
      );
      placeImage(c, ref);
    });
    const r = await detectP6Text(pdf);
    expect(r.findings).toHaveLength(0);
    expect(r.uncheckedImages).toEqual([{ page: 1, reason: "unsupported_filter" }]);
  });
});

describe("注釈で覆った字（text/annotation）", () => {
  const RECT = [15, 95, 135, 115];

  it("見た目のない、中を黒く塗った四角の注釈は、見つける", async () => {
    const pdf = await makePdf((c) => addAnnot(c, { Subtype: "Square", Rect: RECT, IC: [0, 0, 0], F: 4 }));
    const r = await detectP6Text(pdf);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.cover).toBe("annotation");
  });

  it("見た目（/AP）で黒く塗った四角の注釈は、見つける", async () => {
    const pdf = await makePdf((c) => {
      const ap = c.doc.context.register(
        c.doc.context.stream("0 g 0 0 60 10 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 60, 10] }),
      );
      addAnnot(c, { Subtype: "Square", Rect: RECT, F: 4, AP: { N: ap } });
    });
    const r = await detectP6Text(pdf);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.rect).toEqual(RECT); // 見た目の座標を、注釈の箱に合わせて移す
  });

  it("中が薄い色の四角の注釈は、見つけない", async () => {
    const pdf = await makePdf((c) => addAnnot(c, { Subtype: "Square", Rect: RECT, IC: [1, 1, 0], F: 4 }));
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });

  it("隠した（Hidden）注釈は、見えないので見つけない", async () => {
    const pdf = await makePdf((c) => addAnnot(c, { Subtype: "Square", Rect: RECT, IC: [0, 0, 0], F: 2 }));
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });

  it("半透明（CA 0.3）の注釈は、隠していないので見つけない", async () => {
    const pdf = await makePdf((c) => addAnnot(c, { Subtype: "Square", Rect: RECT, IC: [0, 0, 0], CA: 0.3, F: 4 }));
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });

  it("適用していない墨消しの注釈は、色がなくても見つける", async () => {
    const pdf = await makePdf((c) => addAnnot(c, { Subtype: "Redact", Rect: RECT, F: 4 }));
    const r = await detectP6Text(pdf);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.cover).toBe("annotation");
  });

  it("墨消しの注釈に QuadPoints があれば、その範囲だけを覆いとする", async () => {
    // 箱は字全体だが、QuadPoints は字のない所（下の余白）だけ
    const pdf = await makePdf((c) =>
      addAnnot(c, { Subtype: "Redact", Rect: [15, 20, 135, 115], QuadPoints: [15, 40, 135, 40, 15, 20, 135, 20], F: 4 }),
    );
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });
});

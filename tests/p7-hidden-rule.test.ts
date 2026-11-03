// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P7（隠れたテキスト）のテスト。
// 採点に使う合成 PDF（fixtures/p7）は使わず、テストの中で、描く命令を直接書いた小さな PDF を作って確かめる。名前はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFRef } from "pdf-lib";
import { detectP7Hidden } from "../rules/p7-hidden/index.ts";
import { operations } from "../rules/shared/content-lexer.ts";

const enc = (s: string) => new TextEncoder().encode(s);

type Extra = { xobjects?: (doc: PDFDocument, font: PDFRef) => Record<string, PDFRef>; ocg?: "on" | "off"; extgstate?: Record<string, Record<string, unknown>>; cropBox?: [number, number, number, number] };

async function makePdf(content: string, extra: Extra = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }));
  const res: Record<string, unknown> = { Font: { F1: font } };
  if (extra.xobjects) res.XObject = extra.xobjects(doc, font);
  if (extra.extgstate) res.ExtGState = extra.extgstate;
  if (extra.ocg) {
    const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: ctx.obj("Layer") as never }));
    res.Properties = { L1: ocg };
    doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: extra.ocg === "off" ? { OFF: [ocg] } : { ON: [ocg] } }));
  }
  page.node.set(PDFName.of("Resources"), ctx.obj(res as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  if (extra.cropBox) page.setCropBox(...extra.cropBox);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

function image(doc: PDFDocument): PDFRef {
  return doc.context.register(
    doc.context.stream(new Uint8Array([40]), { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8 }),
  );
}

const reasons = async (content: string, extra?: Extra) => {
  const r = await detectP7Hidden(await makePdf(content, extra));
  expect(r.status).toBe("ok");
  return r.findings.map((f) => `${f.reason}:${f.chars}`);
};

describe("命令の読み手", () => {
  it("埋め込みの画像（BI … ID … EI）の中身を命令として読まない", () => {
    const ops = [...operations(enc("q BI /W 1 /H 1 /CS /G /BPC 8 ID \x00Tj EI Q BT (a) Tj ET"))].map((o) => o.op);
    expect(ops).toEqual(["q", "BI", "Q", "BT", "Tj", "ET"]);
  });

  it("深すぎる入れ子では止まる（固まらない）", () => {
    expect(() => [...operations(enc("[".repeat(100) + "] TJ"))]).toThrow();
  });
});

describe("見えない理由ごとに見つける", () => {
  it("白い地の白い字は same_color。字そのものは既定では返さない", async () => {
    const r = await detectP7Hidden(await makePdf("1 g BT /F1 12 Tf 20 100 Td (Taro Yamada) Tj ET"));
    expect(r.findings.map((f) => `${f.reason}:${f.chars}`)).toEqual(["same_color:10"]);
    expect(r.findings[0]!.text).toBeUndefined();
    const r2 = await detectP7Hidden(await makePdf("1 g BT /F1 12 Tf 20 100 Td (Taro Yamada) Tj ET"), { includeText: true });
    expect(r2.findings[0]!.text).toBe("Taro Yamada");
  });

  it("字の箱は、Helvetica の幅と高さ（0.718・-0.207）で出す", async () => {
    const r = await detectP7Hidden(await makePdf("1 g BT /F1 10 Tf 20 100 Td (A) Tj ET"));
    const [x0, y0, x1, y1] = r.findings[0]!.rect;
    expect(x0).toBeCloseTo(20);
    expect(x1).toBeCloseTo(20 + 6.67, 1); // A の幅 667
    expect(y0).toBeCloseTo(100 - 2.07);
    expect(y1).toBeCloseTo(100 + 7.18);
  });

  it("薄い灰色（0.8）の字は読めるので返さない", async () => {
    expect(await reasons("0.8 g BT /F1 12 Tf 20 100 Td (light) Tj ET")).toEqual([]);
  });

  it("黒い帯の上の黒い字は same_color、白い字は返さない", async () => {
    expect(await reasons("0 g 10 90 200 30 re f 0 g BT /F1 12 Tf 20 100 Td (black) Tj ET 1 g BT /F1 12 Tf 120 100 Td (white) Tj ET")).toEqual(["same_color:5"]);
  });

  it("ページの外の字は off_page、見える範囲（CropBox）の外も off_page、端の内側は返さない", async () => {
    expect(await reasons("BT /F1 12 Tf 310 100 Td (outside) Tj ET BT /F1 12 Tf 250 100 Td (edge) Tj ET")).toEqual(["off_page:7"]);
    expect(await reasons("BT /F1 12 Tf 20 150 Td (upper) Tj ET", { cropBox: [0, 0, 300, 100] })).toEqual(["off_page:5"]);
  });

  it("大きさ 0.5 の字は tiny、大きさ 6 の字は返さない", async () => {
    expect(await reasons("BT /F1 0.5 Tf 20 100 Td (tiny) Tj ET BT /F1 6 Tf 20 50 Td (small) Tj ET")).toEqual(["tiny:4"]);
  });

  it("描き方 3 の字は invisible。画像と重なれば文字認識の層として数えない（描く順番に関係なく）", async () => {
    expect(await reasons("3 Tr BT /F1 12 Tf 20 100 Td (hidden) Tj ET")).toEqual(["invisible:6"]);
    const xobjects = (doc: PDFDocument) => ({ Im1: image(doc) });
    const r = await detectP7Hidden(await makePdf("BT 3 Tr /F1 12 Tf 20 100 Td (ocr) Tj ET q 300 0 0 200 0 0 cm /Im1 Do Q", { xobjects }));
    expect(r.findings).toEqual([]);
    expect(r.excluded.ocrLayer).toBe(3);
  });

  it("不透明さ 0 の字は invisible", async () => {
    expect(await reasons("/GS0 gs BT /F1 12 Tf 20 100 Td (clear) Tj ET", { extgstate: { GS0: { ca: 0 } } })).toEqual(["invisible:5"]);
  });

  it("表示しないレイヤーの字は hidden_layer、表示するレイヤーは返さない", async () => {
    const c = "/OC /L1 BDC BT /F1 12 Tf 20 100 Td (layer) Tj ET EMC";
    expect(await reasons(c, { ocg: "off" })).toEqual(["hidden_layer:5"]);
    expect(await reasons(c, { ocg: "on" })).toEqual([]);
  });

  it("切り抜きの外の字は clipped、中の字は返さない", async () => {
    expect(await reasons("q 0 0 100 200 re W n BT /F1 12 Tf 150 100 Td (out) Tj ET BT /F1 12 Tf 20 100 Td (in) Tj ET Q")).toEqual(["clipped:3"]);
  });

  it("字のあとの白い四角は covered_light、黒い四角は P6、乗算の黄色は返さない", async () => {
    expect(await reasons("BT /F1 12 Tf 20 100 Td (name) Tj ET 1 g 15 95 60 20 re f")).toEqual(["covered_light:4"]);
    const r = await detectP7Hidden(await makePdf("BT /F1 12 Tf 20 100 Td (name) Tj ET 0 g 15 95 60 20 re f"));
    expect(r.findings).toEqual([]);
    expect(r.excluded.p6).toBe(4);
    expect(await reasons("BT /F1 12 Tf 20 100 Td (name) Tj ET /M gs 1 1 0 rg 15 95 60 20 re f", { extgstate: { M: { BM: "Multiply" } } })).toEqual([]);
  });

  it("部品（Form XObject）の中の白い字も見つける", async () => {
    const xobjects = (doc: PDFDocument, font: PDFRef) => {
      const ctx = doc.context;
      return {
        Fm1: ctx.register(
          ctx.stream("1 g BT /F1 12 Tf 0 0 Td (inside form) Tj ET", {
            Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 50], Resources: { Font: { F1: font } },
          } as never),
        ),
      };
    };
    expect(await reasons("q 1 0 0 1 20 100 cm /Fm1 Do Q", { xobjects })).toEqual(["same_color:10"]);
  });

  it("1回の TJ の中で同じ理由で続く字は1件にまとめる", async () => {
    expect(await reasons("1 g BT /F1 12 Tf 20 100 Td [(Ta) -20 (ro) 50 ( Ya) (mada)] TJ ET")).toEqual(["same_color:10"]);
  });
});

describe("壊れた・重い入力で止まらない", () => {
  it("命令の数が上限を超えたページは省き、skippedPages に出す", async () => {
    const bytes = await makePdf("0 g ".repeat(200) + "BT /F1 12 Tf 20 100 Td (x) Tj ET");
    const r = await detectP7Hidden(bytes, { settings: { maxOperations: 50 } });
    expect(r.skippedPages).toEqual([{ page: 1, reason: "too_many_operations" }]);
    expect(r.findings).toEqual([]);
  });

  it("空のファイル・PDF でないもの", async () => {
    expect((await detectP7Hidden(new Uint8Array())).error!.code).toBe("empty");
    const r = await detectP7Hidden(enc("hello"));
    expect(r.findings).toEqual([]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P7 1.1.0 で足した型のテスト（取りこぼし 26 項目の 1〜4・23）。
// 型ごとに、隠しのある合成 PDF と、何も隠していない対照の両方を、テストの中で作る。名前・番号はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, type PDFRef } from "pdf-lib";
import { detectP7Hidden } from "../rules/p7-hidden/index.ts";

type ImageSpec = { w: number; h: number; pixels: number[]; filter?: string; smask?: boolean };
type Extra = { images?: Record<string, ImageSpec>; extgstate?: Record<string, Record<string, unknown>> };

async function makePdf(content: string, extra: Extra = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }));
  const res: Record<string, unknown> = { Font: { F1: font } };
  if (extra.images) {
    const xo: Record<string, PDFRef> = {};
    for (const [name, im] of Object.entries(extra.images)) {
      const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Image", Width: im.w, Height: im.h, ColorSpace: "DeviceGray", BitsPerComponent: 8 };
      if (im.filter) dict.Filter = im.filter;
      if (im.smask) {
        dict.SMask = ctx.register(
          ctx.stream(new Uint8Array(im.w * im.h).fill(128), { Type: "XObject", Subtype: "Image", Width: im.w, Height: im.h, ColorSpace: "DeviceGray", BitsPerComponent: 8 }),
        );
      }
      xo[name] = ctx.register(ctx.stream(new Uint8Array(im.pixels), dict as never));
    }
    res.XObject = xo;
  }
  if (extra.extgstate) res.ExtGState = extra.extgstate;
  page.node.set(PDFName.of("Resources"), ctx.obj(res as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

const run = async (content: string, extra?: Extra) => {
  const r = await detectP7Hidden(await makePdf(content, extra));
  expect(r.status).toBe("ok");
  return r;
};
const reasons = async (content: string, extra?: Extra) => (await run(content, extra)).findings.map((f) => `${f.reason}:${f.chars}`);

const uniform = (v: number, w = 4, h = 4): ImageSpec => ({ w, h, pixels: new Array(w * h).fill(v) });
/** 写真の代わり：明るい点と暗い点が交互に並ぶ画像 */
const checker = (w = 8, h = 8): ImageSpec => ({ w, h, pixels: Array.from({ length: w * h }, (_, i) => ((i % w) + Math.floor(i / w)) % 2 ? 255 : 0) });

describe("1. 横につぶれて見えない字（squashed）", () => {
  it("横の伸縮 1% と 0% の字は squashed。箱は画面で見えるよう 1 ポイント以上の幅にする", async () => {
    for (const tz of [1, 0]) {
      const r = await run(`0 g BT /F1 12 Tf ${tz} Tz 20 100 Td (Taro Yamada) Tj ET`);
      expect(r.findings.map((f) => `${f.reason}:${f.chars}`)).toEqual(["squashed:10"]);
      const [x0, , x1] = r.findings[0]!.rect;
      expect(x1 - x0).toBeGreaterThanOrEqual(1);
    }
  });

  it("文字行列で横だけ縮めた字（Tm の横 0.05）も squashed", async () => {
    expect(await reasons("0 g BT /F1 1 Tf 0.05 0 0 12 20 100 Tm (Hanako) Tj ET")).toEqual(["squashed:6"]);
  });

  it("対照：長体（横 80%・50%）、細い字形（i や l）、回した字、裏返した字は返さない", async () => {
    expect(await reasons("0 g BT /F1 12 Tf 80 Tz 20 100 Td (Taro Yamada) Tj ET")).toEqual([]);
    expect(await reasons("0 g BT /F1 12 Tf 50 Tz 20 100 Td (Taro Yamada) Tj ET")).toEqual([]);
    expect(await reasons("0 g BT /F1 12 Tf 20 100 Td (iiiilllll) Tj ET")).toEqual([]);
    expect(await reasons("0 g BT /F1 12 Tf 0 1 -1 0 150 40 Tm (Rotated) Tj ET")).toEqual([]);
    expect(await reasons("0 g BT /F1 12 Tf -1 0 0 1 200 100 Tm (Mirror) Tj ET")).toEqual([]);
  });
});

describe("2. 描き方 1・2・5・6 は、輪郭の不透明さと色も見る", () => {
  const gs = { extgstate: { GS1: { Type: "ExtGState", ca: 0, CA: 1 }, GS2: { Type: "ExtGState", ca: 0, CA: 0 } } };

  it("対照：描き方 2・6 で、塗りが透明・輪郭が黒い字は見えるので返さない", async () => {
    expect(await reasons("/GS1 gs 0 G 0 g 2 Tr BT /F1 12 Tf 20 100 Td (Outline) Tj ET", gs)).toEqual([]);
    expect(await reasons("/GS1 gs 0 G 0 g 6 Tr BT /F1 12 Tf 20 100 Td (Outline) Tj ET", gs)).toEqual([]);
  });

  it("描き方 2 で、塗りが透明・輪郭が白い字は same_color（輪郭が背景と同じ色）", async () => {
    expect(await reasons("/GS1 gs 1 G 0 g 2 Tr BT /F1 12 Tf 20 100 Td (Ichiro) Tj ET", gs)).toEqual(["same_color:6"]);
  });

  it("描き方 2 で、塗りも輪郭も透明な字は invisible", async () => {
    expect(await reasons("/GS2 gs 0 G 0 g 2 Tr BT /F1 12 Tf 20 100 Td (Ichiro) Tj ET", gs)).toEqual(["invisible:6"]);
  });

  it("描き方 2 で、塗りは白・輪郭は黒の字は見える。塗りも輪郭も白なら same_color", async () => {
    expect(await reasons("1 g 0 G 2 Tr BT /F1 12 Tf 20 100 Td (Jiro) Tj ET")).toEqual([]);
    expect(await reasons("1 g 1 G 2 Tr BT /F1 12 Tf 20 100 Td (Jiro) Tj ET")).toEqual(["same_color:4"]);
  });

  it("描き方 1 の白い輪郭の字は、これまでどおり same_color", async () => {
    expect(await reasons("0 g 1 G 1 Tr BT /F1 12 Tf 20 100 Td (Saburo) Tj ET")).toEqual(["same_color:6"]);
  });
});

describe("3. 1文字ずつ別の命令で置いた白い字を、1件にまとめる", () => {
  // Helvetica の幅：T 611・a 556・r 333・o 556（12 ポイントで 7.332・6.672・3.996・6.672）
  const perChar = (y = 100) => `1 g BT /F1 12 Tf 20 ${y} Td (T) Tj 7.332 0 Td (a) Tj 6.672 0 Td (r) Tj 3.996 0 Td (o) Tj ET`;

  it("同じ行で隣り合う字は、命令をまたいで1件", async () => {
    expect(await reasons(perChar())).toEqual(["same_color:4"]);
  });

  it("BT … ET を字ごとに分けて Tm で置いても1件", async () => {
    const c = "1 g " + [["T", 20], ["a", 27.332], ["r", 34.004], ["o", 38]].map(([ch, x]) => `BT /F1 12 Tf 1 0 0 1 ${x} 100 Tm (${ch}) Tj ET`).join(" ");
    expect(await reasons(c)).toEqual(["same_color:4"]);
  });

  it("対照：同じ行でも大きく離れた2語、別の行の2語は、別の件のまま", async () => {
    expect(await reasons("1 g BT /F1 12 Tf 20 100 Td (Taro) Tj 150 0 Td (Jiro) Tj ET")).toEqual(["same_color:4", "same_color:4"]);
    expect(await reasons(`${perChar(100)} ${perChar(60)}`)).toEqual(["same_color:4", "same_color:4"]);
  });

  it("対照：間に見える字があれば、まとめない", async () => {
    expect(await reasons("BT /F1 12 Tf 1 g 20 100 Td (T) Tj 0 g 7.332 0 Td (a) Tj 1 g 6.672 0 Td (r) Tj ET")).toEqual(["same_color:1", "same_color:1"]);
  });
});

describe("4. 字を描いたあと、画像で覆った字（covered_image）", () => {
  const text = "0 g BT /F1 12 Tf 20 100 Td (Shiro Kato) Tj ET";
  const cover = "q 280 0 0 40 10 90 cm /Im1 Do Q";

  it("明るい画像（灰色）で覆った字は covered_image", async () => {
    expect(await reasons(`${text} ${cover}`, { images: { Im1: uniform(200) } })).toEqual(["covered_image:9"]);
  });

  it("このルールで解けない画像（JPEG）で覆った字も covered_image", async () => {
    expect(await reasons(`${text} ${cover}`, { images: { Im1: { ...uniform(200), filter: "DCTDecode" } } })).toEqual(["covered_image:9"]);
  });

  it("ほぼ全部が黒い画像で覆った字は P6 で数え、P7 では返さない", async () => {
    const r = await run(`${text} ${cover}`, { images: { Im1: uniform(0) } });
    expect(r.findings).toEqual([]);
    expect(r.excluded.p6).toBe(9);
  });

  it("対照：やわらかい型抜き（SMask）のある画像・半透明で置いた画像は覆いにしない", async () => {
    expect(await reasons(`${text} ${cover}`, { images: { Im1: { ...uniform(200), smask: true } } })).toEqual([]);
    const gs = { extgstate: { GS1: { Type: "ExtGState", ca: 0.3 } } };
    expect(await reasons(`${text} q /GS1 gs 280 0 0 40 10 90 cm /Im1 Do Q`, { images: { Im1: uniform(200) }, ...gs })).toEqual([]);
  });

  it("対照：スキャン＋文字認識の層（画像が先、見えない字があと）は、これまでどおり数えない", async () => {
    const r = await run(`q 300 0 0 200 0 0 cm /Im1 Do Q 3 Tr BT /F1 12 Tf 20 100 Td (Shiro Kato) Tj ET`, { images: { Im1: checker() } });
    expect(r.findings).toEqual([]);
    expect(r.excluded.ocrLayer).toBe(9);
  });

  it("対照：文字認識の層を先に書き、あとから画像を重ねた（順番が逆の道具）も数えない", async () => {
    const r = await run(`3 Tr BT /F1 12 Tf 20 100 Td (Shiro Kato) Tj ET q 300 0 0 200 0 0 cm /Im1 Do Q`, { images: { Im1: checker() } });
    expect(r.findings).toEqual([]);
    expect(r.excluded.ocrLayer).toBe(9);
  });

  it("対照：画像の上に、あとから見える字を書いたものは返さない", async () => {
    expect(await reasons(`q 300 0 0 200 0 0 cm /Im1 Do Q ${text}`, { images: { Im1: uniform(230) } })).toEqual([]);
  });
});

describe("23. 画像と同じ色の字（same_color_image）", () => {
  const under = "q 300 0 0 200 0 0 cm /Im1 Do Q";

  it("灰色（128）の画像の上の、同じ灰色（0.5）の字は same_color_image", async () => {
    expect(await reasons(`${under} 0.5 g BT /F1 12 Tf 20 100 Td (Goro Sato) Tj ET`, { images: { Im1: uniform(128) } })).toEqual(["same_color_image:8"]);
  });

  it("白い画像の上の白い字も same_color_image", async () => {
    expect(await reasons(`${under} 1 g BT /F1 12 Tf 20 100 Td (Goro Sato) Tj ET`, { images: { Im1: uniform(255) } })).toEqual(["same_color_image:8"]);
  });

  it("対照：写真（明暗のまじった画像）の上の白い説明文は返さない", async () => {
    expect(await reasons(`${under} 1 g BT /F1 12 Tf 20 100 Td (Caption text) Tj ET`, { images: { Im1: checker() } })).toEqual([]);
  });

  it("対照：暗い画像の上の白い字、明るい画像の上の黒い字は返さない", async () => {
    expect(await reasons(`${under} 1 g BT /F1 12 Tf 20 100 Td (Caption) Tj ET`, { images: { Im1: uniform(30) } })).toEqual([]);
    expect(await reasons(`${under} 0 g BT /F1 12 Tf 20 100 Td (Caption) Tj ET`, { images: { Im1: uniform(240) } })).toEqual([]);
  });

  it("対照：解けない画像（JPEG）の上では、色を決めないので返さない", async () => {
    expect(await reasons(`${under} 1 g BT /F1 12 Tf 20 100 Td (Caption) Tj ET`, { images: { Im1: { ...uniform(255), filter: "DCTDecode" } } })).toEqual([]);
  });

  it("画像の一部だけが字と同じ色のとき：字の箱の所の画素で決める", async () => {
    // 上半分が白、下半分が黒の画像。字は下半分（黒の上）の白い字＝読める
    const half: ImageSpec = { w: 2, h: 2, pixels: [255, 255, 0, 0] };
    expect(await reasons(`${under} 1 g BT /F1 12 Tf 20 40 Td (Lower) Tj ET`, { images: { Im1: half } })).toEqual([]);
    expect(await reasons(`${under} 1 g BT /F1 12 Tf 20 150 Td (Upper) Tj ET`, { images: { Im1: half } })).toEqual(["same_color_image:5"]);
  });
});

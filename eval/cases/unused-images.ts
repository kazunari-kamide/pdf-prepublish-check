// SPDX-License-Identifier: AGPL-3.0-only
//
// 描かれていない資源に残る画像（unused-images）の合成 PDF。鍵は「比べた結果」（similar・different・no_same_size・identical など）。
// 画像は灰色の小さな画素の並び（架空の模様）。墨消しした所だけ黒い、元の画像との組みを作る。

import { PDFName, type PDFContext, type PDFPage, type PDFRef } from "pdf-lib";
import type { UnusedImageReport } from "../../rules/unused-images/index.ts";
import { newDoc, save, type Case } from "./pdf.ts";

export const keysOf = (r: UnusedImageReport) => r.findings.map((f) => f.match);

const W = 40;
const H = 30;

/** 灰色の模様。black の範囲（x0,y0,x1,y1）だけ黒くする */
function pattern(black?: [number, number, number, number], seed = 0): Uint8Array {
  const px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = 120 + ((x * 7 + y * 13 + seed) % 100);
  if (black) for (let y = black[1]; y < black[3]; y++) for (let x = black[0]; x < black[2]; x++) px[y * W + x] = 0;
  return px;
}

function image(ctx: PDFContext, px: Uint8Array, w = W, h = H): PDFRef {
  return ctx.register(ctx.flateStream(px, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
}

/** ページの資源に画像を名前つきで並べ、draw の名前だけを描く */
function place(ctx: PDFContext, page: PDFPage, images: Record<string, PDFRef>, draw: string[]) {
  page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: ctx.obj(images as never) } as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(draw.map((n) => `q 120 0 0 90 20 20 cm /${n} Do Q`).join("\n"))));
}

export const CASES: Case[] = [
  {
    id: "ui-l01",
    kind: "leak",
    description: "墨消しを適用したあとの画像（一部だけ黒い）を描き、塗る前の元の画像が、描かれないまま資源に残る（違う点は 1% ほど）",
    leaks: ["similar"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      place(ctx, pages[0]!, { Im1: image(ctx, pattern([10, 10, 16, 12])), Im0: image(ctx, pattern()) }, ["Im1"]);
      return save(doc);
    },
  },
  {
    id: "ui-l02",
    kind: "leak",
    description: "描かれた部品（フォーム XObject）の資源に、描かれない元の画像が残る",
    leaks: ["similar"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const res = ctx.obj({ XObject: ctx.obj({ Im1: image(ctx, pattern([5, 5, 12, 8])), Im0: image(ctx, pattern()) } as never) } as never);
      const form = ctx.register(ctx.stream("q 120 0 0 90 0 0 cm /Im1 Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 200], Resources: res }));
      pages[0]!.node.set(PDFName.of("Resources"), ctx.obj({ XObject: ctx.obj({ Fm1: form } as never) } as never));
      pages[0]!.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("/Fm1 Do")));
      return save(doc);
    },
  },
  {
    id: "ui-l03",
    kind: "leak",
    description: "描かれない画像が、描かれた画像と大きさが違う（元の画像とは言えないので低）",
    leaks: ["no_same_size"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      place(ctx, pages[0]!, { Im1: image(ctx, pattern()), Im2: image(ctx, new Uint8Array(10 * 10).fill(200), 10, 10) }, ["Im1"]);
      return save(doc);
    },
  },
  {
    id: "ui-c01",
    kind: "control",
    description: "資源の画像を全部描いている",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      place(ctx, pages[0]!, { Im1: image(ctx, pattern()), Im2: image(ctx, pattern(undefined, 5)) }, ["Im1", "Im2"]);
      return save(doc);
    },
  },
  {
    id: "ui-c02",
    kind: "control",
    description: "2 ページで資源の辞書を共有し、それぞれのページが別の画像を描く（ほかのページで描く画像は、描かれないとみなさない）",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc(2);
      const res = ctx.obj({ XObject: ctx.obj({ Im1: image(ctx, pattern()), Im2: image(ctx, pattern([1, 1, 3, 3])) } as never) } as never);
      pages.forEach((p, i) => {
        p.node.set(PDFName.of("Resources"), res);
        p.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(`q 120 0 0 90 20 20 cm /Im${i + 1} Do Q`)));
      });
      return save(doc);
    },
  },
];

// SPDX-License-Identifier: AGPL-3.0-only
//
// 見えない所に置いた画像（P7 `p7-hidden` の image_off_page・image_clipped）の合成 PDF（1.4.0 から）。
// 見つける段の3回目で見逃した型：画像の大部分（7 割ほど）がページの外にはみ出し、見えない所に元の画像が残る。
// 鍵は P7 の理由（image_off_page・image_clipped）。画像は灰色の模様（架空）。字は描かない。

import { PDFDocument, PDFName, type PDFContext, type PDFRef } from "pdf-lib";
import { detectP7Hidden, type P7Report } from "../../rules/p7-hidden/index.ts";
import { save, type Case } from "./pdf.ts";

export const keysOf = (r: P7Report) => r.findings.filter((f) => f.reason === "image_off_page" || f.reason === "image_clipped").map((f) => f.reason);
export const detect = (b: Uint8Array) => detectP7Hidden(b);

const W = 64;
const H = 40;
/** 縦長のページ（A3 の縦を縮めた形。幅 300・高さ 424） */
const PAGE: [number, number] = [300, 424];

/** 灰色の模様（ばらつきのある画素）。uniform なら一色 */
function pixels(uniform?: number): Uint8Array {
  const px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = uniform ?? 40 + ((x * 11 + y * 17) % 180);
  return px;
}

function image(ctx: PDFContext, px: Uint8Array, filter?: string): PDFRef {
  const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceGray", BitsPerComponent: 8 };
  if (filter) {
    dict.Filter = filter;
    return ctx.register(ctx.stream(px, dict as never));
  }
  return ctx.register(ctx.flateStream(px, dict as never));
}

/**
 * 幅 240・高さ 150 の画像の箱を、左端 x に置く。ページの中に入る割合は (300 - x) / 240。
 * inForm なら、フォーム XObject の中で描く
 */
async function build(x: number, opts: { uniform?: number; filter?: string; inForm?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage(PAGE);
  const im = image(ctx, opts.filter ? new Uint8Array([0xff, 0xd8, 0xff, 0x00]) : pixels(opts.uniform), opts.filter);
  const draw = `q 240 0 0 150 ${x} 200 cm /Im1 Do Q`;
  if (opts.inForm) {
    const form = ctx.register(
      ctx.stream(draw, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 600, 424], Resources: ctx.obj({ XObject: ctx.obj({ Im1: im } as never) } as never) } as never),
    );
    page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: ctx.obj({ Fm1: form } as never) } as never));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("q /Fm1 Do Q")));
  } else {
    page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: ctx.obj({ Im1: im } as never) } as never));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(draw)));
  }
  return save(doc);
}

export const CASES: Case[] = [
  {
    id: "p7i-l01",
    kind: "leak",
    description: "画像の 69% がページの右の外にはみ出し、ページの中は 31%（見つける段の3回目の形。1.3.0 までは 25% の線で見逃した）",
    leaks: ["image_off_page"],
    build: () => build(226),
  },
  {
    id: "p7i-l02",
    kind: "leak",
    description: "l01 と同じ置き方を、フォーム XObject の中で描く",
    leaks: ["image_off_page"],
    build: () => build(226, { inForm: true }),
  },
  {
    id: "p7i-l03",
    kind: "leak",
    description: "ページの中が 45%（0.5 の線のすぐ内側）",
    leaks: ["image_off_page"],
    build: () => build(192),
  },
  {
    id: "p7i-l04",
    kind: "leak",
    description: "ページの中が 31% で、画素を読めない画像（JPEG）。見えない所が一色か分からないので出す",
    leaks: ["image_off_page"],
    build: () => build(226, { filter: "DCTDecode" }),
  },
  {
    id: "p7i-l05",
    kind: "leak",
    description: "ページの中が 20%（1.3.0 から見つけていた幅。画素を見ずに出す）",
    leaks: ["image_off_page"],
    build: () => build(252),
  },
  {
    id: "p7i-c01",
    kind: "control",
    description: "ページの中が 72%（同じ文書の別のページの形。ふちがはみ出しただけ）",
    leaks: [],
    build: () => build(127),
  },
  {
    id: "p7i-c02",
    kind: "control",
    description: "ページの中が 31% だが、画像は一色（はみ出した所に何も写っていない背景）",
    leaks: [],
    build: () => build(226, { uniform: 235 }),
  },
  {
    id: "p7i-c03",
    kind: "control",
    description: "画像がすっかりページの中にある",
    leaks: [],
    build: () => build(30),
  },
];

// SPDX-License-Identifier: AGPL-3.0-only
//
// 見ないで作るテスト集（eval:blind）で落ちた型を直したもののテスト（2026-11-05）。
// 型ごとに、隠しのある合成 PDF と、何も隠していない対照の両方を、テストの中で作る。名前・番号はすべて架空。
//
// - P6 1.11.0：覆いの下の字は、色によらず P6（白・灰・色の塗り、型抜きのない画像、白い四角の注釈）。黒い蛍光ペンの注釈。縦書きの字の箱
// - P7 1.2.0：ページの外・切り抜きで大部分を隠した画像。画面では、覆いの下の字（covered_light・covered_image）を P7 に出さない
// - P5 1.3.0：資源にあるが描かれない部品。画面の「片付けで消せる残り」は、骨組みだけなら出さない
// - extras 1.1.0：縮小画像を、いまのページとおおまかに比べる
// - alt-text 1.1.0：ページに描いた字と同じ、しおりの題・読み上げ用の説明は数えない
// - 画面：文字認識の層のお知らせ（info）は、調べきれなかった所に数えない

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFHexString, PDFName, PDFString, type PDFRef } from "pdf-lib";
import { detectP6Text } from "../rules/p6-text/index.ts";
import { detectP7Hidden } from "../rules/p7-hidden/index.ts";
import { detectP5Revisions } from "../rules/p5-revisions/index.ts";
import { detectExtras } from "../rules/extras/index.ts";
import { detectAltText } from "../rules/alt-text/index.ts";
import { RULES } from "../src/inspect/rules.ts";
import { buildView } from "../src/ui/model.ts";
import type { InspectSummary, RuleResult } from "../src/inspect/report.ts";

type ImageSpec = { w: number; h: number; pixels?: number[]; fill?: number; filter?: string; smask?: boolean; raw?: Uint8Array };
type Opt = {
  images?: Record<string, ImageSpec>;
  forms?: Record<string, string>;
  extgstate?: Record<string, Record<string, unknown>>;
  annots?: Array<Record<string, unknown> & { ap?: string }>;
  vertical?: boolean;
  thumb?: { w: number; h: number; pixels: number[] };
  outlines?: string[];
  alt?: string[];
  size?: [number, number];
};

async function makePdf(content: string, o: Opt = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage(o.size ?? [300, 200]);
  const fonts: Record<string, PDFRef> = { F1: ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" })) };
  if (o.vertical) {
    const cmap = ctx.register(
      ctx.stream(
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T def 1 begincodespacerange <0000> <FFFF> endcodespacerange 3 beginbfchar <0001> <0041> <0002> <0042> <0003> <0043> endbfchar endcmap end end",
      ),
    );
    const cid = ctx.register(ctx.obj({ Type: "Font", Subtype: "CIDFontType2", BaseFont: "KasouMincho", CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 }, DW: 1000 }));
    fonts.F2 = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "KasouMincho", Encoding: "Identity-V", DescendantFonts: [cid], ToUnicode: cmap }));
  }
  const res: Record<string, unknown> = { Font: fonts };
  const xo: Record<string, PDFRef> = {};
  for (const [name, im] of Object.entries(o.images ?? {})) {
    const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Image", Width: im.w, Height: im.h, ColorSpace: "DeviceGray", BitsPerComponent: 8 };
    if (im.filter) dict.Filter = im.filter;
    if (im.smask) {
      dict.SMask = ctx.register(ctx.stream(new Uint8Array(im.w * im.h).fill(128), { Type: "XObject", Subtype: "Image", Width: im.w, Height: im.h, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
    }
    const data = im.raw ?? new Uint8Array(im.pixels ?? new Array(im.w * im.h).fill(im.fill ?? 0));
    xo[name] = ctx.register(ctx.stream(data, dict as never));
  }
  for (const [name, body] of Object.entries(o.forms ?? {})) {
    xo[name] = ctx.register(ctx.stream(body, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 200], Resources: { Font: fonts } } as never));
  }
  if (Object.keys(xo).length) res.XObject = xo;
  if (o.extgstate) res.ExtGState = o.extgstate;
  page.node.set(PDFName.of("Resources"), ctx.obj(res as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  if (o.annots) {
    const refs = o.annots.map(({ ap, ...a }) => {
      const d: Record<string, unknown> = { Type: "Annot", F: 4, ...a };
      if (ap) d.AP = { N: ctx.register(ctx.stream(ap, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 20] } as never)) };
      return ctx.register(ctx.obj(d as never));
    });
    page.node.set(PDFName.of("Annots"), ctx.obj(refs));
  }
  if (o.thumb) {
    page.node.set(PDFName.of("Thumb"), ctx.register(ctx.stream(new Uint8Array(o.thumb.pixels), { Width: o.thumb.w, Height: o.thumb.h, ColorSpace: "DeviceGray", BitsPerComponent: 8 } as never)));
  }
  if (o.outlines) {
    const outlineRoot = ctx.nextRef();
    const items = o.outlines.map(() => ctx.nextRef());
    o.outlines.forEach((t, i) => {
      const d: Record<string, unknown> = { Title: PDFHexString.fromText(t), Parent: outlineRoot };
      if (i > 0) d.Prev = items[i - 1];
      if (i + 1 < items.length) d.Next = items[i + 1];
      ctx.assign(items[i]!, ctx.obj(d as never));
    });
    ctx.assign(outlineRoot, ctx.obj({ Type: "Outlines", First: items[0], Last: items.at(-1), Count: items.length } as never));
    doc.catalog.set(PDFName.of("Outlines"), outlineRoot);
  }
  if (o.alt) {
    const elems = o.alt.map((a) => ctx.register(ctx.obj({ Type: "StructElem", S: "Figure", Alt: PDFHexString.fromText(a) } as never)));
    doc.catalog.set(PDFName.of("StructTreeRoot"), ctx.register(ctx.obj({ Type: "StructTreeRoot", K: elems } as never)));
  }
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

const NAME = "BT /F1 12 Tf 20 100 Td (Taro Yamada) Tj ET";
const p6 = async (content: string, o?: Opt) => {
  const r = await detectP6Text(await makePdf(content, o));
  expect(r.status).toBe("ok");
  return r.findings.map((f) => (f.layer === "text" ? `${f.cover}/${f.coverTone ?? "dark"}/${f.confidence}/${f.chars}` : `image:${f.cover}`));
};

describe("P6 1.11.0：覆いの下の字は、色によらず P6", () => {
  it("白・灰・赤・青の不透明な四角の下の字を見つける（濃くない覆い）", async () => {
    // 赤・青の原色は明るさ 0.35 以下なので、これまでどおり濃い覆い。白・灰・薄い色は、濃くない覆い
    const cases: Array<[string, string]> = [["1 g", "opaque"], ["0.5 g", "opaque"], ["0 0 0 0 k", "opaque"], ["1 0.6 0.6 rg", "opaque"], ["1 0 0 rg", "dark"], ["0 0 1 rg", "dark"]];
    for (const [color, tone] of cases) {
      expect(await p6(`${NAME} q ${color} 15 95 120 20 re f Q`)).toEqual([`fill/${tone}/high/10`]);
    }
  });

  it("黒い覆いは、これまでどおり濃い覆いとして出す（coverTone は付けない）", async () => {
    expect(await p6(`${NAME} q 0 g 15 95 120 20 re f Q`)).toEqual(["fill/dark/high/10"]);
  });

  it("白い四角の上に別の見える字を描いた形は「確かめてください」", async () => {
    expect(await p6(`${NAME} q 1 g 15 95 120 20 re f Q BT /F1 12 Tf 20 100 Td (Example) Tj ET`)).toEqual(["fill/opaque/check/10"]);
  });

  it("対照：字を四角のあとに描いた・字のない所の四角・半透明・乗算の四角は出さない", async () => {
    expect(await p6(`q 1 0.9 0.2 rg 15 95 120 20 re f Q ${NAME}`)).toEqual([]);
    expect(await p6(`${NAME} q 1 g 150 20 100 20 re f Q`)).toEqual([]);
    expect(await p6(`${NAME} q /A gs 1 0.9 0.2 rg 15 95 120 20 re f Q`, { extgstate: { A: { ca: 0.35 } } })).toEqual([]);
    expect(await p6(`${NAME} q /M gs 1 0.9 0.2 rg 15 95 120 20 re f Q`, { extgstate: { M: { BM: PDFName.of("Multiply") } } })).toEqual([]);
    expect(await p6(`${NAME} q /M gs 1 0.9 0.2 rg 15 95 120 20 re f Q`, { extgstate: { M: { BM: [PDFName.of("Multiply")] } } })).toEqual([]);
  });

  it("型抜きのない画像は、色や、解けるかどうかにかかわらず覆いにする", async () => {
    const photo = { w: 8, h: 8, pixels: Array.from({ length: 64 }, (_, i) => (i % 3 ? 220 : 40)) };
    expect(await p6(`${NAME} q 120 0 0 20 15 95 cm /Im1 Do Q`, { images: { Im1: photo } })).toEqual(["image/opaque/high/10"]);
    const jpeg = { w: 4, h: 4, filter: "DCTDecode", raw: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) };
    expect(await p6(`${NAME} q 120 0 0 20 15 95 cm /Im1 Do Q`, { images: { Im1: jpeg } })).toEqual(["image/opaque/high/10"]);
  });

  it("対照：やわらかい型抜き（SMask）のある画像、文字認識の層（描き方 3）の上の画像は出さない", async () => {
    expect(await p6(`${NAME} q 120 0 0 20 15 95 cm /Im1 Do Q`, { images: { Im1: { w: 4, h: 4, fill: 200, smask: true } } })).toEqual([]);
    expect(await p6(`BT /F1 12 Tf 3 Tr 20 100 Td (Taro Yamada) Tj ET q 120 0 0 20 15 95 cm /Im1 Do Q`, { images: { Im1: { w: 4, h: 4, fill: 200 } } })).toEqual([]);
    expect(await p6(`q 120 0 0 20 15 95 cm /Im1 Do Q BT /F1 12 Tf 3 Tr 20 100 Td (Taro Yamada) Tj ET`, { images: { Im1: { w: 4, h: 4, fill: 200 } } })).toEqual([]);
  });

  it("文字認識の層の字でも、黒い覆いの下ならこれまでどおり出す", async () => {
    expect(await p6(`BT /F1 12 Tf 3 Tr 20 100 Td (Taro Yamada) Tj ET q 0 g 15 95 120 20 re f Q`)).toEqual(["fill/dark/high/10"]);
  });

  it("白く塗った四角の注釈（見た目あり・見た目なし）の下の字を見つける。字のない所の注釈は出さない", async () => {
    expect(await p6(NAME, { annots: [{ Subtype: "Square", Rect: [15, 95, 135, 115], IC: [1, 1, 1], ap: "1 g 0 0 100 20 re f" }] })).toEqual(["annotation/opaque/high/10"]);
    expect(await p6(NAME, { annots: [{ Subtype: "Square", Rect: [15, 95, 135, 115], IC: [1, 1, 1] }] })).toEqual(["annotation/opaque/high/10"]);
    expect(await p6(NAME, { annots: [{ Subtype: "Square", Rect: [150, 20, 250, 40], IC: [1, 1, 1], ap: "1 g 0 0 100 20 re f" }] })).toEqual([]);
  });

  it("黒い蛍光ペンの注釈（見た目なし）の下の字を見つける。黄色の蛍光ペンは出さない", async () => {
    const quad = [15, 115, 135, 115, 15, 95, 135, 95];
    expect(await p6(NAME, { annots: [{ Subtype: "Highlight", Rect: [15, 95, 135, 115], QuadPoints: quad, C: [0, 0, 0] }] })).toEqual(["annotation/dark/high/10"]);
    expect(await p6(NAME, { annots: [{ Subtype: "Highlight", Rect: [15, 95, 135, 115], QuadPoints: quad, C: [1, 1, 0] }] })).toEqual([]);
  });

  it("縦書き（Identity-V）の字は、原点から下へ並ぶ箱で測る。横の四角は重ならない", async () => {
    const v = "BT /F2 12 Tf 150 180 Td <000100020003000100020003> Tj ET";
    expect(await p6(`${v} q 0 g 142 100 16 80 re f Q`, { vertical: true })).toEqual(["fill/dark/high/6"]);
    expect(await p6(`${v} q 0 g 170 100 16 80 re f Q`, { vertical: true })).toEqual([]);
  });
});

describe("P7 1.2.0：見えない所に置いた画像", () => {
  const img = { Im1: { w: 40, h: 40, fill: 128 } };
  const reasons = async (content: string, o?: Opt) => (await detectP7Hidden(await makePdf(content, o))).findings.map((f) => f.reason);

  it("ページの外に置いた画像は image_off_page", async () => {
    expect(await reasons("q 100 0 0 50 400 50 cm /Im1 Do Q", { images: img })).toEqual(["image_off_page"]);
  });

  it("切り抜きで、見えるのが 2 割ほどの画像は image_clipped。切り抜きの外にすっかり出た画像も image_clipped", async () => {
    expect(await reasons("q 20 20 20 50 re W n q 100 0 0 50 20 20 cm /Im1 Do Q Q", { images: img })).toEqual(["image_clipped"]);
    expect(await reasons("q 200 150 20 20 re W n q 100 0 0 50 20 20 cm /Im1 Do Q Q", { images: img })).toEqual(["image_clipped"]);
  });

  it("対照：ページの中の画像、ふちを落としただけの切り抜き、小さな画像、型抜きの画像は出さない", async () => {
    expect(await reasons("q 100 0 0 50 20 20 cm /Im1 Do Q", { images: img })).toEqual([]);
    expect(await reasons("q 25 25 90 40 re W n q 100 0 0 50 20 20 cm /Im1 Do Q Q", { images: img })).toEqual([]);
    expect(await reasons("q 100 0 0 50 400 50 cm /Im1 Do Q", { images: { Im1: { w: 8, h: 8, fill: 128 } } })).toEqual([]);
  });
});

describe("画面（RULES）：覆いの下の字は P6 に出し、P7 には出さない", () => {
  const run = async (bytes: Uint8Array) => {
    const out: string[] = [];
    for (const rule of RULES.filter((r) => r.id === "p6-text" || r.id === "p7-hidden")) {
      const r = await rule.run(bytes.slice());
      for (const it of r.items) out.push(it.pattern);
    }
    return out;
  };

  it("白い四角の下の字は、P6 の1件だけ", async () => {
    expect(await run(await makePdf(`${NAME} q 1 g 15 95 120 20 re f Q`))).toEqual(["P6"]);
  });

  it("あとから重ねた灰色の画像の下の字も、P6 の1件だけ", async () => {
    expect(await run(await makePdf(`${NAME} q 120 0 0 20 15 95 cm /Im1 Do Q`, { images: { Im1: { w: 4, h: 4, fill: 128 } } }))).toEqual(["P6"]);
  });

  it("白い字（背景と同じ色）は、これまでどおり P7", async () => {
    expect(await run(await makePdf("1 g BT /F1 12 Tf 20 100 Td (Taro Yamada) Tj ET"))).toEqual(["P7"]);
  });
});

describe("P5 1.3.0：資源にあるが描かれない部品", () => {
  const FORM = "BT /F1 12 Tf 20 100 Td (Taro Yamada) Tj ET";
  const kinds = async (content: string, o?: Opt) => (await detectP5Revisions(await makePdf(content, o))).findings.map((f) => `${f.kind}:${f.where}`);

  it("資源にあるが Do で呼ばれない、字の入った部品は unused_form", async () => {
    expect(await kinds("BT /F1 12 Tf 20 150 Td (Report) Tj ET", { forms: { Fm1: FORM } })).toEqual(["unused_form:unreferenced"]);
  });

  it("対照：Do で呼ぶ部品、部品の中から呼ぶ部品、字のない部品は出さない", async () => {
    expect(await kinds("/Fm1 Do", { forms: { Fm1: FORM } })).toEqual([]);
    expect(await kinds("q 0 g 0 0 10 10 re f Q", { forms: { Fm1: "0 g 0 0 10 10 re f" } })).toEqual([]);
  });

  it("どの xref にも載らない（%%EOF のあとに足した）字の入った辞書は dict_text。空白だけの足し物は出さない", async () => {
    const base = await makePdf(NAME);
    const tail = new TextEncoder().encode("\n99 0 obj\n<< /Note (old draft Taro Yamada) >>\nendobj\n");
    const leak = new Uint8Array([...base, ...tail]);
    expect((await detectP5Revisions(leak)).findings.map((f) => `${f.kind}:${f.where}`)).toEqual(["dict_text:orphan"]);
    const blank = new Uint8Array([...base, ...new TextEncoder().encode("\n   \n")]);
    expect((await detectP5Revisions(blank)).findings).toEqual([]);
  });

  it("画面：骨組み（そのほかの部品）だけの「片付けで消せる残り」は出さない", async () => {
    const p5rule = RULES.find((r) => r.id === "p5-revisions")!;
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([100, 100]);
    doc.context.register(doc.context.obj(null as never)); // どこからも指されていない null
    doc.context.register(doc.context.obj({ Type: "Pages", Kids: [], Count: 0 } as never)); // どこからも指されていないページの木
    const r = await p5rule.run(new Uint8Array(await doc.save({ useObjectStreams: false })));
    expect(r.items).toEqual([]);
    expect(r.notices).toEqual([]);
  });
});

describe("extras 1.1.0：縮小画像を、いまのページと比べる", () => {
  // ページ 300×200 に、上半分が黒・下半分が白の画像を全面に置く。縮小画像は 30×20
  const half = Array.from({ length: 30 * 20 }, (_, i) => (Math.floor(i / 30) < 10 ? 0 : 255));
  const page = "q 300 0 0 200 0 0 cm /Im1 Do Q";
  const images = { Im1: { w: 30, h: 20, pixels: half } };

  it("ページを縮めた縮小画像は same（画面に出さない）", async () => {
    const r = await detectExtras(await makePdf(page, { images, thumb: { w: 30, h: 20, pixels: half } }));
    expect(r.thumbnails.map((t) => t.compare)).toEqual(["same"]);
    const rule = RULES.find((x) => x.id === "extras")!;
    const out = await rule.run(await makePdf(page, { images, thumb: { w: 30, h: 20, pixels: half } }));
    expect(out.items).toEqual([]);
  });

  it("いまのページにない濃淡のある縮小画像は differs（画面では「高」）", async () => {
    const old = half.map((_, i) => (Math.floor(i / 30) < 10 ? 0 : i % 30 > 5 && i % 30 < 25 && Math.floor(i / 30) === 15 ? 0 : 255));
    const r = await detectExtras(await makePdf(page, { images, thumb: { w: 30, h: 20, pixels: old } }));
    expect(r.thumbnails.map((t) => t.compare)).toEqual(["differs"]);
    const rule = RULES.find((x) => x.id === "extras")!;
    const out = await rule.run(await makePdf(page, { images, thumb: { w: 30, h: 20, pixels: old } }));
    expect(out.items.map((i) => i.severity)).toEqual(["high"]);
  });

  it("比べられない（部品を描くページ）ときは unknown（これまでどおり「低」）", async () => {
    const r = await detectExtras(await makePdf("/Fm1 Do", { forms: { Fm1: "0 g 0 0 10 10 re f" }, thumb: { w: 30, h: 20, pixels: half } }));
    expect(r.thumbnails.map((t) => t.compare)).toEqual(["unknown"]);
  });
});

describe("alt-text 1.1.0：ページに描いた字と同じ題・説明は数えない", () => {
  it("見出しと同じしおりの題は数えず、本文にない題だけを数える", async () => {
    const r = await detectAltText(await makePdf("BT /F1 12 Tf 20 150 Td (Chapter One) Tj ET", { outlines: ["Chapter One", "Hanako Kasou 000-0000"] }));
    expect(r.findings).toMatchObject([{ kind: "outline", count: 1 }]);
    expect(r.notCounted.inBody).toBe(1);
  });

  it("構造要素の題（/T）・略語の展開（/E）も、本文にないものを数える", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const page = doc.addPage([300, 200]);
    page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" })) } } as never));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("BT /F1 12 Tf 20 150 Td (Figure 1) Tj ET")));
    const el = ctx.register(ctx.obj({ Type: "StructElem", S: "Figure", Alt: PDFHexString.fromText("Figure 1"), T: PDFHexString.fromText("Draft by Jiro Kasou"), E: PDFHexString.fromText("Jiro Kasou") } as never));
    doc.catalog.set(PDFName.of("StructTreeRoot"), ctx.register(ctx.obj({ Type: "StructTreeRoot", K: [el] } as never)));
    const r = await detectAltText(new Uint8Array(await doc.save({ useObjectStreams: false })));
    expect(r.findings).toMatchObject([{ kind: "alt", where: "structure", count: 2 }]);
    expect(r.notCounted.inBody).toBe(1);
  });

  it("図の見える説明と同じ /Alt は数えない", async () => {
    const r = await detectAltText(await makePdf("BT /F1 12 Tf 20 150 Td (Figure 1: Sample chart) Tj ET", { alt: ["Figure 1: Sample chart"] }));
    expect(r.findings).toEqual([]);
    const r2 = await detectAltText(await makePdf("BT /F1 12 Tf 20 150 Td (Figure 1: Sample chart) Tj ET", { alt: ["Taro Yamada, 1-2-3 Kasou town"] }));
    expect(r2.findings).toMatchObject([{ kind: "alt", where: "structure", count: 1 }]);
  });
});

describe("画面：文字認識の層のお知らせ", () => {
  it("スキャン画像の上の見えない字の層は、P7 のお知らせ（info）で知らせる。字だけの PDF には出さない", async () => {
    const p7rule = RULES.find((r) => r.id === "p7-hidden")!;
    const scan = await makePdf("q 300 0 0 200 0 0 cm /Im1 Do Q BT /F1 12 Tf 3 Tr 20 100 Td (Taro Yamada) Tj ET", { images: { Im1: { w: 30, h: 20, fill: 230 } } });
    const r = await p7rule.run(scan);
    expect(r.items).toEqual([]);
    expect(r.notices).toMatchObject([{ kind: "info", pages: [1] }]);
    expect((await p7rule.run(await makePdf(NAME))).notices).toEqual([]);
  });

  it("info のお知らせだけなら、調べきれなかった所には数えない（「全部緑」のまま）", () => {
    const rule: RuleResult = { ruleId: "p7-hidden", ruleVersion: "1", label: "隠れたテキスト", pattern: "P7", status: "ok", items: [], notices: [{ kind: "info", message: "文字認識の層があります。", pages: [1] }] };
    const summary: InspectSummary = { pages: [{ page: 1, view: [0, 0, 100, 100], rotate: 0 }], pagesUnreadable: false, rules: [rule] };
    const v = buildView(summary);
    expect(v.verdict).toBe("none");
    expect(v.notices).toEqual(["文字認識の層があります。（ページ 1）"]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 埋め込み画像・模様の覆いの型を足したもののテスト（P6 1.12.0・P7 1.3.0、2026-11-05）。
// 隠しのある合成 PDF と、何も隠していない対照（字のない所の埋め込み画像・字のない模様など）を、テストの中で作る。字はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, type PDFRef } from "pdf-lib";
import { detectP6Text } from "../rules/p6-text/index.ts";
import { detectP7Hidden } from "../rules/p7-hidden/index.ts";
import { operations } from "../rules/shared/content-lexer.ts";
import { RULES } from "../src/inspect/rules.ts";

type Pat = { tiling?: { body: string; xStep: number; yStep: number; bbox: number[]; paintType?: number; matrix?: number[] }; shading?: { c0: number[]; c1: number[]; cs?: string } };
type Opt = { patterns?: Record<string, Pat>; shadings?: Record<string, { c0: number[]; c1: number[]; bbox?: number[] }> };

async function makePdf(content: string, o: Opt = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const res: Record<string, unknown> = { Font: { F1: font } };
  const shadingObj = (c0: number[], c1: number[], cs = "DeviceGray", bbox?: number[]) =>
    ctx.obj({ ShadingType: 2, ColorSpace: cs, Coords: [0, 0, 300, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: c0, C1: c1, N: 1 }, Extend: [true, true], ...(bbox ? { BBox: bbox } : {}) } as never);
  if (o.patterns) {
    const pats: Record<string, PDFRef> = {};
    for (const [name, p] of Object.entries(o.patterns)) {
      if (p.tiling) {
        const t = p.tiling;
        pats[name] = ctx.register(
          ctx.stream(t.body, { Type: "Pattern", PatternType: 1, PaintType: t.paintType ?? 1, TilingType: 1, BBox: t.bbox, XStep: t.xStep, YStep: t.yStep, Resources: { Font: { F1: font } }, ...(t.matrix ? { Matrix: t.matrix } : {}) } as never),
        );
      } else if (p.shading) {
        pats[name] = ctx.register(ctx.obj({ Type: "Pattern", PatternType: 2, Shading: shadingObj(p.shading.c0, p.shading.c1, p.shading.cs) } as never));
      }
    }
    res.Pattern = pats;
  }
  if (o.shadings) {
    const sh: Record<string, unknown> = {};
    for (const [name, s] of Object.entries(o.shadings)) sh[name] = shadingObj(s.c0, s.c1, "DeviceGray", s.bbox);
    res.Shading = sh;
  }
  page.node.set(PDFName.of("Resources"), ctx.obj(res as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

const NAME = "BT /F1 12 Tf 20 100 Td (Taro Yamada) Tj ET";
/** 埋め込みの画像（4×4 の灰色。v は 0〜255）を、字の上（15,95 から 120×20）に置く命令 */
const inline = (v: number, at = "120 0 0 20 15 95") => {
  const hex = v.toString(16).padStart(2, "0").repeat(16);
  return `q ${at} cm BI /W 4 /H 4 /CS /G /BPC 8 /F /AHx ID ${hex}> EI Q`;
};
const p6 = async (content: string, o?: Opt) => {
  const r = await detectP6Text(await makePdf(content, o));
  expect(r.status).toBe("ok");
  return r.findings.map((f) => (f.layer === "text" ? `${f.cover}/${f.coverTone ?? "dark"}/${f.chars}` : `image:${f.cover}`));
};
const p7 = async (content: string, o?: Opt) => (await detectP7Hidden(await makePdf(content, o))).findings.map((f) => `${f.reason}:${f.chars}`);

describe("読み手：埋め込みの画像のバイト列も返す", () => {
  it("BI の引数は、辞書と画像のバイト列（EI の前の区切りの空白は含めない）", () => {
    const head = new TextEncoder().encode("BI /W 2 /H 1 /CS /G /BPC 8 ID ");
    const tail = new TextEncoder().encode(" EI 0 g");
    const ops = [...operations(new Uint8Array([...head, 0x00, 0xff, ...tail]))];
    expect(ops.map((o) => o.op)).toEqual(["BI", "g"]);
    const data = ops[0]!.args[1];
    expect(data?.t === "str" ? [...data.v] : null).toEqual([0, 0xff]);
  });
});

describe("P6 1.12.0：埋め込み画像の覆い", () => {
  it("字の上の黒い埋め込み画像は、外の画像と同じに濃い覆い", async () => {
    expect(await p6(`${NAME} ${inline(0)}`)).toEqual(["image/dark/10"]);
  });

  it("字の上の灰色の埋め込み画像は、濃くない覆い（覆いの下の字は色によらず P6）", async () => {
    expect(await p6(`${NAME} ${inline(128)}`)).toEqual(["image/opaque/10"]);
  });

  it("対照：字のない所の白い埋め込み画像、字の下に置いた白い埋め込み画像は出さない", async () => {
    expect(await p6(`${NAME} ${inline(255, "100 0 0 20 150 20")}`)).toEqual([]);
    expect(await p6(`${inline(255)} ${NAME}`)).toEqual([]);
  });

  it("対照：字の下に置いた黒い埋め込み画像（上に白い字）は出さない", async () => {
    expect(await p6(`${inline(0)} 1 g ${NAME}`)).toEqual([]);
  });
});

describe("P6 1.12.0：模様の覆い", () => {
  const solid = (g: number) => ({ tiling: { body: `${g} g 0 0 10 10 re f`, xStep: 10, yStep: 10, bbox: [0, 0, 10, 10] } });

  it("すき間なく塗るタイルの模様（黒）で塗った四角は、濃い覆い", async () => {
    expect(await p6(`${NAME} q /Pattern cs /P0 scn 15 95 120 20 re f Q`, { patterns: { P0: solid(0) } })).toEqual(["fill/dark/10"]);
  });

  it("すき間なく塗るタイルの模様（白）は、濃くない覆い", async () => {
    expect(await p6(`${NAME} q /Pattern cs /P0 scn 15 95 120 20 re f Q`, { patterns: { P0: solid(1) } })).toEqual(["fill/opaque/10"]);
  });

  it("色のないタイルの模様（PaintType 2）は、scn の色で決める", async () => {
    const p = { tiling: { body: "0 0 10 10 re f", xStep: 10, yStep: 10, bbox: [0, 0, 10, 10], paintType: 2 } };
    expect(await p6(`${NAME} q [/Pattern /DeviceGray] cs 0 /P0 scn 15 95 120 20 re f Q`, { patterns: { P0: p } })).toEqual(["fill/dark/10"]);
  });

  it("シェーディングの模様・sh で塗った所も覆い（切り抜きの中だけ）", async () => {
    expect(await p6(`${NAME} q /Pattern cs /P0 scn 15 95 120 20 re f Q`, { patterns: { P0: { shading: { c0: [0], c1: [0.2] } } } })).toEqual(["fill/dark/10"]);
    expect(await p6(`${NAME} q 15 95 120 20 re W n /S0 sh Q`, { shadings: { S0: { c0: [0], c1: [0.1] } } })).toEqual(["fill/dark/10"]);
    expect(await p6(`${NAME} q 15 95 120 20 re W n /S0 sh Q`, { shadings: { S0: { c0: [0.8], c1: [1] } } })).toEqual(["fill/opaque/10"]);
  });

  it("対照：細い斜線のような、すき間の多い模様は覆いにしない", async () => {
    const hatch = { tiling: { body: "0 g 0 0 10 2 re f", xStep: 10, yStep: 10, bbox: [0, 0, 10, 10] } };
    expect(await p6(`${NAME} q /Pattern cs /P0 scn 15 95 120 20 re f Q`, { patterns: { P0: hatch } })).toEqual([]);
  });

  it("対照：字のない所の模様、字の下に塗った模様、切り抜きのない sh は出さない", async () => {
    expect(await p6(`${NAME} q /Pattern cs /P0 scn 150 20 100 20 re f Q`, { patterns: { P0: solid(0) } })).toEqual([]);
    expect(await p6(`q /Pattern cs /P0 scn 15 95 120 20 re f Q 1 g ${NAME}`, { patterns: { P0: solid(0) } })).toEqual([]);
    expect(await p6(`${NAME} /S0 sh`, { shadings: { S0: { c0: [0], c1: [0.1] } } })).toEqual([]);
  });
});

describe("模様の中の字", () => {
  const withText = (color: string) => ({ tiling: { body: `1 g 0 0 150 30 re f ${color} BT /F1 12 Tf 5 10 Td (Hanako Kasou) Tj ET`, xStep: 150, yStep: 30, bbox: [0, 0, 150, 30] } });

  it("P6：字の入ったタイルの模様で塗った所に、あとから黒い四角を重ねると、タイルの中の字も見つける", async () => {
    const r = await p6(`q /Pattern cs /P0 scn 0 90 150 30 re f Q q 0 g 0 90 150 30 re f Q`, { patterns: { P0: withText("0 g") } });
    expect(r).toEqual(["fill/dark/11"]);
  });

  it("P7：タイルの中の、地と同じ白の字は「背景と同じ色の字」", async () => {
    expect(await p7(`q /Pattern cs /P0 scn 0 90 150 30 re f Q`, { patterns: { P0: withText("1 g") } })).toEqual(["same_color:11"]);
  });

  it("対照：タイルの中の見える字（黒）、字のない模様は P6・P7 とも出さない", async () => {
    expect(await p7(`q /Pattern cs /P0 scn 0 90 150 30 re f Q`, { patterns: { P0: withText("0 g") } })).toEqual([]);
    expect(await p6(`q /Pattern cs /P0 scn 0 90 150 30 re f Q`, { patterns: { P0: withText("0 g") } })).toEqual([]);
    const plain = { tiling: { body: "0.9 g 0 0 10 10 re f", xStep: 10, yStep: 10, bbox: [0, 0, 10, 10] } };
    expect(await p7(`q /Pattern cs /P0 scn 0 90 150 30 re f Q`, { patterns: { P0: plain } })).toEqual([]);
  });
});

describe("P7 1.3.0：埋め込み画像・模様", () => {
  it("灰色の埋め込み画像の上の、同じ灰色の字は「画像と同じ色の字」", async () => {
    expect(await p7(`${inline(128, "120 0 0 20 15 95")} 0.502 g ${NAME}`)).toEqual(["same_color_image:10"]);
  });

  it("対照：白い埋め込み画像の上の黒い字は出さない", async () => {
    expect(await p7(`${inline(255)} ${NAME}`)).toEqual([]);
  });

  it("画面：白い模様で覆った字は P6 の1件だけ（P7 には出さない）", async () => {
    const bytes = await makePdf(`${NAME} q /Pattern cs /P0 scn 15 95 120 20 re f Q`, { patterns: { P0: { tiling: { body: "1 g 0 0 10 10 re f", xStep: 10, yStep: 10, bbox: [0, 0, 10, 10] } } } });
    const out: string[] = [];
    for (const rule of RULES.filter((r) => r.id === "p6-text" || r.id === "p7-hidden")) out.push(...(await rule.run(bytes.slice())).items.map((i) => i.pattern));
    expect(out).toEqual(["P6"]);
  });
});

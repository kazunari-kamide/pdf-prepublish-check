// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P7 1.5.0：字の報告ごとに「読める本文か」（readable）を付け、画面の深刻度を決める（2026-11-05）。
// 実物の公開 PDF で、表の体裁・罫線・白い字の飾りのような、まとまって出る型が「高」で多く出た。
// その型と、本当に本文を隠した型を、テストの中で合成して比べる。字はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
import { detectP7Hidden } from "../rules/p7-hidden/index.ts";
import { RULES } from "../src/inspect/rules.ts";

const p7Rule = RULES.find((r) => r.id === "p7-hidden")!;

/** 1バイトの ToUnicode（bfchar だけ） */
function toUnicode(map: Array<[number, string]>): string {
  return [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CMapName /Test-UCS def /CMapType 2 def",
    "1 begincodespacerange <00> <FF> endcodespacerange",
    `${map.length} beginbfchar`,
    ...map.map(([c, s]) => `<${c.toString(16).toUpperCase().padStart(2, "0")}> <${s.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`),
    "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
}

/** 大文字を、3つ先の字として取り出させる対応表（見た目は A、取り出すと D） */
const SHIFTED: Array<[number, string]> = [...Array(26)].map((_, i) => [65 + i, String.fromCharCode(65 + ((i + 3) % 26))]);

/** ページを作る。F1 はふつうの Helvetica、F2 は取り出される字がずれた Helvetica */
async function makePdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const f1 = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const f2 = ctx.register(
    ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding", ToUnicode: ctx.register(ctx.stream(toUnicode(SHIFTED))) }),
  );
  for (const content of pages) {
    const page = doc.addPage([400, 300]);
    page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: f1, F2: f2 } }));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  }
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

const line = (x: number, y: number, s: string, font = "F1", color = "0 g") => `BT ${color} /${font} 10 Tf ${x} ${y} Td (${s}) Tj ET`;
const white = (x: number, y: number, s: string) => line(x, y, s, "F1", "1 g");
const VISIBLE = line(20, 280, "Kaigi no shiryo desu") + "\n";

async function run(bytes: Uint8Array) {
  const r = await detectP7Hidden(bytes);
  const ui = await p7Rule.run(bytes);
  return {
    found: r.findings.map((f) => `${f.reason}:${f.readable}`),
    severities: ui.items.map((i) => i.severity),
  };
}

describe("読める本文が隠れている（高）", () => {
  it("白い字で書いた1文（背景と同じ色）は、読める本文として「高」", async () => {
    const { found, severities } = await run(await makePdf([VISIBLE + white(20, 200, "Naibu memo: torihikisaki ni tsutaenai")]));
    expect(found).toEqual(["same_color:true"]);
    expect(severities).toEqual(["high"]);
  });

  it("白い字で隠した、4字の名前（日本語の人名の長さ）も「高」", async () => {
    const { found, severities } = await run(await makePdf([VISIBLE + white(20, 200, "Sato")]));
    expect(found).toEqual(["same_color:true"]);
    expect(severities).toEqual(["high"]);
  });

  it("ページの外に置いた1文は「高」", async () => {
    const { found, severities } = await run(await makePdf([VISIBLE + line(-600, 100, "Kesshita hazu no bunsho")]));
    expect(found).toEqual(["off_page:true"]);
    expect(severities).toEqual(["high"]);
  });

  it("ふつうの本文の中で、1語だけ取り出される字が違うなら「高」（書体の不具合ではない）", async () => {
    const page = [
      line(20, 260, "Kono bunsho wa futsuu no honbun desu"),
      line(20, 240, "Nichiji to basho wo kakunin shite kudasai"),
      line(20, 220, "Shusseki sha wa ika no toori desu"),
      line(20, 200, "KAKUSHIGOTOARI", "F2"),
    ].join("\n");
    const { found, severities } = await run(await makePdf([page]));
    expect(found).toEqual(["remapped:true"]);
    expect(severities).toEqual(["high"]);
  });
});

describe("まとまって出る型（中）", () => {
  it("白い罫線（下線の記号の並び）は、字がないので「中」", async () => {
    const { found, severities } = await run(await makePdf([VISIBLE + white(20, 200, "______________________________")]));
    expect(found).toEqual(["same_color:false"]);
    expect(severities).toEqual(["medium"]);
  });

  it("白い字の飾り（同じ字のくり返し・数字1つ・3字の番号）は「中」", async () => {
    const page = [white(20, 200, "xxxxxxxxxxxx"), white(20, 150, "0"), white(20, 100, "No1")].join("\n");
    const { found, severities } = await run(await makePdf([VISIBLE + page]));
    expect(found).toEqual(["same_color:false", "same_color:false", "same_color:false"]);
    expect(severities).toEqual(["medium", "medium", "medium"]);
  });

  it("表のセルごとに同じ型の白い字（数字だけ違う）が並ぶなら、表の体裁として「中」", async () => {
    const cells = [1200, 3400, 5600, 7800].map((n, i) => white(20, 250 - i * 30, `Kingaku ${n} en (zeikomi)`)).join("\n");
    const { found, severities } = await run(await makePdf([VISIBLE + cells]));
    expect(found).toEqual(Array(4).fill("same_color:false"));
    expect(severities).toEqual(Array(4).fill("medium"));
  });

  it("ページごとの欄外の字（ページの外。ページ番号だけ違う）は、くり返しの型として「中」", async () => {
    const slug = (n: number) => VISIBLE + line(-600, 100, `sakusei file shiryo.indd ${n}`);
    const { found, severities } = await run(await makePdf([slug(1), slug(2), slug(3)]));
    expect(found).toEqual(Array(3).fill("off_page:false"));
    expect(severities).toEqual(Array(3).fill("medium"));
  });

  it("ページの大部分の字が、取り出すと違う字になる（書体の対応表の不具合）なら「中」", async () => {
    const page = [line(20, 260, "KONOBUNSHOWAFUTSUU", "F2"), line(20, 240, "NICHIJITOBASHO", "F2"), line(20, 220, "abc")].join("\n");
    const { found, severities } = await run(await makePdf([page]));
    expect(found).toEqual(["remapped:false", "remapped:false"]);
    expect(severities).toEqual(["medium", "medium"]);
  });
});

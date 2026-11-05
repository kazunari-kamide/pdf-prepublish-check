// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする（sanitize/redact.ts）のテスト。合成 PDF（tests/helpers/redact-pdfs.ts。中身はすべて架空）を使う。
// 選んだ所の字・画素・注釈・フォームの欄が本当に消え、保存の前の読み直し（選んだ場所の確かめ・作品の検査・検証器 P6）で
// 残りが 0 件になることを確かめる。字が取れないことは、片付けと別の読み方（PDF.js の字の取り出し）でも確かめる。

import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, PDFString, decodePDFRawStream } from "pdf-lib";
import { redact, sanitizePdf, type RedactArea, type RedactResult } from "../sanitize/index.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";
import { allChecks } from "./helpers/redact-checks.ts";
import { appendRevision, buildPdf, hex, imageFlate, imageJpeg, latinAt, scanPixels, textAt } from "./helpers/redact-pdfs.ts";
import { HEAVY_TIMEOUT } from "./helpers/timeout.ts";

/** PDF.js で取り出せる字（ページごとにつなげたもの） */
async function textOf(bytes: Uint8Array): Promise<string[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    out.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(""));
  }
  await task.destroy();
  return out;
}

/** 片付けたファイルの、すべてのストリームを解いた中身（latin1 の文字列） */
async function allStreams(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let s = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      try {
        s += new TextDecoder("latin1").decode(decodePDFRawStream(obj).decode()) + "\n";
      } catch {
        /* 解けない画像など */
      }
    }
  }
  return s;
}

const run = (bytes: Uint8Array, areas: RedactArea[], opts = {}) => redact(bytes, areas, { checks: allChecks, ...opts });

function ok(r: RedactResult): asserts r is Extract<RedactResult, { status: "ok" }> {
  if (r.status !== "ok") throw new Error(`ok になりませんでした：${JSON.stringify(r.status === "blocked" ? r.leftovers : r)}`);
}
const kinds = (r: RedactResult) => (r.status === "error" ? [] : r.removed.map((x) => x.kind));
const countOf = (r: RedactResult, kind: string) => (r.status === "error" ? 0 : r.removed.filter((x) => x.kind === kind).reduce((s, x) => s + x.count, 0));

// 横書き：字の原点 (50, 200)、大きさ 12、全角。氏 50–62、名 62–74、見 74–86、本 86–98、花 98–110、子 110–122（y は 198.56–210.56）
const NAME_LINE = () => textAt(50, 200, "氏名見本花子") + textAt(50, 170, "電話番号〇一二三");
const NAME_AREA: RedactArea = { page: 1, rect: [75, 195, 121, 215] }; // 見・本・花・子（名 の右端 74 には掛からない）

describe("字の上", () => {
  it("選んだ所の字が消え、ほかの字は残る。読み直しの残りは 0 件", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await buildPdf(() => ({ pages: [{ content: NAME_LINE() }] }));
    const r = await run(bytes, [NAME_AREA]);
    ok(r);
    expect(countOf(r, "redacted_text")).toBe(4);
    expect(countOf(r, "redaction_box")).toBe(1);
    expect(r.checked).toEqual(["area", "rules", "verifier"]);
    const [text] = await textOf(r.bytes);
    expect(text).toContain("氏名");
    expect(text).toContain("電話番号〇一二三");
    for (const c of "見本花子") expect(text).not.toContain(c);
  });

  it("字の一部だけが掛かる所：掛かった字はまるごと消える（両どなりの字だけ）", async () => {
    const bytes = await buildPdf(() => ({ pages: [{ content: NAME_LINE() }] }));
    const r = await run(bytes, [{ page: 1, rect: [96, 195, 99, 215] }]); // 本（86–98）と 花（98–110）に少し掛かる
    ok(r);
    expect(countOf(r, "redacted_text")).toBe(2);
    const [text] = await textOf(r.bytes);
    expect(text).toContain("氏名見");
    expect(text).toContain("子");
    expect(text).not.toContain("本");
    expect(text).not.toContain("花");
  });

  it("残す字の位置は変わらない（消した字は同じ幅の送りになる）", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await buildPdf(() => ({ pages: [{ content: textAt(50, 200, "氏名見本花子") }] }));
    const r = await run(bytes, [{ page: 1, rect: [75, 195, 97, 215] }]); // 見・本
    ok(r);
    const task = pdfjs.getDocument({ data: new Uint8Array(r.bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const doc = await task.promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    const items = tc.items.filter((it): it is Extract<typeof it, { str: string }> => "str" in it && it.str.length > 0);
    const last = items.find((it) => it.str.includes("花"));
    expect(last).toBeTruthy();
    // 花子 の並びの原点は 98（消した 2 字分の送りのあと）
    expect(last!.transform[4]).toBeCloseTo(98, 0);
    await task.destroy();
  });

  it("消した字だけで使っていた字の対応表（/ToUnicode）の行を消す。まだ使う字は残す", async () => {
    const bytes = await buildPdf(() => ({ pages: [{ content: NAME_LINE() }] }));
    const r = await run(bytes, [NAME_AREA]);
    ok(r);
    // 0.8.0 から、片付けが「どこにも描かれていない字の行」（unused_unicode）として先に外すことがある。中身は下で確かめる
    expect(countOf(r, "font_unicode") + countOf(r, "unused_unicode")).toBeGreaterThanOrEqual(4);
    const doc = await PDFDocument.load(r.bytes);
    const page = doc.getPages()[0]!;
    const fonts = page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
    const f1 = fonts.lookup(PDFName.of("F1"), PDFDict);
    const tu = f1.lookup(PDFName.of("ToUnicode"), PDFStream) as PDFRawStream;
    const cmap = new TextDecoder("latin1").decode(decodePDFRawStream(tu).decode());
    expect(cmap).toContain(`<${hex("氏").toUpperCase()}>`);
    expect(cmap).toContain(`<${hex("電").toUpperCase()}>`);
    for (const c of "見本花子") expect(cmap).not.toContain(`<${hex(c).toUpperCase()}>`);
  });
});

describe("表の中", () => {
  it("1つの枡の字だけが消え、罫線とほかの枡は残る", async () => {
    const grid = "0 G 1 w 50 100 m 350 100 l 50 140 m 350 140 l 50 180 m 350 180 l 50 100 m 50 180 l 150 100 m 150 180 l 350 100 m 350 180 l S\n";
    const cells = textAt(60, 155, "氏名") + textAt(160, 155, "見本太郎") + textAt(60, 115, "住所") + textAt(160, 115, "東西町一丁目");
    const bytes = await buildPdf(() => ({ pages: [{ content: grid + cells }] }));
    const r = await run(bytes, [{ page: 1, rect: [152, 142, 348, 178] }]);
    ok(r);
    expect(countOf(r, "redacted_text")).toBe(4);
    const [text] = await textOf(r.bytes);
    expect(text).toContain("氏名");
    expect(text).toContain("住所");
    expect(text).toContain("東西町一丁目");
    expect(text).not.toContain("見本太郎");
  });
});

describe("縦書き", () => {
  it("縦の列の下の 4 字だけを選ぶと、その 4 字が消える", async () => {
    // 原点 (300, 250) から下へ 12 ずつ。i 字目は y ∈ [250 − 12(i+1), 250 − 12i]、x ∈ [294, 306]
    const bytes = await buildPdf(() => ({ pages: [{ content: textAt(300, 250, "氏名見本花子", "/V1") }] }));
    const r = await run(bytes, [{ page: 1, rect: [290, 178.5, 310, 225] }]);
    ok(r);
    expect(countOf(r, "redacted_text")).toBe(4);
    const [text] = await textOf(r.bytes);
    expect(text).toContain("氏名");
    for (const c of "見本花子") expect(text).not.toContain(c);
  });
});

describe("スキャンの画像の上", () => {
  it("Flate の画像：選んだ所の画素を黒く塗り、読み直しの残りは 0 件", async () => {
    const bytes = await buildPdf((doc) => ({
      pages: [{ content: "q 200 0 0 100 100 50 cm /Im1 Do Q\n", images: [imageFlate(doc.context, 200, 100, 1, scanPixels(200, 100))] }],
    }));
    const r = await run(bytes, [{ page: 1, rect: [150, 80, 250, 120] }]);
    ok(r);
    expect(countOf(r, "redacted_pixels")).toBeGreaterThan(3000);
  });

  it("JPEG の画像：画像の道具を渡せば塗れる", async () => {
    const bytes = await buildPdf(async (doc) => ({ pages: [{ content: "q 200 0 0 100 100 50 cm /Im1 Do Q\n", images: [await imageJpeg(doc.context, 200, 100)] }] }));
    const r = await run(bytes, [{ page: 1, rect: [150, 80, 250, 120] }], { codec: createNodeImageCodec() });
    ok(r);
    expect(countOf(r, "redacted_pixels")).toBeGreaterThan(3000);
  });

  it("JPEG の画像で画像の道具がないとき：塗れないので保存させない（何が残ったかを返す）", async () => {
    const bytes = await buildPdf(async (doc) => ({ pages: [{ content: "q 200 0 0 100 100 50 cm /Im1 Do Q\n", images: [await imageJpeg(doc.context, 200, 100)] }] }));
    const r = await run(bytes, [{ page: 1, rect: [150, 80, 250, 120] }]);
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect("bytes" in r).toBe(false);
    expect(r.leftovers.some((l) => l.check === "not_done")).toBe(true);
    expect(r.leftovers.some((l) => l.check === "area" && l.kind === "unchecked_image")).toBe(true);
  });

  it("透明の型（/SMask）のある画像：型の所も不透明にする", async () => {
    const mask = new Uint8Array(200 * 100);
    for (let i = 0; i < mask.length; i++) mask[i] = (i >> 3) % 2 ? 255 : 0; // 縞の形（署名の形のつもり）
    const bytes = await buildPdf((doc) => ({
      pages: [{ content: "q 200 0 0 100 100 50 cm /Im1 Do Q\n", images: [imageFlate(doc.context, 200, 100, 1, scanPixels(200, 100), mask)] }],
    }));
    const r = await run(bytes, [{ page: 1, rect: [150, 80, 250, 120] }]);
    ok(r);
    const doc = await PDFDocument.load(r.bytes);
    const xo = doc.getPages()[0]!.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const im = [...xo.values()].map((v) => doc.context.lookup(v)).find((v): v is PDFRawStream => v instanceof PDFRawStream)!;
    const sm = im.dict.lookup(PDFName.of("SMask")) as PDFRawStream;
    const px = decodePDFRawStream(sm).decode();
    // 選んだ所の真ん中（画像の x=100, y=50 の行）は不透明
    expect(px[50 * 200 + 100]).toBe(255);
    expect(px[50 * 200 + 101]).toBe(255);
  });

  it("ページに直接埋め込んだ画像の上：画像の部品に移し替えて塗り、字も消す（0.8.0 から。読み直しの残りは 0 件）", async () => {
    const inline = "q 100 0 0 50 100 100 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\xff\x00 EI Q\n";
    const bytes = await buildPdf(() => ({ pages: [{ content: inline + textAt(100, 120, "見本") }] }));
    const r = await run(bytes, [{ page: 1, rect: [100, 100, 200, 150] }]);
    ok(r);
    expect(countOf(r, "redacted_pixels")).toBe(4);
    expect(countOf(r, "redacted_text")).toBe(2);
    expect(Buffer.from(r.bytes).toString("latin1")).not.toMatch(/\bBI\b/);
  });
});

describe("注釈とフォームの欄", () => {
  it("選んだ所に掛かる注釈を外す。外の注釈（リンク）は残る", async () => {
    const bytes = await buildPdf(() => ({
      pages: [{
        content: NAME_LINE(),
        annots: [
          { Subtype: "Square", Rect: [76, 190, 120, 220], Contents: PDFString.of("MIHON MEMO"), IC: [1, 1, 0], F: 4 },
          { Subtype: "Link", Rect: [300, 20, 380, 40], Border: [0, 0, 0], F: 4 },
        ],
      }],
    }));
    const r = await run(bytes, [NAME_AREA]);
    ok(r);
    expect(countOf(r, "redacted_annotation")).toBe(1);
    const doc = await PDFDocument.load(r.bytes);
    const annots = doc.getPages()[0]!.node.lookup(PDFName.of("Annots"), PDFArray);
    expect(annots.size()).toBe(1);
    expect(new TextDecoder("latin1").decode(r.bytes)).not.toContain("MIHON MEMO");
  });

  it("フォームの欄：見た目が選んだ所に掛かれば、欄ごと値も外す", async () => {
    const bytes = await buildPdf(() => ({
      pages: [{
        content: latinAt(50, 250, "Name"),
        annots: [{ Subtype: "Widget", FT: "Tx", T: PDFString.of("name"), V: PDFString.of("MIHON HANAKO"), Rect: [100, 240, 250, 265], F: 4 }],
      }],
      acroForm: (ctx, widgets) => setAcro(ctx, widgets),
    }));
    const r = await run(bytes, [{ page: 1, rect: [110, 245, 200, 260] }]);
    ok(r);
    expect(countOf(r, "redacted_field")).toBe(1);
    expect(new TextDecoder("latin1").decode(r.bytes)).not.toContain("MIHON HANAKO");
    expect(await allStreams(r.bytes)).not.toContain("MIHON HANAKO");
  });

  it("フォームの欄：同じ欄の見た目がほかにも残るときは、値を消せないので保存させない", async () => {
    const bytes = await buildPdf(() => ({
      pages: [{
        content: latinAt(50, 250, "Name"),
        annots: [
          { Subtype: "Widget", Rect: [100, 240, 250, 265], F: 4 },
          { Subtype: "Widget", Rect: [100, 40, 250, 65], F: 4 },
        ],
      }],
      acroForm: (ctx, widgets) => {
        const field = ctx.register(ctx.obj({ FT: "Tx", T: PDFString.of("name"), V: PDFString.of("MIHON HANAKO"), Kids: widgets }));
        for (const w of widgets) (ctx.lookup(w) as PDFDict).set(PDFName.of("Parent"), field);
        setAcro(ctx, [field]);
      },
    }));
    const r = await run(bytes, [{ page: 1, rect: [110, 245, 200, 260] }]);
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.notDone.some((n) => n.reason === "field_shared")).toBe(true);
  });
});

function setAcro(ctx: import("pdf-lib").PDFContext, fields: import("pdf-lib").PDFRef[]) {
  const catalog = ctx.lookup(ctx.trailerInfo.Root) as PDFDict;
  catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: fields }));
}

describe("前の版・縮小画像", () => {
  it("前の版のある PDF：前の版の中身を残さず、1つの版にまとめる", async () => {
    const base = await buildPdf(() => ({ pages: [{ content: latinAt(50, 100, "OLD-VERSION-0000") + NAME_LINE() }] }));
    const bytes = appendRevision(base, NAME_LINE());
    expect((await textOf(bytes))[0]).not.toContain("OLD-VERSION"); // 見えているのは新しい版
    expect(new TextDecoder("latin1").decode(bytes)).toContain("OLD-VERSION-0000"); // ファイルには残っている
    const r = await run(bytes, [NAME_AREA]);
    ok(r);
    expect(kinds(r)).toContain("previous_versions");
    const out = new TextDecoder("latin1").decode(r.bytes);
    expect(out.match(/%%EOF/g)?.length).toBe(1);
    expect(await allStreams(r.bytes)).not.toContain("OLD-VERSION");
  });

  it("ページの縮小画像（/Thumb）を消す", async () => {
    const bytes = await buildPdf(() => ({ pages: [{ content: NAME_LINE(), thumb: true }] }));
    const r = await run(bytes, [NAME_AREA]);
    ok(r);
    expect(kinds(r)).toContain("thumbnail");
    expect(new TextDecoder("latin1").decode(r.bytes)).not.toContain("/Thumb");
  });
});

describe("対照（何も選ばない・何もない所を選ぶ）", () => {
  it("何も選ばない：片付け（sanitizePdf）とまったく同じ PDF になり、黒塗りの項目は出ない", async () => {
    const bytes = await buildPdf(() => ({ pages: [{ content: NAME_LINE() }] }));
    const r = await run(bytes, []);
    ok(r);
    const s = await sanitizePdf(bytes);
    expect(s.status).toBe("ok");
    if (s.status !== "ok") return;
    expect(Buffer.from(r.bytes).equals(Buffer.from(s.bytes))).toBe(true);
    expect(kinds(r).filter((k) => k.startsWith("redact") || k === "font_unicode")).toEqual([]);
    expect((await textOf(r.bytes))[0]).toBe((await textOf(bytes))[0]);
  });

  it("字のない所を選ぶ：黒い四角を描くだけで、字は1字も消えない", async () => {
    const bytes = await buildPdf(() => ({ pages: [{ content: NAME_LINE() }] }));
    const r = await run(bytes, [{ page: 1, rect: [250, 50, 350, 100] }]);
    ok(r);
    expect(countOf(r, "redacted_text")).toBe(0);
    expect(countOf(r, "font_unicode")).toBe(0);
    expect(countOf(r, "redaction_box")).toBe(1);
    expect((await textOf(r.bytes))[0]).toBe((await textOf(bytes))[0]);
  });
});

describe("入力の確かめ", () => {
  it.each([
    ["ページの番号が 0", [{ page: 0, rect: [0, 0, 10, 10] }]],
    ["箱に広さがない", [{ page: 1, rect: [10, 10, 10, 20] }]],
    ["数でない値", [{ page: 1, rect: [0, 0, Number.NaN, 10] }]],
    ["ない ページ", [{ page: 5, rect: [0, 0, 10, 10] }]],
    ["並びでない", "nope"],
  ])("%s は bad_areas", async (_, areas) => {
    const bytes = await buildPdf(() => ({ pages: [{ content: NAME_LINE() }] }));
    const r = await redact(bytes, areas as RedactArea[]);
    expect(r.status === "error" && r.code).toBe("bad_areas");
  });

  it("空のファイルは empty", async () => {
    const r = await redact(new Uint8Array(0), [NAME_AREA]);
    expect(r.status === "error" && r.code).toBe("empty");
  });
});

describe("読み直しの確かめそのもの（見せかけの黒塗りを渡すと、残りを数える）", () => {
  // 字の上に黒い四角を重ねただけ（字は残る）。画像の上に黒い四角を重ねただけ（画素は残る）
  const fake = () => buildPdf((doc) => ({
    pages: [{
      content: NAME_LINE() + "0 g 75 195 46 20 re f\n" + "q 200 0 0 100 100 50 cm /Im1 Do Q 0 g 150 80 100 40 re f\n",
      images: [imageFlate(doc.context, 200, 100, 1, scanPixels(200, 100))],
    }],
  }));

  it("選んだ場所の確かめ：残った字と画素を数える", async () => {
    const { checkAreas } = await import("../sanitize/redact-check.ts");
    const left = await checkAreas(await fake(), [NAME_AREA, { page: 1, rect: [150, 80, 250, 120] }]);
    expect(left.find((l) => l.kind === "text")?.count).toBe(4);
    expect(left.find((l) => l.kind === "pixels")?.count).toBeGreaterThan(1000);
  });

  it("作品の検査と検証器：残りを数える", async () => {
    const bytes = await fake();
    for (const c of allChecks) {
      const left = await c.run(bytes, [NAME_AREA]);
      expect(left.length, c.name).toBeGreaterThan(0);
    }
  });
});

describe("黒塗りの候補（P13【仮】）は、読み直しの残りに数えない", () => {
  it("作品の検査の P13 の行と、P13 を調べられなかったことは残りにしない（ほかの型の行は残りにする）", async () => {
    const { rulesCheck } = await import("../sanitize/redact-check.ts");
    const item = (pattern: string) => ({ pattern, page: 1, rect: [0, 0, 10, 10] as [number, number, number, number] });
    const check = rulesCheck(async () => ({
      rules: [
        { ruleId: "pii", pattern: "P13", status: "ok", items: [item("P13"), item("P13")] },
        { ruleId: "pii-err", pattern: "P13", status: "error", items: [] },
        { ruleId: "p6-text", pattern: "P6", status: "ok", items: [item("P6")] },
      ],
    }));
    const left = await check.run(new Uint8Array(), []);
    expect(left.map((l) => `${l.kind}:${l.pattern}`)).toEqual(["rule_item:P6"]);
  });

  it("選んだ所の外に個人情報らしい字があっても、選んだ所を消せば保存できる", async () => {
    const bytes = await buildPdf(() => ({
      pages: [{ content: NAME_LINE() + latinAt(72, 120, "TEL 080-0627-3915") }],
    }));
    const { inspectAll } = await import("../src/inspect/inspect.ts");
    const before = await inspectAll(bytes);
    expect(before.rules.find((r) => r.pattern === "P13")?.items.length ?? 0).toBeGreaterThan(0);

    const r = await redact(bytes, [NAME_AREA], { checks: allChecks });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect((await textOf(r.bytes))[0]).toContain("TEL 080-0627-3915");
  });

  it("選んだ所の中の字は、P13 を外しても場所ごとの確かめで見る", async () => {
    const { checkAreas } = await import("../sanitize/redact-check.ts");
    const bytes = await buildPdf(() => ({ pages: [{ content: latinAt(72, 120, "TEL 080-0627-3915") }] }));
    const left = await checkAreas(bytes, [{ page: 1, rect: [95, 115, 170, 135] }]);
    expect(left.find((l) => l.kind === "text")?.count ?? 0).toBeGreaterThan(0);
  });
});

describe("型抜きの画像（/Mask に画像を指定したもの）", () => {
  it("塗らない型抜きの画像が選んだ所に掛かるときは、確かめられないので保存させない", async () => {
    const bytes = await buildPdf((doc) => {
      const ctx = doc.context;
      const im = imageFlate(ctx, 200, 100, 1, scanPixels(200, 100));
      const mask = ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: 8, Height: 8, ImageMask: true, BitsPerComponent: 1 }), new Uint8Array(8).fill(0xaa)));
      (ctx.lookup(im) as PDFRawStream).dict.set(PDFName.of("Mask"), mask);
      return { pages: [{ content: "q 200 0 0 100 100 50 cm /Im1 Do Q\n", images: [im] }] };
    });
    const r = await run(bytes, [{ page: 1, rect: [150, 80, 250, 120] }]);
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.leftovers.some((l) => l.check === "area" && l.kind === "unchecked_image")).toBe(true);
  });
});

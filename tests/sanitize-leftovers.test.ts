// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付け 0.7.0 で足した決まり（見つけているのに片付けていなかったもの）のテスト。決まりごとに、消す形と、消してはいけない対照を組にする。
// 合成 PDF はテストの中で作る（中身はすべて架空。目印の字 KAKUSHI… が、片付けたあとのファイルのどこにも残らないことを見る）。

import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, decodePDFRawStream, type PDFContext, type PDFRef } from "pdf-lib";
import { sanitizePdf, type SanitizeResult } from "../sanitize/index.ts";
import { isLocalPlace, stripJpegMetadata } from "../sanitize/leftovers.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";
import { buildPdf, imageFlate, latinAt } from "./helpers/redact-pdfs.ts";

const codec = createNodeImageCodec();

/** 字の書き方の形：そのまま・UTF-16・それぞれの16進（大文字・小文字） */
function forms(s: string): Buffer[] {
  const ascii = Buffer.from(s, "latin1");
  const u16 = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) u16.writeUInt16BE(s.charCodeAt(i), i * 2);
  return [ascii, u16, ...[ascii, u16].flatMap((b) => [Buffer.from(b.toString("hex").toUpperCase()), Buffer.from(b.toString("hex"))])];
}

/** ファイルのバイト列と、解けるストリームの中身のどこかに、字があるか（どの書き方でも） */
async function inFile(bytes: Uint8Array, s: string): Promise<boolean> {
  const f = forms(s);
  const has = (b: Uint8Array) => f.some((x) => Buffer.from(b).includes(x));
  if (has(bytes)) return true;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) continue;
    try {
      if (has(decodePDFRawStream(o).decode())) return true;
    } catch {
      if (has(o.contents)) return true;
    }
  }
  return false;
}

async function textOf(bytes: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  let t = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    t += tc.items.map((it) => ("str" in it ? it.str : "")).join("");
  }
  await task.destroy();
  return t;
}

async function clean(bytes: Uint8Array): Promise<Extract<SanitizeResult, { status: "ok" }>> {
  const r = await sanitizePdf(bytes, { codec });
  expect(r.status).toBe("ok");
  if (r.status !== "ok") throw new Error(r.status);
  return r;
}
const kinds = (r: { removed: Array<{ kind: string; reason?: string }> }) => r.removed.map((x) => (x.reason ? `${x.kind}:${x.reason}` : x.kind));
const reasons = (r: { notDone: Array<{ reason: string }> }) => r.notDone.map((x) => x.reason);
const catalogOf = (ctx: PDFContext) => ctx.lookup(ctx.trailerInfo.Root) as PDFDict;

describe("P7 字：横につぶれた字", () => {
  it("横の伸縮 0%・1% の字は消す。50% の字は残す", async () => {
    const r = await clean(await buildPdf(() => ({
      pages: [{ content: `BT /H1 12 Tf 0 Tz 40 250 Td (KAKUSHI-TZ0) Tj ET\nBT /H1 12 Tf 1 Tz 40 220 Td (KAKUSHI-TZ1) Tj ET\nBT /H1 12 Tf 50 Tz 40 190 Td (SHOWN-TZ50) Tj ET\n` }],
    })));
    expect(kinds(r)).toContain("hidden_text:squashed");
    const t = await textOf(r.bytes);
    expect(t).not.toContain("KAKUSHI");
    expect(t).toContain("SHOWN-TZ50");
  });
});

describe("P6・P7 字：注釈で隠した字", () => {
  it("白く塗った四角の注釈の下の字は消す。注釈から外れた字は残す", async () => {
    const ap = (ctx: PDFContext) => ctx.register(ctx.stream("1 g 0 0 96 20 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 96, 20] }));
    const r = await clean(await buildPdf((doc) => ({
      pages: [{
        content: latinAt(120, 200, "KAKUSHI-WHITE") + latinAt(120, 100, "SHOWN-OUTSIDE"),
        annots: [{ Subtype: "Square", Rect: [116, 194, 212, 214], IC: [1, 1, 1], F: 4, AP: { N: ap(doc.context) } }],
      }],
    })));
    expect(kinds(r)).toContain("hidden_text:covered_light");
    const t = await textOf(r.bytes);
    expect(t).not.toContain("KAKUSHI");
    expect(t).toContain("SHOWN-OUTSIDE");
  });

  it("色の濃い蛍光ペン（見た目なし）の下の字は消す。黄色の蛍光ペンの下の字は残す", async () => {
    const quad = (y: number) => [116, y + 20, 212, y + 20, 116, y, 212, y];
    const r = await clean(await buildPdf(() => ({
      pages: [{
        content: latinAt(120, 200, "KAKUSHI-HL") + latinAt(120, 100, "SHOWN-YELLOW"),
        annots: [
          { Subtype: "Highlight", Rect: [116, 194, 212, 214], QuadPoints: quad(194), C: [0, 0, 0], F: 4 },
          { Subtype: "Highlight", Rect: [116, 94, 212, 114], QuadPoints: quad(94), C: [1, 1, 0], F: 4 },
        ],
      }],
    })));
    expect(kinds(r)).toContain("covered_text");
    const t = await textOf(r.bytes);
    expect(t).not.toContain("KAKUSHI");
    expect(t).toContain("SHOWN-YELLOW");
  });
});

describe("P7 字：画像で隠した字・画像と同じ色の字", () => {
  const flat = (w: number, h: number, v: number) => new Uint8Array(w * h).fill(v);

  it("字のあとに重ねた不透明な画像（明るい灰色）の下の字は消す。画像の上に描いた字は残す", async () => {
    const r = await clean(await buildPdf((doc) => ({
      pages: [{
        content: latinAt(120, 200, "KAKUSHI-UNDER") + "q 120 0 0 40 110 184 cm /Im1 Do Q\n" + "q 120 0 0 40 110 84 cm /Im1 Do Q\n" + latinAt(120, 100, "SHOWN-ON-TOP"),
        images: [imageFlate(doc.context, 8, 4, 1, flat(8, 4, 220))],
      }],
    })));
    expect(kinds(r)).toContain("hidden_text:covered_image");
    const t = await textOf(r.bytes);
    expect(t).not.toContain("KAKUSHI");
    expect(t).toContain("SHOWN-ON-TOP");
  });

  it("描き方 3（文字認識の層）の字は、あとから重ねた画像の下でも残す", async () => {
    const r = await clean(await buildPdf((doc) => ({
      pages: [{ content: "BT /H1 12 Tf 3 Tr 120 200 Td (OCR-LAYER) Tj ET\n" + "q 120 0 0 40 110 184 cm /Im1 Do Q\n", images: [imageFlate(doc.context, 8, 4, 1, flat(8, 4, 200))] }],
    })));
    expect(await textOf(r.bytes)).toContain("OCR-LAYER");
  });

  it("一色の画像の上の、画像と同じ明るさの字は消す。違う明るさの字は残す", async () => {
    const r = await clean(await buildPdf((doc) => ({
      pages: [{
        content: "q 300 0 0 100 40 150 cm /Im1 Do Q\n" + "BT /H1 12 Tf 0.4 g 50 210 Td (KAKUSHI-SAME) Tj ET\n" + "BT /H1 12 Tf 0 g 50 170 Td (SHOWN-DARK) Tj ET\n",
        images: [imageFlate(doc.context, 4, 4, 1, flat(4, 4, 102))],
      }],
    })));
    expect(kinds(r)).toContain("hidden_text:same_color");
    const t = await textOf(r.bytes);
    expect(t).not.toContain("KAKUSHI");
    expect(t).toContain("SHOWN-DARK");
  });

  it("模様のある画像の上の字は、平均の明るさが同じでも残す（地が一色でないので見える）", async () => {
    const px = new Uint8Array(16 * 16);
    for (let i = 0; i < px.length; i++) px[i] = (i + Math.floor(i / 16)) % 2 ? 0 : 204;
    const r = await clean(await buildPdf((doc) => ({
      pages: [{ content: "q 300 0 0 100 40 150 cm /Im1 Do Q\n" + "BT /H1 12 Tf 0.4 g 50 210 Td (SHOWN-ON-PATTERN) Tj ET\n", images: [imageFlate(doc.context, 16, 16, 1, px)] }],
    })));
    expect(await textOf(r.bytes)).toContain("SHOWN-ON-PATTERN");
  });
});

describe("P7 画像：ページの外・切り抜きの外", () => {
  const pattern = (w: number, h: number) => {
    const px = new Uint8Array(w * h);
    for (let i = 0; i < px.length; i++) px[i] = i % 3 ? 30 : 240;
    return px;
  };

  it("ページの外に置いた画像は描かないようにし、ファイルから消える", async () => {
    const r = await clean(await buildPdf((doc) => ({
      pages: [{ content: latinAt(40, 250, "Body") + "q 100 0 0 50 500 100 cm /Im1 Do Q\n", images: [imageFlate(doc.context, 20, 10, 1, pattern(20, 10))] }],
    })));
    expect(kinds(r)).toContain("hidden_image");
    const doc = await PDFDocument.load(r.bytes);
    const images = [...doc.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
    expect(images.length).toBe(0);
  });

  it("切り抜きで大部分を隠した画像は、隠れた所の画素を白く塗る。ほとんど見えている画像はそのまま", async () => {
    const r = await clean(await buildPdf((doc) => ({
      pages: [{
        content: "q 40 150 20 20 re W n 200 0 0 100 40 150 cm /Im1 Do Q\n" + "q 40 20 180 100 re W n 200 0 0 100 40 20 cm /Im2 Do Q\n",
        images: [imageFlate(doc.context, 40, 20, 1, pattern(40, 20)), imageFlate(doc.context, 40, 20, 1, pattern(40, 20))],
      }],
    })));
    const hidden = r.removed.filter((x) => x.kind === "hidden_image");
    expect(hidden.length).toBeGreaterThan(0);
    // 2 つめ（見える所が 9 割）は塗らない：塗った箱は、1 つめの画像の箱の中だけ
    for (const h of hidden) expect(h.rect![1]).toBeGreaterThanOrEqual(150);
  });
});

describe("P5 描かれない部品", () => {
  it("ページの資源にあるが描かれない部品は外す。描く部品は残す", async () => {
    const r = await clean(await buildPdf(() => ({ pages: [{ content: "q /Fm1 Do Q\n" }] })).then(async (b) => {
      // buildPdf は画像しか資源に入れないので、部品は書き足す
      const doc = await PDFDocument.load(b);
      const ctx = doc.context;
      const font = ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
      const form = (s: string) => ctx.register(ctx.stream(`BT /F9 12 Tf 40 100 Td (${s}) Tj ET`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 400, 300], Resources: { Font: { F9: font } } }));
      const res = doc.getPage(0).node.Resources()!;
      res.set(PDFName.of("XObject"), ctx.obj({ Fm1: form("SHOWN-FORM"), Fm2: form("KAKUSHI-UNUSED") }));
      return new Uint8Array(await doc.save({ useObjectStreams: false }));
    }));
    expect(kinds(r)).toContain("unused_xobject");
    expect(await inFile(r.bytes, "KAKUSHI")).toBe(false);
    expect(await textOf(r.bytes)).toContain("SHOWN-FORM");
  });
});

describe("P7・P8 消さずに知らせるもの", () => {
  it("同じ所に違う字を重ねて描いたら notDone。同じ字の重ね描き（太字の代わり）は知らせない", async () => {
    const r = await clean(await buildPdf(() => ({
      pages: [{ content: latinAt(40, 200, "AAAA") + latinAt(40, 200, "BBBB") + latinAt(40, 100, "CCCC") + latinAt(40.2, 100, "CCCC") }],
    })));
    const o = r.notDone.filter((n) => n.reason === "overdrawn_text");
    expect(o.length).toBe(1);
    expect(o[0]!.rect![1]).toBeGreaterThan(150);
  });

  it("注釈の見た目の中だけにある字は notDone。コメントのある注釈は知らせない", async () => {
    const r = await clean(await buildPdf((doc) => {
      const ctx = doc.context;
      const font = ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
      const ap = (s: string) => ctx.register(ctx.stream(`BT /F9 10 Tf 2 5 Td (${s}) Tj ET`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 20], Resources: { Font: { F9: font } } }));
      return {
        pages: [{
          content: latinAt(40, 250, "Body"),
          annots: [
            { Subtype: "Stamp", Rect: [40, 150, 140, 170], F: 4, AP: { N: ap("STAMP-ONLY") } },
            { Subtype: "FreeText", Rect: [40, 100, 140, 120], F: 4, Contents: PDFString.of("note"), AP: { N: ap("WITH-CONTENTS") } },
          ],
        }],
      };
    }));
    expect(reasons(r).filter((x) => x === "annotation_text").length).toBe(1);
  });
});

describe("P12 外の動作", () => {
  it("Launch・file: の URI・手元のファイルへ移る動作は外す。web の URI と相対の行き先は残す", async () => {
    expect(isLocalPlace("file:///C:/x")).toBe(true);
    expect(isLocalPlace("\\\\server\\share\\x")).toBe(true);
    expect(isLocalPlace("C:\\x\\y.pdf")).toBe(true);
    expect(isLocalPlace("https://example.com/")).toBe(false);
    expect(isLocalPlace("other.pdf")).toBe(false);
    const r = await clean(await buildPdf((doc) => {
      catalogOf(doc.context).set(PDFName.of("OpenAction"), doc.context.obj({ S: "Launch", F: PDFString.of("KAKUSHI-LAUNCH.exe") }));
      return {
        pages: [{
          content: latinAt(40, 250, "Body"),
          annots: [
            { Subtype: "Link", Rect: [40, 40, 60, 60], F: 4, A: { S: "URI", URI: PDFString.of("file:///C:/KAKUSHI-FILE/a.pdf") } },
            { Subtype: "Link", Rect: [80, 40, 100, 60], F: 4, A: { S: "GoToR", F: PDFHexString.fromText("\\\\KAKUSHI-SERVER\\b.pdf"), D: [0, "Fit"] } },
            { Subtype: "Link", Rect: [120, 40, 140, 60], F: 4, A: { S: "URI", URI: PDFString.of("https://example.com/kept") } },
            { Subtype: "Link", Rect: [160, 40, 180, 60], F: 4, A: { S: "GoToR", F: PDFString.of("next.pdf"), D: [0, "Fit"] } },
          ],
        }],
      };
    }));
    expect(r.removed.find((x) => x.kind === "external_action")?.count).toBe(3);
    expect(await inFile(r.bytes, "KAKUSHI")).toBe(false);
    expect(await inFile(r.bytes, "example.com/kept")).toBe(true);
    expect(await inFile(r.bytes, "next.pdf")).toBe(true);
  });
});

describe("P10 写真の情報", () => {
  /** JPEG（APP0 の JFIF のあと）に、Exif・XMP・コメントの区切りを差し込む */
  async function jpegWithExif(): Promise<{ jpeg: Uint8Array; sos: Uint8Array }> {
    const canvas = createCanvas(8, 8);
    const g = canvas.getContext("2d");
    g.fillStyle = "#808080";
    g.fillRect(0, 0, 8, 8);
    const base = new Uint8Array(await canvas.encode("jpeg", 90));
    const seg = (marker: number, body: string) => {
      const b = Buffer.from(body, "latin1");
      return Buffer.concat([Buffer.from([0xff, marker, (b.length + 2) >> 8, (b.length + 2) & 0xff]), b]);
    };
    const extra = Buffer.concat([seg(0xe1, "Exif\0\0KAKUSHI-GPS-35.0N"), seg(0xe1, "http://ns.adobe.com/xap/1.0/\0KAKUSHI-XMP"), seg(0xfe, "KAKUSHI-COMMENT"), seg(0xed, "Photoshop 3.0\0KAKUSHI-IPTC")]);
    // SOI と、続く APP0（あれば）のあとに入れる
    let at = 2;
    if (base[2] === 0xff && base[3] === 0xe0) at = 4 + ((base[4]! << 8) | base[5]!);
    const jpeg = new Uint8Array(Buffer.concat([Buffer.from(base.subarray(0, at)), extra, Buffer.from(base.subarray(at))]));
    let sos = 0;
    for (let i = 2; i + 1 < base.length; i++) if (base[i] === 0xff && base[i + 1] === 0xda) { sos = i; break; }
    return { jpeg, sos: base.subarray(sos) };
  }

  it("JPEG の中の Exif・XMP・IPTC・コメントを外す。画素の区切りは同じバイト列のまま", async () => {
    const { jpeg, sos } = await jpegWithExif();
    const out = stripJpegMetadata(jpeg)!;
    expect(out).not.toBeNull();
    expect(Buffer.from(out).toString("latin1")).not.toContain("KAKUSHI");
    expect(Buffer.from(out.subarray(out.length - sos.length)).equals(Buffer.from(sos))).toBe(true);
    expect(stripJpegMetadata(out)).toBeNull();
  });

  it("PDF の中の写真から、撮影の情報を消す（写真は描けるまま）", async () => {
    const { jpeg } = await jpegWithExif();
    const r = await clean(await buildPdf((doc) => {
      const ref = doc.context.register(PDFRawStream.of(doc.context.obj({ Type: "XObject", Subtype: "Image", Width: 8, Height: 8, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" }), jpeg));
      return { pages: [{ content: "q 80 0 0 80 40 100 cm /Im1 Do Q\n", images: [ref] }] };
    }));
    expect(r.removed.find((x) => x.kind === "image_exif")?.count).toBe(1);
    expect(await inFile(r.bytes, "KAKUSHI")).toBe(false);
  });
});

describe("P7・P11 しおり・構造要素の題・欄の名前", () => {
  it("しおりを外す。構造要素の題（/T）と欄の書き出し用の名前（/TM）を消し、/Alt・/TU は残して notDone にする", async () => {
    const r = await clean(await buildPdf((doc) => {
      const ctx = doc.context;
      const cat = catalogOf(ctx);
      const outlines = ctx.register(ctx.obj({ Type: "Outlines", Count: 1 }));
      const item = ctx.register(ctx.obj({ Title: PDFString.of("KAKUSHI-OUTLINE"), Parent: outlines }));
      (ctx.lookup(outlines) as PDFDict).set(PDFName.of("First"), item);
      (ctx.lookup(outlines) as PDFDict).set(PDFName.of("Last"), item);
      cat.set(PDFName.of("Outlines"), outlines);
      cat.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
      const root = ctx.register(ctx.obj({ Type: "StructTreeRoot" }));
      const fig = ctx.register(ctx.obj({ Type: "StructElem", S: "Figure", P: root, T: PDFString.of("KAKUSHI-STRUCT-T"), Alt: PDFString.of("ALT-KEPT") }));
      (ctx.lookup(root) as PDFDict).set(PDFName.of("K"), ctx.obj([fig]));
      cat.set(PDFName.of("StructTreeRoot"), root);
      return {
        pages: [{ content: latinAt(40, 250, "Body"), annots: [{ Subtype: "Widget", FT: "Tx", T: PDFString.of("f1"), TU: PDFString.of("TU-KEPT"), TM: PDFString.of("KAKUSHI-TM"), Rect: [40, 100, 140, 120], F: 4 }] }],
        acroForm: (c: PDFContext, widgets: PDFRef[]) => catalogOf(c).set(PDFName.of("AcroForm"), c.obj({ Fields: widgets })),
      };
    }));
    expect(kinds(r)).toEqual(expect.arrayContaining(["outline", "struct_title"]));
    expect(reasons(r).filter((x) => x === "accessibility_text").length).toBe(2);
    expect(await inFile(r.bytes, "KAKUSHI")).toBe(false);
    expect(await inFile(r.bytes, "ALT-KEPT")).toBe(true);
    expect(await inFile(r.bytes, "TU-KEPT")).toBe(true);
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.catalog.has(PDFName.of("Outlines"))).toBe(false);
    expect(doc.catalog.has(PDFName.of("PageMode"))).toBe(false);
  });
});

describe("P11 フォームの値", () => {
  it("見た目のない欄・隠した見た目の欄の値は消す。見えている欄の値は残して notDone にする", async () => {
    const r = await clean(await buildPdf((doc) => {
      const ctx = doc.context;
      const font = ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
      const ap = (s: string) => ctx.register(ctx.stream(`BT /F9 10 Tf 2 5 Td (${s}) Tj ET`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 20], Resources: { Font: { F9: font } } }));
      return {
        pages: [{
          content: latinAt(40, 250, "Body"),
          annots: [
            { Subtype: "Widget", FT: "Tx", T: PDFString.of("hidden"), V: PDFString.of("KAKUSHI-HIDDEN"), Rect: [40, 150, 140, 170], F: 2, AP: { N: ap("KAKUSHI-HIDDEN") } },
            { Subtype: "Widget", FT: "Tx", T: PDFString.of("shown"), V: PDFString.of("SHOWN-VALUE"), Rect: [40, 100, 140, 120], F: 4, AP: { N: ap("SHOWN-VALUE") } },
          ],
        }],
        acroForm: (c: PDFContext, widgets: PDFRef[]) => {
          const noWidget = c.register(c.obj({ FT: "Tx", T: PDFString.of("nowidget"), V: PDFHexString.fromText("KAKUSHI-NOWIDGET") }));
          catalogOf(c).set(PDFName.of("AcroForm"), c.obj({ Fields: [...widgets, noWidget] }));
        },
      };
    }));
    expect(r.removed.find((x) => x.kind === "field_value")?.count).toBe(2);
    expect(r.notDone.filter((n) => n.reason === "field_visible").map((n) => n.page)).toEqual([1]);
    expect(await inFile(r.bytes, "KAKUSHI")).toBe(false);
    expect(await inFile(r.bytes, "SHOWN-VALUE")).toBe(true);
    const doc = await PDFDocument.load(r.bytes);
    const fields = doc.context.lookup((doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict)).get(PDFName.of("Fields"))) as PDFArray;
    expect(fields.size()).toBe(3);
  });
});

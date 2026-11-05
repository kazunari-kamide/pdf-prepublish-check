// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付け（sanitize/）のテスト。
// 片付けた PDF は、片付けの側のコードを使わず、PDF.js で読み直して確かめる（字が取り出せるか・どこにあるか）。
// テスト用の PDF は、テストの中で描く命令を直接書いて作る。名前はすべて架空。
// 採点に使う合成 PDF（fixtures/）は、読み込み（前の版・パスワード）の確かめにだけ、読むだけで使う。

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { sanitizePdf, type SanitizeResult } from "../sanitize/index.ts";
import { formatNumber, serializeOps } from "../sanitize/serialize.ts";
import { operations } from "../rules/shared/content-lexer.ts";
import { makeEncryptedPdf } from "./helpers/encrypted-pdf.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

type Extra = {
  xobjects?: (doc: PDFDocument, font: PDFRef) => Record<string, PDFRef>;
  annots?: (doc: PDFDocument) => PDFRef[];
  ocg?: "off";
};

async function makePdf(content: string, extra: Extra = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const res: Record<string, unknown> = { Font: { F1: font } };
  if (extra.xobjects) res.XObject = extra.xobjects(doc, font);
  if (extra.ocg) {
    const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("Layer") }));
    res.Properties = { L1: ocg };
    doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg] } }));
  }
  page.node.set(PDFName.of("Resources"), ctx.obj(res as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
  if (extra.annots) page.node.set(PDFName.of("Annots"), ctx.obj(extra.annots(doc)));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

/** PDF.js で取り出せる字と、その位置（x） */
async function textItems(bytes: Uint8Array): Promise<Array<{ str: string; x: number; y: number }>> {
  const d = await getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const out: Array<{ str: string; x: number; y: number }> = [];
  for (let p = 1; p <= d.numPages; p++) {
    const tc = await (await d.getPage(p)).getTextContent();
    for (const it of tc.items) if ("str" in it && it.str.trim()) out.push({ str: it.str, x: it.transform[4], y: it.transform[5] });
  }
  return out;
}
const allText = async (bytes: Uint8Array) => (await textItems(bytes)).map((t) => t.str).join("|");

function ok(r: SanitizeResult): Extract<SanitizeResult, { status: "ok" }> {
  if (r.status !== "ok") throw new Error(`片付けに失敗：${r.code}`);
  return r;
}

describe("命令を書き戻す", () => {
  it("数は指数を使わない", () => {
    expect(formatNumber(1e-7)).toBe("0");
    expect(formatNumber(1.5e21)).not.toMatch(/e/);
    expect(formatNumber(-12.3456789)).toBe("-12.345679");
  });
  it("読んで書き戻しても、同じ命令の列になる", () => {
    const src = new TextEncoder().encode("q 1 0 0 1 10 20 cm /F#201 12 Tf BT (a\\)b) Tj [<0102> -250 (c)] TJ ET /OC <</MCID 3>> BDC EMC Q");
    const once = [...operations(src)];
    const twice = [...operations(serializeOps(once))];
    expect(twice).toEqual(once);
  });
});

describe("P6：黒い四角の下の字", () => {
  // Helvetica 12pt の幅（AFM の値 ÷ 1000 × 12）：「Name: 」＝ 3223 → 38.676、「TARO-XYZ」＝ 5056 → 60.672、空白 ＝ 278 → 3.336
  // 字は x＝20 から始まるので、TARO-XYZ は 58.676〜119.348。四角は 57〜121 を覆う（「end」は 122.684 から）
  const content = "BT /F1 12 Tf 20 100 Td (Name: TARO-XYZ end) Tj ET 0 g 57 95 64 20 re f";

  it("覆われた字だけを消し、ほかの字はそのままの位置に残す", async () => {
    const before = await makePdf(content);
    const r = ok(await sanitizePdf(before));
    const after = r.bytes;
    const text = await allText(after);
    expect(text).not.toMatch(/TARO|XYZ/);
    expect(text).toContain("Name:");
    expect(text).toContain("end");
    // 残した字の位置が変わっていない（消した字を同じ幅の送りに置き換えたため）
    const a = await textItems(after);
    expect(a[0]!.x).toBeCloseTo(20, 3);
    const end = a.find((t) => t.str.trim() === "end")!;
    expect(end.x).toBeCloseTo(20 + 38.676 + 60.672 + 3.336, 2);
    const item = r.removed.find((x) => x.kind === "covered_text");
    expect(item).toMatchObject({ pattern: "P6", page: 1 });
    expect(item!.count).toBe(8); // TARO-XYZ（空白は数えない）
    expect(JSON.stringify(r.removed)).not.toContain("TARO");
  });

  it("覆いより後に描いた字（黒い帯の上の白い字）は消さない", async () => {
    const r = ok(await sanitizePdf(await makePdf("0 g 10 90 200 30 re f BT 1 g /F1 12 Tf 20 100 Td (Heading) Tj ET")));
    expect(await allText(r.bytes)).toContain("Heading");
    expect(r.removed.filter((x) => x.pattern === "P6")).toEqual([]);
  });

  it("薄い色の覆い（灰色のマーカー）の下の字は、P6 では消さない", async () => {
    const r = ok(await sanitizePdf(await makePdf("BT /F1 12 Tf 20 100 Td (Visible) Tj ET /GS1 gs 0.85 g 15 95 60 20 re f")));
    expect(r.removed.filter((x) => x.pattern === "P6")).toEqual([]);
  });

  it("文字認識の層（画像の上の見えない字）も、濃い覆いの下なら消す。覆いの外は残す", async () => {
    const pdf = await makePdf("q 280 0 0 180 10 10 cm /Im1 Do Q BT 3 Tr /F1 12 Tf 20 100 Td (OCRNAME) Tj 0 -40 Td (OCRKEEP) Tj ET 0 g 15 95 70 20 re f", {
      xobjects: (doc) => ({ Im1: doc.context.register(doc.context.stream(new Uint8Array([200, 200, 200, 200]), { Type: "XObject", Subtype: "Image", Width: 2, Height: 2, ColorSpace: "DeviceGray", BitsPerComponent: 8 })) }),
    });
    const r = ok(await sanitizePdf(pdf));
    const text = await allText(r.bytes);
    expect(text).not.toContain("OCRNAME");
    expect(text).toContain("OCRKEEP");
  });

  it("部品（Form XObject）の中の字を消し、元の部品は書き換えない", async () => {
    const pdf = await makePdf("q /Fm1 Do Q 0 g 15 95 80 20 re f", {
      xobjects: (doc, font) => ({
        Fm1: doc.context.register(doc.context.stream("BT /F1 12 Tf 20 100 Td (FORMSECRET) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 200], Resources: { Font: { F1: font } } })),
      }),
    });
    const r = ok(await sanitizePdf(pdf));
    expect(await allText(r.bytes)).not.toContain("FORMSECRET");
    // 元の部品は、使われなくなって掃除される（ファイルに残らない）
    const doc = await PDFDocument.load(r.bytes);
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream) expect(latin1(decodePDFRawStream(obj).decode())).not.toContain("FORMSECRET");
    }
  });

  it("未適用の墨消し注釈を適用する：下の字を消し、黒い四角を描き込み、注釈を外す", async () => {
    const pdf = await makePdf("BT /F1 12 Tf 20 100 Td (Before REDACTME after) Tj ET", {
      annots: (doc) => [doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Redact", Rect: [60, 95, 140, 115] }))],
    });
    const r = ok(await sanitizePdf(pdf));
    const text = await allText(r.bytes);
    expect(text).not.toContain("REDACTME");
    expect(text).toContain("Before");
    expect(r.removed.some((x) => x.kind === "redaction_applied")).toBe(true);
    const doc = await PDFDocument.load(r.bytes);
    const page = doc.getPages()[0]!;
    expect(page.node.get(PDFName.of("Annots"))).toBeUndefined();
    const data = latin1(decodePDFRawStream(doc.context.lookup(page.node.get(PDFName.of("Contents"))) as PDFRawStream).decode());
    expect(data).toMatch(/0 g\n60 95 80 20 re\nf/);
  });

  it("スキャン画像の上の黒い四角：覆いの下の画素だけを黒く塗る", async () => {
    // 10×10 の灰色の画像を、100×100 の大きさで置き、左半分を黒い四角で覆う
    const pixels = new Uint8Array(100).fill(180);
    const pdf = await makePdf("q 100 0 0 100 50 50 cm /Im1 Do Q 0 g 50 50 50 100 re f", {
      xobjects: (doc) => ({ Im1: doc.context.register(doc.context.flateStream(pixels, { Type: "XObject", Subtype: "Image", Width: 10, Height: 10, ColorSpace: "DeviceGray", BitsPerComponent: 8 })) }),
    });
    const r = ok(await sanitizePdf(pdf));
    const burned = r.removed.find((x) => x.kind === "covered_pixels");
    expect(burned?.count).toBe(50);
    const doc = await PDFDocument.load(r.bytes);
    const res = doc.getPages()[0]!.node.Resources()!;
    const xo = res.lookup(PDFName.of("XObject"), PDFDict);
    const images = xo.entries().map(([, v]) => doc.context.lookup(v)).filter((v): v is PDFRawStream => v instanceof PDFRawStream);
    const used = images.find((im) => im.dict.get(PDFName.of("Subtype"))?.toString() === "/Image")!;
    const data = decodePDFRawStream(used).decode();
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) expect(data[y * 10 + x]).toBe(x < 5 ? 0 : 180);
    }
    // 報告の箱は、画像全体ではなく、塗った所（覆いの箱と画像の箱の重なり）
    expect(burned?.rect).toEqual([50, 50, 100, 150]);
  });

  it("1つの画像に覆いが2つあれば、塗った所の箱を覆いごとに返す（ページの座標）", async () => {
    // 10×10 の画像を (50,50)–(150,150) に置き、左上と右下に黒い四角を重ねる。右下の四角は画像からはみ出す
    const pixels = new Uint8Array(100).fill(180);
    const pdf = await makePdf("q 100 0 0 100 50 50 cm /Im1 Do Q 0 g 50 120 30 30 re f 120 30 50 50 re f", {
      xobjects: (doc) => ({ Im1: doc.context.register(doc.context.flateStream(pixels, { Type: "XObject", Subtype: "Image", Width: 10, Height: 10, ColorSpace: "DeviceGray", BitsPerComponent: 8 })) }),
    });
    const r = ok(await sanitizePdf(pdf));
    const burned = r.removed.filter((x) => x.kind === "covered_pixels");
    expect(burned.map((x) => ({ rect: x.rect, count: x.count, page: x.page }))).toEqual([
      { rect: [50, 120, 80, 150], count: 9, page: 1 },
      { rect: [120, 50, 150, 80], count: 9, page: 1 },
    ]);
  });

  it("JPEG の画像の上の覆いは塗れないので、片付けられなかった所として返す", async () => {
    const pdf = await makePdf("q 100 0 0 100 50 50 cm /Im1 Do Q 0 g 60 60 30 30 re f", {
      xobjects: (doc) => ({ Im1: doc.context.register(doc.context.stream(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { Type: "XObject", Subtype: "Image", Width: 2, Height: 2, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "DCTDecode" })) }),
    });
    const r = ok(await sanitizePdf(pdf));
    expect(r.notDone).toEqual([expect.objectContaining({ pattern: "P6", reason: "unsupported_image", page: 1 })]);
  });

  it("命令が多すぎるページは片付けを省き、省いたことを返す（問題なしにしない）", async () => {
    const r = ok(await sanitizePdf(await makePdf("BT /F1 12 Tf 20 100 Td (X) Tj ET 0 g 15 95 20 20 re f"), { maxOperationsPerPage: 3 }));
    expect(r.notDone).toEqual([expect.objectContaining({ reason: "too_many_operations", page: 1 })]);
  });
});

describe("P7：見えない字", () => {
  it("白い字・表示しないレイヤーの字・ページの外の字・小さすぎる字を消し、ふつうの字は残す", async () => {
    const pdf = await makePdf(
      [
        "BT /F1 12 Tf 20 150 Td (PLAINTEXT) Tj ET",
        "BT 1 g /F1 12 Tf 20 130 Td (WHITETEXT) Tj ET",
        "/OC /L1 BDC BT 0 g /F1 12 Tf 20 110 Td (LAYERTEXT) Tj ET EMC",
        "BT 0 g /F1 12 Tf 500 90 Td (OFFPAGE) Tj ET",
        "BT 0 g /F1 0.4 Tf 20 70 Td (TINYTEXT) Tj ET",
        "BT 0 g 3 Tr /F1 12 Tf 20 50 Td (INVISIBLE) Tj ET",
      ].join("\n"),
      { ocg: "off" },
    );
    const r = ok(await sanitizePdf(pdf));
    const doc = await PDFDocument.load(r.bytes);
    const data = latin1(decodePDFRawStream(doc.context.lookup(doc.getPages()[0]!.node.get(PDFName.of("Contents"))) as PDFRawStream).decode());
    const hexOf = (s: string) => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    expect(data).toContain(hexOf("PLAINTEXT"));
    for (const s of ["WHITETEXT", "LAYERTEXT", "OFFPAGE", "TINYTEXT", "INVISIBLE"]) {
      expect(data).not.toContain(hexOf(s));
      expect(data).not.toContain(s);
    }
    const reasons = r.removed.filter((x) => x.pattern === "P7").map((x) => x.reason).sort();
    expect(reasons).toEqual(["hidden_layer", "invisible", "off_page", "same_color", "tiny"]);
  });

  it("画像の上の見えない字（文字認識の層）は残す", async () => {
    const pdf = await makePdf("q 280 0 0 180 10 10 cm /Im1 Do Q BT 3 Tr /F1 12 Tf 20 100 Td (OCRLAYER) Tj ET", {
      xobjects: (doc) => ({ Im1: doc.context.register(doc.context.stream(new Uint8Array([200]), { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8 })) }),
    });
    const r = ok(await sanitizePdf(pdf));
    expect(await allText(r.bytes)).toContain("OCRLAYER");
    expect(r.removed.filter((x) => x.pattern === "P7")).toEqual([]);
  });
});

describe("文書全体の隠れた情報", () => {
  async function richPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setAuthor("Yamada Hanako");
    doc.setTitle("Draft title");
    doc.setKeywords(["kw"]);
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    await doc.attach(new TextEncoder().encode("ATTACHED-SECRET-CONTENT"), "budget.xlsx", { mimeType: "application/vnd.ms-excel" });
    doc.addJavaScript("hello", "app.alert('x');");
    const xmp = ctx.register(ctx.stream("<x:xmpmeta><dc:creator>Yamada Hanako</dc:creator></x:xmpmeta>", { Type: "Metadata", Subtype: "XML" }));
    doc.catalog.set(PDFName.of("Metadata"), xmp);
    const popup = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [0, 0, 10, 10] }));
    const note = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [10, 10, 30, 30], Contents: PDFString.of("Reviewer comment"), T: PDFString.of("Suzuki Ichiro"), Popup: popup }));
    page.node.set(PDFName.of("Annots"), ctx.obj([note, popup]));
    page.node.set(PDFName.of("AA"), ctx.obj({ O: { S: "JavaScript", JS: PDFString.of("app.alert(1)") } }));
    return new Uint8Array(await doc.save({ useObjectStreams: false }));
  }

  it("文書情報・XMP・添付・JavaScript・注釈の中身を消し、取り除いた項目を返す", async () => {
    const before = await richPdf();
    const r = ok(await sanitizePdf(before));
    const s = latin1(r.bytes);
    for (const secret of ["Yamada", "Draft title", "ATTACHED-SECRET", "budget.xlsx", "app.alert", "Reviewer comment", "Suzuki", "/JavaScript", "/EmbeddedFile", "/Metadata", "/Info"]) {
      expect(s).not.toContain(secret);
    }
    const kinds = new Set(r.removed.map((x) => x.kind));
    for (const k of ["docinfo", "xmp", "attachment", "javascript", "comment_annotation", "popup"]) expect(kinds.has(k as never)).toBe(true);
    // 片付けの結果の一覧に、中身（名前など）を入れない
    expect(JSON.stringify(r.removed)).not.toMatch(/Yamada|Suzuki|budget|Reviewer/);
    // 付箋と吹き出しは、まるごと外す（ページに注釈が残らない）
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getPages()[0]!.node.get(PDFName.of("Annots"))).toBeUndefined();
  });

  it("付箋と吹き出しはまるごと外し、リンク・強調の注釈は残す（強調はコメント・作者名だけ消す）", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const popup = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [0, 0, 10, 10] }));
    const note = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [10, 10, 30, 30], Contents: PDFString.of("NOTE-SECRET"), T: PDFString.of("NOTE-AUTHOR"), Popup: popup }));
    const reply = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [10, 10, 30, 30], Contents: PDFString.of("REPLY-SECRET"), IRT: note }));
    const hl = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Highlight", Rect: [40, 40, 90, 50], QuadPoints: [40, 50, 90, 50, 40, 40, 90, 40], Contents: PDFString.of("HL-SECRET"), T: PDFString.of("HL-AUTHOR"), IRT: note }));
    const link = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [100, 100, 150, 120], A: { S: "URI", URI: PDFString.of("https://example.com/") } }));
    page.node.set(PDFName.of("Annots"), ctx.obj([note, popup, reply, hl, link]));
    const r = ok(await sanitizePdf(new Uint8Array(await doc.save({ useObjectStreams: false }))));
    const s = latin1(r.bytes);
    for (const secret of ["NOTE-SECRET", "NOTE-AUTHOR", "REPLY-SECRET", "HL-SECRET", "HL-AUTHOR", "/Popup", "/IRT"]) expect(s).not.toContain(secret);
    const after = await PDFDocument.load(r.bytes);
    const annots = after.getPages()[0]!.node.lookup(PDFName.of("Annots"), PDFArray);
    const subtypes = annots.asArray().map((x) => (after.context.lookup(x) as PDFDict).get(PDFName.of("Subtype"))?.toString());
    expect(subtypes.sort()).toEqual(["/Highlight", "/Link"]);
    const comment = r.removed.find((x) => x.kind === "comment_annotation");
    expect(comment?.count).toBe(2);
    expect(r.removed.find((x) => x.kind === "popup")?.count).toBe(1);
    expect(r.removed.find((x) => x.kind === "annotation_content")?.count).toBe(1);
  });

  it("圧縮した中身のストリームの中にも、添付の中身が残っていない", async () => {
    const r = ok(await sanitizePdf(await richPdf()));
    const doc = await PDFDocument.load(r.bytes);
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream) expect(latin1(decodePDFRawStream(obj).decode())).not.toContain("ATTACHED-SECRET");
    }
  });

  it("1つの版にまとめる（%%EOF が1つ、/Prev がない）", async () => {
    const file = path.join(ROOT, "fixtures", "p5", "p5-15-three-revisions.pdf");
    const before = new Uint8Array(readFileSync(file));
    expect(latin1(before).split("%%EOF").length - 1).toBeGreaterThan(1);
    const r = ok(await sanitizePdf(before));
    const s = latin1(r.bytes);
    expect(s.split("%%EOF").length - 1).toBe(1);
    expect(s).not.toContain("/Prev");
    expect(r.removed.some((x) => x.kind === "previous_versions")).toBe(true);
  });

  it("パスワードなしで開ける暗号化は外して書き出す", async () => {
    const r = ok(await sanitizePdf(makeEncryptedPdf({ method: "aesv2" })));
    expect(r.decrypted).toBe(true);
    expect(latin1(r.bytes)).not.toContain("/Encrypt");
  });

  it("パスワードが要る PDF・壊れた PDF・空のファイルは、止まらずにエラーを返す", async () => {
    expect(await sanitizePdf(makeEncryptedPdf({ userPassword: "pw" }))).toMatchObject({ status: "error", code: "encrypted" });
    expect(await sanitizePdf(new TextEncoder().encode("not a pdf at all"))).toMatchObject({ status: "error" });
    expect(await sanitizePdf(new Uint8Array(0))).toMatchObject({ status: "error", code: "empty" });
    const good = await makePdf("BT /F1 12 Tf 20 100 Td (X) Tj ET");
    expect(await sanitizePdf(good.subarray(0, Math.floor(good.length / 2)))).toHaveProperty("status");
  });

  it("ページ数・ページの大きさは変わらない", async () => {
    const before = await makePdf("BT /F1 12 Tf 20 100 Td (Name: TARO) Tj ET 0 g 55 95 50 20 re f");
    const r = ok(await sanitizePdf(before));
    const a = await PDFDocument.load(r.bytes);
    const b = await PDFDocument.load(before);
    expect(a.getPageCount()).toBe(b.getPageCount());
    expect(a.getPages()[0]!.getSize()).toEqual(b.getPages()[0]!.getSize());
  });
});

/** ファイルの全体と、すべてのストリームを開いた中身（中身が残っていないかを確かめる） */
async function everything(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const parts = [latin1(bytes)];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) parts.push(latin1(decodePDFRawStream(obj).decode()));
  }
  return parts.join("\n");
}

describe("字の読み替え・縮小画像・独自データ", () => {
  it("/ActualText を、構造ツリー・属性の辞書・ページの中のマーク付きの中身から消す。見える字は残す", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const page = doc.addPage([300, 200]);
    const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
    const prop = ctx.register(ctx.obj({ ActualText: PDFString.of("PROP-SECRET"), MCID: 1 }));
    page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font }, Properties: { P0: prop } }));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(
      "BT /F1 12 Tf 20 150 Td /Span <</MCID 0 /ActualText (INLINE-SECRET)>> BDC (Visible) Tj EMC ET\n" +
      "BT /F1 12 Tf 20 120 Td /Span /P0 BDC (Second) Tj EMC ET",
    )));
    const elem = ctx.register(ctx.obj({ Type: "StructElem", S: "Span", ActualText: PDFString.of("STRUCT-SECRET"), Alt: PDFString.of("alt"), Pg: page.ref, K: 0 }));
    const root = ctx.register(ctx.obj({ Type: "StructTreeRoot", K: [elem] }));
    doc.catalog.set(PDFName.of("StructTreeRoot"), root);
    const before = new Uint8Array(await doc.save({ useObjectStreams: false }));
    const itemsBefore = await textItems(before);

    const r = ok(await sanitizePdf(before));
    const all = await everything(r.bytes);
    for (const secret of ["INLINE-SECRET", "PROP-SECRET", "STRUCT-SECRET", "/ActualText"]) expect(all).not.toContain(secret);
    // 見える字と位置は変わらない。構造ツリーそのもの・マーク付きの中身の番号（MCID）は残す
    expect(await textItems(r.bytes)).toEqual(itemsBefore);
    expect(all).toContain("/StructTreeRoot");
    expect(all).toContain("/MCID 0");
    const items = r.removed.filter((x) => x.kind === "actual_text");
    expect(items.reduce((n, x) => n + x.count, 0)).toBe(3);
    expect(items.every((x) => x.pattern === "P7")).toBe(true);
    expect(JSON.stringify(r.removed)).not.toMatch(/SECRET/);
  });

  it("ページの縮小画像（/Thumb）を外し、画像もファイルから消す", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    for (let i = 0; i < 2; i++) {
      const page = doc.addPage([200, 200]);
      const thumb = ctx.register(ctx.stream("THUMB-SECRET-PIXELS", { Width: 19, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
      page.node.set(PDFName.of("Thumb"), thumb);
    }
    const r = ok(await sanitizePdf(new Uint8Array(await doc.save({ useObjectStreams: false }))));
    const all = await everything(r.bytes);
    expect(all).not.toContain("THUMB-SECRET");
    expect(all).not.toContain("/Thumb");
    expect(r.removed.find((x) => x.kind === "thumbnail")?.count).toBe(2);
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(2);
  });

  it("アプリの独自データ（/PieceInfo と /LastModified）を、文書・ページ・部品から外す", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const page = doc.addPage([200, 200]);
    const piece = () => ctx.obj({ App: { LastModified: PDFString.of("D:20260101"), Private: ctx.register(ctx.stream("PIECE-SECRET-DATA")) } });
    doc.catalog.set(PDFName.of("PieceInfo"), piece());
    page.node.set(PDFName.of("PieceInfo"), piece());
    page.node.set(PDFName.of("LastModified"), PDFString.of("D:20260102"));
    const form = ctx.register(ctx.stream("0 0 10 10 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], PieceInfo: piece(), LastModified: PDFString.of("D:20260103") }));
    page.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { Fm1: form } }));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("q /Fm1 Do Q")));
    const r = ok(await sanitizePdf(new Uint8Array(await doc.save({ useObjectStreams: false }))));
    const all = await everything(r.bytes);
    for (const secret of ["PIECE-SECRET", "/PieceInfo", "/LastModified", "D:2026"]) expect(all).not.toContain(secret);
    expect(r.removed.find((x) => x.kind === "piece_info")?.count).toBe(3);
    // 部品そのものは残す（描いた中身は変えない）
    expect(all).toContain("/Fm1");
  });
});

describe("通信しない（sanitize/）", () => {
  const list = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? (n === "check" || n === "node" ? [] : list(p)) : /\.ts$/.test(n) ? [p] : [];
    });
  it("ブラウザで動く片付けのコードに、通信の仕組みがない", () => {
    const files = list(path.join(ROOT, "sanitize"));
    expect(files.length).toBeGreaterThan(0);
    // 例外：XMP を書くのに要る名前空間の名前（通信には使わない決まった名前。0.9.0 のプロパティの書き直しから）。
    // 引用符で閉じた、この 5 つと完全に同じものだけを除く
    const XMP_NAMESPACES = [
      "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      "http://purl.org/dc/elements/1.1/",
      "http://ns.adobe.com/xap/1.0/",
      "http://ns.adobe.com/pdf/1.3/",
      "http://www.aiim.org/pdfa/ns/id/",
    ];
    for (const f of files) {
      let s = readFileSync(f, "utf8");
      for (const ns of XMP_NAMESPACES) s = s.split(`"${ns}"`).join('""');
      expect(s, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|importScripts|https?:\/\//);
    }
  });
  it("ブラウザで動く片付けのコードは、Node だけの部品と確かめの道具を読まない", () => {
    for (const f of list(path.join(ROOT, "sanitize"))) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/from "node:|from "\.\/check|from "\.\/node|pdfjs-dist|@napi-rs/);
    }
  });
});

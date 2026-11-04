// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする（sanitize/redact.ts）のテスト・採点に使う合成 PDF を作る。中身はすべて架空の名前・番号。
// fixtures/ は採点する側として書き込みを止めているので、PDF はここで作る（テスト・採点のたびに同じものができる）。
//
// 書体：埋め込まない Type0（Identity-H／Identity-V）。字のコードと字の対応表（/ToUnicode）を自分で決める。
// 字の幅はすべて 1000（全角）。縦書きは /DW2 [880 -1000]。

import { deflateSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts, type PDFContext, type PDFRef } from "pdf-lib";

/** 架空の字の並びに使う字（どれも 1 字 1 コード） */
export const CHARS = "氏名見本花子太郎住所東西南北町丁目電話番号〇一二三四五六七八九生年月日備考欄";

const CODE = new Map([...CHARS].map((c, i) => [c, i + 1] as const));

/** 字の並びを、Type0 の書体のコード（2 バイト）の 16 進に */
export function hex(text: string): string {
  return [...text].map((c) => {
    const code = CODE.get(c);
    if (code === undefined) throw new Error(`書体にない字です：${c}`);
    return code.toString(16).padStart(4, "0");
  }).join("");
}

function toUnicode(): string {
  const entries = [...CHARS].map((c, i) => `<${(i + 1).toString(16).padStart(4, "0")}> <${c.charCodeAt(0).toString(16).padStart(4, "0")}>`);
  return [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Test-UCS def /CMapType 2 def",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    `${entries.length} beginbfchar`, ...entries, "endbfchar",
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
}

/** 埋め込まない Type0 の書体を作る（vertical なら Identity-V） */
export function type0Font(ctx: PDFContext, vertical = false): PDFRef {
  const desc = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "TestGothic", Flags: 4, FontBBox: [0, -120, 1000, 880], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 700, StemV: 80 }));
  const cid = ctx.register(ctx.obj({
    Type: "Font", Subtype: "CIDFontType2", BaseFont: "TestGothic", CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
    FontDescriptor: desc, DW: 1000, DW2: [880, -1000], CIDToGIDMap: "Identity",
  }));
  return ctx.register(ctx.obj({
    Type: "Font", Subtype: "Type0", BaseFont: "TestGothic", Encoding: vertical ? "Identity-V" : "Identity-H",
    DescendantFonts: [cid], ToUnicode: ctx.register(ctx.stream(toUnicode())),
  }));
}

/** 字の並びを描く命令（横書き。x, y は字の原点。大きさ 12） */
export function textAt(x: number, y: number, text: string, font = "/F1", size = 12): string {
  return `BT ${font} ${size} Tf ${x} ${y} Td <${hex(text)}> Tj ET\n`;
}

/** ローマ字・数字を Helvetica で描く命令 */
export function latinAt(x: number, y: number, text: string, size = 12): string {
  return `BT /H1 ${size} Tf ${x} ${y} Td (${text}) Tj ET\n`;
}

export type PageSpec = {
  content: string;
  size?: [number, number];
  /** 画像（/Im1、/Im2…）。描く命令は content に書く */
  images?: PDFRef[];
  annots?: Array<Record<string, unknown>>;
  thumb?: boolean;
};

export type DocSpec = { pages: PageSpec[]; vertical?: boolean; acroForm?: (ctx: PDFContext, widgets: PDFRef[]) => void };

/** ページを作る。images は doc.context で作ってから渡す（imageFlate など） */
export async function buildPdf(build: (doc: PDFDocument) => DocSpec | Promise<DocSpec>): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const spec = await build(doc);
  const f1 = type0Font(ctx, false);
  const v1 = type0Font(ctx, true);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const widgets: PDFRef[] = [];
  for (const p of spec.pages) {
    const page = doc.addPage(p.size ?? [400, 300]);
    const xo: Record<string, PDFRef> = {};
    (p.images ?? []).forEach((ref, i) => (xo[`Im${i + 1}`] = ref));
    page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: f1, V1: v1, H1: helv.ref }, XObject: xo }));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(p.content)));
    if (p.annots?.length) {
      const refs = p.annots.map((a) => {
        const r = ctx.register(ctx.obj({ Type: "Annot", P: page.ref, ...a } as never));
        if (a.Subtype === "Widget") widgets.push(r);
        return r;
      });
      page.node.set(PDFName.of("Annots"), ctx.obj(refs));
    }
    if (p.thumb) page.node.set(PDFName.of("Thumb"), imageFlate(ctx, 8, 8, 1, new Uint8Array(64).fill(128)));
  }
  spec.acroForm?.(ctx, widgets);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

/** Flate の画像（comps 1 は灰色、3 は RGB）。smask を渡すと /SMask をつける */
export function imageFlate(ctx: PDFContext, w: number, h: number, comps: 1 | 3, pixels: Uint8Array, smask?: Uint8Array): PDFRef {
  const dict: Record<string, unknown> = {
    Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: comps === 1 ? "DeviceGray" : "DeviceRGB", BitsPerComponent: 8, Filter: "FlateDecode",
  };
  if (smask) dict.SMask = imageFlate(ctx, w, h, 1, smask);
  return ctx.register(PDFRawStream.of(ctx.obj(dict as never) as unknown as PDFDict, new Uint8Array(deflateSync(pixels))));
}

/** スキャンのような灰色の画像：白地に、横縞の「字の行」（濃い灰色）を描く */
export function scanPixels(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h).fill(250);
  for (let y = 0; y < h; y++) {
    if (y % 10 >= 4) continue;
    for (let x = 4; x < w - 4; x++) if ((x >> 2) % 3 !== 0) px[y * w + x] = 30;
  }
  return px;
}

/** JPEG の画像（RGB）。中身は scanPixels と同じ模様 */
export async function imageJpeg(ctx: PDFContext, w: number, h: number): Promise<PDFRef> {
  const canvas = createCanvas(w, h);
  const g = canvas.getContext("2d");
  const img = g.createImageData(w, h);
  const px = scanPixels(w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = px[i]!;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const bytes = new Uint8Array(await canvas.encode("jpeg", 92));
  return ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" }), bytes));
}

/**
 * 前の版のある PDF：base を書いたあと、1 ページ目の中身を差し替える増分更新を足す。
 * 前の版の中身（oldContent）はファイルに残る（ビューアーでは見えない）
 */
export function appendRevision(base: Uint8Array, newContent: string): Uint8Array {
  const text = new TextDecoder("latin1").decode(base);
  // 1 ページ目のオブジェクトの番号と中身を探す（pdf-lib が書いた形を前提にする）
  const pageMatch = [...text.matchAll(/(\d+) 0 obj([^]*?)endobj/g)].find((m) => /\/Type \/Page(?![a-z])/.test(m[2]!));
  if (!pageMatch) throw new Error("ページが見つかりません");
  const pageNum = Number(pageMatch[1]);
  const pageBody = pageMatch[2]!.trim();
  const sizeMatch = /\/Size (\d+)/.exec(text.slice(text.lastIndexOf("trailer")));
  const rootMatch = /\/Root (\d+ 0 R)/.exec(text.slice(text.lastIndexOf("trailer")));
  const startxref = Number(/startxref\s+(\d+)/.exec(text.slice(text.lastIndexOf("startxref")))![1]);
  const size = Number(sizeMatch![1]);
  const contentNum = size;
  const newPage = pageBody.replace(/\/Contents \d+ 0 R/, `/Contents ${contentNum} 0 R`);
  let out = text.endsWith("\n") ? text : text + "\n";
  const offContent = out.length;
  out += `${contentNum} 0 obj\n<< /Length ${newContent.length} >>\nstream\n${newContent}\nendstream\nendobj\n`;
  const offPage = out.length;
  out += `${pageNum} 0 obj\n${newPage}\nendobj\n`;
  const xref = out.length;
  const pad = (n: number) => n.toString().padStart(10, "0");
  out += `xref\n${pageNum} 1\n${pad(offPage)} 00000 n \n${contentNum} 1\n${pad(offContent)} 00000 n \n`;
  out += `trailer\n<< /Size ${size + 1} /Root ${rootMatch![1]} /Prev ${startxref} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array([...out].map((c) => c.charCodeAt(0)));
}

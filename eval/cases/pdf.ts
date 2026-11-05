// SPDX-License-Identifier: AGPL-3.0-only
//
// 新しい型（P2 の文書全体の XMP・P8・P10・P11・P12 など）の合成 PDF を、その場で作る部品。
// テスト（tests/*.test.ts）と、仮の採点（eval/new-rules.ts）で同じものを使う。
// 中身はすべて架空のもの（山田太郎・架空の番号など）。外の道具の PDF・期待値は使わない。
// fixtures/ は採点する側の場所（Claude は書かない。CLAUDE.md §2-3）なので、ファイルには書き出さず、毎回作る。

import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString, StandardFonts, type PDFContext, type PDFPage } from "pdf-lib";

/** 1件の合成 PDF。leaks は、検出ルールが返すべきものの鍵（型ごとの鍵の作り方は eval/cases/<型>.ts） */
export type Case = {
  id: string;
  /** leak＝隠しあり、control＝何も隠していない対照（誤検知しないことを見る） */
  kind: "leak" | "control";
  description: string;
  build(): Promise<Uint8Array>;
  leaks: string[];
};

export const hex = (s: string) => PDFHexString.fromText(s); // UTF-16BE
export const lit = (s: string) => PDFString.of(s);

export async function newDoc(pages = 1): Promise<{ doc: PDFDocument; ctx: PDFContext; pages: PDFPage[] }> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const list: PDFPage[] = [];
  for (let i = 0; i < pages; i++) list.push(doc.addPage([300, 200]));
  return { doc, ctx: doc.context, pages: list };
}

export async function save(doc: PDFDocument, objectStreams = false): Promise<Uint8Array> {
  return new Uint8Array(await doc.save({ useObjectStreams: objectStreams, updateFieldAppearances: false }));
}

/** ページに注釈を足す（既にある /Annots に足す） */
export function addAnnot(ctx: PDFContext, page: PDFPage, entries: Record<string, unknown>): PDFRef {
  const ref = ctx.register(ctx.obj({ Type: "Annot", Rect: [10, 10, 80, 40], ...entries } as never));
  const annots = page.node.lookup(PDFName.of("Annots"));
  const list = annots && "asArray" in annots ? (annots as unknown as { asArray(): PDFRef[] }).asArray() : [];
  page.node.set(PDFName.of("Annots"), ctx.obj([...list, ref]));
  return ref;
}

/** 標準の書体（Helvetica）で字を描く、見た目のストリーム（フォーム XObject） */
export async function textAppearance(doc: PDFDocument, text: string, opts: { mode?: number } = {}): Promise<PDFRef> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const esc = text.replace(/([()\\])/g, "\\$1");
  const body = `BT /F1 12 Tf ${opts.mode !== undefined ? `${opts.mode} Tr ` : ""}2 10 Td (${esc}) Tj ET`;
  const stream = ctx.stream(body, {
    Type: "XObject",
    Subtype: "Form",
    BBox: [0, 0, 70, 30],
    Resources: { Font: { F1: font.ref } },
  });
  return ctx.register(stream);
}

/** 図形だけの見た目のストリーム（字なし） */
export function shapeAppearance(ctx: PDFContext): PDFRef {
  return ctx.register(ctx.stream("0 0 1 rg 0 0 70 30 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 70, 30] }));
}

/** XMP の包み（x:xmpmeta と rdf:RDF）。body は rdf:Description の中身 */
export function xmpPacket(attrs: string, body: string): string {
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about=""',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    ' xmlns:pdf="http://ns.adobe.com/pdf/1.3/"',
    ' xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"',
    ' xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"',
    ' xmlns:stRef="http://ns.adobe.com/xap/1.0/sType/ResourceRef#"',
    ' xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"',
    ' xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"',
    ' xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/"',
    ` ${attrs}>`,
    body,
    "</rdf:Description>",
    "</rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("\n");
}

/** カタログに /Metadata の XMP を付ける。compressed なら Flate で圧縮する */
export function setCatalogXmp(doc: PDFDocument, xml: string, compressed: boolean): PDFRef {
  const ctx = doc.context;
  const bytes = new TextEncoder().encode(xml);
  const stream = compressed ? ctx.flateStream(bytes, { Type: "Metadata", Subtype: "XML" }) : ctx.stream(bytes, { Type: "Metadata", Subtype: "XML" });
  const ref = ctx.register(stream);
  doc.catalog.set(PDFName.of("Metadata"), ref);
  return ref;
}

/** 文書情報（/Info）を付ける */
export function setInfo(doc: PDFDocument, entries: Record<string, PDFString | PDFHexString>): PDFRef {
  const ctx = doc.context;
  const dict = ctx.obj({}) as PDFDict;
  for (const [k, v] of Object.entries(entries)) dict.set(PDFName.of(k), v);
  const ref = ctx.register(dict);
  ctx.trailerInfo.Info = ref;
  return ref;
}

// ---------------------------------------------------------------- JPEG（Exif つき）

/** Exif の欄（IFD の1つ）。type 1＝BYTE、2＝ASCII、3＝SHORT、4＝LONG、5＝RATIONAL */
export type IfdEntry = { tag: number; type: 1 | 2 | 3 | 4 | 5; value: string | number | number[] };

function asciiBytes(s: string): number[] {
  return [...new TextEncoder().encode(s), 0];
}

/**
 * TIFF（ビッグエンディアン、"MM"）の Exif の中身を作る。
 * ifd0：最初の IFD。gps：GPS の IFD（あれば 0x8825 で指す）。exif：Exif の IFD（0x8769）。
 * thumbnail：IFD1 に付ける縮小画像（JPEG のバイト列。0x201・0x202 で指す）
 */
export function buildExifTiff(opts: { ifd0?: IfdEntry[]; gps?: IfdEntry[]; exif?: IfdEntry[]; thumbnail?: Uint8Array }): Uint8Array {
  const out: number[] = [];
  const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
  const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  // 大きさを先に決めるため、IFD ごとに中身を組み立てる
  type Built = { entries: IfdEntry[] };
  const ifd0: IfdEntry[] = [...(opts.ifd0 ?? [])];
  const ifdList: Array<{ key: string; entries: IfdEntry[] }> = [{ key: "ifd0", entries: ifd0 }];
  if (opts.exif) ifdList.push({ key: "exif", entries: opts.exif });
  if (opts.gps) ifdList.push({ key: "gps", entries: opts.gps });
  if (opts.thumbnail) ifdList.push({ key: "ifd1", entries: [{ tag: 0x0103, type: 3, value: 6 }] });
  // 指す欄を先に入れておく（値はあとで埋める）
  if (opts.exif) ifd0.push({ tag: 0x8769, type: 4, value: 0 });
  if (opts.gps) ifd0.push({ tag: 0x8825, type: 4, value: 0 });
  if (opts.thumbnail) {
    const ifd1 = ifdList.find((x) => x.key === "ifd1")!.entries;
    ifd1.push({ tag: 0x0201, type: 4, value: 0 }, { tag: 0x0202, type: 4, value: opts.thumbnail.length });
  }
  for (const x of ifdList) x.entries.sort((a, b) => a.tag - b.tag);

  const valueBytes = (e: IfdEntry): number[] => {
    if (e.type === 2) return asciiBytes(String(e.value));
    const vals = Array.isArray(e.value) ? e.value : [Number(e.value)];
    if (e.type === 1) return vals.map((v) => v & 0xff);
    if (e.type === 3) return vals.flatMap((v) => u16(v));
    if (e.type === 4) return vals.flatMap((v) => u32(v));
    return vals.flatMap((v) => u32(v)); // RATIONAL は2つずつ（分子・分母）並べて渡す
  };
  const countOf = (e: IfdEntry): number => {
    if (e.type === 2) return asciiBytes(String(e.value)).length;
    const vals = Array.isArray(e.value) ? e.value : [Number(e.value)];
    return e.type === 5 ? vals.length / 2 : vals.length;
  };
  const ifdSize = (b: Built) => 2 + b.entries.length * 12 + 4 + b.entries.reduce((s, e) => s + (valueBytes(e).length > 4 ? valueBytes(e).length : 0), 0);

  // 置き場所を決める
  let at = 8;
  const offsets = new Map<string, number>();
  for (const x of ifdList) {
    offsets.set(x.key, at);
    at += ifdSize(x);
  }
  const thumbAt = at;
  // 指す欄を埋める
  for (const e of ifd0) {
    if (e.tag === 0x8769) e.value = offsets.get("exif")!;
    if (e.tag === 0x8825) e.value = offsets.get("gps")!;
  }
  if (opts.thumbnail) ifdList.find((x) => x.key === "ifd1")!.entries.find((e) => e.tag === 0x0201)!.value = thumbAt;

  out.push(0x4d, 0x4d, ...u16(42), ...u32(8));
  for (const x of ifdList) {
    const start = offsets.get(x.key)!;
    let extra = start + 2 + x.entries.length * 12 + 4;
    const tail: number[] = [];
    out.push(...u16(x.entries.length));
    for (const e of x.entries) {
      const vb = valueBytes(e);
      out.push(...u16(e.tag), ...u16(e.type), ...u32(countOf(e)));
      if (vb.length <= 4) out.push(...vb, ...new Array(4 - vb.length).fill(0));
      else {
        out.push(...u32(extra));
        tail.push(...vb);
        extra += vb.length;
      }
    }
    const next = x.key === "ifd0" && opts.thumbnail ? offsets.get("ifd1")! : 0;
    out.push(...u32(next), ...tail);
  }
  if (opts.thumbnail) out.push(...opts.thumbnail);
  return new Uint8Array(out);
}

/**
 * 小さな JPEG（8×8 の灰色、ベースライン）。exifTiff を渡すと APP1 の Exif を付ける。
 * 画素の中身は検出ルールでは見ないので、決まった最小の符号だけを並べる。
 */
export function tinyJpeg(exifTiff?: Uint8Array, extraApp?: Uint8Array): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  const seg = (marker: number, body: number[]) => {
    const len = body.length + 2;
    parts.push(0xff, marker, (len >> 8) & 0xff, len & 0xff, ...body);
  };
  seg(0xe0, [...new TextEncoder().encode("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  if (exifTiff) seg(0xe1, [...new TextEncoder().encode("Exif"), 0, 0, ...exifTiff]);
  if (extraApp) seg(0xe1, [...extraApp]);
  // 量子化表（すべて 1）
  seg(0xdb, [0x00, ...new Array(64).fill(1)]);
  // フレームの見出し（8×8、1色）
  seg(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]);
  // ハフマン表：DC は「0 ビットの差」だけ、AC は「ブロックの終わり」だけ
  seg(0xc4, [0x00, 1, ...new Array(15).fill(0), 0x00]);
  seg(0xc4, [0x10, 1, ...new Array(15).fill(0), 0x00]);
  // スキャン
  seg(0xda, [1, 1, 0x00, 0, 63, 0]);
  parts.push(0x00, 0xff, 0xd9);
  return new Uint8Array(parts);
}

/** JPEG の画像をページに置く（DCTDecode のまま入れる） */
export function placeJpeg(ctx: PDFContext, page: PDFPage, jpeg: Uint8Array, name = "Im1"): PDFRef {
  const stream = ctx.stream(jpeg, { Type: "XObject", Subtype: "Image", Width: 8, Height: 8, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "DCTDecode" });
  const ref = ctx.register(stream);
  const res = page.node.Resources() ?? (ctx.obj({}) as PDFDict);
  page.node.set(PDFName.of("Resources"), res);
  let xo = res.lookup(PDFName.of("XObject"));
  if (!(xo instanceof PDFDict)) {
    xo = ctx.obj({}) as PDFDict;
    res.set(PDFName.of("XObject"), xo);
  }
  (xo as PDFDict).set(PDFName.of(name), ref);
  const content = ctx.register(ctx.stream(`q 100 0 0 100 10 10 cm /${name} Do Q`));
  page.node.set(PDFName.of("Contents"), content);
  return ref;
}

/** ページに欧文の字を描く（Helvetica。行ごとに1つ） */
export async function drawAscii(doc: PDFDocument, page: PDFPage, lines: string[]): Promise<void> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((t, i) => page.drawText(t, { x: 10, y: 170 - i * 16, size: 10, font }));
}

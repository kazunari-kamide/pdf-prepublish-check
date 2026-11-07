// SPDX-License-Identifier: AGPL-3.0-only
//
// CFF の書体に残った字形（font-glyphs-cff）の合成 PDF。鍵は「leftover」（余った字形のある書体1つにつき1つ）。
// 書体は、その場で組み立てる架空の CFF（字の形は四角を描くだけ）。字の名前は A〜J の欧字で、中身はすべて架空。

import { PDFDocument, PDFName, PDFString, type PDFRef } from "pdf-lib";
import type { CffGlyphReport } from "../../rules/font-glyphs-cff/index.ts";
import { save, type Case } from "./pdf.ts";

export const keysOf = (r: CffGlyphReport) => r.findings.map(() => "leftover");

/** CFF の INDEX（offSize 4） */
function index(items: number[][]): number[] {
  if (items.length === 0) return [0, 0];
  const out = [(items.length >> 8) & 0xff, items.length & 0xff, 4];
  let at = 1;
  const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  out.push(...u32(at));
  for (const it of items) out.push(...u32((at += it.length)));
  for (const it of items) out.push(...it);
  return out;
}

const int5 = (v: number) => [29, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/**
 * 架空の CFF を作る。glyphs 個の形のある字形（字の形の番号 1〜glyphs。名前は A から順）と、
 * space なら形の無い字形 space を最後に足す。字の形 0 は .notdef（形なし）
 */
export function buildCff(glyphs: number, space = false): Uint8Array {
  const cs: number[][] = [[14]];
  const sids: number[] = [];
  for (let i = 0; i < glyphs; i++) {
    // i 番目の字：四角を描く（大きさを字ごとに変える）。数は 1 バイトの形（v + 139）
    const w = 20 + i * 5;
    cs.push([139, 139, 21, w + 139, 139, 5, 139, w + 139, 5, 139 - w, 139, 5, 14]);
    sids.push(34 + i); // A＝34
  }
  if (space) {
    cs.push([14]);
    sids.push(1); // space＝1
  }
  const name = index([[..."KAKUUD+Kakuu"].map((c) => c.charCodeAt(0))]);
  const strings = index([]);
  const gsubrs = index([]);
  const charset = [0, ...sids.flatMap((s) => [(s >> 8) & 0xff, s & 0xff])];
  // Top DICT の大きさは決まっている（charset と CharStrings の位置を 5 バイトの数で書く）
  const topSize = 5 + 1 + 5 + 1;
  const topIndexSize = 2 + 1 + 8 + topSize;
  const charsetAt = 4 + name.length + topIndexSize + strings.length + gsubrs.length;
  const csAt = charsetAt + charset.length;
  const top = index([[...int5(charsetAt), 15, ...int5(csAt), 17]]);
  return new Uint8Array([1, 0, 4, 4, ...name, ...top, ...strings, ...gsubrs, ...charset, ...index(cs)]);
}

const hex2 = (gids: number[]) => `<${gids.map((g) => g.toString(16).padStart(4, "0")).join("")}>`;

/** CIDFontType0C の書体（Identity-H）で、字の形の番号 drawn を描く。黒い四角も置く（下に字は無い） */
async function buildCid(glyphs: number, drawn: number[], opts: { space?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  const file = ctx.register(ctx.stream(buildCff(glyphs, opts.space), { Subtype: "CIDFontType0C" }));
  const fd = ctx.register(
    ctx.obj({ Type: "FontDescriptor", FontName: "KAKUUD+Kakuu", Flags: 4, FontBBox: [0, 0, 1000, 1000], ItalicAngle: 0, Ascent: 900, Descent: -100, CapHeight: 700, StemV: 80, FontFile3: file } as never),
  );
  const cid = ctx.register(
    ctx.obj({ Type: "Font", Subtype: "CIDFontType0", BaseFont: "KAKUUD+Kakuu", CIDSystemInfo: ctx.obj({ Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 } as never), FontDescriptor: fd, DW: 1000 } as never),
  );
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "KAKUUD+Kakuu", Encoding: "Identity-H", DescendantFonts: [cid] } as never));
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: ctx.obj({ F1: font } as never) } as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(`BT /F1 12 Tf 20 100 Td ${hex2(drawn)} Tj ET 0 0 0 rg 150 95 100 16 re f`)));
  return save(doc);
}

/** Type1C の 1 バイトの書体で、shown（A〜J の欧字）を描く。encoding：differences＝/Differences で A〜、winansi＝名前だけ */
async function buildSimple(glyphs: number, shown: string, opts: { encoding?: "differences" | "winansi"; tag?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  const base = opts.tag === false ? "KakuuSans" : "KAKUUE+KakuuSans";
  const file = ctx.register(ctx.stream(buildCff(glyphs), { Subtype: "Type1C" }));
  const fd = ctx.register(
    ctx.obj({ Type: "FontDescriptor", FontName: base, Flags: 32, FontBBox: [0, 0, 1000, 1000], ItalicAngle: 0, Ascent: 900, Descent: -100, CapHeight: 700, StemV: 80, FontFile3: file } as never),
  );
  const letters = Array.from({ length: glyphs }, (_, i) => PDFName.of(String.fromCharCode(65 + i)));
  const encoding = opts.encoding === "winansi" ? PDFName.of("WinAnsiEncoding") : ctx.obj({ Type: "Encoding", Differences: [65, ...letters] } as never);
  const font: PDFRef = ctx.register(
    ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: base, FirstChar: 65, LastChar: 64 + glyphs, Widths: Array.from({ length: glyphs }, () => 600), Encoding: encoding, FontDescriptor: fd } as never),
  );
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: ctx.obj({ F1: font } as never) } as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(`BT /F1 12 Tf 20 100 Td (${shown}) Tj ET 0 0 0 rg 150 95 100 16 re f`)));
  return save(doc);
}

export const CASES: Case[] = [
  {
    id: "cff-l01",
    kind: "leak",
    description: "CIDFontType0C の部分埋め込みに 10 字分の字形。ページで描くのは 3 字だけで、残りの 7 字は黒い四角の下から消した（字形だけ残る）",
    leaks: ["leftover"],
    build: () => buildCid(10, [1, 2, 3]),
  },
  {
    id: "cff-l02",
    kind: "leak",
    description: "Type1C の部分埋め込み（/Differences で A〜J）。ページで描くのは ABC だけで、D〜J の字形が残る",
    leaks: ["leftover"],
    build: () => buildSimple(10, "ABC"),
  },
  {
    id: "cff-l03",
    kind: "leak",
    description: "Type1C の部分埋め込み（/WinAnsiEncoding。/Differences なし）。ABC だけを描き、D〜J の字形が残る",
    leaks: ["leftover"],
    build: () => buildSimple(10, "ABC", { encoding: "winansi" }),
  },
  {
    id: "cff-c01",
    kind: "control",
    description: "CIDFontType0C で、描いた 3 字の字形だけ。形の無い字形（空白）は余っても数えない",
    leaks: [],
    build: () => buildCid(3, [1, 2, 3], { space: true }),
  },
  {
    id: "cff-c02",
    kind: "control",
    description: "Type1C で、描いた ABC の字形だけ",
    leaks: [],
    build: () => buildSimple(3, "ABC"),
  },
  {
    id: "cff-c03",
    kind: "control",
    description: "部分埋め込みの印（ABCDEF+）の無い Type1C（全部の埋め込みとみなす）",
    leaks: [],
    build: () => buildSimple(10, "ABC", { tag: false }),
  },
  {
    id: "cff-c04",
    kind: "control",
    description: "CIDFontType0C で、余りが 1 字だけ（上限より少ない）",
    leaks: [],
    build: () => buildCid(4, [1, 2, 3]),
  },
];

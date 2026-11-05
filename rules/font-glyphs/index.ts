// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：書体に残った字形（`font-glyphs`）1.2.0。26 項目の 22。型は P7（隠れたテキスト）の仲間として扱う【仮】。
// 埋め込みの書体（部分埋め込み＝サブセット）は、ふつう、描いた字の形だけを持つ。
// ページのどこにも描かれていない字の形が残っていれば、前に書いてあって消した字（黒塗りの下だけにあった字など）の手がかりになる。
// 字の形から字を読み取るのは、字の形を描いて見比べる必要があるので、ここでは数だけを返す（字の中身は返さない）。
//
// 見る書体：Type0 の CIDFontType2（TrueType）で、名前がサブセットの印（ABCDEF+）で始まる（1.2.0 からは、印が無くても中身が部分埋め込みの形の）もの。CIDToGIDMap が Identity
//   （または無い）か、ストリームのもの。字のコードは 2 バイトの Identity（CID）とみなす。
// 数え方：書体の字の形のうち、形（glyf の中身）があるもので、どのページ・部品・注釈の見た目でも描かれておらず、
//   描いた字の部品（複合の字形の部品）でもないもの。字の形 0（.notdef）と、形の無い字（空白など）は数えない。
//   合字・記号など、ふつうに少し余る字形があるので、MIN_LEFTOVER 個以上のときだけ出す。
// 1.1.0：Type3 の書体（字の形を PDF の命令で描く書体）も見る。/CharProcs の字の形のうち、塗る・線を引くなどの命令があるもので、
//   /Encoding の /Differences でどの描いた字（1 バイトのコード）からも引かれていないものを数える。Type3 にはサブセットの印が無いので、印は見ない。
// 1.2.0：名前にサブセットの印が無い TrueType も見る（pdf-lib などは印を付けない）。書体の中身が部分埋め込みの形（字の対応表 cmap と
//   名前の表 name が無い。部分埋め込みの道具は、PDF で要らないこの2つを落とす）なら、部分埋め込みとして数える。
//   cmap か name がある印の無い書体は、全部を埋め込んだものとみなして見ない（fullFonts に数える。全部の字形が「余り」になるため）。

import { PDFDict, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { operations } from "../shared/content-lexer.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { appearanceStreams, arrayItems, dictOf, lookup, N, nameOf, numOf, openPdf, streamData, type RuleError } from "../common/index.ts";

export const RULE_ID = "font-glyphs";
export const RULE_VERSION = "1.2.0";

/** これより少ない余りは、ふつうに余る字形（合字・記号）として出さない【仮の値】 */
export const MIN_LEFTOVER = 3;
export const LIMITS = { fontBytes: 32 * 1024 * 1024, streamBytes: 32 * 1024 * 1024, opsPerStream: 3_000_000, glyphs: 70_000 } as const;

export type FontGlyphFinding = {
  pattern: "P7";
  /** 書体の辞書のオブジェクト番号 */
  font: number;
  /** 書体の形（1.1.0） */
  fontType: "truetype" | "type3";
  /** 部分埋め込みと見た理由（1.2.0）。name＝名前の印、tables＝書体の中身の形、type3＝Type3（いつも見る） */
  subsetBy: "name" | "tables" | "type3";
  /** 書体の字の形の数（形のあるもの）と、描かれた数と、余った数 */
  glyphs: number;
  used: number;
  leftover: number;
};

export type FontGlyphReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  findings: FontGlyphFinding[];
  /** 見た書体の数（対象の形のもの）と、形が違って見なかった書体の数 */
  checkedFonts: number;
  skippedFonts: number;
  /** 印が無く、cmap か name の表がある（全部を埋め込んだとみなして見なかった）書体の数（1.2.0。skippedFonts にも入る） */
  fullFonts: number;
  /** 余りが MIN_LEFTOVER より少なくて、出さなかった書体の数 */
  belowThreshold: number;
  limits: Array<"too_many_ops" | "font_too_large" | "broken_font">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

// ---------------------------------------------------------------- TrueType の字の形

type Glyf = { count: number; hasOutline: (gid: number) => boolean; components: (gid: number) => number[] };

/** TrueType の表の名前（head・glyf・cmap など）。壊れていれば例外 */
export function fontTables(font: Uint8Array): Set<string> {
  const v = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const n = v.getUint16(4);
  if (12 + n * 16 > font.length) throw new Error("broken table directory");
  const out = new Set<string>();
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    out.add(String.fromCharCode(font[at]!, font[at + 1]!, font[at + 2]!, font[at + 3]!));
  }
  return out;
}

/** TrueType の表から、字の形の数・形の有無・複合の字形の部品を読む。壊れていれば例外 */
export function readGlyf(font: Uint8Array): Glyf {
  const v = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = new Map<string, { off: number; len: number }>();
  const n = v.getUint16(4);
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(font[at]!, font[at + 1]!, font[at + 2]!, font[at + 3]!);
    tables.set(tag, { off: v.getUint32(at + 8), len: v.getUint32(at + 12) });
  }
  const head = tables.get("head");
  const maxp = tables.get("maxp");
  const loca = tables.get("loca");
  const glyf = tables.get("glyf");
  if (!head || !maxp || !loca || !glyf) throw new Error("no glyf");
  const count = Math.min(v.getUint16(maxp.off + 4), LIMITS.glyphs);
  const long = v.getInt16(head.off + 50) === 1;
  const offset = (g: number) => (long ? v.getUint32(loca.off + g * 4) : v.getUint16(loca.off + g * 2) * 2);
  const range = (g: number): [number, number] => {
    if (g < 0 || g >= count) return [0, 0];
    const a = offset(g);
    const b = offset(g + 1);
    if (b < a || glyf.off + b > font.length) return [0, 0];
    return [glyf.off + a, glyf.off + b];
  };
  return {
    count,
    hasOutline: (g) => {
      const [a, b] = range(g);
      return b - a >= 10 && v.getInt16(a) !== 0;
    },
    components: (g) => {
      const [a, b] = range(g);
      if (b - a < 10 || v.getInt16(a) >= 0) return [];
      const out: number[] = [];
      let p = a + 10;
      for (let k = 0; k < 256 && p + 4 <= b; k++) {
        const flags = v.getUint16(p);
        out.push(v.getUint16(p + 2));
        p += 4 + (flags & 0x1 ? 4 : 2) + (flags & 0x8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
        if (!(flags & 0x20)) break;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- 描かれた字のコード

/** 1 バイトのコードは、2 バイトのコードと分けるため、この値を足して入れる（Type3 で使う） */
const ONE_BYTE = 0x10000;

/** 描く命令を読み、書体の辞書ごとに、描かれた 2 バイトのコード（と、ONE_BYTE を足した 1 バイトのコード）を集める */
function collectCodes(ctx: PDFContext, content: Uint8Array, res: PDFDict | undefined, used: Map<PDFObject, Set<number>>, visited: Set<PDFObject>, onLimit: () => void, depth = 0) {
  const fonts = dictOf(ctx, res?.get(N("Font")));
  const xobjects = dictOf(ctx, res?.get(N("XObject")));
  let current: Set<number> | null = null;
  const stack: Array<Set<number> | null> = [];
  const show = (b: Uint8Array) => {
    if (!current) return;
    for (let k = 0; k + 1 < b.length; k += 2) current.add((b[k]! << 8) | b[k + 1]!);
    for (const c of b) current.add(ONE_BYTE + c);
  };
  let ops = 0;
  try {
    for (const { op, args } of operations(content)) {
      if (++ops > LIMITS.opsPerStream) {
        onLimit();
        return;
      }
      switch (op) {
        case "q":
          stack.push(current);
          break;
        case "Q":
          current = stack.pop() ?? current;
          break;
        case "Tf": {
          const name = args[0]?.t === "name" ? args[0].v : undefined;
          const ref = name !== undefined ? fonts?.get(N(name)) : undefined;
          const key = ref instanceof PDFRef ? ref : ref ? lookup(ctx, ref) : undefined;
          if (!key) {
            current = null;
            break;
          }
          if (!used.has(key)) used.set(key, new Set());
          current = used.get(key)!;
          break;
        }
        case "Tj":
        case "'":
          if (args[0]?.t === "str") show(args[0].v);
          break;
        case '"':
          if (args[2]?.t === "str") show(args[2].v);
          break;
        case "TJ":
          if (args[0]?.t === "arr") for (const a of args[0].v) if (a.t === "str") show(a.v);
          break;
        case "Do": {
          const name = args[0]?.t === "name" ? args[0].v : undefined;
          const ref = name !== undefined ? xobjects?.get(N(name)) : undefined;
          if (!ref || visited.has(ref) || depth >= 8) break;
          visited.add(ref);
          const xo = lookup(ctx, ref);
          if (!(xo instanceof PDFStream) || nameOf(ctx, xo.dict.get(N("Subtype"))) !== "Form") break;
          const inner = streamData(xo, LIMITS.streamBytes);
          if (inner) collectCodes(ctx, inner, dictOf(ctx, xo.dict.get(N("Resources"))) ?? res, used, visited, onLimit, depth + 1);
          break;
        }
      }
    }
  } catch {
    /* 読めない所で止める（集めた分は使う） */
  }
}

// ---------------------------------------------------------------- Type3 の字の形

/** 字の形を描く命令（塗る・線を引く・画像・字）があるか。d0・d1 と、形のない命令だけなら false */
function type3HasOutline(data: Uint8Array): boolean {
  try {
    let ops = 0;
    for (const { op } of operations(data)) {
      if (++ops > LIMITS.opsPerStream) return true;
      if (/^(f\*?|F|B\*?|b\*?|S|s|sh|Do|BI|Tj|TJ|'|")$/.test(op)) return true;
    }
  } catch {
    return true; // 読めない字の形は、形があるものとして扱う
  }
  return false;
}

/** Type3 の書体の、形のある字の形の数と、どの描いた字からも引かれていない数。/CharProcs が無ければ null */
function type3Leftover(ctx: PDFContext, font: PDFDict, usedCodes: Set<number>): { glyphs: number; leftover: number } | null {
  const procs = dictOf(ctx, font.get(N("CharProcs")));
  if (!procs) return null;
  // コード → 字の形の名前（/Encoding の /Differences）
  const nameOfCode = new Map<number, string>();
  const enc = dictOf(ctx, font.get(N("Encoding")));
  let code = 0;
  for (const item of arrayItems(ctx, enc?.get(N("Differences")))) {
    const n = nameOf(ctx, item);
    const num = numOf(ctx, item);
    if (n !== undefined) nameOfCode.set(code++, n);
    else if (num !== undefined) code = num;
  }
  const usedNames = new Set<string>();
  for (const c of usedCodes) {
    if (c < ONE_BYTE) continue;
    const n = nameOfCode.get(c - ONE_BYTE);
    if (n !== undefined) usedNames.add(n);
  }
  let glyphs = 0;
  let leftover = 0;
  for (const [k, v] of procs.entries()) {
    const name = k.decodeText();
    if (name === ".notdef") continue;
    const s = lookup(ctx, v);
    if (!(s instanceof PDFStream)) continue;
    const d = streamData(s, LIMITS.streamBytes);
    if (!d || !type3HasOutline(d)) continue;
    glyphs++;
    if (!usedNames.has(name)) leftover++;
  }
  return { glyphs, leftover };
}

function contentBytes(ctx: PDFContext, raw: PDFObject | undefined): Uint8Array {
  const v = lookup(ctx, raw);
  const list = v instanceof PDFStream ? [v] : arrayItems(ctx, v).map((x) => lookup(ctx, x)).filter((x): x is PDFStream => x instanceof PDFStream);
  const parts = list.map((s) => streamData(s, LIMITS.streamBytes)).filter((b): b is Uint8Array => !!b);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
    out[at++] = 0x0a;
  }
  return out;
}

export async function detectFontGlyphs(bytes: Uint8Array): Promise<FontGlyphReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], checkedFonts: 0, skippedFonts: 0, fullFonts: 0, belowThreshold: 0, limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { doc, ctx } = opened;
  const report: FontGlyphReport = { ...base, status: "ok", findings: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;
  const limit = (l: FontGlyphReport["limits"][number]) => {
    if (!report.limits.includes(l)) report.limits.push(l);
  };

  // 描かれたコード（ページ・部品・注釈の見た目）
  const used = new Map<PDFObject, Set<number>>();
  const visited = new Set<PDFObject>();
  try {
    for (const page of doc.getPages()) {
      const res = dictOf(ctx, page.node.get(N("Resources"))) ?? page.node.Resources();
      collectCodes(ctx, contentBytes(ctx, page.node.get(N("Contents"))), res, used, visited, () => limit("too_many_ops"));
      for (const a of arrayItems(ctx, page.node.get(N("Annots")))) {
        const annot = dictOf(ctx, a);
        if (!annot) continue;
        for (const s of appearanceStreams(ctx, annot)) {
          const d = streamData(s, LIMITS.streamBytes);
          if (d) collectCodes(ctx, d, dictOf(ctx, s.dict.get(N("Resources"))), used, visited, () => limit("too_many_ops"));
        }
      }
    }
  } catch {
    /* ページが読めなくても、書体は見る */
  }
  // 名前で引いた書体と、参照で引いた書体を同じものとして扱うため、辞書で引けるようにする
  const usedByDict = new Map<PDFObject, Set<number>>();
  for (const [k, v] of used) {
    const d = k instanceof PDFRef ? lookup(ctx, k) : k;
    if (!d) continue;
    const s = usedByDict.get(d) ?? new Set<number>();
    for (const c of v) s.add(c);
    usedByDict.set(d, s);
  }

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || nameOf(ctx, obj.get(N("Type"))) !== "Font") continue;
    if (nameOf(ctx, obj.get(N("Subtype"))) === "Type3") {
      const r = type3Leftover(ctx, obj, usedByDict.get(obj) ?? new Set());
      if (!r) {
        report.skippedFonts++;
        continue;
      }
      report.checkedFonts++;
      if (r.leftover >= MIN_LEFTOVER) report.findings.push({ pattern: "P7", font: ref.objectNumber, fontType: "type3", subsetBy: "type3", glyphs: r.glyphs, used: r.glyphs - r.leftover, leftover: r.leftover });
      else if (r.leftover > 0) report.belowThreshold++;
      continue;
    }
    if (nameOf(ctx, obj.get(N("Subtype"))) !== "Type0") continue;
    const desc = dictOf(ctx, arrayItems(ctx, obj.get(N("DescendantFonts")))[0]);
    const base = nameOf(ctx, obj.get(N("BaseFont"))) ?? "";
    const fd = desc ? dictOf(ctx, desc.get(N("FontDescriptor"))) : undefined;
    const ff = fd ? lookup(ctx, fd.get(N("FontFile2"))) : undefined;
    const map = desc ? lookup(ctx, desc.get(N("CIDToGIDMap"))) : undefined;
    const enc = nameOf(ctx, obj.get(N("Encoding")));
    const subset = /^[A-Z]{6}\+/.test(base);
    if (!desc || nameOf(ctx, desc.get(N("Subtype"))) !== "CIDFontType2" || !(ff instanceof PDFStream) || (enc !== "Identity-H" && enc !== "Identity-V")) {
      report.skippedFonts++;
      continue;
    }
    const fontData = streamData(ff, LIMITS.fontBytes);
    if (!fontData) {
      limit("font_too_large");
      continue;
    }
    if (!subset) {
      let tables: Set<string>;
      try {
        tables = fontTables(fontData);
      } catch {
        limit("broken_font");
        continue;
      }
      if (tables.has("cmap") || tables.has("name")) {
        report.fullFonts++;
        report.skippedFonts++;
        continue;
      }
    }
    let g: Glyf;
    try {
      g = readGlyf(fontData);
    } catch {
      limit("broken_font");
      continue;
    }
    // CID → 字の形の番号
    let toGid = (cid: number) => cid;
    if (map instanceof PDFStream) {
      const m = streamData(map, LIMITS.fontBytes);
      if (m) toGid = (cid) => (cid * 2 + 1 < m.length ? (m[cid * 2]! << 8) | m[cid * 2 + 1]! : 0);
    }
    report.checkedFonts++;
    const usedGids = new Set<number>();
    const queue = [...(usedByDict.get(obj) ?? [])].filter((c) => c < ONE_BYTE).map(toGid);
    while (queue.length) {
      const gid = queue.pop()!;
      if (usedGids.has(gid)) continue;
      usedGids.add(gid);
      queue.push(...g.components(gid));
    }
    let glyphs = 0;
    let leftover = 0;
    for (let gid = 1; gid < g.count; gid++) {
      if (!g.hasOutline(gid)) continue;
      glyphs++;
      if (!usedGids.has(gid)) leftover++;
    }
    if (leftover >= MIN_LEFTOVER) report.findings.push({ pattern: "P7", font: ref.objectNumber, fontType: "truetype", subsetBy: subset ? "name" : "tables", glyphs, used: glyphs - leftover, leftover });
    else if (leftover > 0) report.belowThreshold++;
  }
  return report;
}

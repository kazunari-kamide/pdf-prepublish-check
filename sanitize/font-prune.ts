// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付け・黒塗りのあと、どこにも描かれていない字形を、埋め込んだ書体から外す（0.8.0 から）。
// 字を絞った書体（部分埋め込み）でも、絞っていない書体でも、書体の中に残った字の形から、消した字や、もとの文書の字が分かってしまうため。
//
// - TrueType の形（/FontFile2）：使っていない字形の中身（glyf）を空にし、位置の表（loca）を詰めて、書体を作り直す。
//   字形 0（.notdef）と、組み合わせの字形が使う部品の字形は残す。
//   CID の書体（Identity-H・Identity-V。CIDToGIDMap は Identity か表）と、ふつうの TrueType の書体（cmap の (3,0)・(1,0)・(3,1) で引く）を扱う。
// - Type3 の書体：使っていない字の描き方（/CharProcs の項目）を外す。
// - CFF（/FontFile3）・Type1（/FontFile）の書体は外さず、数を notDone で知らせる（11/5 に人が決めた）。
// - 読み切れない所（Type3 の書体の中・模様の中・フォームの既定の書体 /DR など）から使う書体は、触らない（見た目を壊さないため）。
// 使う字は redact-fonts.ts の fontUsage で数える（ページ・部品・注釈の見た目）。

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFObject } from "pdf-lib";
import type { FontInfo } from "../rules/shared/fonts.ts";
import { streamData } from "./content.ts";
import { fontUsage } from "./redact-fonts.ts";
import type { NotDoneItem, RemovedItem } from "./types.ts";

const N = (s: string) => PDFName.of(s);

function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}
const nameOf = (ctx: PDFContext, o: PDFObject | undefined) => {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFName ? v.decodeText() : undefined;
};

// ---------------------------------------------------------------- TrueType を読む・作り直す

export type Sfnt = {
  data: Uint8Array;
  tables: Map<string, { off: number; len: number }>;
  numGlyphs: number;
  unitsPerEm: number;
  longLoca: boolean;
  /** 字形 i の中身は glyf の [loca[i], loca[i+1]) */
  loca: number[];
};

const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const i16 = (b: Uint8Array, o: number) => { const v = u16(b, o); return v >= 0x8000 ? v - 0x10000 : v; };
const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;

/** TrueType（glyf のあるもの）を読む。読めない・形が違うときは null */
export function parseSfnt(data: Uint8Array): Sfnt | null {
  if (data.length < 12) return null;
  const tag = u32(data, 0);
  if (tag !== 0x00010000 && tag !== 0x74727565) return null; // 1.0 か 'true'（'OTTO'・'ttcf' は扱わない）
  const n = u16(data, 4);
  if (12 + n * 16 > data.length) return null;
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const name = String.fromCharCode(data[r]!, data[r + 1]!, data[r + 2]!, data[r + 3]!);
    const off = u32(data, r + 8);
    const len = u32(data, r + 12);
    if (off + len > data.length) return null;
    tables.set(name, { off, len });
  }
  const head = tables.get("head");
  const maxp = tables.get("maxp");
  const loca = tables.get("loca");
  const glyf = tables.get("glyf");
  if (!head || !maxp || !loca || !glyf || head.len < 54 || maxp.len < 6) return null;
  const longLoca = i16(data, head.off + 50) === 1;
  const unitsPerEm = u16(data, head.off + 18) || 1000;
  const numGlyphs = u16(data, maxp.off + 4);
  const offs: number[] = [];
  for (let i = 0; i <= numGlyphs; i++) {
    const o = longLoca ? u32(data, loca.off + i * 4) : u16(data, loca.off + i * 2) * 2;
    if ((longLoca ? (i + 1) * 4 : (i + 1) * 2) > loca.len) return null;
    offs.push(o);
  }
  for (let i = 0; i < numGlyphs; i++) if (offs[i + 1]! < offs[i]! || offs[i + 1]! > glyf.len) return null;
  return { data, tables, numGlyphs, unitsPerEm, longLoca, loca: offs };
}

/** 字形の外枠（字形の単位）。中身のない字形は null */
export function glyphBox(s: Sfnt, gid: number): [number, number, number, number] | null {
  if (gid < 0 || gid >= s.numGlyphs) return null;
  const a = s.loca[gid]!;
  const b = s.loca[gid + 1]!;
  if (b - a < 10) return null;
  const o = s.tables.get("glyf")!.off + a;
  return [i16(s.data, o + 2), i16(s.data, o + 4), i16(s.data, o + 6), i16(s.data, o + 8)];
}

/** 組み合わせの字形が使う部品の字形 */
function componentsOf(s: Sfnt, gid: number): number[] {
  const a = s.loca[gid]!;
  const b = s.loca[gid + 1]!;
  if (b - a < 10) return [];
  const g = s.tables.get("glyf")!.off + a;
  if (i16(s.data, g) >= 0) return [];
  const out: number[] = [];
  let o = g + 10;
  for (let k = 0; k < 1000 && o + 4 <= g + (b - a); k++) {
    const flags = u16(s.data, o);
    out.push(u16(s.data, o + 2));
    o += 4 + (flags & 0x0001 ? 4 : 2);
    if (flags & 0x0008) o += 2;
    else if (flags & 0x0040) o += 4;
    else if (flags & 0x0080) o += 8;
    if (!(flags & 0x0020)) break;
  }
  return out;
}

/** cmap の表（pid, eid）を引く関数。表がなければ null */
export function cmapLookup(s: Sfnt, pid: number, eid: number): ((code: number) => number) | null {
  const t = s.tables.get("cmap");
  if (!t || t.len < 4) return null;
  const d = s.data;
  const n = u16(d, t.off + 2);
  for (let i = 0; i < n; i++) {
    const r = t.off + 4 + i * 8;
    if (r + 8 > t.off + t.len) return null;
    if (u16(d, r) !== pid || u16(d, r + 2) !== eid) continue;
    const st = t.off + u32(d, r + 4);
    const fmt = u16(d, st);
    if (fmt === 0) return (c) => (c >= 0 && c < 256 ? d[st + 6 + c]! : 0);
    if (fmt === 6) {
      const first = u16(d, st + 6);
      const count = u16(d, st + 8);
      return (c) => (c >= first && c < first + count ? u16(d, st + 10 + (c - first) * 2) : 0);
    }
    if (fmt === 4) {
      const segX2 = u16(d, st + 6);
      const ends = st + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      return (c) => {
        for (let k = 0; k < segX2 / 2; k++) {
          const end = u16(d, ends + k * 2);
          if (c > end) continue;
          const start = u16(d, starts + k * 2);
          if (c < start) return 0;
          const delta = u16(d, deltas + k * 2);
          const ro = u16(d, ranges + k * 2);
          if (ro === 0) return (c + delta) & 0xffff;
          const at = ranges + k * 2 + ro + (c - start) * 2;
          if (at + 2 > d.length) return 0;
          const g = u16(d, at);
          return g === 0 ? 0 : (g + delta) & 0xffff;
        }
        return 0;
      };
    }
    if (fmt === 12) {
      const groups = u32(d, st + 12);
      return (c) => {
        for (let k = 0; k < groups; k++) {
          const g = st + 16 + k * 12;
          const a = u32(d, g);
          const b = u32(d, g + 4);
          if (c >= a && c <= b) return u32(d, g + 8) + (c - a);
        }
        return 0;
      };
    }
    return null;
  }
  return null;
}

function checksum(b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) sum = (sum + (((b[i] ?? 0) << 24) >>> 0) + ((b[i + 1] ?? 0) << 16) + ((b[i + 2] ?? 0) << 8) + (b[i + 3] ?? 0)) >>> 0;
  return sum;
}

/** 残す字形（keep）だけの中身にした書体を作る。字形の数・番号は変えない（ほかの表はそのまま） */
export function rebuildSfnt(s: Sfnt, keep: Set<number>): { data: Uint8Array; removed: number } {
  const glyf = s.tables.get("glyf")!;
  const parts: Uint8Array[] = [];
  const newLoca: number[] = [0];
  let at = 0;
  let removed = 0;
  for (let g = 0; g < s.numGlyphs; g++) {
    const a = s.loca[g]!;
    const b = s.loca[g + 1]!;
    if (b > a && keep.has(g)) {
      let chunk = s.data.subarray(glyf.off + a, glyf.off + b);
      if (chunk.length % 4) {
        const p = new Uint8Array(chunk.length + (4 - (chunk.length % 4)));
        p.set(chunk);
        chunk = p;
      }
      parts.push(chunk);
      at += chunk.length;
    } else if (b > a) removed++;
    newLoca.push(at);
  }
  const glyfData = new Uint8Array(at);
  let o = 0;
  for (const p of parts) {
    glyfData.set(p, o);
    o += p.length;
  }
  const long = s.longLoca || at > 0x1fffe;
  const locaData = new Uint8Array((s.numGlyphs + 1) * (long ? 4 : 2));
  newLoca.forEach((v, i) => {
    if (long) {
      locaData[i * 4] = (v >>> 24) & 0xff;
      locaData[i * 4 + 1] = (v >>> 16) & 0xff;
      locaData[i * 4 + 2] = (v >>> 8) & 0xff;
      locaData[i * 4 + 3] = v & 0xff;
    } else {
      locaData[i * 2] = (v >> 9) & 0xff;
      locaData[i * 2 + 1] = (v >> 1) & 0xff;
    }
  });
  // 表を並べ直す（順番は元のまま。4 バイトにそろえる）
  const names = [...s.tables.keys()];
  const bodies = names.map((name) => {
    if (name === "glyf") return glyfData;
    if (name === "loca") return locaData;
    const t = s.tables.get(name)!;
    const b = s.data.slice(t.off, t.off + t.len);
    if (name === "head" && b.length >= 54) {
      b[8] = b[9] = b[10] = b[11] = 0; // checkSumAdjustment（あとで入れる）
      b[50] = 0;
      b[51] = long ? 1 : 0;
    }
    return b;
  });
  const headerLen = 12 + names.length * 16;
  let total = headerLen;
  const offsets = bodies.map((b) => {
    const off = total;
    total += b.length + ((4 - (b.length % 4)) % 4);
    return off;
  });
  const out = new Uint8Array(total);
  out.set(s.data.subarray(0, 12), 0);
  names.forEach((name, i) => {
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[r + k] = name.charCodeAt(k);
    const put = (p: number, v: number) => { out[p] = (v >>> 24) & 0xff; out[p + 1] = (v >>> 16) & 0xff; out[p + 2] = (v >>> 8) & 0xff; out[p + 3] = v & 0xff; };
    put(r + 4, checksum(bodies[i]!));
    put(r + 8, offsets[i]!);
    put(r + 12, bodies[i]!.length);
    out.set(bodies[i]!, offsets[i]!);
  });
  const hi = names.indexOf("head");
  if (hi >= 0) {
    const adj = (0xb1b0afba - checksum(out)) >>> 0;
    const p = offsets[hi]! + 8;
    out[p] = (adj >>> 24) & 0xff;
    out[p + 1] = (adj >>> 16) & 0xff;
    out[p + 2] = (adj >>> 8) & 0xff;
    out[p + 3] = adj & 0xff;
  }
  return { data: out, removed };
}

// ---------------------------------------------------------------- 字のコード → 字形の番号

/** 書体の辞書から、埋め込んだ TrueType と、コードから字形の番号を引く関数。扱えない書体は null */
export function trueTypeOf(ctx: PDFContext, font: PDFDict, info?: FontInfo): { file: PDFStream; desc: PDFDict; gids: (code: number) => number[] | null } | null {
  const subtype = nameOf(ctx, font.get(N("Subtype")));
  if (subtype === "Type0") {
    const enc = nameOf(ctx, font.get(N("Encoding")));
    if (enc !== "Identity-H" && enc !== "Identity-V") return null;
    const kids = ctx.lookup(font.get(N("DescendantFonts")));
    const cid = kids instanceof PDFArray ? dictOf(ctx, kids.get(0)) : undefined;
    if (!cid || nameOf(ctx, cid.get(N("Subtype"))) !== "CIDFontType2") return null;
    const desc = dictOf(ctx, cid.get(N("FontDescriptor")));
    const file = desc ? ctx.lookup(desc.get(N("FontFile2"))) : undefined;
    if (!desc || !(file instanceof PDFStream)) return null;
    const map = ctx.lookup(cid.get(N("CIDToGIDMap")));
    if (map === undefined || (map instanceof PDFName && map.decodeText() === "Identity")) return { file, desc, gids: (c) => [c] };
    if (map instanceof PDFStream) {
      let m: Uint8Array;
      try {
        m = streamData(map);
      } catch {
        return null;
      }
      return { file, desc, gids: (c) => (c * 2 + 1 < m.length ? [u16(m, c * 2)] : [0]) };
    }
    return null;
  }
  if (subtype === "TrueType") {
    const desc = dictOf(ctx, font.get(N("FontDescriptor")));
    const file = desc ? ctx.lookup(desc.get(N("FontFile2"))) : undefined;
    if (!desc || !(file instanceof PDFStream)) return null;
    let s: Sfnt | null = null;
    try {
      s = parseSfnt(streamData(file));
    } catch {
      s = null;
    }
    if (!s) return null;
    const c30 = cmapLookup(s, 3, 0);
    const c10 = cmapLookup(s, 1, 0);
    const c31 = cmapLookup(s, 3, 1);
    if (!c30 && !c10 && !c31) return null;
    // 引けるものは全部残す（多めに残す側。少なすぎると見た目が壊れる）
    return {
      file, desc, gids: (c) => {
        const out = new Set<number>();
        if (c30) for (const g of [c30(c), c30(0xf000 + c)]) if (g) out.add(g);
        if (c10) { const g = c10(c); if (g) out.add(g); }
        if (c31 && info) {
          const t = info.decode(Uint8Array.of(c & 0xff))[0]?.text ?? "";
          for (const ch of t) { const g = c31(ch.codePointAt(0)!); if (g) out.add(g); }
        }
        return out.size ? [...out] : null;
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------- 本体

/** 片付けのあと、描かれていない字形を書体から外す */
export function pruneFonts(doc: PDFDocument, maxOps: number): { removed: RemovedItem[]; notDone: NotDoneItem[] } {
  const ctx = doc.context;
  const removed: RemovedItem[] = [];
  const notDone: NotDoneItem[] = [];
  const all = new Set(doc.getPages().map((_, i) => i + 1));
  const usage = fontUsage(doc, all, maxOps);
  if (!usage) {
    // 埋め込んだ書体がなければ、外す字形もないので知らせない
    if (!hasEmbeddedFonts(ctx)) return { removed, notDone };
    return { removed, notDone: [{ pattern: "P7", reason: "font_not_pruned", label: "書体の中で使っている字を数えきれなかったため、描かれていない字形を書体から外していません" }] };
  }
  // 読み切っていない所から使う書体は触らない
  const exclude = new Set<PDFObject>();
  const fontsIn = (res: PDFDict | undefined): PDFObject[] => {
    const f = dictOf(ctx, res?.get(N("Font")));
    return f ? [...f.values()] : [];
  };
  const acro = dictOf(ctx, doc.catalog.get(N("AcroForm")));
  for (const f of fontsIn(dictOf(ctx, acro?.get(N("DR"))))) exclude.add(f);
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!d || nameOf(ctx, d.get(N("Type"))) === "Pages") continue;
    const res = dictOf(ctx, d.get(N("Resources")));
    if (!res || usage.scannedRes.has(res)) continue;
    for (const f of fontsIn(res)) exclude.add(f);
  }
  // 書体の辞書ごと（参照でも、直接書いたものでも）。同じ書体のファイルを使う書体の辞書は、まとめて数える
  const byFile = new Map<PDFStream, { desc: PDFDict; gids: Set<number>; unsafe: boolean }>();
  let cffType1 = 0;
  let type3Removed = 0;
  const seenFonts = new Set<PDFDict>();
  for (const res of usage.scannedRes) {
    for (const key of fontsIn(res)) {
      const font = dictOf(ctx, key);
      if (!font || seenFonts.has(font)) continue;
      seenFonts.add(font);
      const banned = exclude.has(key) || exclude.has(font);
      const u = usage.usage.get(key) ?? (key instanceof PDFRef ? undefined : usage.usage.get(font));
      const codes = u?.codes ?? new Set<number>();
      const subtype = nameOf(ctx, font.get(N("Subtype")));
      if (subtype === "Type3") {
        if (!banned) type3Removed += pruneType3(ctx, font, codes);
        continue;
      }
      const tt = trueTypeOf(ctx, font, u?.info);
      if (!tt) {
        // 埋め込んだ CFF・Type1 は数えて知らせる（TrueType でも扱えない形は触らない）
        const desc = subtype === "Type0"
          ? (() => { const k = ctx.lookup(font.get(N("DescendantFonts"))); const c = k instanceof PDFArray ? dictOf(ctx, k.get(0)) : undefined; return c ? dictOf(ctx, c.get(N("FontDescriptor"))) : undefined; })()
          : dictOf(ctx, font.get(N("FontDescriptor")));
        if (desc && (desc.has(N("FontFile")) || desc.has(N("FontFile3")))) cffType1++;
        continue;
      }
      const e = byFile.get(tt.file) ?? { desc: tt.desc, gids: new Set<number>([0]), unsafe: false };
      if (banned) e.unsafe = true;
      for (const c of codes) {
        const g = tt.gids(c);
        if (!g) e.unsafe = true;
        else for (const x of g) e.gids.add(x);
      }
      byFile.set(tt.file, e);
    }
  }
  let glyphs = 0;
  let fonts = 0;
  for (const [file, e] of byFile) {
    if (e.unsafe) continue;
    let s: Sfnt | null;
    try {
      s = parseSfnt(streamData(file));
    } catch {
      s = null;
    }
    if (!s) continue;
    // 組み合わせの字形の部品も残す
    const keep = new Set<number>();
    const stack = [...e.gids];
    while (stack.length) {
      const g = stack.pop()!;
      if (keep.has(g) || g < 0 || g >= s.numGlyphs) continue;
      keep.add(g);
      stack.push(...componentsOf(s, g));
    }
    const r = rebuildSfnt(s, keep);
    if (!r.removed) continue;
    const ns = ctx.flateStream(r.data, { Length1: r.data.length });
    e.desc.set(N("FontFile2"), ctx.register(ns));
    glyphs += r.removed;
    fonts++;
  }
  if (glyphs) removed.push({ pattern: "P7", kind: "font_glyphs", count: glyphs, label: `書体（${fonts} 個）の中の、どこにも描かれていない字形（${glyphs} 個）を消しました` });
  if (type3Removed) removed.push({ pattern: "P7", kind: "font_glyphs", count: type3Removed, label: `Type3 の書体の中の、どこにも描かれていない字の描き方（${type3Removed} 個）を消しました` });
  if (cffType1) {
    notDone.push({ pattern: "P7", reason: "font_not_pruned", label: `書体（${cffType1} 個。CFF・Type1 の形）の中の、描かれていない字形は外していません。消した字の形が書体の中に残っていることがあります` });
  }
  return { removed, notDone };
}

/** 埋め込んだ書体（字形のファイル・Type3 の字の描き方）があるか */
function hasEmbeddedFonts(ctx: PDFContext): boolean {
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    const d = o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : undefined;
    if (!d) continue;
    if (d.has(N("FontFile")) || d.has(N("FontFile2")) || d.has(N("FontFile3")) || d.has(N("CharProcs"))) return true;
  }
  return false;
}

/** Type3 の書体：使っていないコードの字の描き方（/CharProcs の項目）を外す。外した数を返す */
function pruneType3(ctx: PDFContext, font: PDFDict, codes: Set<number>): number {
  const procs = dictOf(ctx, font.get(N("CharProcs")));
  const enc = dictOf(ctx, font.get(N("Encoding")));
  const diffs = enc ? ctx.lookup(enc.get(N("Differences"))) : undefined;
  if (!procs || !(diffs instanceof PDFArray)) return 0;
  const used = new Set<string>();
  let code = 0;
  const known = new Set<string>();
  for (const o of diffs.asArray()) {
    const v = ctx.lookup(o);
    if (v instanceof PDFNumber) code = v.asNumber();
    else if (v instanceof PDFName) {
      known.add(v.decodeText());
      if (codes.has(code)) used.add(v.decodeText());
      code++;
    }
  }
  let n = 0;
  for (const [k] of procs.entries()) {
    const name = k.decodeText();
    // Differences にない名前は、どのコードから描くか分からないので残す
    if (!known.has(name) || used.has(name)) continue;
    procs.delete(k);
    n++;
  }
  return n;
}

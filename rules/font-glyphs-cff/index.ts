// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：CFF の書体に残った字形（`font-glyphs-cff`）0.1.0。型は P7（隠れたテキスト）の仲間として扱う【仮】。
// `font-glyphs` は TrueType（CIDFontType2）と Type3 だけを見る。このルールは、CFF（FontFile3）の部分埋め込みの書体を見る。
// - Type0 の CIDFontType0（FontFile3 /Subtype /CIDFontType0C）で、Identity-H・V のもの。字のコードは 2 バイトの CID。
//   CFF が CID の形（Top DICT に ROS がある）なら、charset で CID → 字の形の番号を引く。そうでなければ CID ＝ 字の形の番号。
// - 1 バイトの Type1（FontFile3 /Subtype /Type1C）。コード → 字の形の名前（/Encoding の /Differences、なければ基の符号の表）→
//   charset で字の形の番号。CFF の中の独自の符号の表（Encoding の形 0・1）も使う。
// 名前が部分埋め込みの印（ABCDEF+）で始まる書体だけを見る（印の無い書体は、全部を埋め込んだものとみなす）。
// 数え方：字の形のうち、形（線を引く命令）があるもので、どこにも描かれていないもの。字の形 0（.notdef）と、形の無い字（空白など）は数えない。
// 描いたコードのうち、字の形を引けないものが 1 つでもある書体は、誤検知を避けて見ない（unresolvedFonts）。
// 字の中身は返さない（数だけ）。

import { PDFDict, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { operations } from "../shared/content-lexer.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { appearanceStreams, arrayItems, dictOf, lookup, N, nameOf, numOf, openPdf, streamData, type RuleError } from "../common/index.ts";

export const RULE_ID = "font-glyphs-cff";
export const RULE_VERSION = "0.1.0";

/** これより少ない余りは、ふつうに余る字形（合字・記号）として出さない（font-glyphs と同じ値）【仮の値】 */
export const MIN_LEFTOVER = 3;
export const LIMITS = { fontBytes: 32 * 1024 * 1024, streamBytes: 32 * 1024 * 1024, opsPerStream: 3_000_000, glyphs: 70_000, charstringBytes: 65_536 } as const;

export type CffGlyphFinding = {
  pattern: "P7";
  /** 書体の辞書のオブジェクト番号 */
  font: number;
  /** cid＝CIDFontType0C（2 バイト）、simple＝Type1C（1 バイト） */
  fontType: "cid" | "simple";
  glyphs: number;
  used: number;
  leftover: number;
};

export type CffGlyphReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  findings: CffGlyphFinding[];
  checkedFonts: number;
  /** 印が無い（全部の埋め込みとみなした）CFF の書体の数 */
  fullFonts: number;
  /** 描いたコードの字の形を引けず、見なかった書体の数 */
  unresolvedFonts: number;
  belowThreshold: number;
  limits: Array<"too_many_ops" | "font_too_large" | "broken_font">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

// ---------------------------------------------------------------- CFF を読む

/** 32〜126 のコードの字の形の名前（Standard の符号の表。CFF の標準の字 1〜95 と同じ並び） */
const ASCII_NAMES = (
  "space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma hyphen period slash " +
  "zero one two three four five six seven eight nine colon semicolon less equal greater question at " +
  "A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft " +
  "a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde"
).split(" ");

export type Cff = {
  count: number;
  /** 字の形の番号 → 字の形の CharString（の範囲） */
  charstring: (gid: number) => Uint8Array;
  /** 字の形の番号 → charset の値（SID か CID）。0 は .notdef */
  charsetOf: (gid: number) => number;
  cidKeyed: boolean;
  /** SID → 名前（分からない標準の字は "sid:N"） */
  sidName: (sid: number) => string;
  /** CFF の中の独自の符号の表（コード → 字の形の番号）。無ければ null */
  encoding: Map<number, number> | null;
};

/** CFF を読む。壊れていれば例外 */
export function readCff(b: Uint8Array): Cff {
  const need = (p: number) => {
    if (p > b.length) throw new Error("broken cff");
  };
  const u16 = (p: number) => (need(p + 2), (b[p]! << 8) | b[p + 1]!);
  const off = (p: number, size: number) => {
    need(p + size);
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + b[p + i]!;
    return v;
  };
  const index = (p: number): { items: Array<[number, number]>; end: number } => {
    const count = u16(p);
    if (count === 0) return { items: [], end: p + 2 };
    const size = b[p + 2]!;
    if (size < 1 || size > 4) throw new Error("broken index");
    const base = p + 3 + (count + 1) * size - 1;
    const items: Array<[number, number]> = [];
    let prev = off(p + 3, size);
    for (let i = 1; i <= count; i++) {
      const cur = off(p + 3 + i * size, size);
      items.push([base + prev, base + cur]);
      prev = cur;
    }
    need(base + prev);
    return { items, end: base + prev };
  };
  const dict = (a: number, z: number): Map<number, number[]> => {
    const out = new Map<number, number[]>();
    let ops: number[] = [];
    for (let p = a; p < z; ) {
      const c = b[p]!;
      if (c <= 21) {
        const key = c === 12 ? 1200 + b[p + 1]! : c;
        p += c === 12 ? 2 : 1;
        out.set(key, ops);
        ops = [];
      } else if (c === 28) {
        ops.push(((b[p + 1]! << 24) >> 16) | b[p + 2]!);
        p += 3;
      } else if (c === 29) {
        ops.push((b[p + 1]! << 24) | (b[p + 2]! << 16) | (b[p + 3]! << 8) | b[p + 4]!);
        p += 5;
      } else if (c === 30) {
        p++;
        while (p < z && (b[p]! & 0x0f) !== 0x0f && (b[p]! >> 4) !== 0x0f) p++;
        p++;
        ops.push(0);
      } else if (c >= 32 && c <= 246) {
        ops.push(c - 139);
        p++;
      } else if (c >= 247 && c <= 250) {
        ops.push((c - 247) * 256 + b[p + 1]! + 108);
        p += 2;
      } else if (c >= 251 && c <= 254) {
        ops.push(-(c - 251) * 256 - b[p + 1]! - 108);
        p += 2;
      } else p++;
    }
    return out;
  };
  need(4);
  const names = index(b[2]!);
  const top = index(names.end);
  const strings = index(top.end);
  if (!top.items[0]) throw new Error("no top dict");
  const td = dict(...top.items[0]);
  const csAt = td.get(17)?.[0];
  if (csAt === undefined) throw new Error("no charstrings");
  const cs = index(csAt);
  const count = Math.min(cs.items.length, LIMITS.glyphs);
  // charset（0〜2 は決まった表。名前の番号＝字の形の番号とみなす）
  const charset = new Array<number>(count).fill(0);
  const csetAt = td.get(15)?.[0] ?? 0;
  if (csetAt > 2) {
    const fmt = b[csetAt]!;
    let p = csetAt + 1;
    let gid = 1;
    if (fmt === 0) for (; gid < count; gid++, p += 2) charset[gid] = u16(p);
    else if (fmt === 1 || fmt === 2) {
      while (gid < count) {
        const first = u16(p);
        const left = fmt === 1 ? (need(p + 3), b[p + 2]!) : u16(p + 2);
        p += fmt === 1 ? 3 : 4;
        for (let k = 0; k <= left && gid < count; k++) charset[gid++] = first + k;
      }
    } else throw new Error("broken charset");
  } else for (let g = 0; g < count; g++) charset[g] = g;
  // 独自の符号の表（1 バイトの書体だけ）
  let encoding: Map<number, number> | null = null;
  const encAt = td.get(16)?.[0] ?? 0;
  if (encAt > 1) {
    encoding = new Map();
    const fmt = b[encAt]! & 0x7f;
    let p = encAt + 1;
    if (fmt === 0) {
      const n = b[p++]!;
      for (let i = 0; i < n; i++) encoding.set(b[p + i]!, i + 1);
    } else if (fmt === 1) {
      const n = b[p++]!;
      let gid = 1;
      for (let i = 0; i < n; i++, p += 2) for (let k = 0; k <= b[p + 1]!; k++) encoding.set(b[p]! + k, gid++);
    }
  }
  const dec = new TextDecoder("latin1");
  return {
    count,
    charstring: (g) => {
      const it = cs.items[g];
      return it ? b.subarray(it[0], Math.min(it[1], it[0] + LIMITS.charstringBytes)) : new Uint8Array();
    },
    charsetOf: (g) => charset[g] ?? 0,
    cidKeyed: td.has(1230),
    sidName: (sid) => {
      if (sid >= 1 && sid <= 95) return ASCII_NAMES[sid - 1]!;
      if (sid >= 391) {
        const it = strings.items[sid - 391];
        if (it) return dec.decode(b.subarray(it[0], it[1]));
      }
      return `sid:${sid}`;
    },
    encoding,
  };
}

/** Type2 の CharString に、形を描く命令があるか。読めなければ、形があるものとして扱う */
export function hasOutline(cs: Uint8Array): boolean {
  let args = 0;
  for (let p = 0; p < cs.length; ) {
    const c = cs[p]!;
    if (c === 28) (p += 3), args++;
    else if (c === 255) (p += 5), args++;
    else if (c >= 32 && c <= 246) p++, args++;
    else if (c >= 247) (p += 2), args++;
    else if (c === 12) {
      const e = cs[p + 1]!;
      if (e >= 34 && e <= 37) return true; // flex
      p += 2;
      args = 0;
    } else {
      // 1・3・18・23：幹の印（形ではない）。14：endchar（引数が 4 つ以上なら、字を組み合わせた形）
      if (c === 14) return args >= 4;
      if (c !== 1 && c !== 3 && c !== 18 && c !== 23) return true; // 線を引く・移す・部品を呼ぶ・hintmask など
      p++;
      args = 0;
    }
  }
  return false;
}

// ---------------------------------------------------------------- 描かれた字のコード

/** 1 バイトのコードは、2 バイトのコードと分けるため、この値を足して入れる */
const ONE_BYTE = 0x10000;

function collectCodes(ctx: PDFContext, content: Uint8Array, res: PDFDict | undefined, used: Map<PDFObject, Set<number>>, visited: Set<PDFObject>, onLimit: () => void, depth = 0) {
  const fonts = dictOf(ctx, res?.get(N("Font")));
  const xobjects = dictOf(ctx, res?.get(N("XObject")));
  let current: Set<number> | null = null;
  const stack: Array<Set<number> | null> = [];
  const show = (s: Uint8Array) => {
    if (!current) return;
    for (let k = 0; k + 1 < s.length; k += 2) current.add((s[k]! << 8) | s[k + 1]!);
    for (const c of s) current.add(ONE_BYTE + c);
  };
  let ops = 0;
  try {
    for (const { op, args } of operations(content)) {
      if (++ops > LIMITS.opsPerStream) return onLimit();
      if (op === "q") stack.push(current);
      else if (op === "Q") current = stack.pop() ?? current;
      else if (op === "Tf") {
        const name = args[0]?.t === "name" ? args[0].v : undefined;
        const ref = name !== undefined ? fonts?.get(N(name)) : undefined;
        const d = ref ? lookup(ctx, ref) : undefined;
        if (!d) current = null;
        else {
          if (!used.has(d)) used.set(d, new Set());
          current = used.get(d)!;
        }
      } else if (op === "Tj" || op === "'") {
        if (args[0]?.t === "str") show(args[0].v);
      } else if (op === '"') {
        if (args[2]?.t === "str") show(args[2].v);
      } else if (op === "TJ") {
        if (args[0]?.t === "arr") for (const a of args[0].v) if (a.t === "str") show(a.v);
      } else if (op === "Do") {
        const name = args[0]?.t === "name" ? args[0].v : undefined;
        const ref = name !== undefined ? xobjects?.get(N(name)) : undefined;
        if (!ref || visited.has(ref) || depth >= 8) continue;
        visited.add(ref);
        const xo = lookup(ctx, ref);
        if (!(xo instanceof PDFStream) || nameOf(ctx, xo.dict.get(N("Subtype"))) !== "Form") continue;
        const inner = streamData(xo, LIMITS.streamBytes);
        if (inner) collectCodes(ctx, inner, dictOf(ctx, xo.dict.get(N("Resources"))) ?? res, used, visited, onLimit, depth + 1);
      }
    }
  } catch {
    /* 読めない所で止める（集めた分は使う） */
  }
}

function contentBytes(ctx: PDFContext, raw: PDFObject | undefined): Uint8Array {
  const v = lookup(ctx, raw);
  const list = v instanceof PDFStream ? [v] : arrayItems(ctx, v).map((x) => lookup(ctx, x)).filter((x): x is PDFStream => x instanceof PDFStream);
  const parts = list.map((s) => streamData(s, LIMITS.streamBytes)).filter((x): x is Uint8Array => !!x);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
    out[at++] = 0x0a;
  }
  return out;
}

// ---------------------------------------------------------------- 1 バイトのコード → 字の形の番号

/** コード → 名前（/Differences と、基の符号の表の 32〜126）。分からなければ undefined */
function simpleNames(ctx: PDFContext, font: PDFDict): { byCode: Map<number, string>; base: "standard" | "winansi" | "builtin" } {
  const byCode = new Map<number, string>();
  const raw = lookup(ctx, font.get(N("Encoding")));
  const encName = nameOf(ctx, raw);
  const encDict = raw instanceof PDFDict ? raw : undefined;
  const baseName = encName ?? (encDict ? nameOf(ctx, encDict.get(N("BaseEncoding"))) : undefined);
  const base = baseName === "WinAnsiEncoding" || baseName === "MacRomanEncoding" ? "winansi" : baseName === "StandardEncoding" ? "standard" : "builtin";
  let code = 0;
  for (const item of arrayItems(ctx, encDict?.get(N("Differences")))) {
    const n = nameOf(ctx, item);
    const num = numOf(ctx, item);
    if (n !== undefined) byCode.set(code++, n);
    else if (num !== undefined) code = num;
  }
  return { byCode, base };
}

function asciiName(code: number, base: "standard" | "winansi"): string | undefined {
  if (code < 32 || code > 126) return undefined;
  if (base === "winansi" && code === 39) return "quotesingle";
  if (base === "winansi" && code === 96) return "grave";
  return ASCII_NAMES[code - 32];
}

// ---------------------------------------------------------------- 本体

export async function detectFontGlyphsCff(bytes: Uint8Array): Promise<CffGlyphReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], checkedFonts: 0, fullFonts: 0, unresolvedFonts: 0, belowThreshold: 0, limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { doc, ctx } = opened;
  const report: CffGlyphReport = { ...base, status: "ok", findings: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;
  const limit = (l: CffGlyphReport["limits"][number]) => {
    if (!report.limits.includes(l)) report.limits.push(l);
  };

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

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || nameOf(ctx, obj.get(N("Type"))) !== "Font") continue;
    const subtype = nameOf(ctx, obj.get(N("Subtype")));
    let desc: PDFDict | undefined;
    let kind: "cid" | "simple";
    if (subtype === "Type0") {
      const enc = nameOf(ctx, obj.get(N("Encoding")));
      desc = dictOf(ctx, arrayItems(ctx, obj.get(N("DescendantFonts")))[0]);
      if (!desc || nameOf(ctx, desc.get(N("Subtype"))) !== "CIDFontType0" || (enc !== "Identity-H" && enc !== "Identity-V")) continue;
      kind = "cid";
    } else if (subtype === "Type1") {
      desc = obj;
      kind = "simple";
    } else continue;
    const fd = dictOf(ctx, desc.get(N("FontDescriptor")));
    const ff = fd ? lookup(ctx, fd.get(N("FontFile3"))) : undefined;
    if (!(ff instanceof PDFStream)) continue;
    const ffType = nameOf(ctx, ff.dict.get(N("Subtype")));
    if ((kind === "cid" && ffType !== "CIDFontType0C") || (kind === "simple" && ffType !== "Type1C")) continue;
    if (!/^[A-Z]{6}\+/.test(nameOf(ctx, obj.get(N("BaseFont"))) ?? "")) {
      report.fullFonts++;
      continue;
    }
    const data = streamData(ff, LIMITS.fontBytes);
    if (!data) {
      limit("font_too_large");
      continue;
    }
    let cff: Cff;
    try {
      cff = readCff(data);
    } catch {
      limit("broken_font");
      continue;
    }
    const codes = used.get(obj) ?? new Set<number>();
    const usedGids = new Set<number>();
    let unresolved = false;
    if (kind === "cid") {
      const byCid = new Map<number, number>();
      if (cff.cidKeyed) for (let g = 0; g < cff.count; g++) byCid.set(cff.charsetOf(g), g);
      for (const c of codes) {
        if (c >= ONE_BYTE) continue;
        const g = cff.cidKeyed ? byCid.get(c) : c;
        if (g !== undefined) usedGids.add(g);
      }
    } else {
      const byName = new Map<string, number>();
      for (let g = 1; g < cff.count; g++) byName.set(cff.sidName(cff.charsetOf(g)), g);
      const { byCode, base: encBase } = simpleNames(ctx, obj);
      for (const c of codes) {
        if (c < ONE_BYTE) continue;
        const code = c - ONE_BYTE;
        const name = byCode.get(code) ?? (encBase === "builtin" && cff.encoding ? undefined : asciiName(code, encBase === "winansi" ? "winansi" : "standard"));
        const g = name !== undefined ? byName.get(name) : cff.encoding?.get(code);
        if (g !== undefined) usedGids.add(g);
        else if (code !== 32) unresolved = true; // 空白は字の形が無いことが多い
      }
    }
    if (unresolved) {
      report.unresolvedFonts++;
      continue;
    }
    report.checkedFonts++;
    let glyphs = 0;
    let leftover = 0;
    for (let g = 1; g < cff.count; g++) {
      if (!hasOutline(cff.charstring(g))) continue;
      glyphs++;
      if (!usedGids.has(g)) leftover++;
    }
    if (leftover >= MIN_LEFTOVER) report.findings.push({ pattern: "P7", font: ref.objectNumber, fontType: kind, glyphs, used: glyphs - leftover, leftover });
    else if (leftover > 0) report.belowThreshold++;
  }
  return report;
}

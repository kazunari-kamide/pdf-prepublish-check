// SPDX-License-Identifier: AGPL-3.0-only
//
// ページ（と部品）の中に直接埋め込んだ画像（BI … ID … EI）を、同じ中身の画像の部品（XObject）に移し替える（0.8.0 から）。
// 見た目は変わらない（埋め込んだ画像と、同じ場所に描く画像の部品は同じに描かれる）。
// 移し替えると、ページの中身を書き直せるようになり、ふつうの画像と同じく、覆いの下の字を消し・画素を塗れる。
//
// 区切りは、命令の読み手（rules/shared/content-lexer.ts）と同じ決まりで探す：ID のあとの空白 1 つを飛ばし、
// 前が空白で、後ろが空白・区切り・終わりの "EI" まで。読み手が返す BI の数と、ここで見つけた数が合わないときは、触らない。

import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFObject, type PDFPage } from "pdf-lib";
import { operations, type Tok } from "../rules/shared/content-lexer.ts";

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

type Range = { start: number; end: number; dataStart: number; dataEnd: number };

/** 中身の中の、埋め込んだ画像の範囲（BI の先頭から EI の後ろまで）。字の並び・コメントの中は飛ばす */
export function findInlineImages(data: Uint8Array, limit: number): Range[] | null {
  const out: Range[] = [];
  const n = data.length;
  let i = 0;
  const skipString = () => {
    let depth = 0;
    while (i < n) {
      const c = data[i++]!;
      if (c === 0x5c) i++;
      else if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) return;
    }
  };
  const wordAt = (at: number, w: string) =>
    data[at] === w.charCodeAt(0) && data[at + 1] === w.charCodeAt(1) && (at === 0 || isWhite(data[at - 1]!) || isDelim(data[at - 1]!)) &&
    (at + 2 >= n || isWhite(data[at + 2]!) || isDelim(data[at + 2]!));
  while (i < n) {
    const c = data[i]!;
    if (c === 0x25) {
      while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x28) {
      skipString();
      continue;
    }
    if (c === 0x3c && data[i + 1] !== 0x3c) {
      while (i < n && data[i] !== 0x3e) i++;
      i++;
      continue;
    }
    if (wordAt(i, "BI")) {
      const start = i;
      i += 2;
      // ID まで（辞書の中の字の並びは飛ばす）
      let found = false;
      while (i < n) {
        const d = data[i]!;
        if (d === 0x28) {
          skipString();
          continue;
        }
        if (d === 0x3c && data[i + 1] !== 0x3c) {
          while (i < n && data[i] !== 0x3e) i++;
          i++;
          continue;
        }
        if (wordAt(i, "ID")) {
          i += 2;
          found = true;
          break;
        }
        i++;
      }
      if (!found) return null;
      if (i < n && isWhite(data[i]!)) i++;
      const dataStart = i;
      let end = -1;
      while (i < n) {
        if (data[i] === 0x45 && data[i + 1] === 0x49 && (i === 0 || isWhite(data[i - 1]!)) && (i + 2 >= n || isWhite(data[i + 2]!) || isDelim(data[i + 2]!))) {
          end = i;
          break;
        }
        i++;
      }
      if (end < 0) return null;
      // EI の前の空白 1 つは区切り（画像の中身には入れない）
      out.push({ start, end: end + 2, dataStart, dataEnd: Math.max(dataStart, end - 1) });
      i = end + 2;
      if (out.length > limit) return null;
      continue;
    }
    i++;
  }
  return out;
}

const KEYS: Record<string, string> = { BPC: "BitsPerComponent", CS: "ColorSpace", D: "Decode", DP: "DecodeParms", F: "Filter", H: "Height", IM: "ImageMask", I: "Interpolate", W: "Width" };
const COLOR: Record<string, string> = { G: "DeviceGray", RGB: "DeviceRGB", CMYK: "DeviceCMYK", I: "Indexed" };
const FILTER: Record<string, string> = { AHx: "ASCIIHexDecode", A85: "ASCII85Decode", LZW: "LZWDecode", Fl: "FlateDecode", RL: "RunLengthDecode", CCF: "CCITTFaxDecode", DCT: "DCTDecode" };

function toObj(ctx: PDFContext, t: Tok, nameMap: Record<string, string> = {}): PDFObject {
  switch (t.t) {
    case "num": return PDFNumber.of(t.v);
    case "str": return PDFHexString.of(Array.from(t.v, (b) => b.toString(16).padStart(2, "0")).join(""));
    case "name": return PDFName.of(nameMap[t.v] ?? t.v);
    case "arr": return ctx.obj(t.v.map((x) => toObj(ctx, x, nameMap)));
    case "dict": {
      const d = ctx.obj({}) as PDFDict;
      for (const [k, v] of t.v) d.set(PDFName.of(k), toObj(ctx, v));
      return d;
    }
    case "bool": return t.v ? PDFBool.True : PDFBool.False;
    case "null": return PDFNull;
  }
}

/** 埋め込んだ画像の辞書（略した名前）を、画像の部品の辞書にする。名前で呼ぶ色空間は、資源の中身に置き換える */
function imageDict(ctx: PDFContext, dict: Map<string, Tok>, res: PDFDict | undefined): PDFDict | null {
  const d = ctx.obj({ Type: "XObject", Subtype: "Image" }) as PDFDict;
  for (const [k0, v] of dict) {
    const k = KEYS[k0] ?? k0;
    if (k === "L" || k === "Length") continue;
    if (k === "ColorSpace") {
      if (v.t === "name" && !COLOR[v.v] && !["DeviceGray", "DeviceRGB", "DeviceCMYK"].includes(v.v)) {
        const spaces = res ? ctx.lookup(res.get(PDFName.of("ColorSpace"))) : undefined;
        const def = spaces instanceof PDFDict ? spaces.get(PDFName.of(v.v)) : undefined;
        if (!def) return null;
        d.set(PDFName.of(k), def);
        continue;
      }
      d.set(PDFName.of(k), toObj(ctx, v, COLOR));
      continue;
    }
    if (k === "Filter") {
      d.set(PDFName.of(k), toObj(ctx, v, FILTER));
      continue;
    }
    d.set(PDFName.of(k), toObj(ctx, v));
  }
  const w = d.lookup(PDFName.of("Width"));
  const h = d.lookup(PDFName.of("Height"));
  if (!(w instanceof PDFNumber) || !(h instanceof PDFNumber)) return null;
  return d;
}

/** 辞書にまだない名前 */
function freshName(dict: PDFDict, prefix: string): PDFName {
  for (let k = 1; ; k++) {
    const n = PDFName.of(`${prefix}${k}`);
    if (!dict.has(n)) return n;
  }
}

/**
 * 中身1つの埋め込んだ画像を、画像の部品に移し替えた中身と資源を返す。埋め込んだ画像がない・移し替えられないときは null。
 * 資源の辞書は写してから書き足す（ほかの所と共有かもしれないため）
 */
export function convertInline(ctx: PDFContext, data: Uint8Array, res: PDFDict | undefined, maxOps: number): { data: Uint8Array; res: PDFDict; count: number } | null {
  if (!res) return null;
  const dicts: Array<Map<string, Tok>> = [];
  let ops = 0;
  for (const o of operations(data)) {
    if (++ops > maxOps) return null;
    if (o.op === "BI" && o.args[0]?.t === "dict") dicts.push(o.args[0].v);
  }
  if (!dicts.length) return null;
  const ranges = findInlineImages(data, dicts.length);
  if (!ranges || ranges.length !== dicts.length) return null;
  const newRes = res.clone(ctx);
  const old = ctx.lookup(newRes.get(PDFName.of("XObject")));
  const xo = old instanceof PDFDict ? old.clone(ctx) : (ctx.obj({}) as PDFDict);
  newRes.set(PDFName.of("XObject"), xo);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const [k, r] of ranges.entries()) {
    const d = imageDict(ctx, dicts[k]!, res);
    if (!d) return null;
    const stream = PDFRawStream.of(d, data.slice(r.dataStart, r.dataEnd));
    const name = freshName(xo, "SanInl");
    xo.set(name, ctx.register(stream));
    parts.push(data.subarray(at, r.start), new TextEncoder().encode(` /${name.decodeText()} Do `));
    at = r.end;
  }
  parts.push(data.subarray(at));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { data: out, res: newRes, count: ranges.length };
}

/**
 * ページの中身と、ページから呼ぶ部品（自分の資源を持つもの）の中の埋め込んだ画像を、画像の部品に移し替える。
 * 部品は、同じ見た目のまま中身を差し替える（ほかのページと共有でも、見た目は変わらないため）。移し替えた数を返す
 */
export function convertPageInlineImages(ctx: PDFContext, page: PDFPage, contentData: (c: PDFObject | undefined) => Uint8Array, streamData: (s: PDFStream) => Uint8Array, maxOps: number, maxDepth: number): number {
  let count = 0;
  const res = (ctx.lookup(page.node.get(PDFName.of("Resources"))) as PDFDict | undefined) ?? page.node.Resources();
  const seen = new Set<PDFStream>();
  const forms = (r: PDFDict | undefined, depth: number) => {
    const xo = r ? ctx.lookup(r.get(PDFName.of("XObject"))) : undefined;
    if (!(xo instanceof PDFDict) || depth > maxDepth) return;
    for (const [k, v] of xo.entries()) {
      const s = v instanceof PDFRef ? ctx.lookup(v) : v;
      if (!(s instanceof PDFStream) || seen.has(s) || s.dict.lookup(PDFName.of("Subtype")) !== PDFName.of("Form")) continue;
      seen.add(s);
      const fr = ctx.lookup(s.dict.get(PDFName.of("Resources")));
      if (!(fr instanceof PDFDict)) continue; // ページの資源を使う部品は触らない
      let d: Uint8Array;
      try {
        d = streamData(s);
      } catch {
        continue;
      }
      const c = convertInline(ctx, d, fr, maxOps);
      if (c) {
        const ns = ctx.flateStream(c.data, {});
        for (const [key, val] of s.dict.entries()) {
          const name = key.decodeText();
          if (name === "Filter" || name === "DecodeParms" || name === "DP" || name === "Length" || name === "Resources") continue;
          ns.dict.set(key, val);
        }
        ns.dict.set(PDFName.of("Resources"), c.res);
        const ref = ctx.register(ns);
        xo.set(k, ref);
        count += c.count;
        forms(c.res, depth + 1);
      } else forms(fr, depth + 1);
    }
  };
  const data = contentData(page.node.get(PDFName.of("Contents")));
  const c = convertInline(ctx, data, res, maxOps);
  if (c) {
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(c.data, {})));
    page.node.set(PDFName.of("Resources"), c.res);
    count += c.count;
    forms(c.res, 0);
  } else forms(res, 0);
  return count;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// フォントの辞書から、1字ごとの幅・高さと、字の区切り方（1バイトか2バイトか）を読む。
// 字の中身（Unicode）は、空白かどうかの見分けと、調べるとき（includeText）にだけ使う。

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { operations } from "./lexer.ts";

export type Glyph = {
  /** 字の幅（字の空間の単位。1em = 1） */
  width: number;
  /** 空白か（覆われた字の数に入れない） */
  isSpace: boolean;
  /** 1バイトの字で、コードが 32（Tw＝語の間隔がかかる字） */
  isWordSpace: boolean;
  /** 字の中身（ToUnicode から。分からなければ空） */
  text: string;
};

export type FontInfo = {
  /** バイト列を字に分ける */
  decode(bytes: Uint8Array): Glyph[];
  /** 字の高さの範囲（em。下端は負） */
  ascent: number;
  descent: number;
  /** Type3 の FontMatrix の横の倍率（ほかは 0.001） */
  unitsPerGlyphSpace: number;
};

const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = -0.2;
/** 幅が分からない字に使う幅（em）。標準の14書体で /Widths がないときなど */
const FALLBACK_WIDTH = 0.5;

function num(ctx: PDFContext, obj: PDFObject | undefined): number | undefined {
  const v = obj ? ctx.lookup(obj) : undefined;
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

function nameOf(ctx: PDFContext, obj: PDFObject | undefined): string | undefined {
  const v = obj ? ctx.lookup(obj) : undefined;
  return v instanceof PDFName ? v.decodeText() : undefined;
}

function streamBytes(ctx: PDFContext, obj: PDFObject | undefined): Uint8Array | undefined {
  const v = obj ? ctx.lookup(obj) : undefined;
  if (v instanceof PDFRawStream) return decodePDFRawStream(v).decode();
  if (v instanceof PDFStream) return v.getContents();
  return undefined;
}

function bytesToNumber(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

function utf16beToString(b: Uint8Array): string {
  let s = "";
  for (let k = 0; k + 1 < b.length; k += 2) s += String.fromCharCode((b[k]! << 8) | b[k + 1]!);
  return s;
}

/** ToUnicode の CMap から、コード → 字の表を作る（bfchar・bfrange だけ） */
function parseToUnicode(data: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  const ops = [...operations(data)];
  for (const { op, args } of ops) {
    if (op === "endbfchar") {
      for (let k = 0; k + 1 < args.length; k += 2) {
        const src = args[k];
        const dst = args[k + 1];
        if (src && typeof src === "object" && "kind" in src && src.kind === "bytes" &&
            dst && typeof dst === "object" && "kind" in dst && dst.kind === "bytes") {
          map.set(bytesToNumber(src.value), utf16beToString(dst.value));
        }
      }
    } else if (op === "endbfrange") {
      for (let k = 0; k + 2 < args.length; k += 3) {
        const lo = args[k];
        const hi = args[k + 1];
        const dst = args[k + 2];
        if (!(lo && typeof lo === "object" && "kind" in lo && lo.kind === "bytes")) continue;
        if (!(hi && typeof hi === "object" && "kind" in hi && hi.kind === "bytes")) continue;
        const a = bytesToNumber(lo.value);
        const b = bytesToNumber(hi.value);
        if (b < a || b - a > 65535) continue;
        if (Array.isArray(dst)) {
          for (let c = a; c <= b; c++) {
            const d = dst[c - a];
            if (d && typeof d === "object" && "kind" in d && d.kind === "bytes") map.set(c, utf16beToString(d.value));
          }
        } else if (dst && typeof dst === "object" && "kind" in dst && dst.kind === "bytes") {
          const base = dst.value;
          for (let c = a; c <= b; c++) {
            const out = Uint8Array.from(base);
            let carry = c - a;
            for (let j = out.length - 1; j >= 0 && carry > 0; j--) {
              const v = out[j]! + carry;
              out[j] = v & 0xff;
              carry = v >> 8;
            }
            map.set(c, utf16beToString(out));
          }
        }
      }
    }
  }
  return map;
}

function isBlank(s: string): boolean {
  return s !== "" && s.trim() === "";
}

function readDescriptor(ctx: PDFContext, desc: PDFDict | undefined): { ascent: number; descent: number } {
  if (!desc) return { ascent: DEFAULT_ASCENT, descent: DEFAULT_DESCENT };
  const a = num(ctx, desc.get(PDFName.of("Ascent")));
  const d = num(ctx, desc.get(PDFName.of("Descent")));
  // 0 や、上下が逆の値が入っている PDF もあるので、そのときは既定の値にする
  const ascent = a !== undefined && a > 0 ? a / 1000 : DEFAULT_ASCENT;
  const descent = d !== undefined && d < 0 ? d / 1000 : DEFAULT_DESCENT;
  return { ascent, descent };
}

/** CIDFont の /W 配列を読む */
function parseW(ctx: PDFContext, w: PDFArray | undefined): Map<number, number> {
  const widths = new Map<number, number>();
  if (!w) return widths;
  const items = w.asArray().map((o) => ctx.lookup(o));
  let k = 0;
  while (k < items.length) {
    const first = items[k];
    const next = items[k + 1];
    if (!(first instanceof PDFNumber)) break;
    if (next instanceof PDFArray) {
      const start = first.asNumber();
      next.asArray().forEach((o, j) => {
        const v = ctx.lookup(o);
        if (v instanceof PDFNumber) widths.set(start + j, v.asNumber());
      });
      k += 2;
    } else {
      const last = next instanceof PDFNumber ? next.asNumber() : NaN;
      const wv = items[k + 2];
      if (!Number.isFinite(last) || !(wv instanceof PDFNumber) || last < first.asNumber() || last - first.asNumber() > 65535) break;
      for (let c = first.asNumber(); c <= last; c++) widths.set(c, wv.asNumber());
      k += 3;
    }
  }
  return widths;
}

export function readFont(ctx: PDFContext, fontObj: PDFObject | undefined): FontInfo {
  const font = fontObj ? ctx.lookup(fontObj) : undefined;
  if (!(font instanceof PDFDict)) return fallbackFont();
  const subtype = nameOf(ctx, font.get(PDFName.of("Subtype")));
  const toUnicodeData = streamBytes(ctx, font.get(PDFName.of("ToUnicode")));
  const toUnicode = toUnicodeData ? safe(() => parseToUnicode(toUnicodeData), new Map<number, string>()) : new Map<number, string>();

  if (subtype === "Type0") {
    const descendants = ctx.lookup(font.get(PDFName.of("DescendantFonts")));
    const cid = descendants instanceof PDFArray ? ctx.lookup(descendants.get(0)) : undefined;
    const cidDict = cid instanceof PDFDict ? cid : undefined;
    const dw = (cidDict && num(ctx, cidDict.get(PDFName.of("DW")))) ?? 1000;
    const wArr = cidDict ? ctx.lookup(cidDict.get(PDFName.of("W"))) : undefined;
    const widths = parseW(ctx, wArr instanceof PDFArray ? wArr : undefined);
    const desc = cidDict ? ctx.lookup(cidDict.get(PDFName.of("FontDescriptor"))) : undefined;
    const { ascent, descent } = readDescriptor(ctx, desc instanceof PDFDict ? desc : undefined);
    // Identity-H/V 以外の CMap も、2バイトで区切る（日本語の CMap の多くは2バイト。限界は README に書く）
    return {
      ascent,
      descent,
      unitsPerGlyphSpace: 0.001,
      decode(bytes) {
        const out: Glyph[] = [];
        for (let k = 0; k + 1 < bytes.length; k += 2) {
          const code = (bytes[k]! << 8) | bytes[k + 1]!;
          const text = toUnicode.get(code) ?? "";
          out.push({ width: (widths.get(code) ?? dw) / 1000, isSpace: isBlank(text), isWordSpace: false, text });
        }
        return out;
      },
    };
  }

  // 1バイトの字（Type1・TrueType・Type3 など）
  const firstChar = num(ctx, font.get(PDFName.of("FirstChar"))) ?? 0;
  const wObj = ctx.lookup(font.get(PDFName.of("Widths")));
  const widthList = wObj instanceof PDFArray ? wObj.asArray().map((o) => num(ctx, o) ?? 0) : [];
  let unitsPerGlyphSpace = 0.001;
  if (subtype === "Type3") {
    const fm = ctx.lookup(font.get(PDFName.of("FontMatrix")));
    const a = fm instanceof PDFArray ? num(ctx, fm.get(0)) : undefined;
    if (a !== undefined && a !== 0 && Number.isFinite(a)) unitsPerGlyphSpace = Math.abs(a);
  }
  const desc = ctx.lookup(font.get(PDFName.of("FontDescriptor")));
  const { ascent, descent } = readDescriptor(ctx, desc instanceof PDFDict ? desc : undefined);
  return {
    ascent,
    descent,
    unitsPerGlyphSpace,
    decode(bytes) {
      const out: Glyph[] = [];
      for (const code of bytes) {
        const raw = widthList[code - firstChar];
        const width = raw !== undefined && widthList.length > 0 ? raw * unitsPerGlyphSpace : FALLBACK_WIDTH;
        const text = toUnicode.get(code) ?? (code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : "");
        out.push({ width, isSpace: code === 0x20 || isBlank(text), isWordSpace: code === 0x20, text });
      }
      return out;
    },
  };
}

function fallbackFont(): FontInfo {
  return {
    ascent: DEFAULT_ASCENT,
    descent: DEFAULT_DESCENT,
    unitsPerGlyphSpace: 0.001,
    decode(bytes) {
      return [...bytes].map((code) => ({
        width: FALLBACK_WIDTH,
        isSpace: code === 0x20,
        isWordSpace: code === 0x20,
        text: "",
      }));
    },
  };
}

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

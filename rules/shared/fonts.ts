// SPDX-License-Identifier: AGPL-3.0-only
//
// 書体の辞書から、1字ごとの幅と、字の高さの範囲と、字の区切り方（1バイトか2バイトか）を読む。
// P6（rules/p6-text）と P7（rules/p7-hidden）で同じものを使う（PR #25 の返事の 1）。直すときは、両方の採点で確かめる。
// 字の中身（Unicode）は、空白かどうかの見分けと、調べるとき（includeText）にだけ使う。
//
// 幅（em）の引き方：
//   1バイトの字：/Widths（Type3 は FontMatrix の倍率をかける）→ 標準の書体なら pdf-lib が持つ寸法（AFM）→ /MissingWidth → 0.5
//   2バイトの字（Type0）：子の書体の /W → /DW → 1
// 高さ（em）の引き方：/FontDescriptor の /Ascent・/Descent → /FontBBox（Type3 は書体の /FontBBox）→ 標準の書体の寸法 → 0.8・−0.2

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  PDFRawStream,
  PDFStream,
  StandardFontEmbedder,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { cidUnicodeFor } from "./cid-unicode.ts";
import { decodeStream } from "./inflate-limit.ts";
import { predefinedCMap } from "./predefined-cmaps.ts";
import { operations, type Tok } from "./content-lexer.ts";

export type Glyph = {
  /** 字のコード（1バイトなら 0〜255、2バイトなら 0〜65535） */
  code: number;
  /** 字の幅（字の空間の単位。1em = 1） */
  width: number;
  /** 空白か（隠れた字・覆われた字の数に入れない） */
  isSpace: boolean;
  /** 1バイトの字で、コードが 32（Tw＝語の間隔がかかる字） */
  isWordSpace: boolean;
  /** 字の中身（ToUnicode から。なければ ASCII の字。分からなければ空） */
  text: string;
  /** この字のバイト数（2026-11-06 から）。決まった字の対応表（RKSJ・UTF16）では 1・2・4 バイトが混ざる */
  bytes: number;
};

export type FontInfo = {
  /** 2バイトで区切る書体か（Type0） */
  twoByte: boolean;
  /** バイト列を字に分ける */
  decode(bytes: Uint8Array): Glyph[];
  /** 字の高さの範囲（em。下端は負） */
  ascent: number;
  descent: number;
  /**
   * 縦書き（CMap の名前が -V で終わる Type0）のとき（2026-11-05 から）。PDF 1.7 §9.7.4.3 の DW2 の値（em）。
   * vy＝縦の原点の高さ（位置のベクトルの y）、w1＝縦の送り（下へ進むので負）。W2 の字ごとの値は読まない
   */
  vertical?: { vy: number; w1: number };
};

/**
 * 1字の箱（字の空間。em に字の大きさをかける前）。P6 と P7 で同じものを使う（2026-11-06。前は P7 だけ縦書きを見ず、縦の列の字を横に並べていた）。
 * 横書き：原点から右へ幅、上下は descent〜ascent。
 * 縦書き：縦の原点（字の上の真ん中）から、横は幅の半分ずつ左右に、縦は原点から下へ（PDF 1.7 §9.7.4.3）
 */
export function glyphExtent(font: FontInfo, width: number): { x0: number; x1: number; y0: number; y1: number } {
  const v = font.vertical;
  return v
    ? { x0: -width / 2, x1: width / 2, y0: font.descent - v.vy, y1: font.ascent - v.vy }
    : { x0: 0, x1: width, y0: font.descent, y1: font.ascent };
}

/**
 * 1字を描いたあとの送り（文字空間。[横, 縦]）。横書きは右へ（字の幅＋Tc＋Tw）×Th、縦書きは下へ（w1×字の大きさ − Tc）。
 * 縦書きの Tw と W2 の字ごとの値は見ない（P6 の 1.x からの扱い。限界は rules/p6-text/README.md）
 */
export function glyphAdvance(
  font: FontInfo,
  g: Pick<Glyph, "width" | "isWordSpace">,
  size: number,
  charSpacing: number,
  wordSpacing: number,
  hScale: number,
): [number, number] {
  if (font.vertical) return [0, font.vertical.w1 * size - charSpacing];
  return [(g.width * size + charSpacing + (g.isWordSpace ? wordSpacing : 0)) * hScale, 0];
}

/** TJ の数（千分の 1 em）での送り。横書きは左へ詰める（右へ空ける）、縦書きは下へ詰める・空ける */
export function tjShift(font: FontInfo | null | undefined, value: number, size: number, hScale: number): [number, number] {
  if (font?.vertical) return [0, (-value / 1000) * size];
  return [(-value / 1000) * size * hScale, 0];
}

const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = -0.2;
/** 幅が分からない字に使う幅（em） */
const FALLBACK_WIDTH = 0.5;
/** /W から読む字の数の上限（細工した PDF で固まらないため） */
const MAX_W_ENTRIES = 100_000;

/**
 * 標準の書体（ラテン文字の12書体）と、埋め込まずに使われることの多い別名。
 * Symbol・ZapfDingbats は独自の符号で、コードから字を引けないので除く。
 */
const STANDARD: Record<string, string> = {
  Courier: "Courier", "Courier-Bold": "Courier-Bold", "Courier-Oblique": "Courier-Oblique", "Courier-BoldOblique": "Courier-BoldOblique",
  Helvetica: "Helvetica", "Helvetica-Bold": "Helvetica-Bold", "Helvetica-Oblique": "Helvetica-Oblique", "Helvetica-BoldOblique": "Helvetica-BoldOblique",
  "Times-Roman": "Times-Roman", "Times-Bold": "Times-Bold", "Times-Italic": "Times-Italic", "Times-BoldItalic": "Times-BoldItalic",
  Arial: "Helvetica", "Arial,Bold": "Helvetica-Bold", TimesNewRoman: "Times-Roman",
};

type Standard = { width(code: number): number | undefined; ascent: number | undefined; descent: number | undefined };

/** 標準の書体の寸法（pdf-lib が持つ AFM）。標準の書体でなければ null */
function standardMetrics(baseFont: string | undefined): Standard | null {
  const name = baseFont ? STANDARD[baseFont] : undefined;
  if (!name) return null;
  let embedder: StandardFontEmbedder;
  try {
    embedder = StandardFontEmbedder.for(name as Parameters<typeof StandardFontEmbedder.for>[0]);
  } catch {
    return null;
  }
  const afm = (embedder as unknown as { font?: { Ascender?: number; Descender?: number; FontBBox?: number[] } }).font;
  const asc = afm?.Ascender || afm?.FontBBox?.[3];
  const desc = afm?.Descender || afm?.FontBBox?.[1];
  const cache = new Map<number, number | undefined>();
  return {
    ascent: typeof asc === "number" && asc > 0 ? asc / 1000 : undefined,
    descent: typeof desc === "number" && desc < 0 ? desc / 1000 : undefined,
    width(code) {
      if (cache.has(code)) return cache.get(code);
      let w: number | undefined;
      try {
        w = code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0) ? embedder.widthOfTextAtSize(String.fromCharCode(code), 1) : undefined;
      } catch {
        w = undefined; // 書体にない字
      }
      if (w !== undefined && !(Number.isFinite(w) && w >= 0)) w = undefined;
      cache.set(code, w);
      return w;
    },
  };
}

function num(ctx: PDFContext, obj: PDFObject | undefined): number | undefined {
  const v = obj ? ctx.lookup(obj) : undefined;
  return v instanceof PDFNumber && Number.isFinite(v.asNumber()) ? v.asNumber() : undefined;
}

function nameOf(ctx: PDFContext, obj: PDFObject | undefined): string | undefined {
  const v = obj ? ctx.lookup(obj) : undefined;
  return v instanceof PDFName ? v.decodeText() : undefined;
}

/** 文字列（PDFString・PDFHexString）の中身。CIDSystemInfo の Registry・Ordering を読むため */
function textOf(ctx: PDFContext, obj: PDFObject | undefined): string | undefined {
  const o = obj ? ctx.lookup(obj) : undefined;
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined;
}

function dictOf(ctx: PDFContext, obj: PDFObject | undefined): PDFDict | undefined {
  const v = obj ? ctx.lookup(obj) : undefined;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

function arrOf(ctx: PDFContext, obj: PDFObject | undefined): PDFArray | undefined {
  const v = obj ? ctx.lookup(obj) : undefined;
  return v instanceof PDFArray ? v : undefined;
}

function streamBytes(ctx: PDFContext, obj: PDFObject | undefined): Uint8Array | undefined {
  const v = obj ? ctx.lookup(obj) : undefined;
  if (v instanceof PDFStream) return decodeStream(v);
  return undefined;
}

/** 一部だけ埋め込んだ書体の頭の6字（ABCDEF+）を外す */
const stripSubset = (s: string | undefined) => s?.replace(/^[A-Z]{6}\+/, "");

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

const strOf = (t: Tok | undefined) => (t?.t === "str" ? t.v : undefined);

/** ToUnicode の CMap から、コード → 字の表を作る（bfchar・bfrange だけ） */
function parseToUnicode(data: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  for (const { op, args } of operations(data)) {
    if (op === "endbfchar") {
      for (let k = 0; k + 1 < args.length; k += 2) {
        const src = strOf(args[k]);
        const dst = strOf(args[k + 1]);
        if (src && dst) map.set(bytesToNumber(src), utf16beToString(dst));
      }
    } else if (op === "endbfrange") {
      for (let k = 0; k + 2 < args.length; k += 3) {
        const lo = strOf(args[k]);
        const hi = strOf(args[k + 1]);
        const dst = args[k + 2];
        if (!lo || !hi) continue;
        const a = bytesToNumber(lo);
        const b = bytesToNumber(hi);
        if (b < a || b - a > 65535) continue;
        if (dst?.t === "arr") {
          for (let c = a; c <= b; c++) {
            const d = strOf(dst.v[c - a]);
            if (d) map.set(c, utf16beToString(d));
          }
        } else if (dst?.t === "str") {
          for (let c = a; c <= b; c++) {
            const out = Uint8Array.from(dst.v);
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

/** CIDFont の /W 配列を読む（1000 分の 1 em） */
function parseW(ctx: PDFContext, w: PDFArray | undefined): Map<number, number> {
  const widths = new Map<number, number>();
  if (!w) return widths;
  const items = w.asArray().map((o) => ctx.lookup(o));
  let k = 0;
  while (k < items.length && widths.size < MAX_W_ENTRIES) {
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

/**
 * 字の高さの範囲（em）。上端は正、下端は負の値だけを使い、それ以外（0 や上下が逆の値）は次の引き方に回す。
 * bbox は /FontBBox を em に直したもの（[左, 下, 右, 上]）。
 */
function heights(ctx: PDFContext, desc: PDFDict | undefined, bbox: number[] | undefined, std: Standard | null): { ascent: number; descent: number } {
  const a = desc ? num(ctx, desc.get(PDFName.of("Ascent"))) : undefined;
  const d = desc ? num(ctx, desc.get(PDFName.of("Descent"))) : undefined;
  const pick = (cands: Array<number | undefined>, ok: (v: number) => boolean, fallback: number) => cands.find((v) => v !== undefined && ok(v)) ?? fallback;
  return {
    ascent: pick([a !== undefined ? a / 1000 : undefined, bbox?.[3], std?.ascent], (v) => v > 0, DEFAULT_ASCENT),
    descent: pick([d !== undefined ? d / 1000 : undefined, bbox?.[1], std?.descent], (v) => v < 0, DEFAULT_DESCENT),
  };
}

function bboxOf(ctx: PDFContext, obj: PDFObject | undefined, scale: number): number[] | undefined {
  const arr = arrOf(ctx, obj);
  if (!arr || arr.size() !== 4) return undefined;
  const v = [0, 1, 2, 3].map((k) => num(ctx, arr.get(k)));
  return v.every((x) => x !== undefined) ? (v as number[]).map((x) => x * scale) : undefined;
}

export function readFont(ctx: PDFContext, fontObj: PDFObject | undefined): FontInfo {
  const font = dictOf(ctx, fontObj);
  if (!font) return fallbackFont();
  const subtype = nameOf(ctx, font.get(PDFName.of("Subtype")));
  const toUnicodeData = streamBytes(ctx, font.get(PDFName.of("ToUnicode")));
  const toUnicode = toUnicodeData ? safe(() => parseToUnicode(toUnicodeData), new Map<number, string>()) : new Map<number, string>();

  if (subtype === "Type0") {
    const descendants = arrOf(ctx, font.get(PDFName.of("DescendantFonts")));
    const cid = descendants && descendants.size() > 0 ? dictOf(ctx, descendants.get(0)) : undefined;
    const dw = (cid && num(ctx, cid.get(PDFName.of("DW")))) ?? 1000;
    const widths = parseW(ctx, cid ? arrOf(ctx, cid.get(PDFName.of("W"))) : undefined);
    const desc = cid ? dictOf(ctx, cid.get(PDFName.of("FontDescriptor"))) : undefined;
    const std = standardMetrics(stripSubset(nameOf(ctx, cid?.get(PDFName.of("BaseFont")))));
    const { ascent, descent } = heights(ctx, desc, desc ? bboxOf(ctx, desc.get(PDFName.of("FontBBox")), 0.001) : undefined, std);
    const encName = nameOf(ctx, font.get(PDFName.of("Encoding")));
    // 決まった字の対応表（90ms-RKSJ-H・UniJIS-UCS2-H など。2026-11-06 から）：Shift-JIS・Unicode として区切って字を読み、幅は CID で引く
    // （rules/shared/predefined-cmaps.ts）。ほかの名前の CMap は、これまでどおり 2 バイトずつ区切る（限界は rules/p6-text/README.md に書く）
    const predefined = predefinedCMap(encName);
    // ToUnicode にない字は、Identity-H/V（字の番号＝CID）で CID の書体の並びが Adobe-Japan1 のとき、その並びの表から引く（2026-11-06）。
    // 埋め込みの CID の書体で ToUnicode のない PDF（印刷の会社が作るチラシなど）の字を読むため
    const sysInfo = cid ? dictOf(ctx, cid.get(PDFName.of("CIDSystemInfo"))) : undefined;
    const byCid =
      encName === "Identity-H" || encName === "Identity-V"
        ? cidUnicodeFor(textOf(ctx, sysInfo?.get(PDFName.of("Registry"))), textOf(ctx, sysInfo?.get(PDFName.of("Ordering"))))
        : null;
    let vertical: FontInfo["vertical"];
    if (encName && /-V$/.test(encName)) {
      const dw2 = cid ? arrOf(ctx, cid.get(PDFName.of("DW2"))) : undefined;
      const vy = dw2 && dw2.size() >= 2 ? num(ctx, dw2.get(0)) : undefined;
      const w1 = dw2 && dw2.size() >= 2 ? num(ctx, dw2.get(1)) : undefined;
      vertical = { vy: (vy ?? 880) / 1000, w1: (w1 ?? -1000) / 1000 };
    }
    return {
      twoByte: true,
      ascent,
      descent,
      ...(vertical ? { vertical } : {}),
      decode(bytes) {
        const out: Glyph[] = [];
        if (predefined) {
          for (let k = 0; k < bytes.length; ) {
            const ch = predefined.read(bytes, k);
            const text = toUnicode.get(ch.code) ?? ch.text;
            // 1 バイトのコード 32 には語の間隔（Tw）がかかる（PDF 1.7 §9.3.3）
            const isWordSpace = ch.len === 1 && ch.code === 0x20;
            out.push({ code: ch.code, width: (widths.get(ch.cid) ?? dw) / 1000, isSpace: isWordSpace || isBlank(text), isWordSpace, text, bytes: ch.len });
            k += ch.len;
          }
          return out;
        }
        for (let k = 0; k + 1 < bytes.length; k += 2) {
          const code = (bytes[k]! << 8) | bytes[k + 1]!;
          const text = toUnicode.get(code) ?? byCid?.(code) ?? "";
          out.push({ code, width: (widths.get(code) ?? dw) / 1000, isSpace: isBlank(text), isWordSpace: false, text, bytes: 2 });
        }
        return out;
      },
    };
  }

  // 1バイトの字（Type1・TrueType・Type3 など）
  let scale = 0.001; // 字の空間の単位 → em（Type3 は FontMatrix の横の倍率）
  if (subtype === "Type3") {
    const fm = arrOf(ctx, font.get(PDFName.of("FontMatrix")));
    const a = fm ? num(ctx, fm.get(0)) : undefined;
    if (a !== undefined && a !== 0) scale = Math.abs(a);
  }
  const firstChar = num(ctx, font.get(PDFName.of("FirstChar"))) ?? 0;
  const wArr = arrOf(ctx, font.get(PDFName.of("Widths")));
  const widthList = wArr ? wArr.asArray().map((o) => num(ctx, o)) : [];
  const desc = dictOf(ctx, font.get(PDFName.of("FontDescriptor")));
  const missing = desc ? num(ctx, desc.get(PDFName.of("MissingWidth"))) : undefined;
  const std = subtype === "Type3" ? null : standardMetrics(stripSubset(nameOf(ctx, font.get(PDFName.of("BaseFont")))));
  const bbox =
    subtype === "Type3" ? bboxOf(ctx, font.get(PDFName.of("FontBBox")), scale) : desc ? bboxOf(ctx, desc.get(PDFName.of("FontBBox")), 0.001) : undefined;
  const { ascent, descent } = heights(ctx, desc, bbox, std);
  const widthOf = (code: number): number => {
    const raw = code >= firstChar ? widthList[code - firstChar] : undefined;
    if (raw !== undefined) return raw * scale;
    const s = std?.width(code);
    if (s !== undefined) return s;
    if (missing !== undefined && missing >= 0) return missing * scale;
    return FALLBACK_WIDTH;
  };
  return {
    twoByte: false,
    ascent,
    descent,
    decode(bytes) {
      const out: Glyph[] = [];
      for (const code of bytes) {
        const text = toUnicode.get(code) ?? (code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : "");
        out.push({ code, width: widthOf(code), isSpace: code === 0x20 || isBlank(text), isWordSpace: code === 0x20, text, bytes: 1 });
      }
      return out;
    },
  };
}

/** 書体の辞書が読めないとき（幅は 0.5em、高さは既定の値） */
function fallbackFont(): FontInfo {
  return {
    twoByte: false,
    ascent: DEFAULT_ASCENT,
    descent: DEFAULT_DESCENT,
    decode(bytes) {
      return [...bytes].map((code) => ({ code, width: FALLBACK_WIDTH, isSpace: code === 0x20, isWordSpace: code === 0x20, text: "", bytes: 1 }));
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

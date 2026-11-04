// SPDX-License-Identifier: AGPL-3.0-only
//
// 字の対応表（ToUnicode）の書き換えを見つけるための、「見た目の字」を引く道具（P7 1.1.0 から。取りこぼし 26 項目の 16）。
//
// 見た目の字は、1バイトの書体の文字コード → 字形の名前（/Encoding と /Differences）→ 字、の順に引く。
// 引けるのは、字形の名前から字が決まる場合だけ（ASCII の字形の名前・uniXXXX・uXXXX・合字の名前）。
// 決まらない字形（独自の名前、記号の書体、2バイトの書体、Type3）は null を返し、比べない。
// 字形の名前は PDF の仕様と字形の名前の決まりに出てくる標準の名前で、ここで一から書いた。

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, type PDFContext, type PDFObject } from "pdf-lib";

/** ASCII の字形の名前（0x20〜0x7E） */
const ASCII_NAMES: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'",
  parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@",
  bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`",
  braceleft: "{", bar: "|", braceright: "}", asciitilde: "~",
  quoteleft: "‘", quoteright: "’",
  ff: "ff", fi: "fi", fl: "fl", ffi: "ffi", ffl: "ffl",
};
for (let c = 0x41; c <= 0x5a; c++) ASCII_NAMES[String.fromCharCode(c)] = String.fromCharCode(c);
for (let c = 0x61; c <= 0x7a; c++) ASCII_NAMES[String.fromCharCode(c)] = String.fromCharCode(c);

/** 字形の名前から字を引く。引けなければ null */
export function unicodeOfGlyphName(name: string): string | null {
  // 異体字・小型の大文字などの後ろの印（a.sc・one.oldstyle・f_i）を外す
  const base = name.split(".")[0]!;
  if (base === "") return null;
  if (base.includes("_")) {
    const parts = base.split("_").map(unicodeOfGlyphName);
    return parts.every((p): p is string => p !== null) ? parts.join("") : null;
  }
  if (ASCII_NAMES[base] !== undefined) return ASCII_NAMES[base]!;
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(base);
  if (m) {
    const out: string[] = [];
    for (let i = 0; i < m[1]!.length; i += 4) out.push(String.fromCharCode(parseInt(m[1]!.slice(i, i + 4), 16)));
    return out.join("");
  }
  m = /^u([0-9A-F]{4,6})$/.exec(base);
  if (m) {
    const cp = parseInt(m[1]!, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  return null;
}

const STANDARD_NON_SYMBOLIC = /^(Helvetica|Times|Courier)/;
const FLAG_SYMBOLIC = 4;

function look(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}

/**
 * 書体の辞書から「文字コード → 見た目の字」を引く関数を作る。比べられない書体なら null。
 * ToUnicode のない書体は比べない（取り出される字が、そもそも対応表から来ていないため）
 */
export function expectedTextOf(ctx: PDFContext, font: PDFDict): ((code: number) => string | null) | null {
  const subtype = look(ctx, font.get(PDFName.of("Subtype")));
  const st = subtype instanceof PDFName ? subtype.decodeText() : "";
  if (st !== "Type1" && st !== "TrueType" && st !== "MMType1") return null;
  if (!font.has(PDFName.of("ToUnicode"))) return null;
  const baseFontObj = look(ctx, font.get(PDFName.of("BaseFont")));
  const baseFont = baseFontObj instanceof PDFName ? baseFontObj.decodeText().replace(/^[A-Z]{6}\+/, "") : "";
  const desc = look(ctx, font.get(PDFName.of("FontDescriptor")));
  const flagsObj = desc instanceof PDFDict ? look(ctx, desc.get(PDFName.of("Flags"))) : undefined;
  const symbolic = flagsObj instanceof PDFNumber ? (flagsObj.asNumber() & FLAG_SYMBOLIC) !== 0 : false;
  const enc = look(ctx, font.get(PDFName.of("Encoding")));

  const differences = new Map<number, string>();
  let hasBase = false;
  if (enc instanceof PDFName) {
    hasBase = ["WinAnsiEncoding", "MacRomanEncoding", "StandardEncoding"].includes(enc.decodeText());
  } else if (enc instanceof PDFDict) {
    const be = look(ctx, enc.get(PDFName.of("BaseEncoding")));
    hasBase = be instanceof PDFName ? ["WinAnsiEncoding", "MacRomanEncoding", "StandardEncoding"].includes(be.decodeText()) : !symbolic && STANDARD_NON_SYMBOLIC.test(baseFont);
    const diff = look(ctx, enc.get(PDFName.of("Differences")));
    if (diff instanceof PDFArray) {
      let code = 0;
      for (let i = 0; i < diff.size(); i++) {
        const v = look(ctx, diff.get(i));
        if (v instanceof PDFNumber) code = Math.floor(v.asNumber());
        else if (v instanceof PDFName) differences.set(code++, v.decodeText());
      }
    }
  } else if (enc === undefined) {
    // /Encoding のない書体は、記号でない標準の書体（埋め込みなし）だけ、標準の並びとみなす
    const embedded = desc instanceof PDFDict && ["FontFile", "FontFile2", "FontFile3"].some((k) => desc.has(PDFName.of(k)));
    hasBase = !symbolic && !embedded && STANDARD_NON_SYMBOLIC.test(baseFont);
  }
  // 記号の書体で /Differences のないものは、コードが字を表さないので比べない
  if (symbolic && differences.size === 0) return null;
  if (!hasBase && differences.size === 0) return null;

  return (code) => {
    const name = differences.get(code);
    if (name !== undefined) return unicodeOfGlyphName(name);
    if (!hasBase) return null;
    // 標準の並びの ASCII の範囲。' と ` は並びによって字が違うので比べない
    if (code < 0x21 || code > 0x7e || code === 0x27 || code === 0x60) return null;
    return String.fromCharCode(code);
  };
}

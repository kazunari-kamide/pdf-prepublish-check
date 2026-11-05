// SPDX-License-Identifier: AGPL-3.0-only
//
// 埋め込みの画像（ページの中身の BI … ID … EI）を、外の画像（XObject）と同じ形の画像の流れにする（2026-11-05 から）。
// 濃さを測る道具（rules/p6-text/images.ts の readImagePixels など）に、そのまま渡せるようにするため。
// 埋め込みの画像は、辞書の名前を短く書ける（W・H・CS・BPC・F など。PDF 1.7 §8.9.7 の表 93・94）ので、長い名前に直す。
// 中身（バイト列）は、読み手（content-lexer.ts）が返したものを使う。

import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, type PDFContext, type PDFObject } from "pdf-lib";
import type { Tok } from "./content-lexer.ts";

const KEYS: Record<string, string> = {
  W: "Width", H: "Height", CS: "ColorSpace", BPC: "BitsPerComponent", F: "Filter", DP: "DecodeParms",
  IM: "ImageMask", D: "Decode", I: "Interpolate",
};
const NAMES: Record<string, string> = {
  G: "DeviceGray", RGB: "DeviceRGB", CMYK: "DeviceCMYK", I: "Indexed",
  AHx: "ASCIIHexDecode", A85: "ASCII85Decode", LZW: "LZWDecode", Fl: "FlateDecode", RL: "RunLengthDecode", CCF: "CCITTFaxDecode", DCT: "DCTDecode",
};
/** 埋め込みの画像の大きさの上限（PDF の決まりでは 4KB ほどが目安。細工したものを読み込みすぎないため） */
const MAX_INLINE_BYTES = 16 * 1024 * 1024;

function toObject(ctx: PDFContext, t: Tok, depth = 0): PDFObject | undefined {
  if (depth > 8) return undefined;
  switch (t.t) {
    case "num":
      return PDFNumber.of(t.v);
    case "name":
      return PDFName.of(NAMES[t.v] ?? t.v);
    case "bool":
      return t.v ? PDFBool.True : PDFBool.False;
    case "arr": {
      const a = PDFArray.withContext(ctx);
      for (const x of t.v) {
        const o = toObject(ctx, x, depth + 1);
        if (o) a.push(o);
      }
      return a;
    }
    case "dict": {
      const d = PDFDict.withContext(ctx);
      for (const [k, v] of t.v) {
        const o = toObject(ctx, v, depth + 1);
        if (o) d.set(PDFName.of(k), o);
      }
      return d;
    }
    case "str":
      // 色の表（Indexed の lookup）などの字の並び。バイトのまま渡す
      return PDFHexString.of([...t.v].map((b) => b.toString(16).padStart(2, "0")).join(""));
    default:
      return undefined;
  }
}

/** 埋め込みの画像を、画像の流れ（/Type /XObject /Subtype /Image）にする。辞書が足りなければ null */
export function inlineImageStream(ctx: PDFContext, args: Tok[]): PDFRawStream | null {
  const dictTok = args[0];
  const dataTok = args[1];
  if (dictTok?.t !== "dict" || dataTok?.t !== "str" || dataTok.v.length > MAX_INLINE_BYTES) return null;
  const d = PDFDict.withContext(ctx);
  d.set(PDFName.of("Type"), PDFName.of("XObject"));
  d.set(PDFName.of("Subtype"), PDFName.of("Image"));
  for (const [k, v] of dictTok.v) {
    const key = KEYS[k] ?? k;
    if (key === "L" || key === "Length") continue;
    const o = toObject(ctx, v);
    if (o) d.set(PDFName.of(key), o);
  }
  if (!(d.get(PDFName.of("Width")) instanceof PDFNumber) || !(d.get(PDFName.of("Height")) instanceof PDFNumber)) return null;
  return PDFRawStream.of(d, dataTok.v.slice());
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// ファイルの形式を、拡張子ではなく先頭のバイトで見分ける（拡張子は書き換えられるため）。

import { ascii, hasAscii, indexOfAscii } from "./bytes.ts";
import type { FormatKind } from "./types.ts";

/** HEIC・HEIF の箱（ftyp）の銘柄 */
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

export function detectFormat(bytes: Uint8Array): FormatKind {
  if (bytes.length < 4) return "unknown";
  if (indexOfAscii(bytes, "%PDF-", 0, 1024) >= 0) return "pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && hasAscii(bytes, 1, "PNG\r\n\x1a\n")) return "png";
  if (hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP")) return "webp";
  if (hasAscii(bytes, 4, "ftyp")) {
    const major = ascii(bytes, 8, 4);
    if (HEIF_BRANDS.has(major)) return "heic";
    // 互換の銘柄の並び（ftyp の箱の中）にあるもの
    const size = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    for (let at = 16; at + 4 <= Math.min(size, 256, bytes.length); at += 4) if (HEIF_BRANDS.has(ascii(bytes, at, 4))) return "heic";
    return "unknown";
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "cfb";
  if (hasAscii(bytes, 0, "PK\x03\x04") || hasAscii(bytes, 0, "PK\x05\x06")) return "zip";
  return "unknown";
}

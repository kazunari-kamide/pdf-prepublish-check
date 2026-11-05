// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査の前の確かめ。中身を組み立てる前に、PDF として扱ってよいかだけを軽く見る。
// 入ってくるファイルは、壊れている・巨大・細工されている前提で扱う（CLAUDE.md §11-3）。

import { HEADER_SEARCH_BYTES, MAX_FILE_BYTES } from "./limits.ts";

export type PrecheckResult =
  | { ok: true; version: string; byteLength: number }
  | { ok: false; code: "empty" | "too_large" | "not_pdf"; message: string };

const MARK = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function findMark(bytes: Uint8Array, limit: number): number {
  const end = Math.min(bytes.length - MARK.length, limit);
  for (let i = 0; i <= end; i++) {
    let hit = true;
    for (let j = 0; j < MARK.length; j++) {
      if (bytes[i + j] !== MARK[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

export function precheck(bytes: Uint8Array, maxBytes: number = MAX_FILE_BYTES): PrecheckResult {
  if (bytes.length === 0) {
    return { ok: false, code: "empty", message: "ファイルが空です。" };
  }
  if (bytes.length > maxBytes) {
    const mb = Math.floor(maxBytes / (1024 * 1024));
    return {
      ok: false,
      code: "too_large",
      message: `ファイルが大きすぎるため、検査できません（上限は ${mb}MB です）。`,
    };
  }
  const at = findMark(bytes, HEADER_SEARCH_BYTES);
  if (at < 0) {
    return {
      ok: false,
      code: "not_pdf",
      message: "PDF ファイルではないようです。ファイルの先頭に PDF の印が見つかりません。",
    };
  }
  // 版は "%PDF-1.7" のような形。数字と点だけを、最大4文字まで読む
  let version = "";
  for (let i = at + MARK.length; i < bytes.length && version.length < 4; i++) {
    const c = bytes[i]!;
    if ((c >= 0x30 && c <= 0x39) || c === 0x2e) version += String.fromCharCode(c);
    else break;
  }
  return { ok: true, version: version || "不明", byteLength: bytes.length };
}

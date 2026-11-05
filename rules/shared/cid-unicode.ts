// SPDX-License-Identifier: AGPL-3.0-only
//
// CID → 字（2026-11-06）。埋め込みの CID の書体で ToUnicode がない PDF の字を、Adobe の決まった並び（Adobe-Japan1）の表から引く。
// 表は scripts/build-cid-unicode.mjs が作る（rules/shared/cid-unicode/adobe-japan1.ts。元は Adobe の Adobe-Japan1-UCS2、BSD-3-Clause）。
// 通信はしない（表はルールに同梱する。検査の Worker に入る）。

import { ADOBE_JAPAN1 } from "./cid-unicode/adobe-japan1.ts";

let japan1: string[] | null = null;

/** Adobe-Japan1 の CID の字（分からなければ ""） */
export function japan1Char(cid: number): string {
  if (!Number.isInteger(cid) || cid < 0 || cid >= ADOBE_JAPAN1.cidCount) return "";
  japan1 ??= [...ADOBE_JAPAN1.chars];
  const c = japan1[cid] ?? "";
  if (c !== "\u0000") return c;
  return (ADOBE_JAPAN1.multi as Record<string, string>)[String(cid)] ?? "";
}

/** CID の書体の並び（CIDSystemInfo の Registry・Ordering）から、CID → 字の引き方を選ぶ。表のない並びは null */
export function cidUnicodeFor(registry: string | undefined, ordering: string | undefined): ((cid: number) => string) | null {
  if (registry === "Adobe" && ordering === "Japan1") return japan1Char;
  return null;
}

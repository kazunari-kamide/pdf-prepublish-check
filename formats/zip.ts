// SPDX-License-Identifier: AGPL-3.0-only
//
// ZIP（今の Office のファイルの入れ物）を読む。中の一覧（中央の目録）を読み、要る部分だけを解く。
// 細工された ZIP の前提で、数・大きさ・解いた大きさに上限を設ける。ZIP64・暗号化・知らない圧縮は解かない。

import { ascii, le } from "./bytes.ts";
import { inflate } from "./bytes.ts";

export const ZIP_LIMITS = {
  /** 中のファイルの数 */
  entries: 20_000,
  /** 1つの部分を解いた大きさ（バイト） */
  entryBytes: 64 * 1024 * 1024,
  /** すべてを解いた大きさの合計（バイト） */
  totalBytes: 512 * 1024 * 1024,
} as const;

export type ZipEntry = {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

export type ZipArchive = { entries: Map<string, ZipEntry>; truncated: boolean };

export type ZipError = { error: "broken" | "zip64" | "too_many" };

export function readZip(bytes: Uint8Array): ZipArchive | ZipError {
  const r = le(bytes);
  // 終わりの印（EOCD）を、後ろから探す（あとに付ける字は最大 65535 バイト）
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
    if (r.u32(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return { error: "broken" };
  const count = r.u16(eocd + 10)!;
  const cdSize = r.u32(eocd + 12)!;
  const cdOffset = r.u32(eocd + 16)!;
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { error: "zip64" };
  if (cdOffset + cdSize > bytes.length) return { error: "broken" };
  const entries = new Map<string, ZipEntry>();
  let truncated = false;
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (r.u32(at) !== 0x02014b50) return { error: "broken" };
    if (entries.size >= ZIP_LIMITS.entries) {
      truncated = true;
      break;
    }
    const flags = r.u16(at + 8)!;
    const method = r.u16(at + 10)!;
    const compressedSize = r.u32(at + 20)!;
    const size = r.u32(at + 24)!;
    const nameLen = r.u16(at + 28)!;
    const extraLen = r.u16(at + 30)!;
    const commentLen = r.u16(at + 32)!;
    const localOffset = r.u32(at + 42)!;
    if (at + 46 + nameLen > bytes.length) return { error: "broken" };
    const raw = bytes.subarray(at + 46, at + 46 + nameLen);
    const name = flags & 0x800 ? new TextDecoder("utf-8").decode(raw) : ascii(raw, 0, raw.length);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) return { error: "zip64" };
    // 同じ名前が2つあるときは、先のものを使う（Office と同じ読み方とは限らないので、どちらかを見落としうる）
    if (!entries.has(name)) entries.set(name, { name, method, flags, compressedSize, size, localOffset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, truncated };
}

export type EntryRead = { ok: true; data: Uint8Array } | { ok: false; reason: "encrypted" | "unsupported" | "too_large" | "broken" };

/** 解いた大きさを数え、合計の上限を超えないようにする */
export class ZipBudget {
  used = 0;
  readonly max: number;
  constructor(max: number = ZIP_LIMITS.totalBytes) {
    this.max = max;
  }
}

export async function readEntry(bytes: Uint8Array, e: ZipEntry, budget: ZipBudget, max: number = ZIP_LIMITS.entryBytes): Promise<EntryRead> {
  if (e.flags & 0x1) return { ok: false, reason: "encrypted" };
  const r = le(bytes);
  if (r.u32(e.localOffset) !== 0x04034b50) return { ok: false, reason: "broken" };
  const nameLen = r.u16(e.localOffset + 26)!;
  const extraLen = r.u16(e.localOffset + 28)!;
  const start = e.localOffset + 30 + nameLen + extraLen;
  if (start + e.compressedSize > bytes.length) return { ok: false, reason: "broken" };
  const raw = bytes.subarray(start, start + e.compressedSize);
  const limit = Math.min(max, budget.max - budget.used);
  if (e.method === 0) {
    if (raw.length > limit) return { ok: false, reason: "too_large" };
    budget.used += raw.length;
    return { ok: true, data: raw };
  }
  if (e.method !== 8) return { ok: false, reason: "unsupported" };
  const data = await inflate(raw, "deflate-raw", limit);
  if (!data) return { ok: false, reason: e.size > limit ? "too_large" : "broken" };
  budget.used += data.length;
  return { ok: true, data };
}

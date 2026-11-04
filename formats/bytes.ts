// SPDX-License-Identifier: AGPL-3.0-only
//
// バイト列を読む小さな部品。範囲の外を読んだら undefined を返す（細工されたファイルで落ちないように）。

// Node で型を外すだけで読めるよう、引数でのプロパティ宣言（constructor(readonly …)）は使わない
export class Reader {
  readonly bytes: Uint8Array;
  readonly little: boolean;
  constructor(bytes: Uint8Array, little: boolean) {
    this.bytes = bytes;
    this.little = little;
  }
  u8(at: number): number | undefined {
    return at >= 0 && at < this.bytes.length ? this.bytes[at] : undefined;
  }
  u16(at: number): number | undefined {
    if (at < 0 || at + 2 > this.bytes.length) return undefined;
    const a = this.bytes[at]!;
    const b = this.bytes[at + 1]!;
    return this.little ? a | (b << 8) : (a << 8) | b;
  }
  u32(at: number): number | undefined {
    if (at < 0 || at + 4 > this.bytes.length) return undefined;
    const a = this.bytes[at]!;
    const b = this.bytes[at + 1]!;
    const c = this.bytes[at + 2]!;
    const d = this.bytes[at + 3]!;
    return (this.little ? a | (b << 8) | (c << 16) | (d << 24) : (a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }
}

export const be = (bytes: Uint8Array) => new Reader(bytes, false);
export const le = (bytes: Uint8Array) => new Reader(bytes, true);

/** bytes の at から、ascii の字の並びがあるか */
export function hasAscii(bytes: Uint8Array, at: number, ascii: string): boolean {
  if (at < 0 || at + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i++) if (bytes[at + i] !== ascii.charCodeAt(i)) return false;
  return true;
}

export function ascii(bytes: Uint8Array, at: number, length: number): string {
  let s = "";
  for (let i = at; i < Math.min(bytes.length, at + length); i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

export function indexOfAscii(bytes: Uint8Array, needle: string, from = 0, to = bytes.length): number {
  const end = Math.min(to, bytes.length) - needle.length;
  outer: for (let i = Math.max(0, from); i <= end; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** 0x00 で終わる字の並びの長さ（見つからなければ -1） */
export function nulAt(bytes: Uint8Array, from: number, to = bytes.length): number {
  for (let i = from; i < Math.min(to, bytes.length); i++) if (bytes[i] === 0) return i;
  return -1;
}

/**
 * 圧縮を解く（deflate-raw＝ZIP の中身、deflate＝zlib の形）。ブラウザと Node の DecompressionStream を使う。
 * 解いた大きさが max を超えたら、そこで止めて null を返す（小さく見せかけて大きく膨らむファイルを止める）。壊れていても null
 */
export async function inflate(data: Uint8Array, format: "deflate-raw" | "deflate", max: number): Promise<Uint8Array | null> {
  let ds: DecompressionStream;
  try {
    ds = new DecompressionStream(format);
  } catch {
    return null;
  }
  const writer = ds.writable.getWriter();
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 安全なファイルの種類の目安（英数字だけで 8 字まで）。それ以外は null（ファイル名そのものは出さない） */
export function safeExt(name: string): string | null {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : null;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} バイト`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

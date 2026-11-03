// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの中身（描く命令の列）を、命令と引数に分ける読み手（P7 の検出ルール用）。
// 埋め込みの画像（BI … ID … EI）は、中身を命令として読まず、1つの命令 "BI" として返す（引数は画像の辞書）。

export type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: Uint8Array }
  | { t: "name"; v: string }
  | { t: "arr"; v: Tok[] }
  | { t: "dict"; v: Map<string, Tok> }
  | { t: "bool"; v: boolean }
  | { t: "null" };

export type Op = { op: string; args: Tok[] };

export class LexError extends Error {}

const MAX_DEPTH = 64;

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isRegular = (c: number) => !isWhite(c) && !isDelim(c);

const hexVal = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1);

export function* operations(data: Uint8Array): Generator<Op> {
  let i = 0;
  const n = data.length;
  let stack: Tok[] = [];

  function skipWs() {
    while (i < n) {
      const c = data[i]!;
      if (isWhite(c)) i++;
      else if (c === 0x25) {
        while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++;
      } else break;
    }
  }

  function readString(): Uint8Array {
    i++; // (
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      const c = data[i++]!;
      if (c === 0x5c) {
        const d = data[i++];
        if (d === undefined) break;
        if (d === 0x6e) out.push(0x0a);
        else if (d === 0x72) out.push(0x0d);
        else if (d === 0x74) out.push(0x09);
        else if (d === 0x62) out.push(0x08);
        else if (d === 0x66) out.push(0x0c);
        else if (d === 0x0d) {
          if (data[i] === 0x0a) i++;
        } else if (d === 0x0a) {
          // 行の継続
        } else if (d >= 0x30 && d <= 0x37) {
          let v = d - 0x30;
          for (let k = 0; k < 2 && i < n && data[i]! >= 0x30 && data[i]! <= 0x37; k++) v = v * 8 + (data[i++]! - 0x30);
          out.push(v & 0xff);
        } else out.push(d);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return new Uint8Array(out);
  }

  function readHex(): Uint8Array {
    i++; // <
    const out: number[] = [];
    let hi = -1;
    while (i < n && data[i] !== 0x3e) {
      const v = hexVal(data[i++]!);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    i++; // >
    if (hi >= 0) out.push(hi * 16);
    return new Uint8Array(out);
  }

  function readName(): string {
    i++; // /
    const bytes: number[] = [];
    while (i < n && isRegular(data[i]!)) {
      const c = data[i++]!;
      if (c === 0x23 && i + 1 < n && hexVal(data[i]!) >= 0 && hexVal(data[i + 1]!) >= 0) {
        bytes.push(hexVal(data[i]!) * 16 + hexVal(data[i + 1]!));
        i += 2;
      } else bytes.push(c);
    }
    return new TextDecoder("latin1").decode(new Uint8Array(bytes));
  }

  function readWord(): string {
    const s = i;
    while (i < n && isRegular(data[i]!)) i++;
    return new TextDecoder("latin1").decode(data.subarray(s, i));
  }

  /** 値を1つ読む。命令の言葉なら { word } を返す */
  function readValue(depth: number): Tok | { word: string } | null {
    if (depth > MAX_DEPTH) throw new LexError("入れ子が深すぎます");
    skipWs();
    if (i >= n) return null;
    const c = data[i]!;
    if (c === 0x28) return { t: "str", v: readString() };
    if (c === 0x3c) {
      if (data[i + 1] === 0x3c) {
        i += 2;
        const m = new Map<string, Tok>();
        for (;;) {
          skipWs();
          if (i >= n) break;
          if (data[i] === 0x3e && data[i + 1] === 0x3e) {
            i += 2;
            break;
          }
          const k = readValue(depth + 1);
          if (k === null) break;
          if ("word" in k || k.t !== "name") continue;
          const v = readValue(depth + 1);
          if (v === null) break;
          if (!("word" in v)) m.set(k.v, v);
        }
        return { t: "dict", v: m };
      }
      return { t: "str", v: readHex() };
    }
    if (c === 0x2f) return { t: "name", v: readName() };
    if (c === 0x5b) {
      i++;
      const arr: Tok[] = [];
      for (;;) {
        skipWs();
        if (i >= n) break;
        if (data[i] === 0x5d) {
          i++;
          break;
        }
        const v = readValue(depth + 1);
        if (v === null) break;
        if (!("word" in v)) arr.push(v);
      }
      return { t: "arr", v: arr };
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      i++; // 余分な区切り。読み飛ばす
      return readValue(depth);
    }
    const w = readWord();
    if (w === "") {
      i++;
      return readValue(depth);
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return { t: "num", v: Number(w) };
    if (w === "true" || w === "false") return { t: "bool", v: w === "true" };
    if (w === "null") return { t: "null" };
    return { word: w };
  }

  while (i < n) {
    const v = readValue(0);
    if (v === null) break;
    if (!("word" in v)) {
      stack.push(v);
      if (stack.length > 10_000) throw new LexError("引数が多すぎます");
      continue;
    }
    if (v.word === "BI") {
      // 埋め込みの画像：ID までを辞書として読み、EI まで飛ばす
      const dict = new Map<string, Tok>();
      for (;;) {
        const k = readValue(1);
        if (k === null || "word" in k) break; // ID
        const val = readValue(1);
        if (val === null || "word" in val) break;
        if (k.t === "name") dict.set(k.v, val);
      }
      if (i < n && isWhite(data[i]!)) i++;
      // EI：前後が空白（または終わり）の "EI" を探す
      while (i < n) {
        if (data[i] === 0x45 && data[i + 1] === 0x49 && (i === 0 || isWhite(data[i - 1]!)) && (i + 2 >= n || isWhite(data[i + 2]!) || isDelim(data[i + 2]!))) {
          i += 2;
          break;
        }
        i++;
      }
      yield { op: "BI", args: [{ t: "dict", v: dict }] };
      stack = [];
      continue;
    }
    yield { op: v.word, args: stack };
    stack = [];
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// コンテンツストリーム（ページに描く命令の列）を、命令ごとに読む。
// 図形を組み立てず、命令を順に渡すだけにする（CLAUDE.md §5 の重いページ対策）。
// 入ってくるバイト列は細工されている前提で扱う。深すぎる入れ子・長すぎる要素は打ち切る。

export type Name = { kind: "name"; value: string };
export type Bytes = { kind: "bytes"; value: Uint8Array };
export type Dict = { kind: "dict"; value: Map<string, Operand> };
export type Operand = number | boolean | null | Name | Bytes | Dict | Operand[];

export type Operation = { op: string; args: Operand[] };

const MAX_DEPTH = 32;
const MAX_ARGS = 10_000;

function isWhite(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
}

function isDelim(c: number): boolean {
  return (
    c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d ||
    c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25
  );
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

export class LexError extends Error {}

/**
 * 命令を1つずつ返す。命令の数の上限は、呼ぶ側（page.ts）で数えて打ち切る。
 * 入れ子が深すぎる・引数が多すぎるときは LexError を投げる。
 */
export function* operations(data: Uint8Array): Generator<Operation, void, void> {
  let i = 0;
  const n = data.length;
  let args: Operand[] = [];

  const skipWhiteAndComments = () => {
    while (i < n) {
      const c = data[i]!;
      if (isWhite(c)) i++;
      else if (c === 0x25) {
        while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++;
      } else break;
    }
  };

  const readLiteralString = (): Uint8Array => {
    // i は "(" のあと
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      const c = data[i++]!;
      if (c === 0x5c) {
        if (i >= n) break;
        const e = data[i++]!;
        if (e === 0x6e) out.push(0x0a);
        else if (e === 0x72) out.push(0x0d);
        else if (e === 0x74) out.push(0x09);
        else if (e === 0x62) out.push(0x08);
        else if (e === 0x66) out.push(0x0c);
        else if (e === 0x0d) {
          if (data[i] === 0x0a) i++;
        } else if (e === 0x0a) {
          // 行の続き
        } else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && i < n && data[i]! >= 0x30 && data[i]! <= 0x37; k++) v = v * 8 + (data[i++]! - 0x30);
          out.push(v & 0xff);
        } else out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Uint8Array.from(out);
  };

  const readHexString = (): Uint8Array => {
    // i は "<" のあと
    const out: number[] = [];
    let hi = -1;
    while (i < n) {
      const c = data[i++]!;
      if (c === 0x3e) break;
      const v = hexValue(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return Uint8Array.from(out);
  };

  const readName = (): string => {
    // i は "/" のあと
    let s = "";
    while (i < n) {
      const c = data[i]!;
      if (isWhite(c) || isDelim(c)) break;
      if (c === 0x23 && i + 2 < n) {
        const h = hexValue(data[i + 1]!);
        const l = hexValue(data[i + 2]!);
        if (h >= 0 && l >= 0) {
          s += String.fromCharCode(h * 16 + l);
          i += 3;
          continue;
        }
      }
      s += String.fromCharCode(c);
      i++;
    }
    return s;
  };

  const readWord = (): string => {
    let s = "";
    while (i < n) {
      const c = data[i]!;
      if (isWhite(c) || isDelim(c)) break;
      s += String.fromCharCode(c);
      i++;
    }
    return s;
  };

  // 値を1つ読む。命令（キーワード）なら文字列で返す
  const readValue = (depth: number): Operand | { keyword: string } | undefined => {
    skipWhiteAndComments();
    if (i >= n) return undefined;
    if (depth > MAX_DEPTH) throw new LexError("入れ子が深すぎます");
    const c = data[i]!;
    if (c === 0x2f) {
      i++;
      return { kind: "name", value: readName() };
    }
    if (c === 0x28) {
      i++;
      return { kind: "bytes", value: readLiteralString() };
    }
    if (c === 0x3c) {
      if (data[i + 1] === 0x3c) {
        i += 2;
        const map = new Map<string, Operand>();
        for (;;) {
          skipWhiteAndComments();
          if (i >= n) break;
          if (data[i] === 0x3e && data[i + 1] === 0x3e) {
            i += 2;
            break;
          }
          const key = readValue(depth + 1);
          if (key === undefined) break;
          const val = readValue(depth + 1);
          if (val === undefined) break;
          if (typeof key === "object" && key !== null && !Array.isArray(key) && "kind" in key && key.kind === "name") {
            if (!(typeof val === "object" && val !== null && "keyword" in val)) map.set(key.value, val);
          }
        }
        return { kind: "dict", value: map };
      }
      i++;
      return { kind: "bytes", value: readHexString() };
    }
    if (c === 0x5b) {
      i++;
      const arr: Operand[] = [];
      for (;;) {
        skipWhiteAndComments();
        if (i >= n) break;
        if (data[i] === 0x5d) {
          i++;
          break;
        }
        const v = readValue(depth + 1);
        if (v === undefined) break;
        if (typeof v === "object" && v !== null && "keyword" in v) continue; // 配列の中のキーワードは捨てる
        arr.push(v);
        if (arr.length > MAX_ARGS) throw new LexError("配列が長すぎます");
      }
      return arr;
    }
    if (c === 0x5d || c === 0x29 || c === 0x3e || c === 0x7b || c === 0x7d) {
      i++; // 対応のない区切りは読み飛ばす
      return readValue(depth);
    }
    const word = readWord();
    if (word === "") {
      i++;
      return readValue(depth);
    }
    const num = Number(word);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) && Number.isFinite(num)) return num;
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { keyword: word };
  };

  const skipInlineImage = () => {
    // "BI ... ID" の辞書を読み飛ばし、"ID" の次の1文字のあとから "EI" までを捨てる
    for (;;) {
      const v = readValue(0);
      if (v === undefined) return;
      if (typeof v === "object" && v !== null && "keyword" in v && v.keyword === "ID") break;
    }
    i++; // ID のあとの空白1文字
    while (i + 1 < n) {
      if (
        data[i] === 0x45 && data[i + 1] === 0x49 &&
        (i === 0 || isWhite(data[i - 1]!)) &&
        (i + 2 >= n || isWhite(data[i + 2]!) || isDelim(data[i + 2]!))
      ) {
        i += 2;
        return;
      }
      i++;
    }
    i = n;
  };

  for (;;) {
    const v = readValue(0);
    if (v === undefined) return;
    if (typeof v === "object" && v !== null && "keyword" in v) {
      if (v.keyword === "BI") {
        skipInlineImage();
        args = [];
        yield { op: "BI", args: [] };
        continue;
      }
      yield { op: v.keyword, args };
      args = [];
    } else {
      args.push(v);
      if (args.length > MAX_ARGS) throw new LexError("命令の引数が多すぎます");
    }
  }
}

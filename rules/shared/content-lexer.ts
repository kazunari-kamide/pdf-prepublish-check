// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの中身（描く命令の列）を、命令と引数に分ける読み手。P6（rules/p6-text）と P7（rules/p7-hidden）で同じものを使う。
// - 図形を組み立てず、命令を順に渡すだけにする（CLAUDE.md §5 の重いページ対策）。命令の数の上限は、呼ぶ側で数えて打ち切る。
// - 入ってくるバイト列は細工されている前提で扱う。深すぎる入れ子・多すぎる引数・長すぎる配列は LexError で打ち切る。
// - 埋め込みの画像（BI … ID … EI）は、中身を命令として読まず、1つの命令 "BI" として返す（引数は画像の辞書1つ）。
// ToUnicode の CMap（bfchar・bfrange）も、同じ読み手で読める。

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

const MAX_DEPTH = 32;
/** 1つの命令の引数・1つの配列・1つの辞書の要素の数の上限 */
const MAX_ITEMS = 10_000;

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isRegular = (c: number) => !isWhite(c) && !isDelim(c);
const hexVal = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1);

/** 命令の言葉（Tj・re など）。値と見分けるため、読み手の中だけで使う */
type Word = { word: string };
const isWord = (v: Tok | Word): v is Word => "word" in v;

export function* operations(data: Uint8Array): Generator<Op, void, void> {
  let i = 0;
  const n = data.length;
  let stack: Tok[] = [];

  const skipWs = () => {
    while (i < n) {
      const c = data[i]!;
      if (isWhite(c)) i++;
      else if (c === 0x25) {
        while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++;
      } else break;
    }
  };

  const readString = (): Uint8Array => {
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
          // 行の続き
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
    return Uint8Array.from(out);
  };

  const readHex = (): Uint8Array => {
    i++; // <
    const out: number[] = [];
    let hi = -1;
    while (i < n) {
      const c = data[i++]!;
      if (c === 0x3e) break;
      const v = hexVal(c);
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
    i++; // /
    let s = "";
    while (i < n && isRegular(data[i]!)) {
      const c = data[i]!;
      if (c === 0x23 && i + 2 < n && hexVal(data[i + 1]!) >= 0 && hexVal(data[i + 2]!) >= 0) {
        s += String.fromCharCode(hexVal(data[i + 1]!) * 16 + hexVal(data[i + 2]!));
        i += 3;
        continue;
      }
      s += String.fromCharCode(c);
      i++;
    }
    return s;
  };

  const readWord = (): string => {
    let s = "";
    while (i < n && isRegular(data[i]!)) s += String.fromCharCode(data[i++]!);
    return s;
  };

  /** 値を1つ読む。命令の言葉なら { word } を返す。終わりなら null */
  const readValue = (depth: number): Tok | Word | null => {
    if (depth > MAX_DEPTH) throw new LexError("入れ子が深すぎます");
    skipWs();
    if (i >= n) return null;
    const c = data[i]!;
    if (c === 0x28) return { t: "str", v: readString() };
    if (c === 0x3c) {
      if (data[i + 1] === 0x3c) {
        i += 2;
        const m = new Map<string, Tok>();
        let count = 0;
        for (;;) {
          skipWs();
          if (i >= n) break;
          if (data[i] === 0x3e && data[i + 1] === 0x3e) {
            i += 2;
            break;
          }
          const k = readValue(depth + 1);
          if (k === null) break;
          const v = readValue(depth + 1);
          if (v === null) break;
          // 鍵が名前でない組と、値が命令の言葉の組は捨てる（2つずつ読んで、ずれないようにする）
          if (!isWord(k) && k.t === "name" && !isWord(v)) m.set(k.v, v);
          if (++count > MAX_ITEMS) throw new LexError("辞書が長すぎます");
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
        if (isWord(v)) continue; // 配列の中の言葉は捨てる
        arr.push(v);
        if (arr.length > MAX_ITEMS) throw new LexError("配列が長すぎます");
      }
      return { t: "arr", v: arr };
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      i++; // 対応のない区切りは読み飛ばす
      return readValue(depth);
    }
    const w = readWord();
    if (w === "") {
      i++;
      return readValue(depth);
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const v = Number(w);
      if (Number.isFinite(v)) return { t: "num", v };
    }
    if (w === "true" || w === "false") return { t: "bool", v: w === "true" };
    if (w === "null") return { t: "null" };
    return { word: w };
  };

  const readInlineImage = (): Map<string, Tok> => {
    // ID までを辞書として読み、ID のあとの空白1つを飛ばして、前後が空白（または終わり）の "EI" まで捨てる
    const dict = new Map<string, Tok>();
    for (let count = 0; ; count++) {
      const k = readValue(1);
      if (k === null || isWord(k)) break; // ID
      const v = readValue(1);
      if (v === null || isWord(v)) break;
      if (k.t === "name") dict.set(k.v, v);
      if (count > MAX_ITEMS) throw new LexError("埋め込みの画像の辞書が長すぎます");
    }
    if (i < n && isWhite(data[i]!)) i++;
    while (i < n) {
      if (
        data[i] === 0x45 && data[i + 1] === 0x49 &&
        (i === 0 || isWhite(data[i - 1]!)) &&
        (i + 2 >= n || isWhite(data[i + 2]!) || isDelim(data[i + 2]!))
      ) {
        i += 2;
        return dict;
      }
      i++;
    }
    return dict;
  };

  for (;;) {
    const v = readValue(0);
    if (v === null) return;
    if (!isWord(v)) {
      stack.push(v);
      if (stack.length > MAX_ITEMS) throw new LexError("命令の引数が多すぎます");
      continue;
    }
    if (v.word === "BI") {
      const dict = readInlineImage();
      stack = [];
      yield { op: "BI", args: [{ t: "dict", v: dict }] };
      continue;
    }
    yield { op: v.word, args: stack };
    stack = [];
  }
}

// 引数を取り出す小さな道具（型が違うものは undefined）
export const numArg = (a: Tok | undefined): number | undefined => (a?.t === "num" ? a.v : undefined);
export const nameArg = (a: Tok | undefined): string | undefined => (a?.t === "name" ? a.v : undefined);
export const bytesArg = (a: Tok | undefined): Uint8Array | undefined => (a?.t === "str" ? a.v : undefined);
export const arrArg = (a: Tok | undefined): Tok[] | undefined => (a?.t === "arr" ? a.v : undefined);

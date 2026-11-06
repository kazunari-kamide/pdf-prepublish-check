// SPDX-License-Identifier: AGPL-3.0-only
//
// 決まった字の対応表（日本語の predefined CMap）の読み方（2026-11-06）。
// 書体を埋め込まない日本語の PDF（MS 明朝＋90ms-RKSJ-H など）は ToUnicode を持たず、字の番号は Shift-JIS や Unicode のまま書かれる。
// Identity-H/V のように 2 バイトずつ区切って CID とみなすと、字の中身も幅も分からない（rules/p6-text/README.md の既知の限界だった）。
//
// 読み方（対応表そのものは持たない。外へ取りにも行かない）：
//   - 区切り：RKSJ は Shift-JIS の決まり（先頭のバイトが 0x81〜0x9F・0xE0〜0xFC なら 2 バイト、ほかは 1 バイト）。
//     UCS2 は 2 バイト。UTF16 は 2 バイト（上位のサロゲートのあとに下位のサロゲートが続けば 4 バイト）。
//   - 字の中身：RKSJ は Shift-JIS（Windows の 932。TextDecoder の shift_jis）として、UCS2・UTF16 は Unicode として読む。
//   - CID（/W の幅を引くために要る）：字の中身から Adobe-Japan1 の表（cid-unicode/adobe-japan1.ts）を逆に引く。
//     同じ字に CID がいくつかあるときは、1 バイトの字・HW の表は半角の CID（231〜389）、RKSJ の 2 バイトの字は全角の CID（633 から）、
//     ほかは小さい CID を選ぶ。こう選んで Adobe の表と合わない字だけを、例外の表（cid-unicode/predefined-cmaps.ts）で直す。
//     例外の表は scripts/build-predefined-cmaps.mjs が、npm の pdfjs-dist の Adobe の表で PDF に描いた字と比べて作る（通信しない）。

import { ADOBE_JAPAN1 } from "./cid-unicode/adobe-japan1.ts";
import { PREDEFINED_CMAP_EXCEPTIONS } from "./cid-unicode/predefined-cmaps.ts";

export type CMapFamily = "rksj" | "ucs2" | "utf16";

/** 1 字ぶん。len＝バイト数、code＝バイトをつないだ数、text＝字の中身（分からなければ ""）、cid＝幅を引く CID */
export type CMapChar = { len: number; code: number; text: string; cid: number };

export type PredefinedCMap = {
  name: string;
  family: CMapFamily;
  /** 半角の CID を選ぶ表（UniJIS-UCS2-HW-H/V） */
  halfWidth: boolean;
  /** バイト列の k バイト目から 1 字を読む */
  read(bytes: Uint8Array, k: number): CMapChar;
};

/** 読める対応表の名前（例外の表を作ったもの）。ほかの名前は、これまでどおり 2 バイトずつ区切る */
export const SUPPORTED_PREDEFINED_CMAPS = Object.keys(PREDEFINED_CMAP_EXCEPTIONS);

let inverse: Map<string, number[]> | null = null;
/** 字 → その字になる CID（小さい順） */
function cidsOf(text: string): number[] {
  if (!inverse) {
    inverse = new Map();
    let cid = 0;
    for (const ch of ADOBE_JAPAN1.chars) {
      if (ch !== "\u0000") {
        const list = inverse.get(ch);
        if (list) list.push(cid);
        else inverse.set(ch, [cid]);
      }
      cid++;
    }
    for (const [k, v] of Object.entries(ADOBE_JAPAN1.multi as Record<string, string>)) {
      const list = inverse.get(v) ?? [];
      list.push(Number(k));
      list.sort((a, b) => a - b);
      inverse.set(v, list);
    }
  }
  return inverse.get(text) ?? [];
}

const isHalfWidthCid = (c: number) => c >= 231 && c <= 389;

/** 字の中身から CID を選ぶ（例外の表で直す前） */
export function guessCid(text: string, prefer: "half" | "full" | "small"): number {
  const list = cidsOf(text);
  if (!list.length) return 0;
  if (prefer === "half") return list.find(isHalfWidthCid) ?? list[0]!;
  if (prefer === "full") return list.find((c) => c >= 633) ?? list[0]!;
  return list[0]!;
}

let sjis: { decode(input: Uint8Array): string } | null | undefined;
const sjisCache = new Map<number, string>();
/** Shift-JIS の 2 バイトの字（読めなければ ""） */
function sjisText(lead: number, trail: number): string {
  const code = (lead << 8) | trail;
  const hit = sjisCache.get(code);
  if (hit !== undefined) return hit;
  if (sjis === undefined) {
    try {
      sjis = new TextDecoder("shift_jis", { fatal: true });
    } catch {
      sjis = null; // shift_jis を持たない環境（ICU を小さくした Node など）。字は空にする
    }
  }
  let text = "";
  if (sjis) {
    try {
      text = sjis.decode(Uint8Array.of(lead, trail));
    } catch {
      text = "";
    }
  }
  if (text === "�" || [...text].length !== 1) text = "";
  sjisCache.set(code, text);
  return text;
}

/** Shift-JIS の 1 バイトの字。0x20〜0x7E は ASCII、0xA1〜0xDF は半角カナ */
function sjisSingle(b: number): string {
  if (b >= 0x20 && b <= 0x7e) return String.fromCharCode(b);
  if (b >= 0xa1 && b <= 0xdf) return String.fromCharCode(0xff61 + (b - 0xa1));
  return "";
}

const isControl = (cp: number) => cp < 0x20 || (cp >= 0x7f && cp < 0xa0);

/** 同梱の例外の表がある対応表を返す。ない名前は null（呼ぶ側は、これまでどおり 2 バイトずつ区切る） */
export function predefinedCMap(name: string | undefined): PredefinedCMap | null {
  if (!name) return null;
  const exceptions = (PREDEFINED_CMAP_EXCEPTIONS as Record<string, Record<string, number>>)[name];
  return exceptions ? makePredefinedCMap(name, exceptions) : null;
}

/** 例外の表（コードの 16 進 → CID）を渡して作る。例外の表を作るスクリプトは、空の表で呼ぶ */
export function makePredefinedCMap(name: string, exceptions: Record<string, number>): PredefinedCMap {
  const family: CMapFamily = /RKSJ/.test(name) ? "rksj" : /UTF16/.test(name) ? "utf16" : "ucs2";
  const halfWidth = /-HW-/.test(name);
  const fix = (code: number, cid: number) => {
    const e = exceptions[code.toString(16)];
    return e === undefined ? cid : e;
  };
  const finish = (len: number, code: number, text: string, cid: number): CMapChar => ({ len, code, text, cid: fix(code, cid) });
  if (family === "rksj") {
    return {
      name,
      family,
      halfWidth,
      read(bytes, k) {
        const b = bytes[k]!;
        const lead = (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
        if (lead && k + 1 < bytes.length) {
          const t = bytes[k + 1]!;
          const text = sjisText(b, t);
          return finish(2, (b << 8) | t, text, text ? guessCid(text, "full") : 0);
        }
        const text = sjisSingle(b);
        const cid = b >= 0x20 && b <= 0x7e ? 231 + (b - 0x20) : b >= 0xa0 && b <= 0xdf ? 326 + (b - 0xa0) : 0;
        return finish(1, b, text, cid);
      },
    };
  }
  return {
    name,
    family,
    halfWidth,
    read(bytes, k) {
      if (k + 1 >= bytes.length) return { len: 1, code: bytes[k]!, text: "", cid: 0 };
      const hi = (bytes[k]! << 8) | bytes[k + 1]!;
      let len = 2;
      let code = hi;
      let cp = hi;
      if (hi >= 0xd800 && hi <= 0xdbff && family === "utf16" && k + 3 < bytes.length) {
        const lo = (bytes[k + 2]! << 8) | bytes[k + 3]!;
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          len = 4;
          code = hi * 0x10000 + lo;
          cp = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
        }
      }
      if ((cp >= 0xd800 && cp <= 0xdfff) || isControl(cp)) return finish(len, code, "", 0);
      const text = String.fromCodePoint(cp);
      return finish(len, code, text, guessCid(text, halfWidth ? "half" : "small"));
    },
  };
}

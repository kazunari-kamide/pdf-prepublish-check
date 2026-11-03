// SPDX-License-Identifier: AGPL-3.0-only
//
// 描く命令（rules/shared/content-lexer.ts が分けたもの）を、ページの中身のバイト列に戻す。
// 片付けで命令を書き換えたとき、ページ全体をこの形で書き直す（コメントと空白の並びは残らない）。
// 埋め込みの画像（BI … EI）は、読み手が中身を捨てるので戻せない。呼ぶ側で、BI のある中身は書き換えない。

import type { Op, Tok } from "../rules/shared/content-lexer.ts";

const enc = new TextEncoder();

/** 数を、指数を使わない短い形にする（PDF の数は指数表記を読めない） */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return "0";
  // 1e21 以上は String() が指数表記になるので、整数として書く
  if (Math.abs(v) >= 1e21) return BigInt(Math.round(v)).toString();
  if (Number.isInteger(v)) return String(v);
  let s = v.toFixed(6);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

const isRegularNameChar = (c: number) =>
  c > 0x20 && c < 0x7f && c !== 0x23 && !"()<>[]{}/%".includes(String.fromCharCode(c));

function formatName(name: string): string {
  let s = "/";
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i) & 0xff;
    s += isRegularNameChar(c) ? String.fromCharCode(c) : "#" + c.toString(16).padStart(2, "0");
  }
  return s;
}

function hex(bytes: Uint8Array): string {
  let s = "<";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s + ">";
}

export function formatTok(t: Tok): string {
  switch (t.t) {
    case "num":
      return formatNumber(t.v);
    case "str":
      return hex(t.v);
    case "name":
      return formatName(t.v);
    case "arr":
      return "[" + t.v.map(formatTok).join(" ") + "]";
    case "dict": {
      let s = "<<";
      for (const [k, v] of t.v) s += formatName(k) + " " + formatTok(v) + " ";
      return s + ">>";
    }
    case "bool":
      return t.v ? "true" : "false";
    case "null":
      return "null";
  }
}

export function serializeOps(ops: Op[]): Uint8Array {
  const parts: string[] = [];
  for (const { op, args } of ops) {
    parts.push(args.length ? args.map(formatTok).join(" ") + " " + op : op);
  }
  return enc.encode(parts.join("\n") + "\n");
}

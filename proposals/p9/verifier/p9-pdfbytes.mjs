// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器のための、PDF のバイト列の読み方（pdf-lib を使わない）。
// P1（文書情報）の検証器の案（proposals/p1/verifier/p1.mjs）の読み方の部分と同じ考え方で書いた写し。
// P1 の案と P9 の案を別々に移せるように、いまは別のファイルに持つ。両方が verifier/ に移ったら、1つにまとめる（人が判断）。

import { inflateSync } from "node:zlib";

export const LIMITS = {
  maxBytes: 200 * 1024 * 1024,
  maxDepth: 64, // 入れ子の深さ
  maxXrefSections: 1000, // /Prev をたどる回数
  maxInflate: 64 * 1024 * 1024, // 解いたストリームの大きさ
  maxObjects: 200_000, // 調べるオブジェクトの数
  timeoutMs: 20_000,
};

export class ParseError extends Error {}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function skipWs(buf, i) {
  while (i < buf.length) {
    const c = buf[i];
    if (WS.has(c)) i++;
    else if (c === 0x25) {
      while (i < buf.length && buf[i] !== 0x0a && buf[i] !== 0x0d) i++;
    } else break;
  }
  return i;
}

function readToken(buf, i) {
  const s = i;
  while (i < buf.length && !WS.has(buf[i]) && !DELIM.has(buf[i])) i++;
  return [latin1(buf.subarray(s, i)), i];
}

export function latin1(b) {
  let s = "";
  for (let k = 0; k < b.length; k++) s += String.fromCharCode(b[k]);
  return s;
}

function hexVal(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function utf8OrLatin1(s) {
  const bytes = Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

/** 値を1つ読む。返す形：{ t: "dict"|"array"|"name"|"str"|"num"|"ref"|"bool"|"null"|"kw", v } と次の位置 */
export function parseValue(buf, i, depth = 0) {
  if (depth > LIMITS.maxDepth) throw new ParseError("入れ子が深すぎる");
  i = skipWs(buf, i);
  if (i >= buf.length) throw new ParseError("途中で終わった");
  const c = buf[i];
  if (c === 0x3c && buf[i + 1] === 0x3c) {
    const map = new Map();
    i += 2;
    for (;;) {
      i = skipWs(buf, i);
      if (i >= buf.length) throw new ParseError("辞書が閉じていない");
      if (buf[i] === 0x3e && buf[i + 1] === 0x3e) return [{ t: "dict", v: map }, i + 2];
      const [k, j] = parseValue(buf, i, depth + 1);
      if (k.t !== "name") throw new ParseError("辞書の鍵が名前でない");
      const [v, j2] = parseValue(buf, j, depth + 1);
      map.set(k.v, v);
      i = j2;
    }
  }
  if (c === 0x3c) {
    const out = [];
    let hi = -1;
    i++;
    while (i < buf.length && buf[i] !== 0x3e) {
      const h = hexVal(buf[i++]);
      if (h < 0) continue;
      if (hi < 0) hi = h;
      else {
        out.push(hi * 16 + h);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return [{ t: "str", v: Uint8Array.from(out), form: "hex" }, i + 1];
  }
  if (c === 0x28) return readLiteral(buf, i + 1);
  if (c === 0x2f) {
    let j = i + 1;
    while (j < buf.length && !WS.has(buf[j]) && !DELIM.has(buf[j])) j++;
    const raw = latin1(buf.subarray(i + 1, j)).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return [{ t: "name", v: utf8OrLatin1(raw) }, j];
  }
  if (c === 0x5b) {
    const arr = [];
    i++;
    for (;;) {
      i = skipWs(buf, i);
      if (i >= buf.length) throw new ParseError("配列が閉じていない");
      if (buf[i] === 0x5d) return [{ t: "array", v: arr }, i + 1];
      const [v, j] = parseValue(buf, i, depth + 1);
      arr.push(v);
      i = j;
    }
  }
  const [tok, j] = readToken(buf, i);
  if (tok === "") throw new ParseError("読めない文字");
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
    if (/^\d+$/.test(tok)) {
      const k = skipWs(buf, j);
      const [tok2, j2] = readToken(buf, k);
      if (/^\d+$/.test(tok2)) {
        const k2 = skipWs(buf, j2);
        if (buf[k2] === 0x52 && (k2 + 1 >= buf.length || WS.has(buf[k2 + 1]) || DELIM.has(buf[k2 + 1]))) {
          return [{ t: "ref", v: [Number(tok), Number(tok2)] }, k2 + 1];
        }
      }
    }
    return [{ t: "num", v: Number(tok) }, j];
  }
  if (tok === "true" || tok === "false") return [{ t: "bool", v: tok === "true" }, j];
  if (tok === "null") return [{ t: "null", v: null }, j];
  return [{ t: "kw", v: tok }, j];
}

function readLiteral(buf, i) {
  const out = [];
  let depth = 1;
  while (i < buf.length) {
    const c = buf[i++];
    if (c === 0x5c) {
      const d = buf[i++];
      if (d === undefined) break;
      const map = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
      if (map[d] !== undefined) out.push(map[d]);
      else if (d >= 0x30 && d <= 0x37) {
        let v = d - 0x30;
        for (let k = 0; k < 2 && buf[i] >= 0x30 && buf[i] <= 0x37; k++) v = v * 8 + (buf[i++] - 0x30);
        out.push(v & 0xff);
      } else if (d === 0x0d) {
        if (buf[i] === 0x0a) i++;
      } else if (d === 0x0a) {
        // 行の継続
      } else out.push(d);
    } else if (c === 0x28) {
      depth++;
      out.push(c);
    } else if (c === 0x29) {
      if (--depth === 0) return [{ t: "str", v: Uint8Array.from(out), form: "literal" }, i];
      out.push(c);
    } else if (c === 0x0d) {
      if (buf[i] === 0x0a) i++;
      out.push(0x0a);
    } else out.push(c);
  }
  throw new ParseError("文字列が閉じていない");
}

/** 文字の文字列を読む（UTF-16BE・UTF-8 の BOM、なければ Latin-1 で近似） */
export function decodeTextString(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = "";
    for (let k = 2; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
    return s.replace(/\u001b[^\u001b]{0,8}\u001b/g, "");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  return latin1(bytes);
}

function findStartXref(buf) {
  const tail = latin1(buf.subarray(Math.max(0, buf.length - 2048)));
  const k = tail.lastIndexOf("startxref");
  if (k < 0) return null;
  const m = /startxref\s+(\d+)/.exec(tail.slice(k));
  return m ? Number(m[1]) : null;
}

function undoPng(data, columns) {
  const rowLen = columns;
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    for (let i = 0; i < rowLen; i++) {
      const x = data[r * (rowLen + 1) + 1 + i];
      const left = i > 0 ? out[r * rowLen + i - 1] : 0;
      const up = r > 0 ? out[(r - 1) * rowLen + i] : 0;
      const ul = r > 0 && i > 0 ? out[(r - 1) * rowLen + i - 1] : 0;
      let v = x;
      if (type === 1) v = x + left;
      else if (type === 2) v = x + up;
      else if (type === 3) v = x + ((left + up) >> 1);
      else if (type === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
      }
      out[r * rowLen + i] = v & 0xff;
    }
  }
  return out;
}

/** オブジェクト（「N G obj」）を位置から読む。ストリームなら生のバイト列も返す */
export function readIndirectAt(buf, offset, resolveLength) {
  let i = skipWs(buf, offset);
  const [n, i1] = readToken(buf, i);
  const [g, i2] = readToken(buf, skipWs(buf, i1));
  const [kw, i3] = readToken(buf, skipWs(buf, i2));
  if (!/^\d+$/.test(n) || !/^\d+$/.test(g) || kw !== "obj") throw new ParseError("オブジェクトの頭が読めない");
  const [value, i4] = parseValue(buf, i3);
  let j = skipWs(buf, i4);
  const [kw2] = readToken(buf, j);
  if (kw2 === "stream" && value.t === "dict") {
    j += 6;
    if (buf[j] === 0x0d) j++;
    if (buf[j] === 0x0a) j++;
    let len = value.v.get("Length");
    if (len?.t === "ref") len = resolveLength?.(len.v);
    let end;
    if (len?.t === "num" && j + len.v <= buf.length) end = j + len.v;
    else {
      end = latin1(buf.subarray(j, Math.min(buf.length, j + LIMITS.maxInflate))).indexOf("endstream");
      if (end < 0) throw new ParseError("ストリームが閉じていない");
      end += j;
    }
    return { num: Number(n), gen: Number(g), value, stream: buf.subarray(j, end) };
  }
  return { num: Number(n), gen: Number(g), value };
}

/** ストリームの圧縮を解く（Flate だけ）。解けなければ ParseError */
export function streamData(dict, raw) {
  const f = dict.get("Filter");
  const filters = f?.t === "name" ? [f.v] : f?.t === "array" ? f.v.map((x) => x.v) : [];
  let data = raw;
  for (const name of filters) {
    if (name === "FlateDecode" || name === "Fl") data = new Uint8Array(inflateSync(data, { maxOutputLength: LIMITS.maxInflate }));
    else throw new ParseError(`解けない圧縮：${name}`);
  }
  const parms = dict.get("DecodeParms");
  if (parms?.t === "dict") {
    const pred = parms.v.get("Predictor")?.v ?? 1;
    if (pred >= 10) data = undoPng(data, parms.v.get("Columns")?.v ?? 1);
  }
  return data;
}

/**
 * xref をいまの版から古い版へたどり、オブジェクトの番号 → 場所 の表と、trailer の並び（新しい順）を作る。
 * 場所：{ kind: "offset", offset } / { kind: "objstm", stream, index } / { kind: "free" }
 */
export function readXref(buf) {
  const table = new Map();
  const trailers = [];
  const start = findStartXref(buf);
  if (start === null) throw new ParseError("startxref がない");
  const seen = new Set();
  const pending = [start];
  while (pending.length) {
    const offset = pending.shift();
    if (offset === undefined || seen.has(offset) || offset < 0 || offset >= buf.length) continue;
    if (seen.size >= LIMITS.maxXrefSections) break;
    seen.add(offset);
    let i = skipWs(buf, offset);
    const [kw, afterKw] = readToken(buf, i);
    let trailer;
    if (kw === "xref") {
      i = afterKw;
      for (;;) {
        i = skipWs(buf, i);
        const [a, ia] = readToken(buf, i);
        if (a === "trailer") {
          [trailer] = parseValue(buf, ia);
          break;
        }
        const [b, ib] = readToken(buf, skipWs(buf, ia));
        if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) throw new ParseError("xref の表が読めない");
        const first = Number(a);
        const count = Number(b);
        i = ib;
        for (let k = 0; k < count; k++) {
          i = skipWs(buf, i);
          const [off, i1] = readToken(buf, i);
          const [, i2] = readToken(buf, skipWs(buf, i1));
          const [type, i3] = readToken(buf, skipWs(buf, i2));
          i = i3;
          const num = first + k;
          if (!table.has(num)) table.set(num, type === "n" ? { kind: "offset", offset: Number(off) } : { kind: "free" });
        }
      }
      const xs = trailer?.v.get("XRefStm");
      if (xs?.t === "num") pending.unshift(xs.v);
    } else {
      const obj = readIndirectAt(buf, offset);
      if (obj.value.t !== "dict" || obj.value.v.get("Type")?.v !== "XRef" || !obj.stream) throw new ParseError("xref が読めない");
      trailer = obj.value;
      const d = obj.value.v;
      const data = streamData(d, obj.stream);
      const w = d.get("W")?.v.map((x) => x.v) ?? [1, 2, 1];
      const size = d.get("Size")?.v ?? 0;
      const index = d.get("Index")?.v.map((x) => x.v) ?? [0, size];
      const rowLen = w[0] + w[1] + w[2];
      let p = 0;
      const field = (len, dflt) => {
        if (len === 0) return dflt;
        let v = 0;
        for (let k = 0; k < len; k++) v = v * 256 + data[p++];
        return v;
      };
      for (let s = 0; s + 1 < index.length; s += 2) {
        for (let k = 0; k < index[s + 1]; k++) {
          if (p + rowLen > data.length) break;
          const type = field(w[0], 1);
          const f2 = field(w[1], 0);
          const f3 = field(w[2], 0);
          const num = index[s] + k;
          if (table.has(num)) continue;
          if (type === 1) table.set(num, { kind: "offset", offset: f2 });
          else if (type === 2) table.set(num, { kind: "objstm", stream: f2, index: f3 });
          else table.set(num, { kind: "free" });
        }
      }
    }
    if (trailer?.t !== "dict") throw new ParseError("trailer が読めない");
    trailers.push(trailer);
    const prev = trailer.v.get("Prev");
    if (prev?.t === "num") pending.push(prev.v);
  }
  return { table, trailers };
}

/**
 * 番号からオブジェクトを読む関数を作る。返す：resolve([num, gen]) → 値、resolveFull(num) → { value, stream? }
 */
export function makeResolver(buf, table) {
  const objstmCache = new Map();
  const resolveFull = (num, depth = 0) => {
    if (depth > 8) throw new ParseError("参照の入れ子が深すぎる");
    const loc = table.get(num);
    if (!loc || loc.kind === "free") return { value: { t: "null", v: null } };
    if (loc.kind === "offset") return readIndirectAt(buf, loc.offset, (r) => resolveFull(r[0], depth + 1).value);
    let objs = objstmCache.get(loc.stream);
    if (!objs) {
      const sl = table.get(loc.stream);
      if (!sl || sl.kind !== "offset") throw new ParseError("オブジェクトストリームが見つからない");
      const st = readIndirectAt(buf, sl.offset, (r) => resolveFull(r[0], depth + 1).value);
      const data = streamData(st.value.v, st.stream);
      const n = st.value.v.get("N")?.v ?? 0;
      const first = st.value.v.get("First")?.v ?? 0;
      const offs = new Map();
      let i = 0;
      for (let k = 0; k < n; k++) {
        const [a, ia] = parseValue(data, i);
        const [b, ib] = parseValue(data, ia);
        offs.set(a.v, b.v);
        i = ib;
      }
      objs = { offs, data, first };
      objstmCache.set(loc.stream, objs);
    }
    const off = objs.offs.get(num);
    if (off === undefined) return { value: { t: "null", v: null } };
    return { value: parseValue(objs.data, objs.first + off)[0] };
  };
  return { resolve: (ref) => resolveFull(ref[0]).value, resolveFull };
}

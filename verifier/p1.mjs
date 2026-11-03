// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器：P1（文書情報）。PDF のバイト列を入れると、いまの版の文書情報（Info 辞書）に残っている欄を返す。
//
// 検査器から独立させるため、pdf-lib は使わない（検出ルールは pdf-lib で書く予定）。
// 1. 主の読み方：バイト列を自分で読む。startxref から xref（表・ストリーム）を /Prev までたどり、
//    いまの版の trailer の /Info を、xref が指す場所（オブジェクトストリームの中も）から読む。
// 2. 突き合わせ：PDF.js（pdfjs-dist）の getMetadata でも読み、どちらか片方で値があれば「残っている」とする（安全側）。
//    食い違いは cross_check に出す。
// 中身（欄の値）は既定では出さない。includeValues のときだけ出す（記録やログには使わない）。

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export const VERIFIER = { name: "omamori-verifier-p1", version: "0.1.0" };

export const LIMITS = {
  maxBytes: 200 * 1024 * 1024,
  maxDepth: 64, // 入れ子の深さ
  maxXrefSections: 1000, // /Prev をたどる回数
  maxInflate: 64 * 1024 * 1024, // 解いたストリームの大きさ
  timeoutMs: 20_000,
};

/** 数えない欄（P1 の漏れとしない）。理由つき。rubric/p1.md §2 の案 */
export const NOT_COUNTED_KEYS = { Producer: "producer", CreationDate: "date", ModDate: "date", Trapped: "trapped" };

class ParseError extends Error {}

// ---------- 字句と値 ----------

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

function latin1(b) {
  let s = "";
  for (let k = 0; k < b.length; k++) s += String.fromCharCode(b[k]);
  return s;
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
    if (hi >= 0) out.push(hi * 16); // 奇数桁は 0 を足す
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
    // 「整数 整数 R」なら参照
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
        if (buf[i] === 0x0a) i++; // 行の継続
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
      out.push(0x0a); // 改行はそろえる
    } else out.push(c);
  }
  throw new ParseError("文字列が閉じていない");
}

// ---------- 文字列の解読（PDF の「文字の文字列」） ----------

// PDFDocEncoding のうち、Latin-1 と違う所（PDF 1.7 付録 D）
const PDFDOC = {
  0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9, 0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
  0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044,
  0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018,
  0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160,
  0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142, 0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0xa0: 0x20ac,
};

/** 文字の文字列を読む。返す：{ text, encoding } */
export function decodeTextString(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = "";
    for (let k = 2; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
    return { text: stripLangEscape(s), encoding: "utf16be" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    let s = "";
    for (let k = 2; k + 1 < bytes.length; k += 2) s += String.fromCharCode(bytes[k] | (bytes[k + 1] << 8));
    return { text: s, encoding: "utf16le" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf8" };
  }
  let s = "";
  for (const b of bytes) s += String.fromCharCode(PDFDOC[b] ?? b);
  return { text: s, encoding: "pdfdoc" };
}

/** UTF-16BE の中の言語のしるし（ESC ja ESC など。0x1B で囲む）を外す */
function stripLangEscape(s) {
  return s.replace(/\u001b[^\u001b]{0,8}\u001b/g, "");
}

// ---------- 相互参照（xref） ----------

function findStartXref(buf) {
  const tail = latin1(buf.subarray(Math.max(0, buf.length - 2048)));
  const k = tail.lastIndexOf("startxref");
  if (k < 0) return null;
  const m = /startxref\s+(\d+)/.exec(tail.slice(k));
  return m ? Number(m[1]) : null;
}

function inflateLimited(data) {
  return new Uint8Array(inflateSync(data, { maxOutputLength: LIMITS.maxInflate }));
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

/** オブジェクト（「N G obj」）を位置から読む。ストリームなら中身のバイト列（圧縮を解いたもの）も返す */
function readIndirectAt(buf, offset, resolveLength) {
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

function streamData(dict, raw) {
  const f = dict.get("Filter");
  const filters = f?.t === "name" ? [f.v] : f?.t === "array" ? f.v.map((x) => x.v) : [];
  let data = raw;
  for (const name of filters) {
    if (name === "FlateDecode" || name === "Fl") data = inflateLimited(data);
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
 * 場所：{ kind: "offset", offset } または { kind: "objstm", stream, index }
 */
function readXref(buf) {
  const table = new Map();
  const trailers = [];
  let offset = findStartXref(buf);
  const seen = new Set();
  const pending = [];
  if (offset === null) throw new ParseError("startxref がない");
  pending.push(offset);
  while (pending.length) {
    offset = pending.shift();
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
        const start = Number(a);
        const count = Number(b);
        i = ib;
        for (let k = 0; k < count; k++) {
          i = skipWs(buf, i);
          const [off, i1] = readToken(buf, i);
          const [, i2] = readToken(buf, skipWs(buf, i1));
          const [type, i3] = readToken(buf, skipWs(buf, i2));
          i = i3;
          const num = start + k;
          if (!table.has(num)) table.set(num, type === "n" ? { kind: "offset", offset: Number(off) } : { kind: "free" });
        }
      }
      const xs = trailer?.v.get("XRefStm");
      if (xs?.t === "num") pending.unshift(xs.v); // 混ぜた形（hybrid）。同じ版の追加分なので先に読む
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

function makeResolver(buf, table) {
  const objstmCache = new Map();
  const resolveRef = ([num], depth = 0) => {
    if (depth > 8) throw new ParseError("参照の入れ子が深すぎる");
    const loc = table.get(num);
    if (!loc || loc.kind === "free") return { t: "null", v: null };
    if (loc.kind === "offset") {
      return readIndirectAt(buf, loc.offset, (r) => resolveRef(r, depth + 1)).value;
    }
    let objs = objstmCache.get(loc.stream);
    if (!objs) {
      const sl = table.get(loc.stream);
      if (!sl || sl.kind !== "offset") throw new ParseError("オブジェクトストリームが見つからない");
      const st = readIndirectAt(buf, sl.offset, (r) => resolveRef(r, depth + 1));
      const data = streamData(st.value.v, st.stream);
      const n = st.value.v.get("N")?.v ?? 0;
      const first = st.value.v.get("First")?.v ?? 0;
      const head = [];
      let i = 0;
      for (let k = 0; k < n; k++) {
        const [a, ia] = parseValue(data, i);
        const [b, ib] = parseValue(data, ia);
        head.push([a.v, b.v]);
        i = ib;
      }
      objs = new Map(head.map(([on, off]) => [on, off]));
      objs.data = data;
      objs.first = first;
      objstmCache.set(loc.stream, objs);
    }
    const off = objs.get(num);
    if (off === undefined) return { t: "null", v: null };
    return parseValue(objs.data, objs.first + off)[0];
  };
  return resolveRef;
}

/** 文書情報の辞書（いまの版）を読む。返す：{ keys: Map<鍵, {text, encoding, form}>, previousInfo: 数 } */
function readInfoFromBytes(buf) {
  const { table, trailers } = readXref(buf);
  const current = trailers[0];
  if (current.v.get("Encrypt")) return { encrypted: true };
  const resolve = makeResolver(buf, table);
  let info = current.v.get("Info");
  let infoNum = null;
  if (info?.t === "ref") {
    infoNum = info.v[0];
    info = resolve(info.v);
  }
  const keys = new Map();
  if (info?.t === "dict") {
    for (const [k, v0] of info.v) {
      let v = v0;
      if (v.t === "ref") v = resolve(v.v);
      if (v.t === "str") keys.set(k, { ...decodeTextString(v.v), form: v.form });
      else if (v.t === "name") keys.set(k, { text: v.v, encoding: "name", form: "name" });
      else if (v.t === "num" || v.t === "bool") keys.set(k, { text: String(v.v), encoding: "other", form: v.t });
      else keys.set(k, { text: "", encoding: "other", form: v.t });
    }
  }
  // 前の版の文書情報（P5 の範囲。数えるだけ）：古い trailer が指す Info で、いまの版と違う番号か、同じ番号の別の場所の定義
  let previousInfo = 0;
  const text = latin1(buf);
  for (const t of trailers.slice(1)) {
    const r = t.v.get("Info");
    if (r?.t === "ref" && r.v[0] !== infoNum) previousInfo++;
  }
  if (infoNum !== null) {
    const defs = text.match(new RegExp(`(?:^|[^0-9])${infoNum}\\s+\\d+\\s+obj\\b`, "g"));
    if (defs && defs.length > 1) previousInfo += defs.length - 1;
  }
  return { keys, infoPresent: info?.t === "dict", previousInfo, revisions: trailers.length };
}

async function readInfoWithPdfjs(buf) {
  let task;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    const doc = await task.promise;
    const { info } = await doc.getMetadata();
    const out = new Map();
    for (const [k, v] of Object.entries(info ?? {})) {
      if (k === "Custom" && v && typeof v === "object") {
        // pdfjs-dist 6.4.299 は Custom を Map で返す（pdf.worker.mjs の documentInfo）
        const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
        for (const [ck, cv] of entries) out.set(ck, typeof cv === "object" && cv !== null ? cv.name ?? "" : String(cv));
      } else if (typeof v === "string") out.set(k, v);
      else if (v && typeof v === "object" && "name" in v) out.set(k, v.name);
    }
    // PDF.js が自分で足す欄（PDFFormatVersion など。Info 辞書の欄ではない）は除く
    for (const k of ["PDFFormatVersion", "Language", "EncryptFilterName", "IsLinearized", "IsAcroFormPresent", "IsXFAPresent", "IsCollectionPresent", "IsSignaturesPresent"]) out.delete(k);
    return { ok: true, keys: out };
  } catch (e) {
    return { ok: false, encrypted: e?.name === "PasswordException" };
  } finally {
    await task?.destroy().catch(() => {});
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error("timeout")), ms);
    }),
  ]);
}

/**
 * PDF のバイト列 → 結果（形は p1-schema.json）
 * @param {Uint8Array} bytes
 * @param {{ includeValues?: boolean }} [options]
 */
export async function verifyP1(bytes, options = {}) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = {
    verifier: VERIFIER,
    checked: ["P1"],
    input: { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") },
    status: "ok",
    items: [],
    not_counted: [],
    previous_info: 0,
    revisions: 0,
    cross_check: { only_bytes: [], only_pdfjs: [], value_mismatch: [] },
  };
  const fail = (code, message) => ({ ...result, status: "error", error: { code, message }, items: [], not_counted: [] });
  if (buf.byteLength === 0) return fail("empty", "ファイルが空です");
  if (buf.byteLength > LIMITS.maxBytes) return fail("too_large", "ファイルが大きすぎます");
  if (latin1(buf.subarray(0, 1024)).indexOf("%PDF-") < 0) return fail("unreadable", "PDF として読めません");

  let fromBytes;
  try {
    fromBytes = readInfoFromBytes(buf);
  } catch {
    fromBytes = null;
  }
  if (fromBytes?.encrypted) return fail("encrypted", "暗号化されていて読めません");
  let fromPdfjs;
  try {
    fromPdfjs = await withTimeout(readInfoWithPdfjs(buf), LIMITS.timeoutMs);
  } catch {
    return fail("timeout", "時間内に読み終わりませんでした");
  }
  if (fromPdfjs.encrypted) return fail("encrypted", "暗号化されていて読めません");
  // いまの版の文書情報を、どちらの読み方でも読めなければ「読めない」（0 件と数えない）
  if (!fromBytes && !fromPdfjs.ok) return fail("unreadable", "PDF として読めません");

  const bytesKeys = fromBytes?.keys ?? new Map();
  const pdfjsKeys = fromPdfjs.ok ? fromPdfjs.keys : new Map();
  result.previous_info = fromBytes?.previousInfo ?? 0;
  result.revisions = fromBytes?.revisions ?? 0;
  if (!fromBytes) result.cross_check.bytes_unreadable = true;

  const allKeys = [...new Set([...bytesKeys.keys(), ...pdfjsKeys.keys()])].sort();
  for (const key of allKeys) {
    const b = bytesKeys.get(key);
    const pText = pdfjsKeys.get(key);
    const nonEmpty = (t) => typeof t === "string" && t.replace(/[\s\u0000　]/g, "") !== "";
    const bHas = nonEmpty(b?.text);
    const pHas = nonEmpty(pText);
    if (bHas && !pHas) result.cross_check.only_bytes.push(key);
    if (!bHas && pHas && fromPdfjs.ok && fromBytes) result.cross_check.only_pdfjs.push(key);
    if (bHas && pHas && b.text.trim() !== pText.trim()) result.cross_check.value_mismatch.push(key);
    const reason = NOT_COUNTED_KEYS[key] ?? (bHas || pHas ? null : "empty");
    if (reason) {
      result.not_counted.push({ key, reason });
      continue;
    }
    const text = bHas ? b.text : pText;
    const item = {
      pattern: "P1",
      key,
      where: "current",
      chars: [...text.trim()].length,
      encoding: b?.encoding ?? "unknown",
      found_by: bHas && pHas ? "both" : bHas ? "bytes" : "pdfjs",
    };
    if (options.includeValues) item.value = text;
    result.items.push(item);
  }
  return result;
}

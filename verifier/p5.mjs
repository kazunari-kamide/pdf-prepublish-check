// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器：P5（旧版の残存）。PDF のバイト列を入れると、いまの版では使っていないのに、ファイルの中に残っている中身を返す。
//
// 「残っている中身」の場所（where）は4つ：
//   superseded    増分更新で、同じ番号のオブジェクトを新しく書き直した。前の定義がファイルに残っている
//   free          いまの版の xref が「使っていない」（f）と印をつけた。前の版の定義がファイルに残っている
//   unreferenced  いまの版の xref には載っているが、いまの版の根（trailer の /Root・/Info）からたどれない
//   orphan        どの版の xref にも載っていないのに、ファイルの中に「N G obj」として書いてある
// 種類（kind）を見て、漏れになりうる中身だけを items に出す（rubric/p5.md §2）。
//
// 検査器から独立させるため、pdf-lib は使わない。PDF.js は前の版を見せないので使わない。
// バイト列の読み方の部品は、P9 の検証器と同じ p9-pdfbytes.mjs を使う。xref を版ごとに分けて読む所は、ここに書く。
// 中身そのもの（字・値）は出さない。includeText のときだけ、字数を出す所の中身を出す（記録やログには使わない）。

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

// verifier/ に移したあとは同じフォルダ、proposals/p5/verifier/ にある間は verifier/ の部品を使う
const bytesModuleUrl = existsSync(new URL("./p9-pdfbytes.mjs", import.meta.url))
  ? new URL("./p9-pdfbytes.mjs", import.meta.url)
  : new URL("../../../verifier/p9-pdfbytes.mjs", import.meta.url);
const { LIMITS, ParseError, decodeTextString, latin1, parseValue, readIndirectAt, streamData } = await import(bytesModuleUrl.href);
// 利用者のパスワードが空の暗号化を解く（PR #21 の返事の 5）。同じフォルダの p5-decrypt.mjs
import { makeDecryptor, decryptValue } from "./p5-decrypt.mjs";

export const VERIFIER = { name: "omamori-verifier-p5", version: "0.2.0" };

/** 漏れとして数える種類（rubric/p5.md §2） */
export const COUNTED_KINDS = ["info", "content", "annotation", "form_value", "metadata", "image", "embedded_file"];

/** P1 で「数えない欄」（rubric/p1.md §2）。前の版の文書情報も、これだけなら漏れとしない */
const P1_NOT_COUNTED = new Set(["Producer", "CreationDate", "ModDate", "Trapped"]);

const ANNOT_SUBTYPES = new Set([
  "Text", "Link", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Highlight", "Underline", "Squiggly",
  "StrikeOut", "Stamp", "Caret", "Ink", "Popup", "FileAttachment", "Sound", "Movie", "Widget", "Screen", "PrinterMark",
  "TrapNet", "Watermark", "3D", "Redact", "RichMedia",
]);

const MAX_SCAN_OBJECTS = 200_000;

// ---------- xref を版ごとに読む ----------

function findStartXref(buf) {
  const tail = latin1(buf.subarray(Math.max(0, buf.length - 2048)));
  const k = tail.lastIndexOf("startxref");
  if (k < 0) return null;
  const m = /startxref\s+(\d+)/.exec(tail.slice(k));
  return m ? Number(m[1]) : null;
}

/** 表の形の xref を1つ読む。返す：{ entries: Map<num, loc>, trailer, end } */
function readXrefTable(buf, offset) {
  const entries = new Map();
  const text = latin1(buf.subarray(offset, Math.min(buf.length, offset + 64 * 1024 * 1024)));
  const tIdx = text.indexOf("trailer");
  if (tIdx < 0) throw new ParseError("trailer がない");
  const lines = text.slice(4, tIdx).split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  let num = 0;
  for (const line of lines) {
    const head = /^(\d+)\s+(\d+)$/.exec(line);
    if (head) {
      num = Number(head[1]);
      continue;
    }
    const ent = /^(\d{1,10})\s+(\d{1,5})\s+([nf])/.exec(line);
    if (!ent) throw new ParseError("xref の表が読めない");
    entries.set(num, ent[3] === "n" ? { kind: "offset", offset: Number(ent[1]), gen: Number(ent[2]) } : { kind: "free" });
    num++;
  }
  const [trailer] = parseValue(buf, offset + Buffer.byteLength(text.slice(0, tIdx + 7), "latin1"));
  return { entries, trailer };
}

/** xref ストリームを1つ読む */
function readXrefStream(buf, offset) {
  const obj = readIndirectAt(buf, offset);
  if (obj.value.t !== "dict" || obj.value.v.get("Type")?.v !== "XRef" || !obj.stream) throw new ParseError("xref が読めない");
  const d = obj.value.v;
  const data = streamData(d, obj.stream);
  const w = d.get("W")?.v.map((x) => x.v) ?? [1, 2, 1];
  const size = d.get("Size")?.v ?? 0;
  const index = d.get("Index")?.v.map((x) => x.v) ?? [0, size];
  const rowLen = w[0] + w[1] + w[2];
  const entries = new Map();
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
      if (type === 1) entries.set(num, { kind: "offset", offset: f2, gen: f3 });
      else if (type === 2) entries.set(num, { kind: "objstm", stream: f2, index: f3, gen: 0 });
      else entries.set(num, { kind: "free" });
    }
  }
  return { entries, trailer: obj.value, selfNum: obj.num };
}

/**
 * xref の区切りを、いまの版から古い版へたどる。返す：sections（新しい順）。
 * 同じ版の中の、表と xref ストリームの混ぜた形（/XRefStm）は、1つの区切りとしてまとめる。
 */
function readSections(buf) {
  const start = findStartXref(buf);
  if (start === null) throw new ParseError("startxref がない");
  const sections = [];
  const seen = new Set();
  let offset = start;
  while (offset !== undefined && offset !== null) {
    if (seen.has(offset) || offset < 0 || offset >= buf.length) break;
    if (seen.size >= LIMITS.maxXrefSections) break;
    seen.add(offset);
    const kw = latin1(buf.subarray(offset, offset + 16)).trimStart();
    let sec;
    if (kw.startsWith("xref")) {
      sec = readXrefTable(buf, offset);
      const xs = sec.trailer.v.get("XRefStm");
      if (xs?.t === "num" && !seen.has(xs.v)) {
        seen.add(xs.v);
        const extra = readXrefStream(buf, xs.v);
        for (const [n, loc] of extra.entries) if (!sec.entries.has(n)) sec.entries.set(n, loc);
        sec.xrefStreamNums = [extra.selfNum];
      }
    } else {
      sec = readXrefStream(buf, offset);
      sec.xrefStreamNums = [sec.selfNum];
    }
    sec.offset = offset;
    sections.push(sec);
    const prev = sec.trailer.v.get("Prev");
    offset = prev?.t === "num" ? prev.v : null;
  }
  return sections;
}

// ---------- オブジェクトを読む ----------

/**
 * crypt：{ decryptor, encNum } のとき、暗号化された版（enc が false でないもの）の文字列とストリームを解いて返す。
 * 解くときのオブジェクトの番号・世代は、ファイルに書いてある「N G obj」の頭のものを使う。
 * 暗号化の辞書そのもの（encNum）と、オブジェクトストリームの中のオブジェクト（ストリームごと解く）は、個別には解かない。
 */
function makeReader(buf, crypt = null) {
  const objstmCache = new Map();
  const shouldDecrypt = (enc, n) => crypt && enc !== false && n !== crypt.encNum;
  const rawStream = (st, enc) =>
    shouldDecrypt(enc, st.num) ? crypt.decryptor.decryptStream(st.num, st.gen, st.stream, st.value.v) : st.stream;
  /** オブジェクトストリームの中身を開く（どの版のものでも、オフセットで開く） */
  const openObjStm = (offset, enc) => {
    const ck = `${offset}|${enc !== false}`;
    if (objstmCache.has(ck)) return objstmCache.get(ck);
    let out = null;
    try {
      const st = readIndirectAt(buf, offset);
      if (st.value.t === "dict" && st.stream) {
        const data = streamData(st.value.v, rawStream(st, enc));
        const n = st.value.v.get("N")?.v ?? 0;
        const first = st.value.v.get("First")?.v ?? 0;
        const list = [];
        let i = 0;
        for (let k = 0; k < Math.min(n, MAX_SCAN_OBJECTS); k++) {
          const [a, ia] = parseValue(data, i);
          const [b, ib] = parseValue(data, ia);
          list.push({ num: a.v, off: b.v });
          i = ib;
        }
        out = { num: st.num, list, data, first };
      }
    } catch {
      out = null;
    }
    objstmCache.set(ck, out);
    return out;
  };
  /** 定義の場所から、値（とストリームの中身）を読む */
  const readDef = (def) => {
    if (def.offset !== undefined) {
      const o = readIndirectAt(buf, def.offset);
      if (!shouldDecrypt(def.enc, o.num)) return { value: o.value, stream: o.stream };
      const value = decryptValue(o.value, crypt.decryptor.decryptString, o.num, o.gen);
      return { value, stream: o.stream ? rawStream(o, def.enc) : undefined };
    }
    const os = openObjStm(def.objstmOffset, def.enc);
    const entry = os?.list[def.index];
    if (!os || !entry) return null;
    return { value: parseValue(os.data, os.first + entry.off)[0] };
  };
  return { openObjStm, readDef };
}

// ---------- 種類を見分ける ----------

const strOf = (v) => (v?.t === "str" ? decodeTextString(v.v) : v?.t === "name" ? v.v : "");
const nonEmpty = (s) => typeof s === "string" && s.replace(/[\s\u0000　]/g, "") !== "";

/** 中身のバイト列に、字を描く命令（Tj・TJ・'・"）があるか。あれば、その字数（文字列のバイトの数の目安） */
function textOps(data) {
  const s = latin1(data.subarray(0, Math.min(data.length, 16 * 1024 * 1024)));
  if (!/(\)|>|\])\s*(Tj|TJ|'|")(\s|$)/.test(s)) return 0;
  let n = 0;
  for (const m of s.matchAll(/\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|\[([^\]]*)\]\s*TJ|<([0-9A-Fa-f\s]*)>\s*Tj/g)) {
    if (m[1] !== undefined) n += m[1].replace(/\\./g, "x").replace(/\s/g, "").length;
    else if (m[2] !== undefined) for (const t of m[2].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) n += t[1].replace(/\\./g, "x").replace(/\s/g, "").length;
    else if (m[3] !== undefined) n += Math.floor(m[3].replace(/\s/g, "").length / 2);
  }
  return Math.max(1, n);
}

/**
 * 種類を返す：{ kind, counted, reason?, chars? }
 * infoNums：どれかの版の trailer が /Info として指した番号
 */
function classify(value, stream, num, infoNums) {
  if (value?.t !== "dict") return { kind: "structure", counted: false, reason: "structure" };
  const d = value.v;
  const type = d.get("Type")?.v;
  const subtype = d.get("Subtype")?.v;
  if (type === "XRef" || type === "ObjStm") return { kind: "xref", counted: false, reason: "structure" };
  if (stream) {
    if (type === "EmbeddedFile") return { kind: "embedded_file", counted: true };
    if (type === "Metadata" || subtype === "XML") return { kind: "metadata", counted: true };
    if (subtype === "Image") return { kind: "image", counted: true };
    if (subtype === "Form" || !type) {
      let data;
      try {
        data = streamData(d, stream);
      } catch {
        return { kind: "structure", counted: false, reason: "unreadable_stream" };
      }
      const chars = textOps(data);
      if (chars > 0) return { kind: "content", counted: true, chars };
    }
    return { kind: "structure", counted: false, reason: "structure" };
  }
  // 文書情報：どれかの版の /Info が指した番号か、/Type のない辞書で Info の鍵を持つもの
  const infoKeys = ["Author", "Title", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Company"];
  if (infoNums.has(num) || (!type && [...d.keys()].some((k) => infoKeys.includes(k)) && !d.has("Kids") && !d.has("Rect"))) {
    let chars = 0;
    for (const [k, v] of d) if (!P1_NOT_COUNTED.has(k) && nonEmpty(strOf(v))) chars += [...strOf(v).trim()].length;
    return chars > 0 ? { kind: "info", counted: true, chars } : { kind: "info", counted: false, reason: "info_without_counted_keys" };
  }
  if (type === "Annot" || (ANNOT_SUBTYPES.has(subtype) && d.has("Rect"))) {
    // フォームの欄を兼ねる注釈（Widget）は、値（/V）があればフォームの値として数える
    if (d.has("FT") && nonEmpty(strOf(d.get("V")))) return { kind: "form_value", counted: true, chars: [...strOf(d.get("V")).trim()].length };
    const chars = ["Contents", "T", "RC", "Subj"].reduce((s, k) => s + (nonEmpty(strOf(d.get(k))) ? [...strOf(d.get(k)).trim()].length : 0), 0);
    return chars > 0 ? { kind: "annotation", counted: true, chars } : { kind: "annotation", counted: false, reason: "annotation_without_text" };
  }
  if (d.has("FT") || (d.has("T") && d.has("V"))) {
    const v = strOf(d.get("V"));
    return nonEmpty(v) ? { kind: "form_value", counted: true, chars: [...v.trim()].length } : { kind: "form_field", counted: false, reason: "form_without_value" };
  }
  if (type === "Filespec") return { kind: "filespec", counted: false, reason: "filespec" };
  return { kind: "structure", counted: false, reason: "structure" };
}

// ---------- いまの版の根からたどる ----------

function reachableFrom(roots, readCurrent) {
  const seen = new Set();
  const stack = [...roots];
  let steps = 0;
  const visit = (v, depth) => {
    if (!v || depth > LIMITS.maxDepth) return;
    if (v.t === "ref") {
      if (!seen.has(v.v[0])) {
        seen.add(v.v[0]);
        stack.push(v.v[0]);
      }
    } else if (v.t === "dict") for (const x of v.v.values()) visit(x, depth + 1);
    else if (v.t === "array") for (const x of v.v) visit(x, depth + 1);
  };
  for (const r of roots) seen.add(r);
  while (stack.length) {
    if (++steps > MAX_SCAN_OBJECTS) throw new ParseError("オブジェクトが多すぎる");
    const n = stack.pop();
    const o = readCurrent(n);
    if (o) visit(o.value, 0);
  }
  return seen;
}

// ---------- 本体 ----------

function analyze(buf) {
  const sections = readSections(buf);
  const current = sections[0];
  // その版が暗号化されているか（trailer に /Encrypt があるか）。暗号化のない古い版の中身は、解かずに読む
  const sectionEncrypted = (sec) => !!sec.trailer.v.get("Encrypt");

  // いまの版の場所（新しい版から順に、最初に出てきた場所）。その場所を書いた版が暗号化されていたかも持つ
  const currentLoc = new Map();
  for (const sec of sections) {
    for (const [n, loc] of sec.entries) if (!currentLoc.has(n)) currentLoc.set(n, { ...loc, enc: sectionEncrypted(sec), sec });
  }
  const xrefStreamNums = new Set(sections.flatMap((s) => s.xrefStreamNums ?? []));

  // オブジェクトストリームの番号 → オフセット（その版で）
  const locKey = (num, loc) => (loc.kind === "offset" ? `o${loc.offset}` : `s${loc.stream}:${loc.index}`);
  const objstmOffsetFor = (sec, stmNum) => {
    // 同じ版か、それより古い版で、そのオブジェクトストリームの番号が指す場所
    const i = sections.indexOf(sec);
    for (let k = i; k < sections.length; k++) {
      const l = sections[k].entries.get(stmNum);
      if (l?.kind === "offset") return l.offset;
    }
    return undefined;
  };

  // 暗号化：利用者のパスワードが空のものだけ解く。解けなければ調べない（前の版の中身も暗号化されているため）
  let crypt = null;
  const encVal = current.trailer.v.get("Encrypt");
  if (encVal) {
    let encDict = null;
    let encNum = null;
    if (encVal.t === "dict") encDict = encVal.v;
    else if (encVal.t === "ref") {
      encNum = encVal.v[0];
      const loc = currentLoc.get(encNum);
      const plain = makeReader(buf); // 暗号化の辞書は暗号化されていない
      try {
        let o = null;
        if (loc?.kind === "offset") o = plain.readDef({ offset: loc.offset });
        else if (loc?.kind === "objstm") {
          const off = objstmOffsetFor(loc.sec, loc.stream);
          if (off !== undefined) o = plain.readDef({ objstmOffset: off, index: loc.index });
        }
        if (o?.value?.t === "dict") encDict = o.value.v;
      } catch {
        encDict = null;
      }
    }
    const idArr = current.trailer.v.get("ID");
    const id0 = idArr?.t === "array" && idArr.v[0]?.t === "str" ? idArr.v[0].v : null;
    const d = makeDecryptor(encDict, id0);
    if (!d.ok) return { encrypted: true, reason: d.reason };
    crypt = { decryptor: d, encNum };
  }
  const { readDef } = makeReader(buf, crypt);

  // すべての定義（どの版の xref にも載っているもの）
  const defs = [];
  const knownOffsets = new Set();
  sections.forEach((sec, si) => {
    for (const [num, loc] of sec.entries) {
      if (loc.kind === "free") continue;
      const def = { num, gen: loc.gen ?? 0, revision: sections.length - si, key: locKey(num, loc), enc: sectionEncrypted(sec) };
      if (loc.kind === "offset") {
        def.offset = loc.offset;
        knownOffsets.add(loc.offset);
      } else {
        def.objstmOffset = objstmOffsetFor(sec, loc.stream);
        def.index = loc.index;
        if (def.objstmOffset === undefined) continue;
      }
      defs.push(def);
    }
  });

  const readCurrent = (num) => {
    const loc = currentLoc.get(num);
    if (!loc || loc.kind === "free") return null;
    try {
      if (loc.kind === "offset") return readDef({ offset: loc.offset, enc: loc.enc });
      const off = objstmOffsetFor(current, loc.stream);
      if (off === undefined) return null;
      return readDef({ objstmOffset: off, index: loc.index, enc: loc.enc });
    } catch {
      return null;
    }
  };

  const infoNums = new Set();
  for (const sec of sections) {
    const r = sec.trailer.v.get("Info");
    if (r?.t === "ref") infoNums.add(r.v[0]);
  }
  // 根：trailer の /Root・/Info・/Encrypt。trailer の中に直接書いた辞書なら、その中の参照を根にする
  const roots = [];
  const collectRefs = (v, depth) => {
    if (!v || depth > LIMITS.maxDepth) return;
    if (v.t === "ref") roots.push(v.v[0]);
    else if (v.t === "dict") for (const x of v.v.values()) collectRefs(x, depth + 1);
    else if (v.t === "array") for (const x of v.v) collectRefs(x, depth + 1);
  };
  for (const k of ["Root", "Info", "Encrypt"]) collectRefs(current.trailer.v.get(k), 0);
  const reachable = reachableFrom(roots, readCurrent);

  const found = [];
  const seenKeys = new Set();
  const consider = (def, where) => {
    const k = `${where}|${def.num}|${def.key}`;
    if (seenKeys.has(k)) return;
    seenKeys.add(k);
    let o;
    try {
      o = readDef(def);
    } catch {
      o = null;
    }
    if (!o) return;
    const c = classify(o.value, o.stream, def.num, infoNums);
    if (c.kind === "xref" || xrefStreamNums.has(def.num)) return;
    found.push({ object: def.num, gen: def.gen, revision: def.revision ?? null, where, ...c, value: o.value, stream: o.stream });
  };

  // superseded・free
  for (const def of defs) {
    const cur = currentLoc.get(def.num);
    if (cur?.kind === "free") consider(def, "free");
    else if (cur && locKey(def.num, cur) !== def.key) consider(def, "superseded");
  }
  // unreferenced：いまの版の場所にあるが、根からたどれない（オブジェクトストリーム・xref ストリームは除く）
  for (const [num, loc] of currentLoc) {
    if (loc.kind === "free" || reachable.has(num) || xrefStreamNums.has(num)) continue;
    const def = defs.find((d) => d.num === num && d.key === locKey(num, loc));
    if (def) consider(def, "unreferenced");
  }
  // orphan：どの版の xref にも載っていない「N G obj」。既知のストリームの中身の範囲にあるものは除く
  const text = latin1(buf);
  const streamRanges = [];
  for (const off of knownOffsets) {
    try {
      const o = readIndirectAt(buf, off);
      if (o.stream) streamRanges.push([o.stream.byteOffset - buf.byteOffset, o.stream.byteOffset - buf.byteOffset + o.stream.length]);
    } catch {
      // 飛ばす
    }
  }
  let scanned = 0;
  for (const m of text.matchAll(/(?:^|[\r\n\s>])(\d{1,10})\s+(\d{1,5})\s+obj\b/g)) {
    if (++scanned > MAX_SCAN_OBJECTS) break;
    const at = m.index + m[0].indexOf(m[1]);
    if (knownOffsets.has(at)) continue;
    if (streamRanges.some(([a, b]) => at >= a && at < b)) continue;
    // 表の xref のオフセットは、行の頭の空白を含めて指すことがあるので、前後の空白のずれも見る
    if (knownOffsets.has(at - 1) || knownOffsets.has(at - 2)) continue;
    // xref の外のものは、どの版のものか分からないので、いまの版の暗号化に従う
    consider({ num: Number(m[1]), gen: Number(m[2]), offset: at, key: `o${at}`, revision: null, enc: sectionEncrypted(current) }, "orphan");
  }

  return { found, revisions: sections.length };
}

/**
 * PDF のバイト列 → 結果（形は p5-schema.json）
 * @param {Uint8Array} bytes
 */
export async function verifyP5(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = {
    verifier: VERIFIER,
    checked: ["P5"],
    input: { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") },
    status: "ok",
    revisions: 0,
    items: [],
    not_counted: [],
    summary: { previous_info: 0, removed_attachment: 0 },
  };
  const fail = (code, message) => ({ ...result, status: "error", error: { code, message }, items: [], not_counted: [] });
  if (buf.byteLength === 0) return fail("empty", "ファイルが空です");
  if (buf.byteLength > LIMITS.maxBytes) return fail("too_large", "ファイルが大きすぎます");
  if (latin1(buf.subarray(0, 1024)).indexOf("%PDF-") < 0) return fail("unreadable", "PDF として読めません");
  let a;
  try {
    a = analyze(buf);
  } catch (e) {
    if (e instanceof ParseError && /深すぎる|多すぎる/.test(e.message)) return fail("too_deep", "入れ子が深すぎる・大きすぎるため、読みませんでした");
    return fail("unreadable", "PDF として読めません");
  }
  if (a.encrypted) {
    return fail(
      "encrypted",
      a.reason === "password_required"
        ? "パスワードで守られていて開けません"
        : "この暗号化の方式は解けないため、前の版の中身を調べられません",
    );
  }
  result.revisions = a.revisions;
  const order = { superseded: 0, free: 1, unreferenced: 2, orphan: 3 };
  a.found.sort((x, y) => order[x.where] - order[y.where] || x.object - y.object || (x.revision ?? 0) - (y.revision ?? 0));
  for (const f of a.found) {
    // いまの版に載っていて、根からたどれない添付の中身は、P9 で数える（rubric/p9.md の unreferenced）
    if (f.kind === "embedded_file" && f.where === "unreferenced") {
      result.not_counted.push({ object: f.object, kind: f.kind, where: f.where, reason: "counted_by_p9" });
      continue;
    }
    if (!f.counted) {
      result.not_counted.push({ object: f.object, kind: f.kind, where: f.where, reason: f.reason });
      continue;
    }
    const item = { pattern: "P5", object: f.object, gen: f.gen, kind: f.kind, where: f.where, revision: f.revision };
    if (f.chars !== undefined) item.chars = f.chars;
    result.items.push(item);
    if (f.kind === "info") result.summary.previous_info++;
    if (f.kind === "embedded_file") result.summary.removed_attachment++;
  }
  return result;
}

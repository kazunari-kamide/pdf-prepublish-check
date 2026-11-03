// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P1（文書情報）。
// いまの版の文書情報（trailer の /Info）で、値が残っている欄を見つける。値そのものは返さず、どの欄に残っているかだけを返す。
// 数えない欄（Producer・CreationDate・ModDate・Trapped、空・空白だけの値）は notCounted に理由つきで返す（rubric/p1.md §2）。
// 前の版の文書情報（増分更新で残ったもの。P5 の範囲）は、数だけを previousInfo に返す。

import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObjectParser,
  PDFRef,
  PDFString,
  pdfDocEncodingDecode,
  type PDFObject,
} from "pdf-lib";

export const RULE_ID = "p1-info";
export const RULE_VERSION = "1.0.0";

/** 決まった欄（rubric/p1.json の breakdown.standard と同じ並び）。それ以外は独自の欄 */
export const STANDARD_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator"] as const;

/** 数えない欄と、その理由 */
const NOT_COUNTED_KEYS: Record<string, NotCountedReason> = {
  Producer: "producer",
  CreationDate: "date",
  ModDate: "date",
  Trapped: "trapped",
};

/** 前の版を読み直す数の上限（%%EOF の区切りの数）。これを超えた分は読まず、previousInfo.truncated に出す */
export const MAX_REVISIONS = 64;

export type NotCountedReason = "producer" | "date" | "trapped" | "empty";
export type ValueEncoding = "utf16be" | "utf16le" | "utf8" | "pdfdoc" | "name" | "other";

export type P1InfoFinding = {
  pattern: "P1";
  /** 文書情報の欄の名前（#xx は解いたもの） */
  key: string;
  /** standard＝決まった欄（Title・Author・Subject・Keywords・Creator）、custom＝独自の欄 */
  group: "standard" | "custom";
  /** 値の字数（前後の空白を除く） */
  chars: number;
  encoding: ValueEncoding;
  /** includeValues のときだけ。値そのもの。記録やログには使わない */
  value?: string;
};

export type P1InfoReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: { code: "empty" | "unreadable" | "encrypted"; message: string };
  /** いまの版に文書情報（/Info）があるか */
  hasInfo: boolean;
  findings: P1InfoFinding[];
  /** あったが数えなかった欄 */
  notCounted: Array<{ key: string; reason: NotCountedReason }>;
  /**
   * 前の版の文書情報（P5 の範囲。P1 の分母に入れない）。
   * revisions＝%%EOF で区切った版の数。keys＝前の版にあって、いまの版にない・値が違う、数える欄の数（鍵の重なりは1つと数える）
   */
  previousInfo: { revisions: number; keys: number; truncated: boolean };
};

export type DetectOptions = { includeValues?: boolean };

type Field = { key: string; kind: "count"; text: string; encoding: ValueEncoding } | { key: string; kind: "skip"; reason: NotCountedReason };

const latin1 = new TextDecoder("latin1");

/** 鍵の名前。#xx を解いたバイト列を UTF-8 として読み、読めなければ1バイト1字で読む */
function keyName(name: PDFName): string {
  const bytes = name.asBytes();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

/** UTF-16BE の中の言語のしるし（ESC で囲んだ部分）を取り除く */
function stripLanguageEscapes(s: string): string {
  return s.replace(/\u001b[^\u001b]*\u001b/g, "");
}

export function decodeTextBytes(bytes: Uint8Array): { text: string; encoding: ValueEncoding } {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2, 2 + ((bytes.length - 2) & ~1));
    return { text: stripLanguageEscapes(new TextDecoder("utf-16be").decode(body)), encoding: "utf16be" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const body = bytes.subarray(2, 2 + ((bytes.length - 2) & ~1));
    return { text: new TextDecoder("utf-16le").decode(body), encoding: "utf16le" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf8" };
  }
  return { text: pdfDocEncodingDecode(bytes), encoding: "pdfdoc" };
}

/** 空白だけかどうか。NUL も空白とみなす（片付けで NUL を詰めた値を「残っている」としない） */
function visible(text: string): string {
  return text.replace(/\u0000/g, "").trim();
}

/** 値を文字にする。値として数えないもの（null・空の配列など）は null を返す */
function valueText(context: PDFContext, raw: PDFObject | undefined, depth = 0): { text: string; encoding: ValueEncoding } | null {
  if (raw === undefined || depth > 8) return null;
  const v = raw instanceof PDFRef ? context.lookup(raw) : raw;
  if (v === undefined || v === PDFNull) return null;
  if (v instanceof PDFString || v instanceof PDFHexString) return decodeTextBytes(v.asBytes());
  if (v instanceof PDFName) return { text: keyName(v), encoding: "name" };
  if (v instanceof PDFNumber || v instanceof PDFBool) return { text: v.toString(), encoding: "other" };
  if (v instanceof PDFArray) {
    // 配列の中の文字をつないで見る（安全側。文字が1つもなければ値なし）
    const parts: string[] = [];
    for (let i = 0; i < v.size(); i++) {
      const p = valueText(context, v.get(i), depth + 1);
      if (p) parts.push(p.text);
    }
    return { text: parts.join(" "), encoding: "other" };
  }
  if (v instanceof PDFDict) return { text: v.keys().length > 0 ? "[dict]" : "", encoding: "other" };
  return { text: "", encoding: "other" };
}

function readFields(context: PDFContext, info: PDFDict): Field[] {
  const out: Field[] = [];
  for (const [k, raw] of info.entries()) {
    const key = keyName(k);
    const fixed = NOT_COUNTED_KEYS[key];
    if (fixed) {
      out.push({ key, kind: "skip", reason: fixed });
      continue;
    }
    const v = valueText(context, raw);
    const text = v ? visible(v.text) : "";
    if (!v || text === "") out.push({ key, kind: "skip", reason: "empty" });
    else out.push({ key, kind: "count", text, encoding: v.encoding });
  }
  return out;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number, to = hay.length): number {
  outer: for (let i = from; i <= to - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number, to: number): number {
  outer: for (let i = to - needle.length; i >= from; i--) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const EOF = new TextEncoder().encode("%%EOF");
const TRAILER = new TextEncoder().encode("trailer");

/** 各版の終わり（%%EOF の直後）の位置 */
function revisionEnds(bytes: Uint8Array): number[] {
  const ends: number[] = [];
  let at = 0;
  for (;;) {
    const i = indexOfBytes(bytes, EOF, at);
    if (i < 0) break;
    ends.push(i + EOF.length);
    at = i + EOF.length;
  }
  return ends;
}

/**
 * いまの版の文書情報の辞書。
 * pdf-lib は、新しい trailer に /Info がないとき、古い trailer の /Info を使い続ける。
 * そのため、最後の版の中に trailer があれば、それを読み直して /Info の有無を確かめる。
 * trailer がない版（xref ストリーム）は、pdf-lib が xref ストリームの辞書から読んだものを使う。
 */
function currentInfo(doc: PDFDocument, bytes: Uint8Array, segmentStart: number): PDFDict | null {
  const context = doc.context;
  let infoEntry: PDFObject | undefined = context.trailerInfo.Info;
  const t = lastIndexOfBytes(bytes, TRAILER, segmentStart, bytes.length);
  if (t >= 0) {
    try {
      const parsed = PDFObjectParser.forBytes(bytes.subarray(t + TRAILER.length), context).parseObject();
      if (parsed instanceof PDFDict) infoEntry = parsed.get(PDFName.of("Info"));
    } catch {
      // 読めなければ pdf-lib の読んだものを使う
    }
  }
  if (!infoEntry) return null;
  const info = infoEntry instanceof PDFRef ? context.lookup(infoEntry) : infoEntry;
  return info instanceof PDFDict ? info : null;
}

class Encrypted extends Error {}

/**
 * pdf-lib 1.17.1 の EncryptedPDFError は ES5 向けに変換されたクラスで、instanceof で見分けられない。
 * そのため、暗号化を気にせずに読み、isEncrypted で見分ける。
 */
async function load(bytes: Uint8Array): Promise<PDFDocument> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false, ignoreEncryption: true });
  if (doc.isEncrypted) throw new Encrypted();
  return doc;
}

async function readRevision(bytes: Uint8Array, segmentStart: number): Promise<Field[] | null> {
  const doc = await load(bytes);
  const info = currentInfo(doc, bytes, segmentStart);
  return info ? readFields(doc.context, info) : null;
}

export async function detectP1Info(bytes: Uint8Array, options: DetectOptions = {}): Promise<P1InfoReport> {
  const base = {
    rule: { id: RULE_ID, version: RULE_VERSION },
    hasInfo: false,
    findings: [],
    notCounted: [],
    previousInfo: { revisions: 0, keys: 0, truncated: false },
  };
  if (bytes.length === 0) return { ...base, status: "error", error: { code: "empty", message: "ファイルが空です。" } };

  // 版の終わりの位置。最後の %%EOF のあとに意味のある中身が続いていれば、ファイルの終わりも1つの版の終わりとみなす
  const revs = revisionEnds(bytes);
  const lastEnd = revs.length ? revs[revs.length - 1]! : 0;
  if (revs.length === 0 || latin1.decode(bytes.subarray(lastEnd)).trim() !== "") revs.push(bytes.length);
  const segmentStart = revs.length >= 2 ? revs[revs.length - 2]! : 0;

  let fields: Field[] | null;
  try {
    fields = await readRevision(bytes, segmentStart);
  } catch (e) {
    if (e instanceof Encrypted) {
      return { ...base, status: "error", error: { code: "encrypted", message: "暗号化された PDF は、いまは調べられません。" } };
    }
    return { ...base, status: "error", error: { code: "unreadable", message: "PDF として読めませんでした。" } };
  }

  const report: P1InfoReport = { ...base, status: "ok", hasInfo: fields !== null, findings: [], notCounted: [], previousInfo: { ...base.previousInfo } };
  const current = new Map<string, string>();
  for (const f of fields ?? []) {
    if (f.kind === "skip") {
      report.notCounted.push({ key: f.key, reason: f.reason });
      continue;
    }
    current.set(f.key, f.text);
    const finding: P1InfoFinding = {
      pattern: "P1",
      key: f.key,
      group: (STANDARD_KEYS as readonly string[]).includes(f.key) ? "standard" : "custom",
      chars: [...f.text].length,
      encoding: f.encoding,
    };
    if (options.includeValues) finding.value = f.text;
    report.findings.push(finding);
  }

  // 前の版：%%EOF ごとに切り出して読み直し、いまの版にない・値が違う、数える欄を数える（P1 の分母には入れない）
  report.previousInfo.revisions = revs.length;
  const previous = revs.slice(0, -1).map((end, i, all) => ({ start: i > 0 ? all[i - 1]! : 0, end }));
  const limited = previous.slice(-MAX_REVISIONS);
  report.previousInfo.truncated = limited.length < previous.length;
  const changed = new Set<string>();
  for (const { start, end } of limited) {
    try {
      const old = await readRevision(bytes.subarray(0, end), start);
      for (const f of old ?? []) {
        if (f.kind === "count" && current.get(f.key) !== f.text) changed.add(f.key);
      }
    } catch {
      // 前の版だけでは読めないもの（線形化した PDF の最初の区切りなど）は数えない
    }
  }
  report.previousInfo.keys = changed.size;
  return report;
}

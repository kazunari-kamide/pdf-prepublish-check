// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：部品に残った情報（p2-parts）1.0.0。見つけたもの1件ごとに、型の番号を付ける（2026-11-04 人の決定）。
//   P2（XMP メタデータ）：人名らしい欄（dc:creator など）、Illustrator の編集用データの利用者名（%%For）、編集用データそのもの
//   P4（ファイルパス）：パソコンのユーザーのフォルダ（Users\<名前>\ など）を含むパス
//   P10（画像の位置情報など）：GPS の緯度・経度
//
// 見る所：
// - 文書全体の XMP（カタログの /Metadata）とは別に、画像・部品（フォーム XObject）・マーク付きの中身の /Properties・ページなど、
//   部品ごとに付いた /Metadata（XMP）。どこからも指されていない XMP のストリームも見る。
//   文書全体の XMP は、このルールでは見ない（P2 の別の検出ルールの範囲）。
// - ページなどの /PieceInfo /Illustrator /Private（Illustrator で「編集機能を保持」のまま書き出したときの元データ）。
//   先頭が %AI12_CompressedData なら zlib を展開し（ブラウザと Node の標準の DecompressionStream。ライブラリは足していない）、
//   %%For（作ったパソコンの利用者名）と %%DocumentFiles（使ったファイルのパス）を探す。
//   先頭が %AI24_ZStandard_Data（zstd）なら展開しない。「残っているが中身は調べていない」として返す（2026-11-04 人の決定）。
//
// 数えないもの（見つける段の誤検知の型）：ソフト名・文書 ID・色の情報、「Links」「画像」などの中立なフォルダ名、
// 端末名・数字の入った英数字のアカウント（user01 など）、素材の配布元の名前（photoshop:Credit などは見ない）。
// 値そのものは返さない（字数だけ。includeValues のときだけ値も返す）。

import { PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFContext, type PDFObject } from "pdf-lib";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { loadPdf } from "../shared/load.ts";

export const RULE_ID = "p2-parts";
export const RULE_VERSION = "1.0.0";

/** 1つの XMP・編集用データとして読む大きさの上限（バイト）。超えた分は読まない【仮の値】 */
export const MAX_STREAM_BYTES = 16 * 1024 * 1024;
/** 展開した編集用データの大きさの上限（バイト）。超えた所で展開をやめる【仮の値】 */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
/** 見るオブジェクトの数の上限【仮の値】 */
export const MAX_OBJECTS = 1_000_000;

export type PartOwner = "image" | "form" | "properties" | "page" | "other" | "unreferenced";

export type P2PartsFinding = {
  pattern: "P2" | "P4" | "P10";
  kind: "person" | "path" | "gps" | "private_data";
  source: "xmp" | "illustrator";
  /** 欄の名前（dc:creator、stRef:filePath、%%For など） */
  field: string;
  /** どこに付いていたか（同じ値が何か所にもあれば、最初に見つけた所） */
  owner: PartOwner;
  /** 同じ値を持っていた部品の数 */
  parts: number;
  /** 人名・ユーザー名の字数（パスは、ユーザーのフォルダの名前の字数。GPS・編集用データは 0） */
  chars: number;
  /** 編集用データ（private_data）のとき：中身を調べたか。zstd の形は false */
  checked?: boolean;
  /** includeValues のときだけ。値そのもの（パスは全体）。記録やログには使わない */
  value?: string;
};

export type P2PartsReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: { code: "empty" | "unreadable" | "encrypted"; message: string };
  pages: number | null;
  /** 見た部品の XMP の数 */
  xmpParts: number;
  findings: P2PartsFinding[];
  /** 値はあったが、決まり文句・アカウント・中立な名前として数えなかった数（欄ごと） */
  notCounted: Array<{ field: string; reason: "generic" | "account" | "software" | "no_user_folder"; count: number }>;
  /** 読めなかった・上限で止めたもの */
  limits: Array<{ reason: "too_many_objects" | "stream_too_large" | "unreadable_stream" | "inflate_failed" | "inflated_too_large" }>;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { includeValues?: boolean };

// ---------------------------------------------------------------- XMP を読む（XML の部品は使わず、決まった欄だけを正規表現で拾う）

/** 人名らしい欄 */
export const PERSON_FIELDS = ["dc:creator", "dc:contributor", "pdf:Author", "xmp:Author", "xmpRights:Owner", "photoshop:CaptionWriter"] as const;
/** パスが入る欄。xmpMM:DerivedFrom・xmpMM:Ingredients の中のパスは stRef:filePath として拾う（二重に数えない） */
export const PATH_FIELDS = ["stRef:filePath", "stRef:lastURL", "photoshop:DocumentAncestors"] as const;
const GPS_FIELDS = ["exif:GPSLatitude", "exif:GPSLongitude"] as const;

const GENERIC_NAMES = new Set(["author", "user", "users", "administrator", "admin", "owner", "guest", "public", "default", "default user", "all users", "shared", "unknown", "ユーザー", "ユーザ", "管理者"]);
const SOFTWARE = /\b(adobe|illustrator|photoshop|indesign|acrobat|microsoft|word|excel|quark|canon|nikon|epson|ricoh|fujifilm|sharp|xerox|konica|kyocera)\b/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Math.min(0x10ffff, Number(d))))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Math.min(0x10ffff, parseInt(h, 16))))
    .replace(/&amp;/g, "&");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 欄の値を、属性（ns:name="…"）と要素（<ns:name>…</ns:name>。中の rdf:li は1つずつ）から、すべて拾う */
export function xmpValues(xml: string, field: string): string[] {
  const f = escapeRe(field);
  const out: string[] = [];
  for (const m of xml.matchAll(new RegExp(`[\\s<]${f}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "g"))) out.push(decodeEntities(m[1] ?? m[2] ?? ""));
  for (const m of xml.matchAll(new RegExp(`<${f}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${f}>)`, "g"))) {
    const inner = m[1] ?? "";
    const lis = [...inner.matchAll(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((x) => x[1] ?? "");
    const parts = lis.length ? lis : [inner];
    for (const p of parts) {
      // 中に入れ子の要素（stRef:filePath など）があるものは、その欄を別に拾うので、字だけの所を使う
      const t = p.replace(/<[^>]*>/g, " ");
      out.push(decodeEntities(t));
    }
    // 要素の属性に入った値（<xmpMM:DerivedFrom stRef:filePath="…"/>）は、属性の欄として上で拾う
  }
  return out.map((v) => v.replace(/\s+/g, " ").trim()).filter((v) => v.length > 0);
}

/** パスから、パソコンのユーザーのフォルダの名前を取り出す。なければ null */
export function userFolderOf(path: string): string | null {
  let p = path;
  try {
    if (/%[0-9a-f]{2}/i.test(p)) p = decodeURIComponent(p);
  } catch {
    /* そのまま */
  }
  const m = p.match(/(?:^|[\\/:])(?:Users|Documents and Settings|home)[\\/]+([^\\/]+)/i);
  return m ? m[1]!.trim() : null;
}

export type Classified = { counted: true; chars: number } | { counted: false; reason: "generic" | "account" | "software" | "no_user_folder" };

/** 人名・ユーザー名らしい値か。決まり文句・ソフト名・数字の入ったアカウント（端末名など）は数えない */
export function classifyName(value: string): Classified {
  const v = value.trim();
  if (GENERIC_NAMES.has(v.toLowerCase())) return { counted: false, reason: "generic" };
  if (SOFTWARE.test(v) || /^(uuid|xmp\.(did|iid))[:.]/i.test(v)) return { counted: false, reason: "software" };
  if (/[0-9０-９]/.test(v)) return { counted: false, reason: "account" };
  return { counted: true, chars: [...v].length };
}

export function classifyPath(value: string): Classified {
  const user = userFolderOf(value);
  if (user === null) return { counted: false, reason: "no_user_folder" };
  return classifyName(user);
}

// ---------------------------------------------------------------- Illustrator の編集用データ

const AI_ZLIB = "%AI12_CompressedData";
const AI_ZSTD = "%AI24_ZStandard_Data";

async function inflate(data: Uint8Array, limits: P2PartsReport["limits"]): Promise<Uint8Array | null> {
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      writer.write(data as Uint8Array<ArrayBuffer>).catch(() => undefined);
      writer.close().catch(() => undefined);
      const reader = ds.readable.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let tooLarge = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_INFLATED_BYTES) {
          tooLarge = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
      }
      if (tooLarge) limits.push({ reason: "inflated_too_large" });
      const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    } catch {
      /* 次の形を試す */
    }
  }
  limits.push({ reason: "inflate_failed" });
  return null;
}

/** PostScript の (…) の中の字。\( などの逃がしを戻す */
function psString(s: string): string {
  return s.replace(/\\([()\\])/g, "$1");
}

/** 編集用データの字から、%%For の名前と %%DocumentFiles のパスを拾う */
export function illustratorFields(text: string): { forNames: string[]; files: string[] } {
  const forNames: string[] = [];
  for (const m of text.matchAll(/%%For:\s*\(((?:\\.|[^\\)])*)\)/g)) forNames.push(psString(m[1] ?? "").trim());
  const files: string[] = [];
  for (const m of text.matchAll(/%%DocumentFiles:([^\r\n]*)((?:\r?\n%%\+[^\r\n]*)*)/g)) {
    const lines = [m[1] ?? "", ...(m[2] ?? "").split(/\r?\n%%\+/).slice(1)];
    for (const l of lines) {
      const t = l.trim();
      const paren = t.match(/^\((.*)\)$/);
      if (t) files.push(paren ? psString(paren[1]!) : t);
    }
  }
  return { forNames: forNames.filter(Boolean), files: files.filter(Boolean) };
}

// ---------------------------------------------------------------- 本体

function streamBytes(s: PDFStream, limits: P2PartsReport["limits"]): Uint8Array | null {
  try {
    const raw = s instanceof PDFRawStream ? s.contents : s.getContents();
    if (raw.length > MAX_STREAM_BYTES) {
      limits.push({ reason: "stream_too_large" });
      return null;
    }
    const out = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : raw;
    if (out.length > MAX_STREAM_BYTES) {
      limits.push({ reason: "stream_too_large" });
      return null;
    }
    return out;
  } catch {
    limits.push({ reason: "unreadable_stream" });
    return null;
  }
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

function ownerOf(dict: PDFDict): PartOwner {
  const type = dict.lookup(PDFName.of("Type"));
  const sub = dict.lookup(PDFName.of("Subtype"));
  const t = type instanceof PDFName ? type.decodeText() : "";
  const s = sub instanceof PDFName ? sub.decodeText() : "";
  if (s === "Image") return "image";
  if (s === "Form") return "form";
  if (t === "Page") return "page";
  if (t === "OCG" || t === "OCMD" || t === "Properties") return "properties";
  return "other";
}

export async function detectP2Parts(bytes: Uint8Array, options: DetectOptions = {}): Promise<P2PartsReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, xmpParts: 0, findings: [], notCounted: [], limits: [] };
  if (bytes.length === 0) return { ...base, status: "error", pages: null, error: { code: "empty", message: "ファイルが空です。" } };
  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") {
    if (loaded.code === "encrypted") {
      const message = loaded.reason === "password_required" ? "パスワードが要る PDF は、調べられません。" : "この形の暗号化は、いまは調べられません。";
      return { ...base, status: "error", pages: null, error: { code: "encrypted", message } };
    }
    return { ...base, status: "error", pages: null, error: { code: "unreadable", message: "PDF として読めませんでした。" } };
  }
  const doc = loaded.doc;
  const ctx: PDFContext = doc.context;
  const report: P2PartsReport = { ...base, status: "ok", pages: null, findings: [], notCounted: [], limits: [] };
  if (loaded.decrypted) report.decrypted = loaded.decrypted;
  try {
    report.pages = doc.getPageCount();
  } catch {
    report.pages = null;
  }

  // 文書全体の XMP（カタログの /Metadata）は、このルールでは見ない
  const catalogMeta = ctx.trailerInfo.Root ? (ctx.lookup(ctx.trailerInfo.Root) as PDFDict | undefined)?.get(PDFName.of("Metadata")) : undefined;
  const skipRef = catalogMeta instanceof PDFRef ? catalogMeta : null;

  // 部品の XMP と、その持ち主。編集用データ（/PieceInfo）を持つ辞書
  const xmpOwners = new Map<PDFRef, PartOwner>();
  const pieceInfos: PDFDict[] = [];
  const metadataStreams: PDFRef[] = [];
  let count = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (++count > MAX_OBJECTS) {
      report.limits.push({ reason: "too_many_objects" });
      break;
    }
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    const type = dict.lookup(PDFName.of("Type"));
    if (obj instanceof PDFStream && type instanceof PDFName && type.decodeText() === "Metadata") metadataStreams.push(ref);
    if (type instanceof PDFName && type.decodeText() === "Catalog") continue;
    const meta = dict.get(PDFName.of("Metadata"));
    if (meta instanceof PDFRef && meta !== skipRef && !xmpOwners.has(meta)) xmpOwners.set(meta, ownerOf(dict));
    const pi = dict.lookup(PDFName.of("PieceInfo"));
    if (pi instanceof PDFDict) pieceInfos.push(pi);
  }
  for (const ref of metadataStreams) if (ref !== skipRef && !xmpOwners.has(ref)) xmpOwners.set(ref, "unreferenced");

  type Group = { f: P2PartsFinding; value: string };
  const groups = new Map<string, Group>();
  const skipped = new Map<string, { field: string; reason: "generic" | "account" | "software" | "no_user_folder"; count: number }>();
  const add = (pattern: P2PartsFinding["pattern"], kind: P2PartsFinding["kind"], source: P2PartsFinding["source"], field: string, owner: PartOwner, value: string, chars: number, extra: Partial<P2PartsFinding> = {}) => {
    const key = [pattern, kind, field, value].join("\u0000");
    const g = groups.get(key);
    if (g) g.f.parts++;
    else groups.set(key, { f: { pattern, kind, source, field, owner, parts: 1, chars, ...extra }, value });
  };
  const skip = (field: string, reason: "generic" | "account" | "software" | "no_user_folder") => {
    const key = `${field}\u0000${reason}`;
    const s = skipped.get(key) ?? { field, reason, count: 0 };
    s.count++;
    skipped.set(key, s);
  };

  // ---- 部品の XMP
  for (const [ref, owner] of xmpOwners) {
    const s = ctx.lookup(ref);
    if (!(s instanceof PDFStream)) continue;
    const b = streamBytes(s, report.limits);
    if (!b) continue;
    report.xmpParts++;
    const xml = decodeText(b);
    for (const field of PERSON_FIELDS) {
      for (const v of new Set(xmpValues(xml, field))) {
        const c = classifyName(v);
        if (c.counted) add("P2", "person", "xmp", field, owner, v, c.chars);
        else skip(field, c.reason);
      }
    }
    for (const field of PATH_FIELDS) {
      for (const v of new Set(xmpValues(xml, field))) {
        const c = classifyPath(v);
        if (c.counted) add("P4", "path", "xmp", field, owner, v, c.chars);
        else skip(field, c.reason);
      }
    }
    const gps = GPS_FIELDS.map((f) => xmpValues(xml, f)[0] ?? "").filter(Boolean);
    if (gps.length) add("P10", "gps", "xmp", "exif:GPSLatitude/exif:GPSLongitude", owner, gps.join(" "), 0);
  }

  // ---- Illustrator の編集用データ
  for (const pi of pieceInfos) {
    const ai = pi.lookup(PDFName.of("Illustrator"));
    if (!(ai instanceof PDFDict)) continue;
    const priv = ai.lookup(PDFName.of("Private"));
    if (!(priv instanceof PDFDict)) continue;
    const texts: string[] = [];
    // 編集用データのはじめの部分（AIMetaData）は、圧縮されていない字のことが多い
    const metaS = priv.lookup(PDFName.of("AIMetaData"));
    if (metaS instanceof PDFStream) {
      const b = streamBytes(metaS, report.limits);
      if (b) texts.push(new TextDecoder("latin1").decode(b));
    }
    const blocks = priv
      .keys()
      .map((k) => k.decodeText())
      .map((k) => ({ k, n: Number(k.match(/^AI(?:PDF)?PrivateData(\d+)$/)?.[1] ?? NaN) }))
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => a.n - b.n);
    if (!blocks.length && !texts.length) continue;
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const { k } of blocks) {
      const s = priv.lookup(PDFName.of(k));
      if (!(s instanceof PDFStream)) continue;
      const b = streamBytes(s, report.limits);
      if (!b) continue;
      total += b.length;
      if (total > MAX_STREAM_BYTES * 4) {
        report.limits.push({ reason: "stream_too_large" });
        break;
      }
      parts.push(b);
    }
    const data = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of parts) {
      data.set(p, at);
      at += p.length;
    }
    const head = new TextDecoder("latin1").decode(data.subarray(0, 64));
    let checked = true;
    if (head.startsWith(AI_ZSTD)) {
      checked = false; // zstd は展開しない（ライブラリを足さないため。2026-11-04 人の決定）
    } else if (head.startsWith(AI_ZLIB)) {
      const inflated = await inflate(data.subarray(AI_ZLIB.length), report.limits);
      if (inflated) texts.push(new TextDecoder("latin1").decode(inflated));
      else checked = false;
    } else if (data.length) {
      texts.push(new TextDecoder("latin1").decode(data));
    }
    add("P2", "private_data", "illustrator", "PieceInfo/Illustrator/Private", "page", checked ? "checked" : "unchecked", 0, { checked });
    for (const t of texts) {
      const { forNames, files } = illustratorFields(t);
      for (const v of new Set(forNames)) {
        const c = classifyName(v);
        if (c.counted) add("P2", "person", "illustrator", "%%For", "page", v, c.chars);
        else skip("%%For", c.reason);
      }
      for (const v of new Set(files)) {
        const c = classifyPath(v);
        if (c.counted) add("P4", "path", "illustrator", "%%DocumentFiles", "page", v, c.chars);
        else skip("%%DocumentFiles", c.reason);
      }
    }
  }

  for (const g of groups.values()) {
    if (options.includeValues && g.f.kind !== "private_data") g.f.value = g.value;
    report.findings.push(g.f);
  }
  const order = { P2: 0, P4: 1, P10: 2 } as const;
  report.findings.sort((a, b) => order[a.pattern] - order[b.pattern] || a.field.localeCompare(b.field));
  report.notCounted = [...skipped.values()];
  return report;
}

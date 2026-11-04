// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P5（旧版の残存）。
// いまの版では使っていないのに、ファイルの中に残っているオブジェクトの定義を見つける（rubric/p5.md §2）。1件 ＝ 定義1つ。
//
// 読み方：pdf-lib の PDFParser を、このルールの中だけで少し手を入れて使う。
// pdf-lib は同じ番号の定義をいちばん新しいものだけ残すので、そのままでは前の版が見えない。
// そこで、読み手（PDFParser）のインスタンスに差し込みを入れ、定義を1つ読むたびに、その位置とオブジェクトを書き留める。
// xref の表・xref ストリームの項目と trailer も書き留め、/Prev の鎖から「いまの版の表」を作って、定義ごとに場所を決める。
// 差し込みはインスタンスだけに入れ、pdf-lib のクラスそのものは変えない（同時に動くほかの読み込みに影響しない）。

import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectParser,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFXRefStreamParser,
  decodePDFRawStream,
} from "pdf-lib";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { unusedForms } from "./unused-forms.ts";
import { decryptDefinitions, expandObjectStream, hasEncryptMarker, isMaskedObjStm, maskObjectStreams, unmaskObjectStream } from "./decrypt.ts";

export const RULE_ID = "p5-revisions";
export const RULE_VERSION = "1.3.0";

export type P5Where = "superseded" | "free" | "unreferenced" | "orphan";
/** unused_form（1.3.0 から）＝いまの版のページの資源にあるが、どこからも描かれない部品（Form XObject）で、字を描く命令を持つもの */
export type P5Kind = "info" | "content" | "annotation" | "form_value" | "metadata" | "image" | "embedded_file" | "dict_text" | "unused_form";
/** 字の中身を持たない構造の部品の種類（1.2.0）。font＝フォントの辞書・FontDescriptor、font_file＝フォントの本体（FontFile など）、
 *  cmap＝文字の対応表（CMap・ToUnicode）、color_profile＝色の設定（ICC）、other＝ページ・ページの木などそのほかの骨組み */
export type P5Part = "font" | "font_file" | "cmap" | "color_profile" | "other";
export type P5NotCountedReason =
  | "structure"
  | "unreadable_stream"
  | "info_without_counted_keys"
  | "annotation_without_text"
  | "form_without_value"
  | "filespec"
  | "counted_by_p9";

/** 上限（固まらないため） */
export const LIMITS = { definitions: 200_000, xrefSections: 1_000, streamBytes: 32 * 1024 * 1024, depth: 64 } as const;

export type P5Finding = {
  pattern: "P5";
  object: number;
  gen: number;
  kind: P5Kind;
  where: P5Where;
  /** その定義のある版（1 ＝ いちばん古い版。%%EOF で数える）。orphan は null */
  revision: number | null;
  /** info・annotation・form_value・dict_text のとき：残っている字の数（目安）。値そのものは返さない */
  chars?: number;
};

export type P5Report = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: { code: "empty" | "unreadable" | "encrypted"; message: string };
  /** 版の数（/Prev の鎖でたどれた xref の区切りの数） */
  revisions: number;
  findings: P5Finding[];
  notCounted: Array<{ object: number; kind: string; where: P5Where; reason: P5NotCountedReason }>;
  /** ほかの型との対応（参考）。previousInfo＝前の版の文書情報（数える欄のあるもの）、removedAttachment＝ free の添付の中身 */
  summary: { previousInfo: number; removedAttachment: number };
  /** /Prev の鎖をたどれず、ファイルの中の順で版を決めたとき true（線形化した PDF・壊れた xref など） */
  chainFallback: boolean;
  /** パスワードなしで開ける暗号化 PDF を、前の版も含めて復号して調べたときだけ（1.1.0 から） */
  decrypted?: EncryptionSummary & { failedObjects: number };
  /**
   * 片付けで消せる残り（1.2.0）。いまの版では使っていない、字の中身を持たない構造の部品（notCounted のうち reason が structure のもの）の数。
   * 漏れ（findings）には数えない。画面では「低」で出し、片付けへ案内する。
   */
  cleanupOnly: { count: number; parts: Record<P5Part, number> };
};

// ---------------------------------------------------------------- 読み取り（pdf-lib の読み手に差し込みを入れる）

type Def = { num: number; gen: number; start: number; objstm: number | null; obj: PDFObject };
type XEntry = { num: number; gen: number; offset: number; deleted: boolean; inObjStm: boolean };
type Section = { at: number; entries: XEntry[]; trailer: PDFDict | null };

const N = (s: string) => PDFName.of(s);
const K = {
  Root: N("Root"), Info: N("Info"), Encrypt: N("Encrypt"), Prev: N("Prev"), XRefStm: N("XRefStm"), Type: N("Type"),
  Subtype: N("Subtype"), Rect: N("Rect"), FT: N("FT"), T: N("T"), V: N("V"), Contents: N("Contents"), RC: N("RC"),
  Subj: N("Subj"), Annot: N("Annot"), Metadata: N("Metadata"), Image: N("Image"), EmbeddedFile: N("EmbeddedFile"),
  Filespec: N("Filespec"), Form: N("Form"), XRef: N("XRef"), ObjStm: N("ObjStm"), Off: N("Off"),
  Font: N("Font"), FontDescriptor: N("FontDescriptor"), CMap: N("CMap"), ICCBased: N("ICCBased"),
};
const INFO_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"];
const NOT_COUNTED_INFO = new Set(["Producer", "CreationDate", "ModDate", "Trapped"]);

class TooMany extends Error {}

type ParserInternals = {
  bytes: { offset(): number };
  context: PDFContext;
  skipWhitespaceAndComments(): void;
  matchKeyword(k: number[]): boolean;
  parseDict(): PDFDict;
  parseIndirectObject(): Promise<PDFRef>;
  parseIndirectObjectHeader(): PDFRef;
  maybeParseCrossRefSection(): unknown;
  maybeParseTrailerDict(): void;
  parseDocument(): Promise<PDFContext>;
};

const TRAILER_KW = [...new TextEncoder().encode("trailer")];

/** 1つのストリームを、間接オブジェクトとして読み直す（xref ストリームの項目を取るため）。読み捨ての文脈を使う */
function reparseStreamAt(bytes: Uint8Array, start: number): PDFRawStream | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(start, start + 64));
  const m = /^\s*\d+\s+\d+\s+obj/.exec(head);
  if (!m) return null;
  try {
    const o = PDFObjectParser.forBytes(bytes.subarray(start + m[0].length), PDFContext.create()).parseObject();
    return o instanceof PDFRawStream ? o : null;
  } catch {
    return null;
  }
}

async function collect(bytes: Uint8Array): Promise<{ defs: Def[]; sections: Section[] }> {
  const parser = PDFParser.forBytesWithOptions(bytes, Infinity, false, false) as unknown as ParserInternals;
  const ctx = parser.context;
  const defs: Def[] = [];
  const sections: Section[] = [];
  let current: { start: number; header: PDFRef | null; trailerSet: boolean } = { start: 0, header: null, trailerSet: false };

  // 定義を1つ読むたびに、その位置を書き留める
  const origAssign = ctx.assign.bind(ctx);
  ctx.assign = (ref: PDFRef, obj: PDFObject) => {
    if (defs.length >= LIMITS.definitions) throw new TooMany();
    const top = current.header !== null && current.header.objectNumber === ref.objectNumber && current.header.generationNumber === ref.generationNumber;
    defs.push({
      num: ref.objectNumber,
      gen: ref.generationNumber,
      start: current.start,
      objstm: top || current.header === null ? null : current.header.objectNumber,
      obj,
    });
    origAssign(ref, obj);
  };

  // trailer の値がいつ書かれたか（xref ストリームを読んだしるし）
  let trailerInfo = ctx.trailerInfo;
  Object.defineProperty(ctx, "trailerInfo", {
    get: () => trailerInfo,
    set: (v) => {
      trailerInfo = v;
      current.trailerSet = true;
    },
    configurable: true,
  });

  const origHeader = parser.parseIndirectObjectHeader.bind(parser);
  parser.parseIndirectObjectHeader = () => {
    const ref = origHeader();
    current.header = ref;
    return ref;
  };

  const origIndirect = parser.parseIndirectObject.bind(parser);
  parser.parseIndirectObject = async () => {
    current = { start: parser.bytes.offset(), header: null, trailerSet: false };
    const ref = await origIndirect();
    if (current.trailerSet) {
      // xref ストリームだった。項目を取るために読み直す
      const st = reparseStreamAt(bytes, current.start);
      if (st && st.dict.get(K.Type) === K.XRef) {
        try {
          const entries = PDFXRefStreamParser.forStream(st).parseIntoContext() as Array<{ ref: PDFRef; offset: number; deleted: boolean; inObjectStream: boolean }>;
          sections.push({
            at: current.start,
            trailer: st.dict,
            entries: entries.map((e) => ({ num: e.ref.objectNumber, gen: e.ref.generationNumber, offset: e.offset, deleted: e.deleted, inObjStm: e.inObjectStream })),
          });
        } catch {
          // 読めない xref ストリームは、版として数えない
        }
      }
    }
    current = { start: current.start, header: null, trailerSet: false };
    return ref;
  };

  const origXref = parser.maybeParseCrossRefSection.bind(parser);
  parser.maybeParseCrossRefSection = () => {
    parser.skipWhitespaceAndComments();
    const at = parser.bytes.offset();
    const xref = origXref() as { subsections?: Array<Array<{ ref: PDFRef; offset: number; deleted: boolean }>> } | undefined;
    if (xref && xref.subsections) {
      if (sections.length >= LIMITS.xrefSections) throw new TooMany();
      const entries: XEntry[] = [];
      for (const sub of xref.subsections) {
        for (const e of sub) entries.push({ num: e.ref.objectNumber, gen: e.ref.generationNumber, offset: e.offset, deleted: e.deleted, inObjStm: false });
      }
      sections.push({ at, entries, trailer: null });
    }
    return xref;
  };

  // pdf-lib の trailer の読み方は、新しい trailer にない鍵を古い値で埋める。ここでは trailer の辞書をそのまま残す
  parser.maybeParseTrailerDict = () => {
    parser.skipWhitespaceAndComments();
    if (!parser.matchKeyword(TRAILER_KW)) return;
    parser.skipWhitespaceAndComments();
    const dict = parser.parseDict();
    const last = sections[sections.length - 1];
    if (last && last.trailer === null) last.trailer = dict;
    trailerInfo = {
      Root: dict.get(K.Root) || trailerInfo.Root,
      Encrypt: dict.get(K.Encrypt) || trailerInfo.Encrypt,
      Info: dict.get(K.Info) || trailerInfo.Info,
      ID: dict.get(N("ID")) || trailerInfo.ID,
    };
  };

  await parser.parseDocument();
  return { defs, sections };
}

// ---------------------------------------------------------------- 版の鎖と、いまの版の表

function lastStartXref(bytes: Uint8Array): number | null {
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  const all = [...tail.matchAll(/startxref\s+(\d+)/g)];
  return all.length ? Number(all[all.length - 1]![1]) : null;
}

function num(o: PDFObject | undefined): number | null {
  return o instanceof PDFNumber ? o.asNumber() : null;
}

/** 新しい順の xref の区切り（いまの版の xref と、それに混ぜた /XRefStm を含む）。たどれなければ、ファイルの中の順を逆にしたもの */
function chain(bytes: Uint8Array, sections: Section[]): { ordered: Section[][]; fallback: boolean } {
  const byAt = new Map(sections.map((s) => [s.at, s]));
  const find = (off: number | null) => (off === null ? undefined : byAt.get(off));
  const ordered: Section[][] = [];
  const seen = new Set<Section>();
  let s = find(lastStartXref(bytes));
  while (s && !seen.has(s)) {
    seen.add(s);
    const group = [s];
    const stm = find(num(s.trailer?.get(K.XRefStm)));
    if (stm && !seen.has(stm)) {
      seen.add(stm);
      group.push(stm); // 混ぜた形：表の項目が先、xref ストリームの項目があと
    }
    ordered.push(group);
    s = find(num(s.trailer?.get(K.Prev)));
  }
  const fallback = ordered.length === 0 || seen.size < sections.length;
  if (ordered.length === 0) return { ordered: [...sections].reverse().map((x) => [x]), fallback: true };
  return { ordered, fallback };
}

// ---------------------------------------------------------------- 種類の見分け

const latin1 = new TextDecoder("latin1");

function textOf(o: PDFObject | undefined): string | null {
  if (o instanceof PDFString || o instanceof PDFHexString) {
    const b = o.asBytes();
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
    return o.decodeText();
  }
  if (o instanceof PDFStream) {
    // /RC などがストリームのとき
    try {
      return o instanceof PDFRawStream ? latin1.decode(decodePDFRawStream(o).decode()) : "";
    } catch {
      return "";
    }
  }
  return null;
}

const visible = (s: string | null) => (s ?? "").replace(/\u0000/g, "").trim();

/** 字を描く命令（Tj・TJ・'・"）があるか（目安。文字の並びで探す） */
export function hasTextOperators(content: string): boolean {
  return /(\)|>)\s*(Tj|'|")(?![A-Za-z0-9])|\]\s*TJ(?![A-Za-z0-9])/.test(content);
}

type Kinded =
  | { counted: true; kind: P5Kind; chars?: number }
  | { counted: false; kind: string; reason: P5NotCountedReason; part?: P5Part }
  | null;

const structure = (part: P5Part = "other"): Kinded => ({ counted: false, kind: "structure", reason: "structure", part });

/**
 * 構造の部品として指されている番号（1.2.0）。FontDescriptor の /FontFile・/FontFile2・/FontFile3・/CIDSet、
 * フォントの /ToUnicode・/Encoding・/CIDToGIDMap、色空間の [/ICCBased n 0 R]。どの版の定義から指されていてもよい。
 */
function partRoles(defs: Def[]): Map<number, P5Part> {
  const roles = new Map<number, P5Part>();
  const mark = (v: PDFObject | undefined, part: P5Part) => {
    if (v instanceof PDFRef && !roles.has(v.objectNumber)) roles.set(v.objectNumber, part);
  };
  const walk = (o: PDFObject | undefined, depth: number): void => {
    if (o === undefined || depth > LIMITS.depth) return;
    if (o instanceof PDFStream) return walk(o.dict, depth + 1);
    if (o instanceof PDFArray) {
      if (o.size() >= 2 && o.get(0) === K.ICCBased) mark(o.get(1), "color_profile");
      for (let i = 0; i < o.size(); i++) walk(o.get(i), depth + 1);
      return;
    }
    if (!(o instanceof PDFDict)) return;
    const type = o.get(K.Type);
    if (type === K.FontDescriptor) for (const k of ["FontFile", "FontFile2", "FontFile3", "CIDSet"]) mark(o.get(N(k)), "font_file");
    if (type === K.Font) {
      mark(o.get(N("ToUnicode")), "cmap");
      mark(o.get(N("Encoding")), "cmap");
      mark(o.get(N("CIDToGIDMap")), "font_file");
    }
    for (const [, v] of o.entries()) walk(v, depth + 1);
  };
  for (const d of defs) walk(d.obj, 0);
  return roles;
}

const startsWith = (b: Uint8Array, s: string, at = 0) => {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/** 中身の頭の印で、フォントの本体・色の設定（ICC）・文字の対応表（CMap）を見分ける（1.2.0） */
export function partBySignature(b: Uint8Array): P5Part | null {
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "font_file"; // TrueType
  if (startsWith(b, "true") || startsWith(b, "OTTO") || startsWith(b, "ttcf") || startsWith(b, "typ1")) return "font_file";
  if (startsWith(b, "%!PS-AdobeFont") || startsWith(b, "%!FontType1")) return "font_file"; // Type 1
  if (b.length >= 4 && b[0] === 0x01 && b[1] === 0x00 && b[2] === 0x04 && b[3]! >= 1 && b[3]! <= 4) return "font_file"; // CFF
  if (startsWith(b, "acsp", 36)) return "color_profile"; // ICC
  if (/\bbegincmap\b/.test(latin1.decode(b.subarray(0, 4096)))) return "cmap";
  return null;
}

/** 字を描く命令が BT〜ET の中にある（ページの中身らしい）か。フォントの本体などのバイト列が、たまたま Tj などに見えるのを除くため */
const TEXT_OBJECT = /(?:^|[\s\]>)])BT[\s/][\s\S]*?(?:\)|>|\])\s*(?:Tj|TJ|'|")(?![A-Za-z0-9])[\s\S]*?\sET(?![A-Za-z0-9])/;

const FONT_FILE_SUBTYPES = new Set(["Type1C", "CIDFontType0C", "OpenType"]);
/** dict_text で字の値を数えない辞書の /Type（構造の部品）。注釈・文書情報・欄・ファイル指定は、この前で見分けている */
const STRUCTURE_TYPES = new Set([
  "Catalog", "Pages", "Page", "Font", "FontDescriptor", "Encoding", "CMap", "ExtGState", "Pattern", "Shading", "XObject",
  "Group", "Mask", "Halftone", "OCMD", "ObjStm", "XRef", "Metadata",
]);
/** dict_text で数えない鍵（構造の値・日付など） */
const NOT_COUNTED_TEXT_KEYS = new Set(["Registry", "Ordering", "Lang", "ID", "Version", "M", ...NOT_COUNTED_INFO]);

/** 辞書の中の文字列の値の字数（間接参照はたどらない。入れ子の辞書・配列は中まで見る）。字そのものは返さない */
function stringChars(o: PDFObject, depth = 0): number {
  if (depth > LIMITS.depth) return 0;
  if (o instanceof PDFString || o instanceof PDFHexString) {
    const t = visible(textOf(o));
    return /^D:\d{4}/.test(t) ? 0 : [...t].length;
  }
  if (o instanceof PDFArray) {
    let n = 0;
    for (let i = 0; i < o.size(); i++) n += stringChars(o.get(i), depth + 1);
    return n;
  }
  if (o instanceof PDFDict) {
    if (o.get(N("Registry")) !== undefined && o.get(N("Ordering")) !== undefined) return 0; // CIDSystemInfo
    let n = 0;
    for (const [k, v] of o.entries()) if (!NOT_COUNTED_TEXT_KEYS.has(k.decodeText())) n += stringChars(v, depth + 1);
    return n;
  }
  return 0;
}

function classify(
  def: Def,
  where: P5Where,
  infoNums: Set<number>,
  roles: Map<number, P5Part>,
  resolve: (o: PDFObject | undefined) => PDFObject | undefined,
): Kinded {
  const o = def.obj;
  if (o instanceof PDFStream) {
    const d = o.dict;
    const type = d.get(K.Type);
    const subtype = d.get(K.Subtype);
    if (type === K.XRef || type === K.ObjStm) return null; // 場所の入れ物は数えない（not_counted にも出さない）
    if (type === K.EmbeddedFile) return { counted: true, kind: "embedded_file" };
    if (type === K.Metadata) return { counted: true, kind: "metadata" };
    if (subtype === K.Image) return { counted: true, kind: "image" };
    if (type === K.CMap) return structure("cmap");
    if (type === undefined || subtype === K.Form) {
      // フォントの本体の印（1.2.0）：/Length1〜3、/Subtype /Type1C など
      const fontKeys = ["Length1", "Length2", "Length3"].some((k) => d.get(N(k)) !== undefined);
      if (type === undefined && (fontKeys || (subtype instanceof PDFName && FONT_FILE_SUBTYPES.has(subtype.decodeText())))) return structure("font_file");
      if (!(o instanceof PDFRawStream)) return structure();
      if (o.contents.length > LIMITS.streamBytes) return { counted: false, kind: "content", reason: "unreadable_stream" };
      let raw: Uint8Array;
      try {
        raw = decodePDFRawStream(o).decode();
      } catch {
        return { counted: false, kind: "content", reason: "unreadable_stream" };
      }
      const text = latin1.decode(raw);
      if (subtype !== K.Form) {
        // 字の中身を持たない構造の部品（1.2.0）。頭の印で見分ける。印がなくても、フォントなどから部品として指されていて、
        // BT〜ET の中の字の命令がなければ部品とみなす
        const sig = partBySignature(raw);
        if (sig) return structure(sig);
        const role = roles.get(def.num);
        if (role && !TEXT_OBJECT.test(text)) return structure(role);
      }
      return hasTextOperators(text) ? { counted: true, kind: "content" } : structure();
    }
    return structure(roles.get(def.num) ?? "other");
  }
  if (!(o instanceof PDFDict)) return structure();
  const type = o.get(K.Type);
  if (type === K.Filespec) return { counted: false, kind: "filespec", reason: "filespec" };

  // フォームの欄（注釈を兼ねるものも、フォームの値として見る）
  if (o.get(K.FT) !== undefined || (o.get(K.T) !== undefined && o.get(K.V) !== undefined)) {
    const v = resolve(o.get(K.V));
    let value = "";
    if (v instanceof PDFName) value = v === K.Off ? "" : v.decodeText();
    else if (v instanceof PDFArray) value = v.size() > 0 ? "[array]" : "";
    else if (v instanceof PDFNumber || v instanceof PDFBool) value = v.toString();
    else value = visible(textOf(v));
    return value ? { counted: true, kind: "form_value", chars: [...value].length } : { counted: false, kind: "form_value", reason: "form_without_value" };
  }
  // 注釈
  if (type === K.Annot || (o.get(K.Subtype) instanceof PDFName && o.get(K.Rect) !== undefined)) {
    let chars = 0;
    for (const k of [K.Contents, K.T, K.RC, K.Subj]) chars += [...visible(textOf(resolve(o.get(k))))].length;
    return chars > 0 ? { counted: true, kind: "annotation", chars } : { counted: false, kind: "annotation", reason: "annotation_without_text" };
  }
  // 文書情報
  const looksInfo = type === undefined && o.keys().some((k) => INFO_KEYS.includes(k.decodeText()));
  if (infoNums.has(def.num) || looksInfo) {
    let chars = 0;
    for (const [k, v] of o.entries()) {
      if (NOT_COUNTED_INFO.has(k.decodeText())) continue;
      const r = resolve(v);
      const t = r instanceof PDFName ? r.decodeText() : r instanceof PDFNumber || r instanceof PDFBool ? r.toString() : visible(textOf(r));
      chars += [...t].length;
    }
    return chars > 0 ? { counted: true, kind: "info", chars } : { counted: false, kind: "info", reason: "info_without_counted_keys" };
  }
  const part: P5Part = type === K.Font || type === K.FontDescriptor ? "font" : type === K.CMap ? "cmap" : "other";
  // オブジェクトストリームの中の、どこからも指されていない辞書で、字の値を持つもの（1.2.0）。構造の部品は数えない
  const typeName = type instanceof PDFName ? type.decodeText() : null;
  const isolated = where === "unreferenced" || where === "orphan";
  if (def.objstm !== null && isolated && part === "other" && (typeName === null || !STRUCTURE_TYPES.has(typeName))) {
    const chars = stringChars(o);
    if (chars > 0) return { counted: true, kind: "dict_text", chars };
  }
  return structure(part);
}

// ---------------------------------------------------------------- 暗号化（1.1.0）

/**
 * 暗号化された版の定義を解き、オブジェクトストリームを開いて中の定義を defs に足す。
 * 版ごとに、その版を閉じる xref の trailer に /Encrypt があるかを見る。ない版（暗号化する前の版）の定義は解かない。
 * どの xref よりあとにある定義（orphan になりうるもの）は、いまの版に合わせる。
 * 暗号化の辞書と /ID は、/Encrypt を持ついちばん新しい trailer のものを使う。
 * 暗号化の印はあったが、どの trailer にも /Encrypt がなければ null（解かない）。
 */
async function decryptRevisions(defs: Def[], sections: Section[], newest: PDFDict | null) {
  const byAt = [...sections].sort((a, b) => a.at - b.at);
  const closing = (d: Def): PDFDict | null => byAt.find((s) => s.at > d.start)?.trailer ?? newest;
  const withEncrypt = [newest, ...[...byAt].reverse().map((s) => s.trailer)].find((t) => t?.get(K.Encrypt) !== undefined) ?? null;
  let result: Awaited<ReturnType<typeof decryptDefinitions>> | null = null;

  if (withEncrypt) {
    const entry = withEncrypt.get(K.Encrypt)!;
    let dict: PDFDict | null = entry instanceof PDFDict ? entry : null;
    if (entry instanceof PDFRef) {
      for (const d of defs) if (d.num === entry.objectNumber && d.obj instanceof PDFDict) dict = d.obj; // いちばんあとの定義
    }
    if (!dict) return { ok: false as const, reason: "broken" as const };
    const targets = defs.filter((d) => d.objstm === null && closing(d)?.get(K.Encrypt) !== undefined);
    result = await decryptDefinitions(targets, { entry, dict }, withEncrypt.get(N("ID")));
    if (!result.ok) return result;
  }

  // オブジェクトストリームを開く（解いた版のものは decryptContext が /Type を戻している。解かなかった版のものはここで戻す）
  const containers = defs.filter((d) => d.objstm === null && d.obj instanceof PDFRawStream);
  for (const c of containers) {
    if (isMaskedObjStm(c.obj)) unmaskObjectStream(c.obj);
    if ((c.obj as PDFRawStream).dict.get(K.Type) !== K.ObjStm) continue;
    for (const inner of expandObjectStream(c.obj as PDFRawStream, LIMITS.definitions)) {
      if (defs.length >= LIMITS.definitions) break;
      defs.push({ num: inner.num, gen: inner.gen, start: c.start, objstm: c.num, obj: inner.obj });
    }
  }
  return result;
}

// ---------------------------------------------------------------- 本体

const emptyParts = (): Record<P5Part, number> => ({ font: 0, font_file: 0, cmap: 0, color_profile: 0, other: 0 });

function revisionEnds(bytes: Uint8Array): number[] {
  const text = latin1.decode(bytes);
  const ends: number[] = [];
  for (const m of text.matchAll(/%%EOF/g)) ends.push(m.index! + 5);
  return ends;
}

export async function detectP5Revisions(bytes: Uint8Array): Promise<P5Report> {
  const base: P5Report = {
    rule: { id: RULE_ID, version: RULE_VERSION },
    status: "ok",
    revisions: 0,
    findings: [],
    notCounted: [],
    summary: { previousInfo: 0, removedAttachment: 0 },
    chainFallback: false,
    cleanupOnly: { count: 0, parts: emptyParts() },
  };
  if (bytes.length === 0) return { ...base, status: "error", error: { code: "empty", message: "ファイルが空です。" } };

  // 暗号化の印があれば、オブジェクトストリームの名前を置き換えた写しを読む（解いてから開くため。decrypt.ts）
  const encryptedFile = hasEncryptMarker(bytes);
  let defs: Def[];
  let sections: Section[];
  try {
    ({ defs, sections } = await collect(encryptedFile ? maskObjectStreams(bytes) : bytes));
  } catch (e) {
    const message = e instanceof TooMany ? "オブジェクトか版が多すぎるため、調べるのをやめました。" : "PDF として読めませんでした。";
    return { ...base, status: "error", error: { code: "unreadable", message } };
  }
  if (sections.length === 0 && defs.length === 0) {
    return { ...base, status: "error", error: { code: "unreadable", message: "PDF として読めませんでした。" } };
  }

  const { ordered, fallback } = chain(bytes, sections);
  const newest = ordered[0]?.[0]?.trailer ?? null;
  let decrypted: P5Report["decrypted"];
  if (encryptedFile) {
    const r = await decryptRevisions(defs, sections, newest);
    if (r && !r.ok) {
      const message =
        r.reason === "password_required" ? "パスワードが要る PDF は、調べられません。" : "この形の暗号化は、いまは調べられません。";
      return { ...base, status: "error", error: { code: "encrypted", message } };
    }
    if (r) decrypted = { ...r.summary, failedObjects: r.failedObjects };
  }

  // いまの版の表：新しい区切りから見て、最初に出てくる項目
  const currentEntry = new Map<number, XEntry>();
  // どれかの版の xref が指している定義の場所（番号 → 位置、またはオブジェクトストリームの番号）
  const pointedOffsets = new Set<string>();
  for (const group of ordered) {
    // 混ぜた形（表＋/XRefStm。Word などの「ハイブリッド xref」）では、表で「使っていない（f）」とした番号を、
    // xref ストリームの側が「使っている」と示す（PDF 1.7 §7.5.8.4）。同じ版の中では、使っている項目を先に採る（1.2.1 から）
    const inGroup = new Map<number, XEntry>();
    for (const sec of group) {
      for (const e of sec.entries) {
        if (e.num === 0) continue;
        const prev = inGroup.get(e.num);
        if (!prev || (prev.deleted && !e.deleted)) inGroup.set(e.num, e);
        if (!e.deleted) pointedOffsets.add(e.inObjStm ? `${e.num}@stm${e.offset}` : `${e.num}@${e.offset}`);
      }
    }
    for (const [n, e] of inGroup) if (!currentEntry.has(n)) currentEntry.set(n, e);
  }
  const defKey = (d: Def) => (d.objstm !== null ? `${d.num}@stm${d.objstm}` : `${d.num}@${d.start}`);
  const isCurrentDef = (d: Def) => {
    const e = currentEntry.get(d.num);
    if (!e || e.deleted) return false;
    return e.inObjStm ? d.objstm === e.offset : d.objstm === null && d.start === e.offset;
  };

  // いまの版のオブジェクト（番号 → 定義）。根からたどる
  const live = new Map<number, Def>();
  for (const d of defs) if (isCurrentDef(d)) live.set(d.num, d);
  const resolve = (o: PDFObject | undefined): PDFObject | undefined => (o instanceof PDFRef ? live.get(o.objectNumber)?.obj : o);

  const reachable = new Set<number>();
  const stack: PDFObject[] = [];
  for (const k of [K.Root, K.Info, K.Encrypt]) {
    const v = newest?.get(k);
    if (v) stack.push(v);
  }
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (reachable.has(o.objectNumber)) continue;
      reachable.add(o.objectNumber);
      const d = live.get(o.objectNumber);
      if (d) stack.push(d.obj);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }

  // どれかの版の trailer が /Info として指した番号
  const infoNums = new Set<number>();
  for (const sec of sections) {
    const i = sec.trailer?.get(K.Info);
    if (i instanceof PDFRef) infoNums.add(i.objectNumber);
  }

  const ends = revisionEnds(bytes);
  const revisionOf = (d: Def): number => {
    const i = ends.findIndex((e) => d.start < e);
    return i < 0 ? ends.length + 1 : i + 1;
  };

  const roles = partRoles(defs);
  const report: P5Report = {
    ...base,
    revisions: ordered.length,
    chainFallback: fallback,
    findings: [],
    notCounted: [],
    summary: { previousInfo: 0, removedAttachment: 0 },
    cleanupOnly: { count: 0, parts: emptyParts() },
  };
  if (decrypted) report.decrypted = decrypted;
  for (const d of defs) {
    if (d.num === 0) continue;
    let where: P5Where;
    if (!pointedOffsets.has(defKey(d))) where = "orphan";
    else if (currentEntry.get(d.num)?.deleted) where = "free";
    else if (isCurrentDef(d)) {
      if (reachable.has(d.num)) continue; // いまの版で使っている
      where = "unreferenced";
    } else where = "superseded";

    const k = classify(d, where, infoNums, roles, resolve);
    if (k === null) continue;
    if (k.counted) {
      if (k.kind === "embedded_file" && where === "unreferenced") {
        report.notCounted.push({ object: d.num, kind: k.kind, where, reason: "counted_by_p9" });
        continue;
      }
      const f: P5Finding = { pattern: "P5", object: d.num, gen: d.gen, kind: k.kind, where, revision: where === "orphan" ? null : revisionOf(d) };
      if (k.chars !== undefined) f.chars = k.chars;
      report.findings.push(f);
      if (k.kind === "info") report.summary.previousInfo++;
      if (k.kind === "embedded_file" && where === "free") report.summary.removedAttachment++;
    } else {
      report.notCounted.push({ object: d.num, kind: k.kind, where, reason: k.reason });
      if (k.reason === "structure") {
        report.cleanupOnly.count++;
        report.cleanupOnly.parts[k.part ?? "other"]++;
      }
    }
  }
  // 資源にあるが描かれない部品（1.3.0 から。unused-forms.ts）。いまの版のページからたどる
  const pages: PDFDict[] = [];
  for (const n of reachable) {
    const o = live.get(n)?.obj;
    if (o instanceof PDFDict && o.get(K.Type) === N("Page")) pages.push(o);
  }
  for (const num of [...unusedForms(pages, resolve)].sort((a, b) => a - b)) {
    const d = live.get(num);
    if (!d || !(d.obj instanceof PDFRawStream) || d.obj.contents.length > LIMITS.streamBytes) continue;
    let text: string;
    try {
      text = latin1.decode(decodePDFRawStream(d.obj).decode());
    } catch {
      continue;
    }
    if (!hasTextOperators(text)) continue;
    report.findings.push({ pattern: "P5", object: d.num, gen: d.gen, kind: "unused_form", where: "unreferenced", revision: revisionOf(d) });
  }
  return report;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// プロパティを書き直す（整える。0.9.0 から）。
// - 題・作成者・サブタイトル・キーワード・作成したアプリ・PDF を作ったアプリ・作成日・更新日を、項目ごとに「そのまま／書き直す／消す」。
// - 文書情報（Info）と XMP の両方に、同じ値から書く（片方にだけ古い値が残らない）。
//   XMP は元のものを直さず、選んだ項目だけで作り直す（編集の履歴 xmpMM:History・文書の番号 DocumentID・ほかのアプリの独自の項目は残らない）。
// - 書き出したあと、書き直した・消した欄の古い値が残っていないかを、バイト列から読み直して確かめる（checkOldValues）。
// - 整える前に知らせること（PDF/A の印・電子署名）を preflightTidy で返す。外す・残すは options で受ける。
//
// 値の中身は、結果（報告）に入れない。preflightTidy の今の値だけは、画面の「そのまま」の欄に見せるために返す（Worker の中だけで使う）。

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFString, type PDFContext, type PDFDocument, type PDFObject } from "pdf-lib";
import { decodeTextBytes } from "../rules/p1-info/index.ts";
import { catalogXmp } from "../rules/p2-xmp/index.ts";
import { xmpFields } from "../rules/props/index.ts";
import { loadPdf } from "../rules/shared/load.ts";
import { dictOf, nameOf, hasValue } from "./structure.ts";
import type { NotDoneItem, PropertyChange, PropertyEdit, PropertyKey, RemovedItem, TidyPreflight } from "./types.ts";

const N = (s: string) => PDFName.of(s);

/** 項目と、文書情報・XMP の欄の組み（rules/props の PAIRS と同じ組み。日付を足した） */
export const FIELDS: ReadonlyArray<{ key: PropertyKey; info: string; xmp: string; date: boolean; label: string }> = [
  { key: "title", info: "Title", xmp: "dc:title", date: false, label: "題" },
  { key: "author", info: "Author", xmp: "dc:creator", date: false, label: "作成者" },
  { key: "subject", info: "Subject", xmp: "dc:description", date: false, label: "サブタイトル" },
  { key: "keywords", info: "Keywords", xmp: "pdf:Keywords", date: false, label: "キーワード" },
  { key: "creator", info: "Creator", xmp: "xmp:CreatorTool", date: false, label: "作成したアプリ" },
  { key: "producer", info: "Producer", xmp: "pdf:Producer", date: false, label: "PDF を作ったアプリ" },
  { key: "created", info: "CreationDate", xmp: "xmp:CreateDate", date: true, label: "作成日" },
  { key: "modified", info: "ModDate", xmp: "xmp:ModifyDate", date: true, label: "更新日" },
];
const KEYS = new Set<string>(FIELDS.map((f) => f.key));

/** 書き直す値の長さの上限（字） */
export const MAX_PROPERTY_CHARS = 1000;
/** preflightTidy で返す今の値の長さの上限（字） */
const MAX_PREVIEW_CHARS = 500;
/** 古い値として探す字の数の下限（短すぎる値は、ほかの所にたまたま同じ並びがある） */
const MIN_SEARCH_CHARS = 2;
/** 古い値を探すために解く XMP・オブジェクトストリームの大きさの上限（バイト） */
const MAX_INFLATE_BYTES = 64 << 20;

// ---------------------------------------------------------------- 日付

/** 日付の部品。tz は UTC からの差（分）。null は時差なし */
type PdfDate = { y: number; mo: number; d: number; h: number; mi: number; s: number; tz: number | null };

const pad = (n: number, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, "0");

function validDate(t: PdfDate): boolean {
  return t.y >= 1 && t.y <= 9999 && t.mo >= 1 && t.mo <= 12 && t.d >= 1 && t.d <= 31 && t.h <= 23 && t.mi <= 59 && t.s <= 59 && (t.tz === null || Math.abs(t.tz) <= 14 * 60);
}

/** 文書情報の日付（D:YYYYMMDDHHmmSS+HH'mm'）を読む。読めなければ null */
export function parsePdfDate(s: string): PdfDate | null {
  const m = /^\s*(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?\s*$/.exec(s);
  if (!m) return null;
  const t: PdfDate = {
    y: +m[1]!, mo: m[2] ? +m[2] : 1, d: m[3] ? +m[3] : 1, h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0,
    tz: m[7] ? 0 : m[8] ? (m[8] === "-" ? -1 : 1) * (+m[9]! * 60 + (m[10] ? +m[10] : 0)) : null,
  };
  return validDate(t) ? t : null;
}

/** XMP・画面の日付（2026-11-05、2026-11-05T10:30、2026-11-05T10:30:00+09:00、…Z）を読む。読めなければ null */
export function parseIsoDate(s: string): PdfDate | null {
  const m = /^\s*(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?)?)?)?\s*$/.exec(s);
  if (!m) return null;
  const t: PdfDate = {
    y: +m[1]!, mo: m[2] ? +m[2] : 1, d: m[3] ? +m[3] : 1, h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0,
    tz: m[7] ? 0 : m[8] ? (m[8] === "-" ? -1 : 1) * (+m[9]! * 60 + +m[10]!) : null,
  };
  return validDate(t) ? t : null;
}

function fromJsDate(d: Date): PdfDate | null {
  if (Number.isNaN(d.getTime())) return null;
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), tz: -d.getTimezoneOffset() };
}

/** 時差のない字は、その環境の時差を付ける（文書情報と XMP で同じ時刻になるように） */
function withLocalTz(t: PdfDate): PdfDate {
  if (t.tz !== null) return t;
  const local = new Date(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
  return { ...t, tz: -local.getTimezoneOffset() };
}

export function formatPdfDate(t: PdfDate): string {
  const base = `D:${pad(t.y, 4)}${pad(t.mo)}${pad(t.d)}${pad(t.h)}${pad(t.mi)}${pad(t.s)}`;
  if (t.tz === null) return base;
  if (t.tz === 0) return base + "Z";
  return `${base}${t.tz < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(t.tz) / 60))}'${pad(Math.abs(t.tz) % 60)}'`;
}

export function formatIsoDate(t: PdfDate): string {
  const base = `${pad(t.y, 4)}-${pad(t.mo)}-${pad(t.d)}T${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}`;
  if (t.tz === null) return base;
  if (t.tz === 0) return base + "Z";
  return `${base}${t.tz < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(t.tz) / 60))}:${pad(Math.abs(t.tz) % 60)}`;
}

// ---------------------------------------------------------------- 元の値を読む

type Original = {
  /** 項目ごとの元の値（文書情報・XMP） */
  values: Map<PropertyKey, { info: string | null; xmp: string | null }>;
  /** 文書情報のすべての欄の値と、元の XMP のすべての欄の値（古い値として探すもの） */
  oldValues: string[];
  pdfa: { part: string; conformance: string | null; rev: string | null } | null;
};

/** 制御文字を外し、前後の空白を切る */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[\r\n\t]+/g, " ").trim();
}

function infoText(ctx: PDFContext, o: PDFObject | undefined): string | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFString || v instanceof PDFHexString) return clean(decodeTextBytes(v.asBytes()).text) || null;
  if (v instanceof PDFName) return clean(v.decodeText()) || null;
  return null;
}

function pdfaOf(xml: string): Original["pdfa"] {
  const read = (name: string): string | null => {
    const attr = new RegExp(`pdfaid:${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(xml);
    if (attr) return (attr[1] ?? attr[2] ?? "").trim() || null;
    const el = new RegExp(`<pdfaid:${name}\\b[^>]*>([^<]*)</pdfaid:${name}>`).exec(xml);
    return el ? el[1]!.trim() || null : null;
  };
  const part = read("part");
  if (!part || !/^\d{1,2}$/.test(part)) return null;
  const conformance = read("conformance");
  const rev = read("rev");
  return { part, conformance: conformance && /^[A-Za-z]{1,2}$/.test(conformance) ? conformance : null, rev: rev && /^\d{4}$/.test(rev) ? rev : null };
}

export function readOriginal(ctx: PDFContext): Original {
  const values = new Map<PropertyKey, { info: string | null; xmp: string | null }>();
  const oldValues: string[] = [];
  const info = dictOf(ctx, ctx.trailerInfo.Info);
  const infoMap = new Map<string, string>();
  if (info) {
    for (const [k, raw] of info.entries()) {
      const t = infoText(ctx, raw);
      if (t) {
        infoMap.set(k.decodeText(), t);
        oldValues.push(t);
      }
    }
  }
  const x = catalogXmp(ctx);
  const xmpMap = new Map<string, string[]>();
  let pdfa: Original["pdfa"] = null;
  if (x && typeof x !== "string") {
    for (const f of xmpFields(x.xml)) {
      const v = clean(f.value);
      if (!v) continue;
      oldValues.push(v);
      const list = xmpMap.get(f.name) ?? [];
      list.push(v);
      xmpMap.set(f.name, list);
    }
    pdfa = pdfaOf(x.xml);
  }
  for (const f of FIELDS) {
    const xs = xmpMap.get(f.xmp);
    values.set(f.key, { info: infoMap.get(f.info) ?? null, xmp: xs?.length ? xs.join("; ") : null });
  }
  return { values, oldValues, pdfa };
}

// ---------------------------------------------------------------- 電子署名

/** 署名の欄（/FT /Sig、親から受け継ぐものも）で、値（署名の辞書）のあるもの */
function signedFields(ctx: PDFContext, catalog: PDFDict): Array<{ field: PDFDict; widgets: PDFDict[] }> {
  const out: Array<{ field: PDFDict; widgets: PDFDict[] }> = [];
  const form = dictOf(ctx, catalog.get(N("AcroForm")));
  const fields = form ? ctx.lookup(form.get(N("Fields"))) : undefined;
  if (!(fields instanceof PDFArray)) return out;
  const seen = new Set<PDFDict>();
  const visit = (o: PDFObject, inheritedFt: string | undefined, depth: number) => {
    const d = dictOf(ctx, o);
    if (!d || seen.has(d) || depth > 64) return;
    seen.add(d);
    const ft = nameOf(ctx, d.get(N("FT"))) ?? inheritedFt;
    const kids = ctx.lookup(d.get(N("Kids")));
    const kidDicts = kids instanceof PDFArray ? kids.asArray().map((k) => dictOf(ctx, k)).filter((k): k is PDFDict => !!k) : [];
    if (ft === "Sig" && dictOf(ctx, d.get(N("V")))) {
      // 欄そのものが見た目（Widget）を兼ねるか、子に見た目がある
      const widgets = [d, ...kidDicts.filter((k) => !k.has(N("T")))].filter((w) => nameOf(ctx, w.get(N("Subtype"))) === "Widget" || w.has(N("AP")));
      out.push({ field: d, widgets });
    }
    for (const k of kidDicts) if (k.has(N("T")) || k.has(N("Kids")) || k.has(N("FT"))) visit(k, ft, depth + 1);
  };
  for (const f of fields.asArray()) visit(f, undefined, 0);
  return out;
}

/** 電子署名を外す（署名の値・署名の見た目・文書の署名の決まり /Perms・検証用の情報 /DSS・/SigFlags） */
export function handleSignatures(doc: PDFDocument, mode: "remove" | "keep"): { removed: RemovedItem[]; notDone: NotDoneItem[] } {
  const ctx = doc.context;
  const signed = signedFields(ctx, doc.catalog);
  const hasPerms = doc.catalog.has(N("Perms"));
  if (signed.length === 0 && !hasPerms) return { removed: [], notDone: [] };
  const n = Math.max(signed.length, hasPerms ? 1 : 0);
  if (mode === "keep") {
    return {
      removed: [],
      notDone: [{ pattern: "P11", reason: "signature_kept", label: `電子署名（${n} 個）を残しました。整えると中身が変わるため、署名は無効になります` }],
    };
  }
  for (const { field, widgets } of signed) {
    field.delete(N("V"));
    field.delete(N("Lock"));
    field.delete(N("SV"));
    // 署名の見た目には、署名した人の名前・印影が描かれていることがある
    for (const w of widgets) w.delete(N("AP"));
  }
  doc.catalog.delete(N("Perms"));
  doc.catalog.delete(N("DSS"));
  const form = dictOf(ctx, doc.catalog.get(N("AcroForm")));
  form?.delete(N("SigFlags"));
  return {
    removed: [{ pattern: "P11", kind: "signature", count: n, label: `電子署名（${n} 個）を外しました。整えると署名は無効になるため、署名の情報と見た目を残しませんでした` }],
    notDone: [],
  };
}

// ---------------------------------------------------------------- 整える前に知らせること

const clip = (s: string | null): { v: string | null; cut: boolean } => {
  if (s === null) return { v: null, cut: false };
  const chars = [...s];
  return chars.length > MAX_PREVIEW_CHARS ? { v: chars.slice(0, MAX_PREVIEW_CHARS).join(""), cut: true } : { v: s, cut: false };
};

/** 整える前に、今のプロパティ・PDF/A の印・電子署名の数を返す（画面で「そのまま」の値を見せ、同意を取るため） */
export async function preflightTidy(bytes: Uint8Array, maxBytes: number): Promise<TidyPreflight> {
  if (bytes.length === 0) return { status: "error", code: "empty", message: "ファイルが空です。" };
  if (bytes.length > maxBytes) return { status: "error", code: "too_large", message: "ファイルが大きすぎるため、整えられません。" };
  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") {
    if (loaded.code === "encrypted") return { status: "error", code: "encrypted", message: "パスワードが要る PDF は、整えられません。" };
    return { status: "error", code: "unreadable", message: "PDF として読めませんでした。" };
  }
  const ctx = loaded.doc.context;
  const orig = readOriginal(ctx);
  const properties = FIELDS.map((f) => {
    const o = orig.values.get(f.key)!;
    const i = clip(o.info);
    const x = clip(o.xmp);
    return { key: f.key, info: i.v, xmp: x.v, truncated: i.cut || x.cut };
  });
  const signed = signedFields(ctx, loaded.doc.catalog).length;
  return {
    status: "ok",
    properties,
    pdfa: orig.pdfa ? { part: orig.pdfa.part, conformance: orig.pdfa.conformance } : null,
    signatures: Math.max(signed, loaded.doc.catalog.has(N("Perms")) ? 1 : 0),
    decrypted: loaded.decrypted !== null,
  };
}

// ---------------------------------------------------------------- 指定を確かめる

type Final = { key: PropertyKey; text: string | null; date: PdfDate | null; action: PropertyChange["action"] };

export type CheckedEdits = { ok: true; edits: Map<PropertyKey, PropertyEdit> } | { ok: false; message: string };

/** 指定の形を確かめる（細工された呼び出しでも止まらないように） */
export function checkEdits(input: unknown): CheckedEdits {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "プロパティの指定の形が正しくありません。" };
  const edits = new Map<PropertyKey, PropertyEdit>();
  for (const [k, e] of Object.entries(input as Record<string, unknown>)) {
    if (!KEYS.has(k)) return { ok: false, message: "知らないプロパティの項目が指定されています。" };
    const key = k as PropertyKey;
    const field = FIELDS.find((f) => f.key === key)!;
    if (e === undefined) continue;
    if (e === "keep" || e === "remove") {
      edits.set(key, e);
      continue;
    }
    if (e === null || typeof e !== "object" || !("set" in e)) return { ok: false, message: `「${field.label}」の指定の形が正しくありません。` };
    const v = (e as { set: unknown }).set;
    if (field.date) {
      if (v instanceof Date) {
        if (!fromJsDate(v)) return { ok: false, message: `「${field.label}」の日付が正しくありません。` };
      } else if (typeof v === "string") {
        if (clean(v) !== "" && !parseIsoDate(v)) return { ok: false, message: `「${field.label}」の日付が正しくありません（例：2026-11-05）。` };
      } else return { ok: false, message: `「${field.label}」の日付が正しくありません。` };
    } else {
      if (typeof v !== "string") return { ok: false, message: `「${field.label}」の値は字で指定してください。` };
      if ([...clean(v)].length > MAX_PROPERTY_CHARS) return { ok: false, message: `「${field.label}」が長すぎます（${MAX_PROPERTY_CHARS} 字まで）。` };
    }
    edits.set(key, { set: v as string | Date });
  }
  return { ok: true, edits };
}

function finalValues(orig: Original, edits: Map<PropertyKey, PropertyEdit>): Final[] {
  return FIELDS.map((f) => {
    const o = orig.values.get(f.key)!;
    const had = o.info !== null || o.xmp !== null;
    const e = edits.get(f.key) ?? "remove";
    if (e === "remove") return { key: f.key, text: null, date: null, action: had ? "removed" : "absent" };
    if (e === "keep") {
      if (!had) return { key: f.key, text: null, date: null, action: "absent" };
      if (f.date) {
        const d = (o.info !== null ? parsePdfDate(o.info) : null) ?? (o.xmp !== null ? parseIsoDate(o.xmp) : null);
        // 日付として読めない元の値は、そのままの字で両方に書く
        return d ? { key: f.key, text: null, date: d, action: "kept" } : { key: f.key, text: o.info ?? o.xmp, date: null, action: "kept" };
      }
      return { key: f.key, text: o.info ?? o.xmp, date: null, action: "kept" };
    }
    const v = e.set;
    if (f.date) {
      const d = v instanceof Date ? fromJsDate(v) : clean(v) === "" ? null : parseIsoDate(v);
      if (!d) return { key: f.key, text: null, date: null, action: had ? "removed" : "absent" };
      return { key: f.key, text: null, date: withLocalTz(d), action: "set" };
    }
    const t = clean(v as string);
    if (!t) return { key: f.key, text: null, date: null, action: had ? "removed" : "absent" };
    return { key: f.key, text: t, date: null, action: "set" };
  });
}

// ---------------------------------------------------------------- 書く

/** 文書情報の字：ASCII の見える字だけなら PDFDocEncoding の 16 進、それ以外は UTF-16BE（BOM つき）の 16 進 */
function infoString(s: string): PDFHexString {
  if (/^[\x20-\x7e]*$/.test(s)) {
    let h = "";
    for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(2, "0");
    return PDFHexString.of(h);
  }
  return PDFHexString.fromText(s);
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** 選んだ項目だけで XMP を作る（UTF-8） */
export function buildXmp(values: Array<{ xmp: string; text: string }>, pdfa: Original["pdfa"]): string {
  const el = (name: string, text: string) => {
    const v = escapeXml(text);
    if (name === "dc:title" || name === "dc:description") return `<${name}><rdf:Alt><rdf:li xml:lang="x-default">${v}</rdf:li></rdf:Alt></${name}>`;
    if (name === "dc:creator") return `<${name}><rdf:Seq><rdf:li>${v}</rdf:li></rdf:Seq></${name}>`;
    return `<${name}>${v}</${name}>`;
  };
  const body = values.map((x) => el(x.xmp, x.text));
  if (pdfa) {
    body.push(`<pdfaid:part>${pdfa.part}</pdfaid:part>`);
    if (pdfa.conformance) body.push(`<pdfaid:conformance>${pdfa.conformance}</pdfaid:conformance>`);
    if (pdfa.rev) body.push(`<pdfaid:rev>${pdfa.rev}</pdfaid:rev>`);
  }
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about=""' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
      ' xmlns:xmp="http://ns.adobe.com/xap/1.0/"' +
      ' xmlns:pdf="http://ns.adobe.com/pdf/1.3/"' +
      (pdfa ? ' xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"' : "") +
      ">",
    ...body,
    "</rdf:Description>",
    "</rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("\n");
}

export type PropertiesApplied = {
  removed: RemovedItem[];
  notDone: NotDoneItem[];
  changes: PropertyChange[];
  /** 書き出したあとに探す古い値（本人が残した値・書いた値に含まれるものは除いた） */
  search: string[];
};

/**
 * 文書情報と XMP を、選んだ値で書き直す。removeXmp（/Metadata をすべて外す）のあと、たどれないものを捨てる前に呼ぶ。
 * edits が null なら、今までどおり文書情報を消す（PDF/A の印を残すときだけ、印だけの XMP を書く）
 */
export function applyProperties(doc: PDFDocument, orig: Original, edits: Map<PropertyKey, PropertyEdit> | null, pdfaMark: "remove" | "keep"): PropertiesApplied {
  const ctx = doc.context;
  const removed: RemovedItem[] = [];
  const notDone: NotDoneItem[] = [];
  const finals = edits ? finalValues(orig, edits) : FIELDS.map((f): Final => ({ key: f.key, text: null, date: null, action: "absent" }));

  // 文書情報：元の欄のうち、書かないもの（8 項目の消すもの・それ以外の欄）を数える
  const oldInfo = dictOf(ctx, ctx.trailerInfo.Info);
  let infoFieldsBefore = 0;
  if (oldInfo) for (const [, v] of oldInfo.entries()) if (hasValue(ctx, v)) infoFieldsBefore++;

  const infoOut = new Map<string, PDFObject>();
  const xmpOut: Array<{ xmp: string; text: string }> = [];
  const written: string[] = [];
  for (const f of FIELDS) {
    const v = finals.find((x) => x.key === f.key)!;
    if (v.date) {
      infoOut.set(f.info, PDFString.of(formatPdfDate(v.date)));
      xmpOut.push({ xmp: f.xmp, text: formatIsoDate(v.date) });
      written.push(formatPdfDate(v.date), formatIsoDate(v.date));
    } else if (v.text !== null) {
      infoOut.set(f.info, infoString(v.text));
      xmpOut.push({ xmp: f.xmp, text: v.text });
      written.push(v.text);
    }
  }
  const keepPdfa = pdfaMark === "keep" && orig.pdfa !== null;
  if (infoOut.size) {
    const d = ctx.obj({}) as PDFDict;
    for (const [k, v] of infoOut) d.set(N(k), v);
    ctx.trailerInfo.Info = ctx.register(d);
  } else {
    ctx.trailerInfo.Info = undefined;
  }
  if (xmpOut.length || keepPdfa) {
    const xml = buildXmp(xmpOut, keepPdfa ? orig.pdfa : null);
    const stream = ctx.stream(new TextEncoder().encode(xml), { Type: "Metadata", Subtype: "XML" });
    doc.catalog.set(N("Metadata"), ctx.register(stream));
  }

  const dropped = Math.max(0, infoFieldsBefore - finals.filter((v) => v.action === "kept" || v.action === "set").length);
  if (edits === null) {
    if (dropped > 0) removed.push({ pattern: "P1", kind: "docinfo", count: infoFieldsBefore, label: `文書のプロパティ（作成者・タイトル・作成ソフトなど）の欄（${infoFieldsBefore} 個）を消しました` });
  } else {
    const removedN = finals.filter((v) => v.action === "removed").length;
    const setN = finals.filter((v) => v.action === "set").length;
    // 8 項目のほかに、文書情報にあった欄（独自の欄・Trapped など）
    const others = oldInfo ? [...oldInfo.keys()].filter((k) => !FIELDS.some((f) => f.info === k.decodeText()) && hasValue(ctx, oldInfo.get(k))).length : 0;
    if (removedN + others > 0) {
      removed.push({ pattern: "P1", kind: "docinfo", count: removedN + others, label: `文書のプロパティの欄（${removedN + others} 個）を消しました` });
    }
    if (setN > 0) {
      removed.push({ pattern: "P1", kind: "property_rewritten", count: setN, label: `文書のプロパティの欄（${setN} 個）を、選んだ値に書き直しました（文書情報と XMP の両方）` });
    }
  }
  if (orig.pdfa) {
    if (keepPdfa) {
      notDone.push({ pattern: "P2", reason: "pdfa_mark_kept", label: "長期保存用の形式（PDF/A）の印を残しました。整えたあとの PDF は、形式の決まりを満たさない恐れがあります" });
    } else {
      removed.push({ pattern: "P2", kind: "pdfa_mark", count: 1, label: "長期保存用の形式（PDF/A）の印を外しました（整えると形式の決まりを満たさなくなることがあるため）" });
    }
  }

  const changes: PropertyChange[] = finals.map((v) => {
    const o = orig.values.get(v.key)!;
    return {
      key: v.key,
      action: v.action,
      before: { info: o.info !== null, xmp: o.xmp !== null },
      differed: o.info !== null && o.xmp !== null && o.info.normalize("NFKC") !== o.xmp.normalize("NFKC"),
    };
  });
  const keptOrWritten = written.map((s) => s.normalize("NFC"));
  const search = [...new Set(orig.oldValues.map((s) => s.normalize("NFC")))].filter(
    (s) => [...s].length >= MIN_SEARCH_CHARS && !keptOrWritten.some((w) => w.includes(s)),
  );
  return { removed, notDone, changes, search };
}

// ---------------------------------------------------------------- 書き出したあとに、古い値が残っていないか確かめる

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

function utf16be(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += String.fromCharCode(c >> 8, c & 0xff);
  }
  return out;
}
/** 1つの古い値の、ファイルの中で取りうる書き方（latin1 の字の並び。16 進の字・( ) の字は、解いてから探す） */
export function encodings(s: string): string[] {
  const out = new Set<string>();
  const u8 = (t: string) => latin1(new TextEncoder().encode(t));
  out.add(u8(s));
  out.add(utf16be(s));
  out.add(u8(escapeXml(s)));
  out.add(u8(s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")));
  if (/^[\x00-\xff]*$/.test(s)) out.add(s);
  return [...out].filter((p) => p.length >= 2);
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };

/** ストリームの外の字から、16 進の字（< … >）と ( … ) の字を解いて、字の並びとして返す（区切りに 0 を入れる） */
export function decodeStrings(t: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < t.length) {
    const c = t[i]!;
    if (c === "%") {
      // 注釈（行の終わりまで）
      while (i < t.length && t[i] !== "\n" && t[i] !== "\r") i++;
    } else if (c === "<" && t[i + 1] === "<") {
      i += 2;
    } else if (c === "<") {
      const end = t.indexOf(">", i + 1);
      if (end < 0) break;
      let h = t.slice(i + 1, end).replace(/\s+/g, "");
      if (/^[0-9a-fA-F]*$/.test(h)) {
        if (h.length % 2) h += "0";
        let b = "";
        for (let k = 0; k < h.length; k += 2) b += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
        parts.push(b);
      }
      i = end + 1;
    } else if (c === "(") {
      let depth = 1;
      let b = "";
      i++;
      while (i < t.length && depth > 0) {
        const d = t[i]!;
        if (d === "\\") {
          const n = t[i + 1] ?? "";
          if (ESCAPES[n] !== undefined) {
            b += ESCAPES[n];
            i += 2;
          } else if (/[0-7]/.test(n)) {
            const m = /^[0-7]{1,3}/.exec(t.slice(i + 1, i + 4))!;
            b += String.fromCharCode(parseInt(m[0], 8) & 0xff);
            i += 1 + m[0].length;
          } else if (n === "\r" || n === "\n") {
            // 行の継続
            i += 2;
            if (n === "\r" && t[i] === "\n") i++;
          } else {
            b += n;
            i += 2;
          }
          continue;
        }
        if (d === "(") depth++;
        else if (d === ")" && --depth === 0) {
          i++;
          break;
        }
        b += d;
        i++;
      }
      parts.push(b);
    } else {
      i++;
    }
  }
  return parts.join("\u0000");
}

async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream("deflate");
    const w = ds.writable.getWriter();
    w.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
    w.close().catch(() => {});
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const c of ds.readable as unknown as AsyncIterable<Uint8Array>) {
      total += c.length;
      if (total > limit) return null;
      chunks.push(c);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  } catch {
    return null;
  }
}

/** found：残っていた古い値の数（同じ値は1つ）。unreadable：解けなかった XMP・オブジェクトストリームの数（0 でなければ確かめきれていない） */
export type OldValueCheck = { found: number; places: Array<"objects" | "metadata" | "object_stream">; unreadable: number };

/**
 * 書き出した PDF のバイト列を、pdf-lib を使わずに読み直し、古い値が残っていないか探す。
 * 探す所：ストリームの中身の外にある字（< … > と ( … ) を解いたもの。文書情報の値は必ずここ）、XMP（/Type /Metadata・/Subtype /XML）の中身、
 * オブジェクトストリーム（/Type /ObjStm）の中の字（Flate なら解く）。字の外（名前・鍵・%PDF の頭など）は探さない（短い値がたまたま当たるため）。
 * ページの中身・書体・画像のストリームは探さない（ページに見えている字と同じ字が、画面に出ている題などにあるのは当たり前のため）
 */
export async function checkOldValues(out: Uint8Array, search: string[]): Promise<OldValueCheck> {
  const result: OldValueCheck = { found: 0, places: [], unreadable: 0 };
  if (!search.length) return result;
  const pats = search.map(encodings);
  const text = latin1(out);
  const regions: Array<{ place: OldValueCheck["places"][number]; s: string }> = [];
  // オブジェクトを、stream … endstream の中身とそれ以外に分ける
  let outside = "";
  let pos = 0;
  const re = /stream\r?\n/g;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) break;
    const head = text.slice(pos, m.index);
    // このストリームの辞書（直前の「obj」から）
    const objAt = head.lastIndexOf("obj");
    const dict = objAt >= 0 ? head.slice(objAt) : head.slice(-4096);
    outside += head;
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) {
      outside += text.slice(start);
      pos = text.length;
      break;
    }
    const isMeta = /\/Type\s*\/Metadata\b/.test(dict) || /\/Subtype\s*\/XML\b/.test(dict);
    const isObjStm = /\/Type\s*\/ObjStm\b/.test(dict);
    if (isMeta || isObjStm) {
      // endstream の前の改行は、中身に入らない（入れたまま解くと、圧縮の後ろの余りとして失敗する）
      let stop = end;
      while (stop > start && (out[stop - 1] === 0x0a || out[stop - 1] === 0x0d)) stop--;
      let data: Uint8Array | null = out.subarray(start, stop);
      if (/\/Filter\s*(?:\[\s*)?\/FlateDecode\b/.test(dict)) data = await inflate(data, MAX_INFLATE_BYTES);
      else if (/\/Filter\b/.test(dict)) data = null;
      if (!data) result.unreadable++;
      else {
        const s = latin1(data);
        regions.push(isMeta ? { place: "metadata", s } : { place: "object_stream", s: decodeStrings(s) });
      }
    }
    pos = end + "endstream".length;
  }
  outside += text.slice(pos);
  regions.push({ place: "objects", s: decodeStrings(outside) });

  for (const p of pats) {
    const at = regions.filter((r) => p.some((x) => r.s.includes(x)));
    if (!at.length) continue;
    result.found++;
    for (const r of at) if (!result.places.includes(r.place)) result.places.push(r.place);
  }
  return result;
}

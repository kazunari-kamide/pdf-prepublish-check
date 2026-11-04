// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P2（文書全体の XMP メタデータ）1.0.0。カタログの /Metadata の XMP を読む。圧縮あり・なしの両方。
// 部品ごとの XMP（画像・フォーム XObject など）は rules/p2-parts の範囲で、ここでは見ない。
//
// 数えるもの（1件 ＝ 種類・欄・値の組み1つ。値そのものは返さず、字数だけ）：
//   person：人名らしい欄（dc:creator・pdf:Author など。p2-parts と同じ欄と見分け方）
//   text：題・説明・キーワード（dc:title・dc:description・dc:subject・pdf:Keywords）と、独自の欄（pdfx: の名前空間。文書情報の独自の欄が写されたもの）
//   path：ユーザーのフォルダ（Users\<名前>\ など）を含むパス（P4）。字数は、ユーザーのフォルダの名前の字数
//   history：編集の履歴（xmpMM:History）の出来事の数（低い「確認してほしい所」。字数は 0）
//   gps：GPS の緯度・経度（P10）
// 数えないもの：ソフト名（xmp:CreatorTool・pdf:Producer）・文書 ID（xmpMM:DocumentID・InstanceID）・日付・形式（dc:format）。
// 決まり文句・ソフト名・数字の入ったアカウント名は、p2-parts と同じく notCounted に回す。

import { PDFStream, type PDFContext } from "pdf-lib";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { catalogOf, charCount, lookup, N, openPdf, streamData, type RuleError } from "../common/index.ts";
import { classifyName, classifyPath, PATH_FIELDS, PERSON_FIELDS, xmpValues } from "../p2-parts/index.ts";

export const RULE_ID = "p2-xmp";
export const RULE_VERSION = "1.0.0";

/** XMP として読む大きさの上限（バイト）【仮の値】 */
export const MAX_XMP_BYTES = 16 * 1024 * 1024;

export const TEXT_FIELDS = ["dc:title", "dc:description", "dc:subject", "pdf:Keywords"] as const;
const GPS_FIELDS = ["exif:GPSLatitude", "exif:GPSLongitude"] as const;

export type P2XmpKind = "person" | "text" | "path" | "history" | "gps";

export type P2XmpFinding = {
  pattern: "P2" | "P4" | "P10";
  kind: P2XmpKind;
  /** 欄の名前（dc:creator、pdfx:Company など。history は xmpMM:History） */
  field: string;
  /** 字数（path はユーザーのフォルダの名前の字数。history・gps は 0） */
  chars: number;
  /** history のとき：出来事の数 */
  events?: number;
  /** includeValues のときだけ。値そのもの。記録やログには使わない */
  value?: string;
};

export type P2XmpReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  /** 文書全体の XMP があったか。compressed は圧縮されていたか */
  xmp: { present: boolean; compressed: boolean; bytes: number } | null;
  findings: P2XmpFinding[];
  notCounted: Array<{ field: string; reason: "generic" | "account" | "software" | "no_user_folder"; count: number }>;
  limits: Array<"too_large" | "unreadable">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { includeValues?: boolean };

function decodeXml(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

/** 名前空間の接頭辞（pdfx: など）の欄の名前を、属性と要素から集める */
export function fieldsWithPrefix(xml: string, prefix: string): string[] {
  const names = new Set<string>();
  const p = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of xml.matchAll(new RegExp(`[\\s<](${p}:[A-Za-z_][\\w.-]*)\\s*=`, "g"))) names.add(m[1]!);
  for (const m of xml.matchAll(new RegExp(`<(${p}:[A-Za-z_][\\w.-]*)[\\s>/]`, "g"))) names.add(m[1]!);
  names.delete(`xmlns:${prefix}`);
  return [...names];
}

/** 編集の履歴の出来事の数（xmpMM:History の中の rdf:li） */
export function historyEvents(xml: string): number {
  const m = xml.match(/<xmpMM:History\b[^>]*>([\s\S]*?)<\/xmpMM:History>/);
  if (!m) return 0;
  return [...m[1]!.matchAll(/<rdf:li\b/g)].length;
}

/** 文書全体の XMP（カタログの /Metadata）の字。なければ null */
export function catalogXmp(ctx: PDFContext): { xml: string; compressed: boolean; bytes: number } | "too_large" | "unreadable" | null {
  const cat = catalogOf(ctx);
  const raw = cat?.get(N("Metadata"));
  const s = lookup(ctx, raw);
  if (!(s instanceof PDFStream)) return null;
  const compressed = s.dict.has(N("Filter"));
  const data = streamData(s, MAX_XMP_BYTES);
  if (!data) return "too_large";
  try {
    return { xml: decodeXml(data), compressed, bytes: data.length };
  } catch {
    return "unreadable";
  }
}

export async function detectP2Xmp(bytes: Uint8Array, options: DetectOptions = {}): Promise<P2XmpReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, xmp: null, findings: [], notCounted: [], limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const report: P2XmpReport = { ...base, status: "ok", findings: [], notCounted: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;

  const x = catalogXmp(opened.ctx);
  if (x === null) return report;
  if (typeof x === "string") {
    report.limits.push(x);
    report.xmp = { present: true, compressed: false, bytes: 0 };
    return report;
  }
  report.xmp = { present: true, compressed: x.compressed, bytes: x.bytes };
  const xml = x.xml;

  const groups = new Map<string, { f: P2XmpFinding; value: string }>();
  const add = (f: P2XmpFinding, value: string) => {
    const key = [f.kind, f.field, value].join("\u0000");
    if (!groups.has(key)) groups.set(key, { f, value });
  };
  const skipped = new Map<string, P2XmpReport["notCounted"][number]>();
  const skip = (field: string, reason: P2XmpReport["notCounted"][number]["reason"]) => {
    const k = `${field}\u0000${reason}`;
    const s = skipped.get(k) ?? { field, reason, count: 0 };
    s.count++;
    skipped.set(k, s);
  };

  for (const field of PERSON_FIELDS) {
    for (const v of new Set(xmpValues(xml, field))) {
      const c = classifyName(v);
      if (c.counted) add({ pattern: "P2", kind: "person", field, chars: c.chars }, v);
      else skip(field, c.reason);
    }
  }
  for (const field of TEXT_FIELDS) {
    for (const v of new Set(xmpValues(xml, field))) add({ pattern: "P2", kind: "text", field, chars: charCount(v) }, v);
  }
  for (const field of fieldsWithPrefix(xml, "pdfx")) {
    for (const v of new Set(xmpValues(xml, field))) add({ pattern: "P2", kind: "text", field, chars: charCount(v) }, v);
  }
  for (const field of [...PATH_FIELDS, "stEvt:parameters"]) {
    for (const v of new Set(xmpValues(xml, field))) {
      const c = classifyPath(v);
      if (c.counted) add({ pattern: "P4", kind: "path", field, chars: c.chars }, v);
      else if (field !== "stEvt:parameters") skip(field, c.reason); // 履歴の説明（「変換」など）は、パスでなければ数えも記録もしない
    }
  }
  const events = historyEvents(xml);
  if (events > 0) add({ pattern: "P2", kind: "history", field: "xmpMM:History", chars: 0, events }, String(events));
  const gps = GPS_FIELDS.map((f) => xmpValues(xml, f)[0] ?? "").filter(Boolean);
  if (gps.length) add({ pattern: "P10", kind: "gps", field: "exif:GPSLatitude/exif:GPSLongitude", chars: 0 }, gps.join(" "));

  for (const g of groups.values()) {
    if (options.includeValues && g.f.kind !== "history") g.f.value = g.value;
    report.findings.push(g.f);
  }
  report.notCounted = [...skipped.values()];
  return report;
}


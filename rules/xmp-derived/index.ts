// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：XMP の元の文書・素材の一覧（xmp-derived）1.0.0。型は P2（文書全体の XMP）の仲間【仮】。
// カタログの /Metadata（文書全体の XMP）の、次の 3 つの欄の中にある、ファイルの名前（stRef:filePath）を数える。
//   derived：元の文書（xmpMM:DerivedFrom）
//   ingredients：組み込んだ素材の一覧（xmpMM:Ingredients）
//   manifest：リンクした資源の一覧（xmpMM:Manifest）
// 1件 ＝ 欄 1 つ。files にファイルの名前の数（同じ名前は 1 つ）、chars に字数の合計。値そのものは返さない（includeValues のときだけ）。
//
// 数えないもの（ほかのルールがすでに見ているもの。notCounted に回す）：
//   user_folder：ユーザーのフォルダを含むパス（p2-xmp の path）
//   path：ドライブ名・共有フォルダ・file: などから始まるパス（p4-paths）
//   文書 ID・インスタンス ID（stRef:documentID・stRef:instanceID）は、漏れではないので見ない。
// 編集の履歴（xmpMM:History）は p2-xmp の範囲で、ここでは見ない。部品ごとの XMP は p2-parts の範囲。

import { charCount, openPdf, type RuleError } from "../common/index.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { catalogXmp } from "../p2-xmp/index.ts";
import { classifyPath, xmpValues } from "../p2-parts/index.ts";

export const RULE_ID = "xmp-derived";
export const RULE_VERSION = "1.0.0";

// 種類の名前の終わりに from を付けない（tests/site-pages.test.ts の読み込みを拾う正規表現が、import と見まちがえるため）
export type XmpDerivedKind = "derived" | "ingredients" | "manifest";

/** 欄の名前と、種類 */
export const CONTAINERS: ReadonlyArray<{ kind: XmpDerivedKind; field: string }> = [
  { kind: "derived", field: "xmpMM:DerivedFrom" },
  { kind: "ingredients", field: "xmpMM:Ingredients" },
  { kind: "manifest", field: "xmpMM:Manifest" },
];

/** ファイルの名前が入る欄（欄の中で探す） */
const NAME_FIELDS = ["stRef:filePath", "stRef:lastURL"] as const;

export type XmpDerivedFinding = {
  pattern: "P2";
  kind: XmpDerivedKind;
  /** 欄の名前（xmpMM:DerivedFrom など） */
  field: string;
  /** ファイルの名前の数（同じ名前は 1 つ） */
  files: number;
  /** 字数の合計 */
  chars: number;
  /** includeValues のときだけ。名前そのもの。記録やログには使わない */
  values?: string[];
};

export type XmpDerivedReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  findings: XmpDerivedFinding[];
  notCounted: Array<{ field: string; reason: "user_folder" | "path"; count: number }>;
  limits: Array<"too_large" | "unreadable">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { includeValues?: boolean };

/** ほかのルール（p4-paths）がパスとして見る形：ドライブ名・共有フォルダ・URL の形 */
const PATH_LIKE = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/|[A-Za-z][A-Za-z0-9+.-]*:\/\/|file:|smb:|\/(?:Users|home|Volumes)\/)/i;

/** 欄（要素）のまとまりを、すべて取り出す。属性だけの形（<xmpMM:DerivedFrom stRef:filePath="…"/>）も含む */
export function containerBlocks(xml: string, field: string): string[] {
  const f = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out: string[] = [];
  for (const m of xml.matchAll(new RegExp(`<${f}\\b[^>]*?(?:/>|>[\\s\\S]*?</${f}>)`, "g"))) out.push(m[0]);
  return out;
}

export async function detectXmpDerived(bytes: Uint8Array, options: DetectOptions = {}): Promise<XmpDerivedReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], notCounted: [], limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const report: XmpDerivedReport = { ...base, status: "ok", findings: [], notCounted: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;

  const x = catalogXmp(opened.ctx);
  if (x === null) return report;
  if (typeof x === "string") {
    report.limits.push(x);
    return report;
  }

  const skipped = new Map<string, XmpDerivedReport["notCounted"][number]>();
  const skip = (field: string, reason: "user_folder" | "path") => {
    const k = `${field}\u0000${reason}`;
    const s = skipped.get(k) ?? { field, reason, count: 0 };
    s.count++;
    skipped.set(k, s);
  };

  for (const { kind, field } of CONTAINERS) {
    const names = new Set<string>();
    for (const block of containerBlocks(x.xml, field)) {
      // 属性の形を拾うため、頭に空白を足して渡す（xmpValues は空白か < のあとの属性を拾う）
      for (const nf of NAME_FIELDS) for (const v of xmpValues(` ${block}`, nf)) names.add(v);
    }
    const counted: string[] = [];
    for (const v of names) {
      if (classifyPath(v).counted) skip(field, "user_folder");
      else if (PATH_LIKE.test(v)) skip(field, "path");
      else counted.push(v);
    }
    if (counted.length === 0) continue;
    const f: XmpDerivedFinding = { pattern: "P2", kind, field, files: counted.length, chars: counted.reduce((s, v) => s + charCount(v), 0) };
    if (options.includeValues) f.values = counted;
    report.findings.push(f);
  }
  report.notCounted = [...skipped.values()];
  return report;
}

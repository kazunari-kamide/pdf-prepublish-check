// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P3（他組織名の混入）1.0.1。
// 文書情報・文書全体の XMP の題などにある団体名らしい語が、本文に出てくる団体名と違うものを返す。
// ほかの団体の書類をひな形にして作ったとき、題や作成者欄に元の団体の名前が残る型。値は返さない（字数だけ）。
//
// 団体名らしい語の見分け方（団体名の一覧は持たない。字の並びの形だけ）：
//   日本語：rules/props の orgMarks のうち、〇〇市・町・村・区・県・都・府・北海道と、株式会社などの会社・法人の言葉のあるもの。
//     課・室・係・局・部・庁は、同じ団体の中の部署のことが多いので、ここでは比べない。
//   英語：大文字で始まる語のあとに City・Town・Village・Ward・Prefecture・County が続くもの（例：Sample City）。
//     会社は Inc.・Ltd.・Co.・Corporation・Corp. が続くもの。比べるのは、後ろの言葉と、その直前の 1 語。
// 出す条件：本文（ページの字）に団体名らしい語が 1 つ以上あり、題などの団体名らしい語が、本文のどこにも無いとき。
//   本文に団体名らしい語が無いときは、比べられないので出さない（notCompared に数える）。
// 見る欄：/Info の Title・Subject・Author・Keywords、XMP の dc:title・dc:description・dc:creator・pdf:Keywords。

import type { EncryptionSummary } from "../shared/decrypt.ts";
import { charCount, dictOf, N, openPdf, textOf, type RuleError } from "../common/index.ts";
import { readPageTexts } from "../common/page-text.ts";
import { catalogXmp } from "../p2-xmp/index.ts";
import { xmpValues } from "../p2-parts/index.ts";
import { orgMarks } from "../props/index.ts";

export const RULE_ID = "p3-orgs";
export const RULE_VERSION = "1.0.1";

const INFO_FIELDS = ["Title", "Subject", "Author", "Keywords"] as const;
const XMP_FIELDS = ["dc:title", "dc:description", "dc:creator", "pdf:Keywords"] as const;
/** 日本語で比べる団体名の後ろの字（自治体）。部署（課・室など）は入れない */
const JA_PLACE = /[市町村区県都府]$|北海道$/;
const JA_COMPANY = /株式会社|有限会社|合同会社|社団法人|財団法人|社会福祉法人|特定非営利活動法人/;
const EN_ORG = /\b([A-Z][\p{L}'-]+)\s+(City|Town|Village|Ward|Prefecture|County|Inc\.?|Ltd\.?|Co\.|Corporation|Corp\.?)(?![\p{L}])/gu;

export type P3Finding = {
  pattern: "P3";
  /** どこにあったか */
  source: "info" | "xmp";
  field: string;
  /** 題などの中の、本文に無い団体名らしい語の字数 */
  chars: number;
  /** includeValues のときだけ。記録やログには使わない */
  value?: string;
};

export type P3Report = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  findings: P3Finding[];
  /** 本文の団体名らしい語の数（種類） */
  bodyOrgs: number;
  /** 題などに団体名らしい語があったが、本文に団体名らしい語が無く、比べなかった数 */
  notCompared: number;
  skippedPages: number[];
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { includeValues?: boolean };

/** 比べるための形（NFKC・小文字・空白をつめる） */
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** 日付・回の字の前に来る数（漢数字） */
const KANJI_NUM = /[〇一二三四五六七八九十百元]/u;
/**
 * 団体名の頭についた日付の切れ端を外す（1.0.1 から）。「令和6年9月架空町議会」は、数字の手前で切れて「月架空町」になる。
 * 本文で「9月 架空町議会」と間があくと「架空町」になり、同じ団体なのに名前が合わなかったため。
 * 外すのは、頭にある年・月・日・号・回か、漢数字のすぐあとの年・月・日・号・回まで（「九月架空町」→「架空町」）。
 */
export function stripDatePrefix(word: string): string {
  const chars = [...word];
  let cut = 0;
  for (let i = 0; i < chars.length - 2; i++) {
    if (!/[年月日号回]/u.test(chars[i]!)) continue;
    // 頭の 1 字（前は数字など、並びの外）か、漢数字のすぐあと。「令和6年月宵町」は「年」だけ外して「月宵町」を残す
    if (i === 0 || KANJI_NUM.test(chars[i - 1]!)) cut = i + 1;
  }
  return chars.slice(cut).join("");
}

/** 字の中の団体名らしい語（比べる形にしたもの） */
export function orgNames(text: string): string[] {
  const out = new Set<string>();
  const chars = [...text];
  for (const m of orgMarks(text)) {
    const w = stripDatePrefix(chars.slice(m.start, m.end).join(""));
    if (JA_PLACE.test(w) || JA_COMPANY.test(w)) out.add(norm(w));
  }
  for (const m of text.matchAll(EN_ORG)) out.add(norm(`${m[1]} ${m[2]!.replace(/\.$/, "")}`));
  return [...out];
}

export async function detectP3Orgs(bytes: Uint8Array, options: DetectOptions = {}): Promise<P3Report> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], bodyOrgs: 0, notCompared: 0, skippedPages: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { doc, ctx } = opened;
  const report: P3Report = { ...base, status: "ok", findings: [], skippedPages: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;

  // 題などの団体名らしい語
  const meta: Array<{ source: "info" | "xmp"; field: string; name: string }> = [];
  const info = dictOf(ctx, ctx.trailerInfo.Info);
  for (const f of INFO_FIELDS) {
    const t = info ? textOf(ctx, info.get(N(f))) : null;
    if (t) for (const name of orgNames(t)) meta.push({ source: "info", field: f, name });
  }
  const x = catalogXmp(ctx);
  if (x && typeof x === "object") {
    for (const f of XMP_FIELDS) for (const v of xmpValues(x.xml, f)) for (const name of orgNames(v)) meta.push({ source: "xmp", field: f, name });
  }
  if (!meta.length) return report;

  // 本文の団体名らしい語と、本文の字（比べる形）
  const texts = readPageTexts(doc);
  report.skippedPages = texts.skipped;
  const body = norm(texts.pages.map((p) => p.text).join("\n"));
  const bodyOrgs = new Set(texts.pages.flatMap((p) => orgNames(p.text)));
  report.bodyOrgs = bodyOrgs.size;

  const seen = new Set<string>();
  for (const m of meta) {
    const key = `${m.source}:${m.field}:${m.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!bodyOrgs.size) {
      report.notCompared++;
      continue;
    }
    if (bodyOrgs.has(m.name) || body.includes(m.name)) continue;
    const f: P3Finding = { pattern: "P3", source: m.source, field: m.field, chars: charCount(m.name) };
    if (options.includeValues) f.value = m.name;
    report.findings.push(f);
  }
  return report;
}

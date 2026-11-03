// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P7（隠れたテキスト）の報告を、検証器の出力と同じ形（verifier/p7-schema.json のうち、採点に使う所）にそろえる。
// この変換は採点する側（eval）に置き、verifier/ には置かない（rubric/p7.md §4、rubric/p6.md §4 と同じ）。

import type { P7Report } from "../../rules/p7-hidden/index.ts";

export type P7Item = { pattern: "P7"; page: number; reason: string; rect: [number, number, number, number]; chars: number };
export type P7VerifierShapedReport = {
  status: "ok" | "error";
  items: P7Item[];
  skipped_pages: Array<{ page: number; reason: string }>;
  excluded?: { p6?: number; ocr_layer?: number };
};

export function adaptP7Hidden(report: P7Report): P7VerifierShapedReport {
  return {
    status: report.status,
    items: report.findings.map((f) => ({ pattern: "P7", page: f.page, reason: f.reason, rect: f.rect, chars: f.chars })),
    skipped_pages: report.skippedPages.map((s) => ({ page: s.page, reason: s.reason })),
    excluded: { p6: report.excluded.p6, ocr_layer: report.excluded.ocrLayer },
  };
}

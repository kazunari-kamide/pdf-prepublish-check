// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6（見せかけの黒塗り）の文字の層の報告を、検証器の出力と同じ形（verifier/schema.json）にそろえる。
// この変換は採点する側（eval）に置き、verifier/ には置かない（docs/prd.md §2-3-1 の3、rubric/p6.md §4）。

import type { P6TextReport } from "../../rules/p6-text/index.ts";
import type { VerifierShapedReport } from "../match.ts";

export function adaptP6Text(report: P6TextReport): VerifierShapedReport {
  return {
    status: report.status,
    ...(report.error ? { error: { code: report.error.code } } : {}),
    // 図形の層（1.13.0 から）は、検証器の形（text・image）にないので入れない。採点は eval:new の合成 PDF（eval/cases/p6-vector.ts）で数える
    items: report.findings.flatMap((f) => (f.layer === "vector" ? [] : [f])).map((f) => ({
      pattern: f.pattern,
      layer: f.layer,
      cover: f.cover,
      page: f.page,
      rect: f.rect,
      // 画像の層（1.5.0 から）は、残っている字数を持たない
      remaining: f.layer === "text" ? { chars: f.chars } : {},
    })),
    skipped_pages: report.skippedPages.map((s) => ({ page: s.page, reason: s.reason })),
  };
}

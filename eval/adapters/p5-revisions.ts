// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P5（旧版の残存）の報告を、検証器の出力と同じ形（verifier/p5-schema.json のうち、採点に使う所）にそろえる。
// この変換は採点する側（eval）に置き、verifier/ には置かない（rubric/p5.md §5、rubric/p6.md §4 と同じ）。

import type { P5Report } from "../../rules/p5-revisions/index.ts";

export type P5Item = { pattern: "P5"; object: number; gen: number; kind: string; where: string; revision: number | null; chars?: number };
export type P5VerifierShapedReport = {
  status: "ok" | "error";
  items: P5Item[];
  not_counted: Array<{ object: number; kind: string; where: string; reason: string }>;
  summary?: { previous_info?: number; removed_attachment?: number };
};

export function adaptP5Revisions(report: P5Report): P5VerifierShapedReport {
  return {
    status: report.status,
    items: report.findings.map((f) => {
      const item: P5Item = { pattern: "P5", object: f.object, gen: f.gen, kind: f.kind, where: f.where, revision: f.revision };
      if (f.chars !== undefined) item.chars = f.chars;
      return item;
    }),
    not_counted: report.notCounted.map((n) => ({ ...n })),
    summary: { previous_info: report.summary.previousInfo, removed_attachment: report.summary.removedAttachment },
  };
}

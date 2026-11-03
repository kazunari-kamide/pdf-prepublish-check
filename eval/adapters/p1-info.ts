// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P1（文書情報）の報告を、検証器の出力と同じ形（verifier/p1-schema.json のうち、採点に使う所）にそろえる。
// この変換は採点する側（eval）に置き、verifier/ には置かない（rubric/p1.md §4、rubric/p6.md §4 と同じ）。

import type { P1InfoReport } from "../../rules/p1-info/index.ts";

export type P1VerifierShapedReport = {
  status: "ok" | "error";
  items: Array<{ pattern: "P1"; key: string; where: "current"; chars?: number }>;
  not_counted: Array<{ key: string; reason: string }>;
  previous_info: number;
};

export function adaptP1Info(report: P1InfoReport): P1VerifierShapedReport {
  return {
    status: report.status,
    items: report.findings.map((f) => ({ pattern: "P1", key: f.key, where: "current", chars: f.chars })),
    not_counted: report.notCounted.map((n) => ({ key: n.key, reason: n.reason })),
    previous_info: report.previousInfo.keys,
  };
}

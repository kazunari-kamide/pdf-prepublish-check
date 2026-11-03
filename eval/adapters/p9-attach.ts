// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P9（添付ファイル）の報告を、検証器の出力と同じ形（verifier/p9-schema.json のうち、採点に使う所）にそろえる。
// この変換は採点する側（eval）に置き、verifier/ には置かない（rubric/p9.md §4、rubric/p6.md §4 と同じ）。
// 照らし合わせにはファイル名が要る（rubric/p9.md §3 の2）ので、検出ルールを includeNames つきで呼んだ報告を渡す。

import type { P9AttachReport } from "../../rules/p9-attach/index.ts";

export type P9Item = {
  pattern: "P9";
  where: "names" | "annotation" | "af" | "unreferenced";
  page?: number;
  object: number;
  also: string[];
  name_chars: number;
  ext: string | null;
  size: number | null;
  subtype: string | null;
  name?: string;
};

export type P9VerifierShapedReport = { status: "ok" | "error"; items: P9Item[] };

export function adaptP9Attach(report: P9AttachReport): P9VerifierShapedReport {
  return {
    status: report.status,
    items: report.findings.map((f) => {
      const item: P9Item = {
        pattern: "P9",
        where: f.where,
        object: f.object,
        also: [...f.also],
        name_chars: f.nameChars,
        ext: f.ext,
        size: f.size,
        subtype: f.subtype,
      };
      if (f.page !== undefined) item.page = f.page;
      if (f.name !== undefined) item.name = f.name;
      return item;
    }),
  };
}

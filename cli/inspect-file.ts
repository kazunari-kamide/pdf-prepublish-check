// SPDX-License-Identifier: AGPL-3.0-only
//
// 1つのファイルを、形式を見分けてから調べる。Node の API は使わない（Worker の中から呼ぶ）。
// PDF は画面と同じ検査（inspect-pdf.ts）、写真・今の Office は formats/。

import { FORMATS_VERSION, detectFormat, inspectFormat, type FormatReport } from "../formats/index.ts";
import { inspectPdf } from "./inspect-pdf.ts";
import type { FileFormat, FileReport } from "./report.ts";

const RULE_ID: Record<string, string> = { image: "formats-image", office: "formats-office" };

export function fromFormatReport(r: FormatReport): FileReport {
  const ruleId = r.format === "docx" || r.format === "xlsx" || r.format === "pptx" || r.format === "zip" ? RULE_ID.office! : RULE_ID.image!;
  const format: FileFormat = r.format === "cfb" || r.format === "zip" ? "unknown" : (r.format as FileFormat);
  return {
    format,
    items: r.findings.map((f) => ({
      ruleId,
      ruleVersion: FORMATS_VERSION,
      pattern: null,
      type: f.type,
      severity: f.severity,
      title: f.title,
      why: f.why,
      detail: f.detail,
      page: f.page,
      rect: null,
      ...(f.where ? { where: f.where } : {}),
    })),
    notices: r.notices.map((n) => ({ ruleId, kind: n.kind, message: n.message, pages: [], unchecked: n.unchecked })),
  };
}

export async function inspectFile(bytes: Uint8Array): Promise<FileReport> {
  const kind = detectFormat(bytes);
  // PDF の印が見つからないものの中で、形式の分からないもの（壊れた PDF・ただの字のファイルなど）は、PDF として調べて「PDF ではない」と返す
  if (kind === "pdf" || kind === "unknown") return inspectPdf(bytes);
  return fromFormatReport(await inspectFormat(bytes, kind));
}

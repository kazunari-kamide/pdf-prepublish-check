// SPDX-License-Identifier: AGPL-3.0-only
//
// PDF を、画面と同じ入口で調べる：precheck（src/inspect/precheck.ts）のあと、
// 画面の Worker と同じ inspectAll（src/inspect/inspect.ts。ルールの一覧は src/inspect/rules.ts の RULES）にかける。
// ここでは、その結果をコマンドの道具の形（report.ts）に並べ替えるだけ。
// Node の API は使わない（MCP など、ほかの入口からも同じものを呼べるように）。
// Node で読むときは、先に resolve-ts.ts のフックを入れる（画面のコードの import に拡張子がないため）。

import { inspectAll } from "../src/inspect/inspect.ts";
import { precheck } from "../src/inspect/precheck.ts";
import type { Notice, RuleResult } from "../src/inspect/report.ts";
import type { RuleEntry } from "../src/inspect/rules.ts";
import type { FileNotice, FileReport, Finding } from "./report.ts";

/** 「調べられなかった所」として数える知らせ。decrypted（ほどいて調べた）は数えない */
const UNCHECKED_NOTICES = new Set<Notice["kind"]>(["skipped_pages", "unchecked_images", "partial"]);

export function toFindings(r: RuleResult): Finding[] {
  return r.items.map((it) => ({
    ruleId: r.ruleId,
    ruleVersion: r.ruleVersion,
    pattern: it.pattern,
    type: it.pattern,
    severity: it.severity,
    title: it.title,
    why: it.why,
    detail: it.detail,
    page: it.page,
    rect: it.rect,
  }));
}

export function toNotices(r: RuleResult): FileNotice[] {
  const out: FileNotice[] = r.notices.map((n) => ({
    ruleId: r.ruleId,
    kind: n.kind,
    message: n.message,
    pages: n.pages,
    unchecked: UNCHECKED_NOTICES.has(n.kind),
  }));
  if (r.status === "error") {
    out.unshift({
      ruleId: r.ruleId,
      kind: "rule_error",
      message: `「${r.label}」は調べられませんでした。${r.message ?? ""}`.trim(),
      pages: [],
      unchecked: true,
    });
  }
  return out;
}

export async function inspectPdf(bytes: Uint8Array, rules?: RuleEntry[]): Promise<FileReport> {
  const pre = precheck(bytes);
  if (!pre.ok) {
    return { format: "pdf", items: [], notices: [{ ruleId: null, kind: pre.code, message: pre.message, pages: [], unchecked: true }] };
  }
  const summary = await inspectAll(bytes, () => {}, rules);
  return {
    format: "pdf",
    items: summary.rules.flatMap(toFindings),
    notices: mergeNotices(summary.rules.flatMap(toNotices)),
  };
}

/** 同じ知らせ（暗号化をほどいた・図形が多くて省いたページなど）は、ルールごとに出るので1つにまとめ、ページを合わせる */
export function mergeNotices(notices: FileNotice[]): FileNotice[] {
  const out: FileNotice[] = [];
  for (const n of notices) {
    const same = out.find((o) => o.kind === n.kind && o.message === n.message && o.unchecked === n.unchecked);
    if (!same) {
      out.push({ ...n, pages: [...n.pages] });
      continue;
    }
    if (same.ruleId !== n.ruleId) same.ruleId = null;
    same.pages = [...new Set([...same.pages, ...n.pages])].sort((a, b) => a - b);
  }
  return out;
}

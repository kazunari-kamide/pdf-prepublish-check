// SPDX-License-Identifier: AGPL-3.0-only
//
// 結果の出し方：人が読む形・JSON・SARIF（2.1.0）。
// 出すのは型・数・場所と、調べたファイルの場所（利用者が渡したもの）だけ。字の中身・欄の値・中のファイル名は、
// 結果の形（report.ts）に入っていないので、ここからも出ない。

import type { FileReport, Finding, Stage } from "./report.ts";
import { STAGE_CODE, STAGE_LABEL, stagesOf, topStage } from "./stage.ts";

export const TOOL_NAME = "omamori-pdf";
export const TOOL_VERSION = "0.1.0";

export type CheckedFile = { path: string; report: FileReport; elapsedMs: number };

const SEV_LABEL: Record<Finding["severity"], string> = { high: "高", medium: "中", low: "低" };

function placeOf(f: Finding): string {
  const parts: string[] = [];
  if (f.page !== null) parts.push(`${f.page}ページ`);
  if (f.where) parts.push(f.where);
  return parts.join("　");
}

function counts(r: FileReport) {
  return {
    high: r.items.filter((i) => i.severity === "high").length,
    review: r.items.filter((i) => i.severity !== "high").length,
    unchecked: r.notices.filter((n) => n.unchecked).length,
  };
}

// ---------------------------------------------------------------- 人が読む形

export function formatText(files: CheckedFile[], exitCode: number): string {
  const lines: string[] = [];
  const mark: Record<Stage, string> = { none: "○", review: "△", high: "×", unchecked: "？" };
  for (const f of files) {
    const stages = stagesOf(f.report);
    const top = topStage(stages);
    const c = counts(f.report);
    const parts: string[] = [];
    if (c.high) parts.push(`高い危険 ${c.high} 件`);
    if (c.review) parts.push(`確認してほしい所 ${c.review} 件`);
    if (c.unchecked) parts.push(`調べられなかった所 ${c.unchecked} 件`);
    lines.push(`${mark[top]} ${f.path}　${parts.length ? parts.join("・") : STAGE_LABEL.none}`);
    const sorted = [...f.report.items].sort((a, b) => sevRank(a) - sevRank(b) || (a.page ?? 0) - (b.page ?? 0));
    for (const it of sorted) {
      const place = placeOf(it);
      lines.push(`    [${SEV_LABEL[it.severity]}] ${place ? place + "　" : ""}${it.title}${it.detail ? `（${it.detail}）` : ""}`);
      lines.push(`         なぜ：${it.why}`);
    }
    for (const n of f.report.notices) {
      const pages = n.pages.length ? `（${pageList(n.pages)}）` : "";
      lines.push(`    [${n.unchecked ? "調べられなかった所" : "お知らせ"}] ${n.message}${pages}`);
    }
  }
  const all = files.map((f) => counts(f.report));
  const sum = (k: keyof ReturnType<typeof counts>) => all.reduce((s, c) => s + c[k], 0);
  lines.push("");
  lines.push(
    `調べたファイル：${files.length} 個　高い危険：${sum("high")} 件　確認してほしい所：${sum("review")} 件　調べられなかった所：${sum("unchecked")} 件　終了コード：${exitCode}`,
  );
  lines.push("見つけられるのは、このツールが調べる決まった型だけです。「見つかりませんでした」は、すべてを保証するものではありません。");
  return lines.join("\n");
}

const sevRank = (f: Finding) => (f.severity === "high" ? 0 : f.severity === "medium" ? 1 : 2);

function pageList(pages: number[]): string {
  const shown = pages.slice(0, 10).map((p) => `${p}`).join("・");
  return `${shown}${pages.length > 10 ? ` ほか ${pages.length - 10} ページ` : ""}ページ`;
}

// ---------------------------------------------------------------- JSON

export function formatJson(files: CheckedFile[], exitCode: number): string {
  const out = {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    exitCode,
    files: files.map((f) => {
      const stages = stagesOf(f.report);
      return {
        path: f.path,
        format: f.report.format,
        stage: topStage(stages),
        stages: [...stages].sort((a, b) => STAGE_CODE[a] - STAGE_CODE[b]),
        elapsedMs: f.elapsedMs,
        items: f.report.items,
        notices: f.report.notices,
      };
    }),
    summary: {
      files: files.length,
      high: files.reduce((s, f) => s + counts(f.report).high, 0),
      review: files.reduce((s, f) => s + counts(f.report).review, 0),
      unchecked: files.reduce((s, f) => s + counts(f.report).unchecked, 0),
    },
  };
  return JSON.stringify(out, null, 2);
}

// ---------------------------------------------------------------- SARIF 2.1.0

const SARIF_LEVEL: Record<Finding["severity"], "error" | "warning" | "note"> = { high: "error", medium: "warning", low: "note" };

/** SARIF の uri は、/ で区切った相対パス（Windows の \ も / にする）。各部分は % で符号化する */
export function toSarifUri(p: string): string {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export function formatSarif(files: CheckedFile[], exitCode: number): string {
  const ruleIds = new Map<string, { id: string; name: string; pattern: string | null }>();
  for (const f of files) {
    for (const it of f.report.items) if (!ruleIds.has(it.ruleId)) ruleIds.set(it.ruleId, { id: it.ruleId, name: it.title, pattern: it.pattern });
  }
  const rules = [...ruleIds.values()].map((r) => ({
    id: r.id,
    name: r.id,
    shortDescription: { text: r.pattern ? `${r.pattern}：${r.name}` : r.name },
    properties: r.pattern ? { pattern: r.pattern } : {},
  }));
  const ruleIndex = new Map([...ruleIds.keys()].map((id, i) => [id, i]));

  const results = files.flatMap((f) =>
    f.report.items.map((it) => {
      const place = placeOf(it);
      return {
        ruleId: it.ruleId,
        ruleIndex: ruleIndex.get(it.ruleId),
        level: SARIF_LEVEL[it.severity],
        message: { text: `${place ? place + "：" : ""}${it.title}${it.detail ? `（${it.detail}）` : ""}。${it.why}` },
        locations: [
          {
            physicalLocation: { artifactLocation: { uri: toSarifUri(f.path) } },
            ...(place ? { logicalLocations: [{ name: place, kind: it.page !== null ? "page" : "element" }] } : {}),
          },
        ],
        properties: { severity: it.severity, type: it.type, page: it.page, rect: it.rect, ...(it.where ? { where: it.where } : {}) },
      };
    }),
  );

  const notifications = files.flatMap((f) =>
    f.report.notices.map((n) => ({
      level: n.unchecked ? "warning" : "note",
      message: { text: `${n.message}${n.pages.length ? `（${pageList(n.pages)}）` : ""}` },
      locations: [{ physicalLocation: { artifactLocation: { uri: toSarifUri(f.path) } } }],
      properties: { kind: n.kind, unchecked: n.unchecked, pages: n.pages, ...(n.ruleId ? { ruleId: n.ruleId } : {}) },
    })),
  );

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: TOOL_NAME, version: TOOL_VERSION, informationUri: "https://omamoripdf.com/", rules } },
        invocations: [{ executionSuccessful: true, exitCode, toolExecutionNotifications: notifications }],
        artifacts: files.map((f) => ({ location: { uri: toSarifUri(f.path) } })),
        results,
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

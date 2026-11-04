// SPDX-License-Identifier: AGPL-3.0-only
//
// 結果の段階と、終了コード。
//   0 見つからない（調べた項目について）
//   1 確認してほしい所だけ（中・低）
//   2 高い危険がある
//   3 調べられなかった所がある（ファイル全体・ルール1つ・省いたページ・読めなかった画像など）
//  64 使い方の誤り（選択肢の誤り・ファイルが見つからない）
// 終了コードは、--fail-on に挙げた段階のうち、届いたものの一番大きい数。挙げていない段階は 0 として扱う。

import type { FileReport, Stage } from "./report.ts";

export const STAGES: readonly Stage[] = ["none", "review", "high", "unchecked"];
export const STAGE_CODE: Record<Stage, number> = { none: 0, review: 1, high: 2, unchecked: 3 };
export const USAGE_ERROR = 64;

export const STAGE_LABEL: Record<Stage, string> = {
  none: "見つかりませんでした（調べた項目について）",
  review: "確認してほしい所があります",
  high: "高い危険があります",
  unchecked: "調べられなかった所があります",
};

/** --fail-on に書ける段階 */
export const FAILABLE: readonly Exclude<Stage, "none">[] = ["review", "high", "unchecked"];
export const DEFAULT_FAIL_ON: ReadonlySet<Stage> = new Set(FAILABLE);

/** 1つのファイルが届いた段階（届いたものすべて）。unchecked はほかの段階と一緒に届くことがある */
export function stagesOf(r: FileReport): Set<Stage> {
  const out = new Set<Stage>();
  if (r.items.some((i) => i.severity === "high")) out.add("high");
  if (r.items.some((i) => i.severity !== "high")) out.add("review");
  if (r.notices.some((n) => n.unchecked)) out.add("unchecked");
  if (out.size === 0) out.add("none");
  return out;
}

/** 一番大きい段階（表示用） */
export function topStage(stages: Iterable<Stage>): Stage {
  let top: Stage = "none";
  for (const s of stages) if (STAGE_CODE[s] > STAGE_CODE[top]) top = s;
  return top;
}

export function exitCodeOf(reports: FileReport[], failOn: ReadonlySet<Stage>): number {
  let code = 0;
  for (const r of reports) {
    for (const s of stagesOf(r)) if (failOn.has(s)) code = Math.max(code, STAGE_CODE[s]);
  }
  return code;
}

/** "high,unchecked" の形を読む。"never" は、どの段階でも落とさない */
export function parseFailOn(text: string): Set<Stage> | null {
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0] === "never") return new Set();
  const out = new Set<Stage>();
  for (const p of parts) {
    if (!(FAILABLE as readonly string[]).includes(p)) return null;
    out.add(p as Stage);
  }
  return out.size ? out : null;
}

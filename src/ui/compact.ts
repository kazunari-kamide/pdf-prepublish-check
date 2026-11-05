// SPDX-License-Identifier: AGPL-3.0-only
//
// 結果の欄を詰めて読みやすくするための計算（2026-11-05 本人の気づき「結果の欄が縦に長く、字が多くて読みにくい」）。
// 画面の部品に頼らない計算だけを置き、テストで確かめる。
// - 項目の内訳（「覆っているもの：…／残っている字：4字」など）は、区切りを「・」にした 1 行にする（ルールの文は変えない）
// - 「見た所・見なかった所」は、初めは閉じた見出しにし、1 行の要約を出す
// - PDF の欄と結果の欄のあいだの仕切りで、結果の欄の幅を決める（上限と下限）

import type { CoverageRow } from "./coverage.ts";

/** 内訳を 1 行にする（区切り「／」を「・」に。前後の空白を落とす） */
export function compactDetail(detail: string): string {
  return detail
    .split("／")
    .map((x) => x.trim())
    .filter(Boolean)
    .join("・");
}

/**
 * 「見た所・見なかった所」の見出しの 1 行の要約。
 * 例：「14 の型のうち 13 を調べた・見つかったのは 2 つ（一部だけ 1・この版では調べていない 1）」
 * after（整えたあとの読み直し）では「残っているのは」にする
 */
export function coverageSummary(rows: readonly CoverageRow[], phase: "before" | "after"): string {
  const looked = rows.filter((r) => r.state === "checked" || r.state === "partial").length;
  const found = rows.filter((r) => r.found + r.check > 0).length;
  const partial = rows.filter((r) => r.state === "partial").length;
  const failed = rows.filter((r) => r.state === "failed").length;
  const notIn = rows.filter((r) => r.state === "not_in_version").length;
  const extras = [partial ? `一部だけ ${partial}` : "", failed ? `調べられなかった ${failed}` : "", notIn ? `この版では調べていない ${notIn}` : ""].filter(Boolean);
  const head = `${rows.length} の型のうち ${looked} を調べた・${phase === "after" ? "残っているのは" : "見つかったのは"} ${found} つ`;
  return extras.length ? `${head}（${extras.join("・")}）` : head;
}

/** 仕切りで決める、結果の欄の幅の下限（rem）と、PDF の欄に残す幅の下限（rem） */
export const RESULTS_MIN_REM = 20;
export const STAGE_MIN_REM = 16;
/** 矢印キー 1 回で動かす幅（px）。Shift を押しながらのときは大きく */
export const SPLIT_STEP_PX = 24;
export const SPLIT_BIG_STEP_PX = 96;

/**
 * 結果の欄の幅を、上限と下限の中に収める。
 * available＝PDF の欄と結果の欄に使える幅（px。縮小したページの列・すき間・仕切りを除いたもの）、rootPx＝html の字の大きさ（px）
 */
export function clampResultsWidth(want: number, available: number, rootPx: number): number {
  const min = RESULTS_MIN_REM * rootPx;
  const max = Math.max(min, available - STAGE_MIN_REM * rootPx);
  return Math.round(Math.min(max, Math.max(min, want)));
}

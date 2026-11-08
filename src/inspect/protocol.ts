// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面と検査の Worker の間でやり取りする形。

import type { PrecheckResult } from "./precheck.ts";
import type { InspectSummary } from "./report.ts";

/** warm＝PDF を入れる前に、PDF.js と画像を解く部品を読み込んでおく（2026-11-06。PDF を入れた後に部品を読みに行かないため） */
/** after＝整えたあと・小さくしたあとの読み直し（整える前に覚えた、塗った下の字でも探す。redacted-text-elsewhere） */
export type InspectRequest = { type: "inspect"; id: number; buffer: ArrayBuffer; after?: boolean } | { type: "warm"; id: number };

export type InspectResponse =
  | { type: "progress"; id: number; done: number; total: number; label: string }
  | { type: "result"; id: number; precheck: PrecheckResult; summary: InspectSummary | null }
  | { type: "error"; id: number; message: string }
  | { type: "warm-done"; id: number; ok: boolean };

export type InspectProgress = { done: number; total: number; label: string };

/** 画面から見た、1つのファイルの検査の結果 */
export type InspectOutcome =
  | { kind: "done"; precheck: PrecheckResult; summary: InspectSummary | null; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number }
  | { kind: "error"; message: string; elapsedMs: number };

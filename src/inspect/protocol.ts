// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面と検査の Worker の間でやり取りする形。

import type { PrecheckResult } from "./precheck.ts";
import type { InspectSummary } from "./report.ts";

export type InspectRequest = { type: "inspect"; id: number; buffer: ArrayBuffer };

export type InspectResponse =
  | { type: "progress"; id: number; done: number; total: number; label: string }
  | { type: "result"; id: number; precheck: PrecheckResult; summary: InspectSummary | null }
  | { type: "error"; id: number; message: string };

export type InspectProgress = { done: number; total: number; label: string };

/** 画面から見た、1つのファイルの検査の結果 */
export type InspectOutcome =
  | { kind: "done"; precheck: PrecheckResult; summary: InspectSummary | null; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number }
  | { kind: "error"; message: string; elapsedMs: number };

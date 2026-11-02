// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面と検査の Worker の間でやり取りする形。

import type { PrecheckResult } from "./precheck";

export type InspectRequest = { type: "inspect"; id: number; buffer: ArrayBuffer };

export type InspectResponse =
  | { type: "result"; id: number; precheck: PrecheckResult }
  | { type: "error"; id: number; message: string };

/** 画面から見た、1つのファイルの検査の結果 */
export type InspectOutcome =
  | { kind: "done"; precheck: PrecheckResult; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number }
  | { kind: "error"; message: string; elapsedMs: number };

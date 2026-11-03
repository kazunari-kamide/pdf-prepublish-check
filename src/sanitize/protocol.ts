// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面と片付けの Worker の間でやり取りする形（sanitize/README.md「画面へのつなぎ方」の案のとおり）。
// 返すのは片付けた PDF と、取り除いた項目・片付けられなかった所の数と場所だけ。字の中身は入らない（sanitize/types.ts）。

import type { NotDoneItem, RemovedItem } from "../../sanitize/types.ts";

export type SanitizeRequest = { type: "sanitize"; id: number; buffer: ArrayBuffer };

export type SanitizeResponse =
  | { type: "sanitized"; id: number; buffer: ArrayBuffer; pages: number; removed: RemovedItem[]; notDone: NotDoneItem[]; decrypted: boolean }
  /** 片付けを始められなかったとき（パスワードが要る・読めない など）。message は画面にそのまま出せる文 */
  | { type: "refused"; id: number; message: string }
  | { type: "error"; id: number; message: string };

/** 画面から見た、片付けの結果 */
export type SanitizeOutcome =
  | { kind: "done"; bytes: Uint8Array; pages: number; removed: RemovedItem[]; notDone: NotDoneItem[]; decrypted: boolean; elapsedMs: number }
  | { kind: "refused"; message: string; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number }
  | { kind: "error"; message: string; elapsedMs: number };

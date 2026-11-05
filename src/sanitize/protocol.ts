// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面と片付けの Worker の間でやり取りする形（sanitize/README.md「画面へのつなぎ方」の案のとおり）。
// 返すのは片付けた PDF と、取り除いた項目・片付けられなかった所・残りの数と場所だけ。字の中身は入らない（sanitize/types.ts）。

import type { NotDoneItem, RedactLeftover, RemovedItem } from "../../sanitize/types.ts";

import type { RedactArea } from "./areas.ts";

/** areas＝利用者が自分で選んだ黒塗りの所（あれば片付けの redact、なければ sanitizePdf） */
export type SanitizeRequest = { type: "sanitize"; id: number; buffer: ArrayBuffer; areas?: RedactArea[] };

export type SanitizeResponse =
  | { type: "sanitized"; id: number; buffer: ArrayBuffer; pages: number; removed: RemovedItem[]; notDone: NotDoneItem[]; decrypted: boolean }
  /** 自分で黒塗りした PDF を保存の前に読み直したら、残りが見つかった。PDF は返さない（保存させない） */
  | { type: "redact_blocked"; id: number; removed: RemovedItem[]; notDone: NotDoneItem[]; leftovers: RedactLeftover[] }
  /** 片付けを始められなかったとき（パスワードが要る・読めない など）。message は画面にそのまま出せる文 */
  | { type: "refused"; id: number; message: string }
  | { type: "error"; id: number; message: string };

/** 画面から見た、片付けの結果 */
export type SanitizeOutcome =
  | { kind: "done"; bytes: Uint8Array; pages: number; removed: RemovedItem[]; notDone: NotDoneItem[]; decrypted: boolean; elapsedMs: number }
  | { kind: "blocked"; removed: RemovedItem[]; notDone: NotDoneItem[]; leftovers: RedactLeftover[]; elapsedMs: number }
  | { kind: "refused"; message: string; elapsedMs: number }
  | { kind: "timeout"; elapsedMs: number }
  | { kind: "error"; message: string; elapsedMs: number };

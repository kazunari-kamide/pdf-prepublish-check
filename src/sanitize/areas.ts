// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする所の形と上限（11/5 B の 9）。画面（main.ts）と片付けの Worker の両方から使う。
// 形は片付けの redact（sanitize/types.ts の RedactArea）と同じものを使う。型だけを読むので、画面に pdf-lib は入らない。

export type { RedactArea } from "../../sanitize/types.ts";

/** 1回に選べる所の上限【仮の値】（片付けの redact の上限 1 万より小さく、画面の一覧が長くなりすぎない数） */
export const MAX_REDACT_AREAS = 200;

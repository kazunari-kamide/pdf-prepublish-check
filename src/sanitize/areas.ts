// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする所の形と上限（11/5 B の 9）。画面（main.ts）と片付けの Worker の両方から使う。
// 画面から pdf-lib を読み込まないよう、pdf-lib を使う src/sanitize/redact.ts とは分けて置く（画面の JavaScript を軽く保つ）。

import type { Rect } from "../inspect/report";

export type RedactArea = { page: number; rect: Rect };

/** 1回に選べる所の上限【仮の値】 */
export const MAX_REDACT_AREAS = 200;

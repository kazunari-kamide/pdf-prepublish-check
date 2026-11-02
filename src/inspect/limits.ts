// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査の上限。CLAUDE.md §5・§11-3。
// どれも【仮の値】。重いページや巨大なファイルの合成 PDF で測ってから決め直す（docs/prd.md §5）。

/** 受け付けるファイルの大きさの上限（バイト）【仮の値】 */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

/** 1つのファイルの検査にかけてよい時間（ミリ秒）。超えたら Worker を止める【仮の値】 */
export const WORKER_TIMEOUT_MS = 60_000;

/** ファイルの先頭のどこまでに「%PDF-」があればよいか（バイト） */
export const HEADER_SEARCH_BYTES = 1024;

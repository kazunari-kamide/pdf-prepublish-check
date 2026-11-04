// SPDX-License-Identifier: AGPL-3.0-only
//
// 重い PDF を扱うテストの時間の上限。既定の 5 秒では、GitHub Actions の機械（手元より 2 倍以上遅い）で時間切れになることがある。
// 2026-11-05 に手元で 0.5 秒以上かかったテストのうち、まだ上限を付けていないものに付ける（中身と期待は変えない）。
export const HEAVY_TIMEOUT = 30_000;

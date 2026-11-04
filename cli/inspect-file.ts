// SPDX-License-Identifier: AGPL-3.0-only
//
// 1つのファイルを、形式を見分けてから調べる。Node の API は使わない（Worker の中から呼ぶ）。

import { inspectPdf } from "./inspect-pdf.ts";
import type { FileReport } from "./report.ts";

export async function inspectFile(bytes: Uint8Array): Promise<FileReport> {
  return inspectPdf(bytes);
}

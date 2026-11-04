// SPDX-License-Identifier: AGPL-3.0-only
//
// PDF 以外の形式の入口。画面からもコマンドの道具からも呼べる（Node の API を使わない）。
// 形式は先頭のバイトで見分ける。PDF は src/inspect の検査に回すので、ここでは調べない。
// いまは「知らせる」まで（消す・画面に出すは、まだ作らない）。

import { detectFormat } from "./detect.ts";
import { inspectImage } from "./image.ts";
import { inspectOffice } from "./office.ts";
import type { FormatKind, FormatReport } from "./types.ts";

export { detectFormat } from "./detect.ts";
export { FORMATS_VERSION, type FormatFinding, type FormatKind, type FormatNotice, type FormatReport } from "./types.ts";

/** 受け付けるファイルの大きさの上限（バイト）【仮の値】。PDF と同じ */
export const MAX_FORMAT_BYTES = 200 * 1024 * 1024;

export async function inspectFormat(bytes: Uint8Array, kind: FormatKind = detectFormat(bytes)): Promise<FormatReport> {
  if (bytes.length === 0) return { format: "unknown", findings: [], notices: [{ kind: "broken", message: "ファイルが空です。", unchecked: true }] };
  if (bytes.length > MAX_FORMAT_BYTES) {
    const mb = Math.floor(MAX_FORMAT_BYTES / (1024 * 1024));
    return { format: kind, findings: [], notices: [{ kind: "too_large", message: `ファイルが大きすぎるため、検査できません（上限は ${mb}MB です）。`, unchecked: true }] };
  }
  switch (kind) {
    case "jpeg":
    case "png":
    case "webp":
    case "heic":
      return inspectImage(bytes, kind);
    case "zip":
    case "docx":
    case "xlsx":
    case "pptx":
      return inspectOffice(bytes);
    case "cfb":
      return {
        format: "cfb",
        findings: [],
        notices: [{ kind: "unsupported", message: "古い形式の Office・一太郎・パスワードのかかった Office のファイルは、調べていません。", unchecked: true }],
      };
    case "pdf":
      return { format: "pdf", findings: [], notices: [{ kind: "unsupported", message: "PDF は、PDF の検査で調べます。", unchecked: true }] };
    default:
      return { format: "unknown", findings: [], notices: [{ kind: "unsupported", message: "調べられない形式のファイルです（PDF・写真・今の Office のほかは調べていません）。", unchecked: true }] };
  }
}

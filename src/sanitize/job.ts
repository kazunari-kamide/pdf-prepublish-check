// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付けの Worker の中身（src/worker/sanitize.worker.ts から呼ぶ。Worker の外でもテストできるよう、ここに分ける）。
// - 自分で選んだ所があれば、片付けの redact（sanitize/redact.ts）：選んだ所を本当に消し、保存の前に選んだ所を読み直す。
//   残りが見つかれば PDF は返さない（blocked）。
// - なければ、ふつうの片付け（sanitizePdf）。何も選ばない redact は sanitizePdf と同じ PDF になる（sanitize/README.md）。
// - 全部のルールでの読み直しは、ここではしない。画面が、片付けた PDF を検査の入口に最初から入れ直して行う
//   （同じ検査を2回回さないため。捨てた案：ここでも rulesCheck(inspectAll) を redact に渡す）。

import { redact, sanitizePdf } from "../../sanitize/index.ts";
import type { ImageCodec, NotDoneItem, RedactLeftover, RemovedItem } from "../../sanitize/types.ts";
import type { RedactArea } from "./areas.ts";

export type SanitizeJobResult =
  | { type: "sanitized"; bytes: Uint8Array; pages: number; removed: RemovedItem[]; notDone: NotDoneItem[]; decrypted: boolean }
  | { type: "redact_blocked"; removed: RemovedItem[]; notDone: NotDoneItem[]; leftovers: RedactLeftover[] }
  | { type: "refused"; message: string };

export async function sanitizeJob(input: Uint8Array, areas: unknown, codec?: ImageCodec): Promise<SanitizeJobResult> {
  const options = codec ? { codec } : {};
  const picked = Array.isArray(areas) ? (areas as RedactArea[]) : [];
  const r = picked.length ? await redact(input, picked, options) : await sanitizePdf(input, options);
  if (r.status === "error") return { type: "refused", message: r.message };
  if (r.status === "blocked") return { type: "redact_blocked", removed: r.removed, notDone: r.notDone, leftovers: r.leftovers };
  return { type: "sanitized", bytes: r.bytes, pages: r.pages, removed: r.removed, notDone: r.notDone, decrypted: r.decrypted };
}

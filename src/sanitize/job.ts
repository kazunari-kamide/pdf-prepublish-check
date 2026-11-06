// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付けの Worker の中身（src/worker/sanitize.worker.ts から呼ぶ。Worker の外でもテストできるよう、ここに分ける）。
// - 自分で選んだ所があれば、片付けの redact（sanitize/redact.ts）：選んだ所を本当に消し、保存の前に選んだ所を読み直す。
//   残りが見つかれば PDF は返さない（blocked）。
// - なければ、ふつうの片付け（sanitizePdf）。何も選ばない redact は sanitizePdf と同じ PDF になる（sanitize/README.md）。
// - 全部のルールでの読み直しは、ここではしない。画面が、片付けた PDF を検査の入口に最初から入れ直して行う
//   （同じ検査を2回回さないため。捨てた案：ここでも rulesCheck(inspectAll) を redact に渡す）。

import { compress, preflightTidy, redact, sanitizePdf } from "../../sanitize/index.ts";
import type { CompressImages, CompressIncrease, ImageCodec, NotDoneItem, PropertyChange, RedactCheck, RedactLeftover, RemovedItem, TidyPreflight } from "../../sanitize/types.ts";
import type { TidyChoices } from "./protocol.ts";
import type { RedactArea } from "./areas.ts";

export type SanitizeJobResult =
  | { type: "sanitized"; bytes: Uint8Array; pages: number; removed: RemovedItem[]; notDone: NotDoneItem[]; decrypted: boolean; properties?: PropertyChange[] }
  | { type: "redact_blocked"; removed: RemovedItem[]; notDone: NotDoneItem[]; leftovers: RedactLeftover[] }
  | { type: "refused"; message: string };

export async function sanitizeJob(input: Uint8Array, areas: unknown, codec?: ImageCodec, tidy: TidyChoices = {}): Promise<SanitizeJobResult> {
  // 本人が選んだこと（プロパティ・PDF/A の印・電子署名）は、ふつうの片付けにも、自分で黒塗りする redact にも同じく渡す
  const options = { ...(codec ? { codec } : {}), ...tidyOptions(tidy) };
  const picked = Array.isArray(areas) ? (areas as RedactArea[]) : [];
  const r = picked.length ? await redact(input, picked, options) : await sanitizePdf(input, options);
  if (r.status === "error") return { type: "refused", message: r.message };
  if (r.status === "blocked") return { type: "redact_blocked", removed: r.removed, notDone: r.notDone, leftovers: r.leftovers };
  return { type: "sanitized", bytes: r.bytes, pages: r.pages, removed: r.removed, notDone: r.notDone, decrypted: r.decrypted, ...("properties" in r && r.properties ? { properties: r.properties } : {}) };
}

/** 画面から来た選んだことを、片付けの設定の形にする（知らない値は渡さない。片付けの側でも確かめる） */
function tidyOptions(t: TidyChoices) {
  return {
    ...(t.properties && typeof t.properties === "object" ? { properties: t.properties } : {}),
    ...(t.pdfaMark === "keep" || t.pdfaMark === "remove" ? { pdfaMark: t.pdfaMark } : {}),
    ...(t.signatures === "keep" || t.signatures === "remove" ? { signatures: t.signatures } : {}),
    ...(Array.isArray(t.keep) ? { keep: t.keep.filter((p): p is string => typeof p === "string") } : {}),
  };
}

/** 整える前に聞く：プロパティの今の値・PDF/A の印・電子署名の数（片付けの preflightTidy） */
export async function preflightJob(input: Uint8Array): Promise<TidyPreflight> {
  return preflightTidy(input);
}

export type CompressJobResult =
  | { type: "compressed"; bytes: Uint8Array; sizeBefore: number; sizeAfter: number; changed: boolean; images: CompressImages }
  | { type: "compress_blocked"; sizeBefore: number; sizeAfter: number; increased: CompressIncrease[] }
  | { type: "refused"; message: string };

/**
 * 片付けた PDF を小さくする（片付けの compress）。小さくする前と後に、作品の検査（checks）を同じようにかけ、
 * 種類ごとの残りが増えたら PDF を返さない（compress_blocked）。画像の道具がないと小さくできない（no_codec）。
 * 画面は、返った PDF をもう一度検査の入口に入れ直し、保存できるかを片付けと同じ決まり（saveGate）で決める
 */
export async function compressJob(
  input: Uint8Array,
  preset: { maxDpi: number; jpegQuality: number },
  codec: ImageCodec | undefined,
  checks: RedactCheck[],
): Promise<CompressJobResult> {
  if (!codec) return { type: "refused", message: "画像を書き直す道具を読み込めなかったため、小さくできません。" };
  const r = await compress(input, { codec, maxDpi: preset.maxDpi, jpegQuality: preset.jpegQuality, checks });
  if (r.status === "error") return { type: "refused", message: r.message };
  if (r.status === "blocked") return { type: "compress_blocked", sizeBefore: r.sizeBefore, sizeAfter: r.sizeAfter, increased: r.increased };
  return { type: "compressed", bytes: r.bytes, sizeBefore: r.sizeBefore, sizeAfter: r.sizeAfter, changed: r.changed, images: r.images };
}

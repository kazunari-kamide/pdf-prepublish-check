// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付け：見つかった危ない所を取り除いた PDF を、ブラウザの中で作る（Node でも同じコードで動く）。
// 通信はしない。入力の PDF は細工されている前提で扱い、読めないページは「片付けられなかった所」に入れて隠さない。
//
// 使い方（画面へのつなぎ方は sanitize/README.md）：
//   const r = await sanitizePdf(bytes);
//   if (r.status === "ok") { r.bytes（片付けた PDF）, r.removed（取り除いた項目）, r.notDone（片付けられなかった所） }
//   自分で黒塗りする：redact(bytes, areas, options)（redact.ts）
//   ファイルを小さくする：compress(bytes, options)（compress.ts。片付けのあとの PDF に使う）
//
// 順番：
//   1. 読む（rules/shared/load.ts。パスワードなしで開ける暗号化は外して読む）
//   2. ページごとに、P6（覆いの下の字・画素、未適用の墨消し、選んだ場所）と P7（見えない字）を片付ける（content.ts）
//   3. 文書全体の P1・P2・P8・P9・P12 を片付ける（structure.ts）
//   4. 文書の根からたどれないものを捨て、1つの版として書き出す（P5）。圧縮の設定・パスワードはまだ入れない

import type { PDFDocument, PDFObject } from "pdf-lib";
import { isInflateLimitError } from "../rules/shared/inflate-limit.ts";
import { loadPdf } from "../rules/shared/load.ts";
import type { Rect } from "../rules/p6-text/geometry.ts";
import { SETTINGS, TooManyOperations, makeVisibility, sanitizePageContent } from "./content.ts";
import { cleanAnnotations, countRevisions, dropUnreachable, removeAttachments, removeStructureExtras, removeJavaScript, removeXmp } from "./structure.ts";
import { applyProperties, checkEdits, checkOldValues, handleSignatures, preflightTidy as preflight, readOriginal } from "./properties.ts";
import { cleanLeftovers } from "./leftovers.ts";
import { pruneFonts } from "./font-prune.ts";
import type { NotDoneItem, PropertyChange, RemovedItem, SanitizeOptions, SanitizeResult, TidyPreflight } from "./types.ts";

export type * from "./types.ts";
export { redact } from "./redact.ts";
export { compress, COMPRESS_DPI, COMPRESS_QUALITY } from "./compress.ts";

// 0.9.1：解くと大きすぎる中身（圧縮の爆弾）のページは stream_too_large として片付けられなかった所にし、
//        ページの外で止まったとき（読み込み・文書全体）は、片付けた PDF を作らない（rules/shared/inflate-limit.ts）
export const SANITIZER_VERSION = "0.9.1";

/** 入力の大きさの上限（バイト）。画面の上限とは別に、ここでも止める */
export const MAX_INPUT_BYTES = 512 * 1024 * 1024;

type ErrorResult = Extract<SanitizeResult, { status: "error" }>;

/** 片付けの途中に、呼ぶ側（redact.ts）が足す作業 */
export type SanitizeHooks = {
  /** ページ番号（1から）→ 利用者が選んだ場所 */
  areas?: Map<number, Rect[]>;
  /** ページの中身を片付ける前（黒塗りの前に使っていた字のコードを数える） */
  beforePages?: (doc: PDFDocument) => void;
  /** ページの中身を片付けたあと、文書全体の片付けの前（選んだ場所に掛かる注釈・フォームの欄を外す） */
  afterPages?: (doc: PDFDocument) => RemovedItem[];
  /** 文書全体の片付けのあと、たどれないものを捨てる前（字の対応表を絞る） */
  beforeDrop?: (doc: PDFDocument) => RemovedItem[];
};

export type SanitizeCore =
  | { status: "ok"; bytes: Uint8Array; pages: number; removed: RemovedItem[]; notDone: NotDoneItem[]; decrypted: boolean; properties?: PropertyChange[] }
  | ErrorResult;

/**
 * 片付けの本体（sanitizePdf と redact が使う）。
 * 解くと大きすぎる所で、ページの外（読み込み・文書全体の片付け・書き出し）が止まったときは、片付けた PDF を作らない
 * （どこを片付けられなかったか言えないまま、保存させないため）。
 */
export async function sanitizeCore(bytes: Uint8Array, options: SanitizeOptions = {}, hooks: SanitizeHooks = {}): Promise<SanitizeCore> {
  try {
    return await sanitizeBody(bytes, options, hooks);
  } catch (e) {
    if (isInflateLimitError(e)) return { status: "error", code: "too_large", message: "解くと大きすぎる所があるため、片付けられません。" };
    throw e;
  }
}

async function sanitizeBody(bytes: Uint8Array, options: SanitizeOptions, hooks: SanitizeHooks): Promise<SanitizeCore> {
  if (bytes.length === 0) return { status: "error", code: "empty", message: "ファイルが空です。" };
  if (bytes.length > MAX_INPUT_BYTES) return { status: "error", code: "too_large", message: "ファイルが大きすぎるため、整えられません。" };
  const edits = options.properties !== undefined ? checkEdits(options.properties) : null;
  if (edits && !edits.ok) return { status: "error", code: "bad_properties", message: edits.message };
  const settings = {
    ...SETTINGS,
    ...(options.maxOperationsPerPage !== undefined ? { maxOperationsPerPage: options.maxOperationsPerPage } : {}),
    ...(options.maxImageBytes !== undefined ? { maxImageBytes: options.maxImageBytes } : {}),
    ...(options.maxImagePixels !== undefined ? { maxImagePixels: options.maxImagePixels } : {}),
  };

  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") {
    if (loaded.code === "encrypted") {
      return {
        status: "error", code: "encrypted",
        message: loaded.reason === "password_required" ? "パスワードが要る PDF は、整えられません。" : "この形の暗号化は、いまは整えられません。",
      };
    }
    return { status: "error", code: "unreadable", message: "PDF として読めませんでした。" };
  }
  const doc = loaded.doc;
  const ctx = doc.context;
  const removed: RemovedItem[] = [];
  const notDone: NotDoneItem[] = [];
  // 元のプロパティ・PDF/A の印（文書全体の片付けで XMP を外す前に読む）
  const original = readOriginal(ctx);

  let pages;
  try {
    pages = doc.getPages();
  } catch {
    return { status: "error", code: "unreadable", message: "ページの並びを読めませんでした。" };
  }

  // 2. ページの中身
  const visible = makeVisibility(ctx, doc.catalog);
  const redactAnnots = new Set<PDFObject>();
  hooks.beforePages?.(doc);
  for (const [index, page] of pages.entries()) {
    const pageNo = index + 1;
    const areas = hooks.areas?.get(pageNo) ?? [];
    try {
      const r = await sanitizePageContent(ctx, page, pageNo, visible, settings, options.codec, options.trace, areas);
      removed.push(...r.removed);
      notDone.push(...r.notDone);
      for (const a of r.redactAnnots) redactAnnots.add(a);
    } catch (e) {
      const heavy = e instanceof TooManyOperations;
      if (isInflateLimitError(e)) {
        // 解くと大きすぎる中身（圧縮の爆弾など）：このページは書き換えずに残すので、片付けられなかった所にする
        options.trace?.({ type: "page_error", page: pageNo, error: "stream_too_large" });
        notDone.push({
          pattern: "P6",
          reason: "stream_too_large",
          page: pageNo,
          label: areas.length
            ? "このページは、解くと大きすぎる中身があるため、選んだ所を消せませんでした"
            : "このページは、解くと大きすぎる中身があるため、黒い四角の下の字・見えない字の片付けを省きました",
        });
        continue;
      }
      options.trace?.({ type: "page_error", page: pageNo, error: heavy ? "too_many_operations" : "unreadable_page" });
      notDone.push({
        pattern: "P6",
        reason: heavy ? "too_many_operations" : "unreadable_page",
        page: pageNo,
        label: areas.length
          ? heavy
            ? "このページは図形が多すぎるため、選んだ所を消せませんでした"
            : "このページの中身を読めなかったため、選んだ所を消せませんでした"
          : heavy
            ? "このページは図形が多すぎるため、黒い四角の下の字・見えない字を整えるのを省きました"
            : "このページの中身を読めなかったため、黒い四角の下の字・見えない字を整えるのを省きました",
      });
    }
  }
  if (hooks.afterPages) removed.push(...hooks.afterPages(doc));

  // 3. 文書全体（電子署名は、注釈の片付けより先に。署名の見た目も署名と一緒に外す）
  const sig = handleSignatures(doc, options.signatures ?? "remove");
  removed.push(...sig.removed);
  notDone.push(...sig.notDone);
  removed.push(...cleanAnnotations(doc, redactAnnots));
  removed.push(...removeAttachments(doc));
  removed.push(...removeJavaScript(ctx));
  removed.push(...removeXmp(ctx));
  // 文書情報と文書の XMP：選んだ値で書き直す（指定がなければ消す）
  const props = applyProperties(doc, original, edits?.ok ? edits.edits : null, options.pdfaMark ?? "remove");
  removed.push(...props.removed);
  notDone.push(...props.notDone);
  removed.push(...removeStructureExtras(doc));
  const left = cleanLeftovers(doc);
  removed.push(...left.removed);
  notDone.push(...left.notDone);
  // 描かれていない字形を書体から外す（0.8.0 から。ページの片付けのあとの中身で数える）
  const pruned = pruneFonts(doc, settings.maxOperationsPerPage * Math.max(1, pages.length));
  removed.push(...pruned.removed);
  notDone.push(...pruned.notDone);
  if (hooks.beforeDrop) removed.push(...hooks.beforeDrop(doc));

  // 4. 1つの版にまとめる
  ctx.trailerInfo.Encrypt = undefined;
  const revisions = countRevisions(bytes);
  const dropped = dropUnreachable(ctx);
  if (revisions > 1) {
    removed.push({ pattern: "P5", kind: "previous_versions", count: revisions - 1, label: `前の版（${revisions - 1} 回分の書き足し）を残さず、1つの版にまとめました` });
  }
  if (dropped > 0) {
    removed.push({ pattern: "P5", kind: "unused_objects", count: dropped, label: `どこからも使われていない中身（${dropped} 個）を消しました` });
  }

  let out: Uint8Array;
  try {
    // updateFieldAppearances：フォームの見た目を作り直さない（書体を足さない）。useObjectStreams：古い読み手でも読める形にする
    out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false });
  } catch {
    return { status: "error", code: "unreadable", message: "整えた PDF を書き出せませんでした。" };
  }
  if (edits) {
    // 書き直した・消したプロパティの古い値が、書き出したバイト列に残っていないか、読み直して確かめる
    const left = await checkOldValues(out, props.search);
    if (left.found > 0 || left.unreadable > 0) {
      return {
        status: "error", code: "properties_left",
        message: left.found > 0
          ? "書き直した・消したプロパティの古い値が、PDF の中に残っていたため、整えた PDF を作りませんでした。"
          : "PDF の中の一部を読み直せず、プロパティの古い値が残っていないかを確かめきれなかったため、整えた PDF を作りませんでした。",
      };
    }
    return { status: "ok", bytes: out, pages: pages.length, removed, notDone, decrypted: loaded.decrypted !== null, properties: props.changes };
  }
  return { status: "ok", bytes: out, pages: pages.length, removed, notDone, decrypted: loaded.decrypted !== null };
}

/** 整える前に知らせること（今のプロパティ・PDF/A の印・電子署名の数）。画面は、これを見て同意を取ってから sanitizePdf を呼ぶ */
export async function preflightTidy(bytes: Uint8Array): Promise<TidyPreflight> {
  return preflight(bytes, MAX_INPUT_BYTES);
}

export async function sanitizePdf(bytes: Uint8Array, options: SanitizeOptions = {}): Promise<SanitizeResult> {
  return sanitizeCore(bytes, options);
}

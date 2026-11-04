// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付け：見つかった危ない所を取り除いた PDF を、ブラウザの中で作る（Node でも同じコードで動く）。
// 通信はしない。入力の PDF は細工されている前提で扱い、読めないページは「片付けられなかった所」に入れて隠さない。
//
// 使い方（画面へのつなぎ方は sanitize/README.md）：
//   const r = await sanitizePdf(bytes);
//   if (r.status === "ok") { r.bytes（片付けた PDF）, r.removed（取り除いた項目）, r.notDone（片付けられなかった所） }
//
// 順番：
//   1. 読む（rules/shared/load.ts。パスワードなしで開ける暗号化は外して読む）
//   2. ページごとに、P6（覆いの下の字・画素、未適用の墨消し）と P7（見えない字）を片付ける（content.ts）
//   3. 文書全体の P1・P2・P8・P9・P12 を片付ける（structure.ts）
//   4. 文書の根からたどれないものを捨て、1つの版として書き出す（P5）。圧縮の設定・パスワードはまだ入れない

import type { PDFObject } from "pdf-lib";
import { loadPdf } from "../rules/shared/load.ts";
import { SETTINGS, TooManyOperations, makeVisibility, sanitizePageContent } from "./content.ts";
import { cleanAnnotations, countRevisions, dropUnreachable, removeAttachments, removeDocInfo, removeStructureExtras, removeJavaScript, removeXmp } from "./structure.ts";
import type { NotDoneItem, RemovedItem, SanitizeOptions, SanitizeResult } from "./types.ts";

export type * from "./types.ts";

export const SANITIZER_VERSION = "0.3.1";

/** 入力の大きさの上限（バイト）。画面の上限とは別に、ここでも止める */
const MAX_INPUT_BYTES = 512 * 1024 * 1024;

export async function sanitizePdf(bytes: Uint8Array, options: SanitizeOptions = {}): Promise<SanitizeResult> {
  if (bytes.length === 0) return { status: "error", code: "empty", message: "ファイルが空です。" };
  if (bytes.length > MAX_INPUT_BYTES) return { status: "error", code: "too_large", message: "ファイルが大きすぎるため、片付けられません。" };
  const settings = {
    ...SETTINGS,
    ...(options.maxOperationsPerPage !== undefined ? { maxOperationsPerPage: options.maxOperationsPerPage } : {}),
    ...(options.maxImageBytes !== undefined ? { maxImageBytes: options.maxImageBytes } : {}),
  };

  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") {
    if (loaded.code === "encrypted") {
      return {
        status: "error", code: "encrypted",
        message: loaded.reason === "password_required" ? "パスワードが要る PDF は、片付けられません。" : "この形の暗号化は、いまは片付けられません。",
      };
    }
    return { status: "error", code: "unreadable", message: "PDF として読めませんでした。" };
  }
  const doc = loaded.doc;
  const ctx = doc.context;
  const removed: RemovedItem[] = [];
  const notDone: NotDoneItem[] = [];

  let pages;
  try {
    pages = doc.getPages();
  } catch {
    return { status: "error", code: "unreadable", message: "ページの並びを読めませんでした。" };
  }

  // 2. ページの中身
  const visible = makeVisibility(ctx, doc.catalog);
  const redactAnnots = new Set<PDFObject>();
  pages.forEach((page, index) => {
    const pageNo = index + 1;
    try {
      const r = sanitizePageContent(ctx, page, pageNo, visible, settings);
      removed.push(...r.removed);
      notDone.push(...r.notDone);
      for (const a of r.redactAnnots) redactAnnots.add(a);
    } catch (e) {
      const heavy = e instanceof TooManyOperations;
      notDone.push({
        pattern: "P6",
        reason: heavy ? "too_many_operations" : "unreadable_page",
        page: pageNo,
        label: heavy
          ? "このページは図形が多すぎるため、黒い四角の下の字・見えない字の片付けを省きました"
          : "このページの中身を読めなかったため、黒い四角の下の字・見えない字の片付けを省きました",
      });
    }
  });

  // 3. 文書全体
  removed.push(...cleanAnnotations(doc, redactAnnots));
  removed.push(...removeAttachments(doc));
  removed.push(...removeJavaScript(ctx));
  removed.push(...removeXmp(ctx));
  removed.push(...removeDocInfo(doc));
  removed.push(...removeStructureExtras(doc));

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
    return { status: "error", code: "unreadable", message: "片付けた PDF を書き出せませんでした。" };
  }
  return { status: "ok", bytes: out, pages: pages.length, removed, notDone, decrypted: loaded.decrypted !== null };
}


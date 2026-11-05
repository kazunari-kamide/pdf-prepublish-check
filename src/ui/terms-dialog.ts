// SPDX-License-Identifier: AGPL-3.0-only
//
// 利用規約のダイアログ。検査のページの「利用規約」のリンクを押したとき、ページを移らずに、その場で規約を読めるようにする
// （移ると最初の画面に戻ってこない人がいるため。2026-11-05 本人の頼み）。
// - 規約の文は、ビルドの時に site.ts が index.html の中へ入れておく（src/site/pages.ts の renderTermsDialog）。開くときに通信はしない。
// - リンクの href は利用規約のページのまま。新しいタブ・中クリック・修飾キーつきのクリックでは、ふつうにそのページを開く。
//   止めるのは、修飾キーなしの左クリック（と Enter）だけ。
// - 閉じるボタン・Esc・ダイアログの外を押して閉じる。開いたら見出しに、閉じたら押したリンクにフォーカスを戻す。

import { isOutside, isPlainClick } from "./terms-click";

export function setupTermsDialog(doc: Document = document): void {
  const dialog = doc.getElementById("terms-dialog");
  if (!(dialog instanceof HTMLDialogElement) || typeof dialog.showModal !== "function") return; // ないときは、ふつうのリンクのまま
  const page = dialog.dataset.page;
  const title = doc.getElementById("terms-dialog-title");
  const close = doc.getElementById("terms-dialog-close");
  if (!page || !title || !close) return;
  let opener: HTMLElement | null = null;

  doc.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a") : null;
    if (!a || a.getAttribute("href") !== page || dialog.contains(a) || !isPlainClick(e)) return;
    e.preventDefault();
    opener = a;
    dialog.showModal();
    title.focus();
    const body = dialog.querySelector(".terms-dialog-body");
    if (body) body.scrollTop = 0;
  });

  close.addEventListener("click", () => dialog.close());
  // 外側（::backdrop）を押したとき。中の字を選ぶドラッグが外で終わっても閉じないよう、押し始めも離した所も外のときだけ
  const onBackdrop = (e: MouseEvent) => e.target === dialog && isOutside(e.clientX, e.clientY, dialog.getBoundingClientRect());
  let downOutside = false;
  dialog.addEventListener("pointerdown", (e) => {
    downOutside = onBackdrop(e);
  });
  dialog.addEventListener("click", (e) => {
    if (downOutside && onBackdrop(e)) dialog.close();
    downOutside = false;
  });
  // Esc はブラウザが閉じる（cancel → close）。どの閉じ方でも、押したリンクにフォーカスを戻す
  dialog.addEventListener("close", () => {
    const back = opener;
    opener = null;
    if (back && back.isConnected) back.focus();
  });
}

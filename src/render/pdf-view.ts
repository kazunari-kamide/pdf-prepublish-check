// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの絵を描く（PDF.js）。検査（src/worker/inspect.worker.ts）とは別に動き、判定には使わない。見せるためだけに使う。
//
// 通信しないための設定（2026-11-03 本人が決定。docs/no-network.md）：
// - 渡すのはバイト列だけ（data）。URL から読む道（url・range・stream）は使わない。
// - 2026-11-06 本人が決定（案 B）：CCITT・JBIG2・JPEG 2000 の画像を解く部品（WASM の代わりの JS）と字の対応表（cMap）は、
//   配信の中の /pdfjs/ に置いたもの（pdfjs-dist の写し。src/render/pdfjs-parts.ts）を、自分の配信先から読む。
//   前は渡さなかったため、スキャンの画像がまっ白になり、埋め込まれていない日本語の字が描かれなかった。
//   cMap は、この画面（主のスレッド）が fetch で読み、PDF.js の Worker に渡す（useWorkerFetch: false）。検査のページの CSP だけ connect-src 'self'（csp.ts）。
//   標準の書体（standardFontDataUrl）と ICC（色の変換）は渡さない（理由は src/render/pdfjs-parts.ts）。
// - useWorkerFetch: false、useWasm: false（WASM は使わず、代わりの JS を import() で読む。'wasm-unsafe-eval' は足さない）。
// - CVE-2024-4367（書体の処理で eval を使っていた）の設定 isEvalSupported は、6.x にはない。6.4.299 の build/ に
//   eval・new Function は 0 件（2026-11-03 に数えた）。
// - それでも中のコードには fetch などが残る。ページ全体の CSP（connect-src 'none'）で止め、
//   ブラウザで外への要求が0件であることを scripts/check-browser.mjs で確かめる。
//
// 図形の多いページでブラウザを止めないため（CLAUDE.md §5）：
// - 1ページを描く時間に上限をかけ、超えたら描くのをやめて、PDF.js の Worker ごと止める。
// - 検査で「図形が多すぎる」と省いたページは、描かない（呼ぶ側で決める）。

import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
// PDF.js は、npm の pdfjs-dist のファイルを、手を加えずにそのまま配る（?url）。バンドルして混ぜないのは、
// scripts/check-dist.mjs が「pdfjs-dist と1バイトも違わないファイル」だけに通信の仕組みを許すため（docs/no-network.md）。
import pdfjsUrl from "pdfjs-dist/build/pdf.min.mjs?url";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFJS_CMAP_URL, PDFJS_WASM_URL } from "./pdfjs-parts";

/** 1ページを描く時間の上限（ミリ秒）【仮の値】。検査の Worker の上限（60秒）より短くし、絵のせいで待たせない */
export const RENDER_TIMEOUT_MS = 8_000;

export type OpenResult =
  | { ok: true; view: PdfView }
  | { ok: false; reason: "password" | "unreadable" };

type Pdfjs = typeof import("pdfjs-dist");
let loaded: Promise<Pdfjs> | null = null;

/** PDF.js は大きいので、PDF を受け取ってから読み込む（別のファイルに分かれる） */
function pdfjs(): Promise<Pdfjs> {
  loaded ??= (import(/* @vite-ignore */ pdfjsUrl) as Promise<Pdfjs>).then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  return loaded;
}

export class RenderTimeout extends Error {}

export class PdfView {
  private broken = false;
  private constructor(
    private readonly task: PDFDocumentLoadingTask,
    private readonly doc: PDFDocumentProxy,
  ) {}

  static async open(bytes: Uint8Array): Promise<OpenResult> {
    const lib = await pdfjs();
    const task = lib.getDocument({
      data: bytes,
      useWorkerFetch: false,
      useWasm: false,
      wasmUrl: PDFJS_WASM_URL,
      cMapUrl: PDFJS_CMAP_URL,
      cMapPacked: true,
      enableXfa: false,
      // PDF の中の書体を、ブラウザの書体（@font-face）として読ませない。字は PDF.js が形をなぞって描く。
      // 細工した書体がブラウザの書体の処理に届く道を閉じる（2026-11-05。絵の変わり方は design/screenshots/ で比べた）
      disableFontFace: true,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      stopAtErrors: false,
      verbosity: 0,
    });
    // パスワードを画面で聞かない（聞かれたら、描けないとして閉じる）
    task.onPassword = () => {
      void task.destroy();
    };
    try {
      const doc = await task.promise;
      return { ok: true, view: new PdfView(task, doc) };
    } catch (e) {
      await task.destroy().catch(() => {});
      return { ok: false, reason: (e as { name?: string })?.name === "PasswordException" ? "password" : "unreadable" };
    }
  }

  get pageCount(): number {
    return this.doc.numPages;
  }

  /** 時間の上限を超えたあとは、この PDF ではもう描かない（PDF.js の Worker を止めたため） */
  get stopped(): boolean {
    return this.broken;
  }

  /**
   * 1ページを canvas に描く。幅 cssWidth（CSS のピクセル）に合わせる。
   * 時間の上限を超えたら RenderTimeout を投げ、PDF.js の Worker を止める。
   */
  async render(pageNo: number, canvas: HTMLCanvasElement, cssWidth: number, timeoutMs = RENDER_TIMEOUT_MS): Promise<void> {
    if (this.broken) throw new RenderTimeout();
    let task: RenderTask | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.broken = true;
        task?.cancel();
        void this.task.destroy();
        reject(new RenderTimeout());
      }, timeoutMs);
    });
    try {
      const page = await Promise.race([this.doc.getPage(pageNo), timeout]);
      const base = page.getViewport({ scale: 1 });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (cssWidth / base.width) * ratio });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      task = page.render({ canvas, viewport });
      await Promise.race([task.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.broken = true;
    await this.task.destroy().catch(() => {});
  }
}

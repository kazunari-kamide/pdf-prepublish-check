// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの絵を描く（PDF.js）。検査（src/worker/inspect.worker.ts）とは別に動き、判定には使わない。見せるためだけに使う。
//
// 通信しないための設定（2026-11-03 本人が決定。docs/no-network.md）：
// - 渡すのはバイト列だけ（data）。URL から読む道（url・range・stream）は使わない。
// - 2026-11-06 本人が決定（案 B）：CCITT・JBIG2・JPEG 2000 の画像を解く部品（WASM の代わりの JS）と字の対応表（cMap）は、
//   配信の中の /pdfjs/ に置いたもの（pdfjs-dist の写し。src/render/pdfjs-parts.ts）を、自分の配信先から読む。
//   前は渡さなかったため、スキャンの画像がまっ白になり、埋め込まれていない日本語の字が描かれなかった。
//   cMap は、まとめたモジュール（cmaps.mjs）を import() で 1 回読んでメモリに持ち、PDF.js にはメモリから渡す（useWorkerFetch: false。fetch は使わない）。
//   そのため、検査のページの CSP も connect-src 'none' のまま（2026-11-06 D170）。
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
import { PDFJS_CMAP_BUNDLE_URL, PDFJS_WASM_URL } from "./pdfjs-parts";
import { warmPdfjs } from "./warm-pdf";

/** 1ページを描く時間の上限（ミリ秒）【仮の値】。検査の Worker の上限（60秒）より短くし、絵のせいで待たせない */
export const RENDER_TIMEOUT_MS = 8_000;

export type OpenResult =
  | { ok: true; view: PdfView }
  | { ok: false; reason: "password" | "unreadable" };

type Pdfjs = typeof import("pdfjs-dist");
type PdfWorker = InstanceType<Pdfjs["PDFWorker"]>;
let loaded: Promise<Pdfjs> | null = null;

/**
 * PDF.js を読み込む（別のファイルに分かれる）。2026-11-06 から、画面の表示が終わったあとに読み込んでおく
 * （src/parts.ts。PDF を入れた後に読みに行かないため）
 */
export function pdfjs(): Promise<Pdfjs> {
  loaded ??= (import(/* @vite-ignore */ pdfjsUrl) as Promise<Pdfjs>).then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  return loaded;
}

// ---- 字の対応表（cMap）：まとめたモジュール（cmaps.mjs）を 1 回だけ import() で読み、メモリに持つ。PDF.js にはメモリから渡す
const cmaps = new Map<string, Uint8Array>();
let cmapsLoaded: Promise<number> | null = null;

/** 字の対応表を読み込む（読めた数を返す。読めなければ 0。そのときは埋め込みのない字の一部を描けない） */
export function loadCmaps(): Promise<number> {
  cmapsLoaded ??= (import(/* @vite-ignore */ PDFJS_CMAP_BUNDLE_URL) as Promise<{ default: Record<string, string> }>)
    .then((m) => {
      for (const [name, b64] of Object.entries(m.default)) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        cmaps.set(name, bytes);
      }
      return cmaps.size;
    })
    .catch(() => 0);
  return cmapsLoaded;
}

/**
 * PDF.js の Worker が「この字の対応表をください」と頼んできたときに、メモリから答える（PDF.js の BinaryDataFactory の形）。
 * 通信はしない。持っていなければ、描けないとして断る（PDF.js は、その書体の字を描かないだけで止まらない）
 */
class MemoryBinaryData {
  // PDF.js が呼ぶ名前は決まっている（fetch）。通信の仕組みと見分けられるよう、メソッドではなく、メモリから返す関数を入れる
  readonly [key: string]: unknown;
  constructor(_options: unknown) {
    Object.defineProperty(this, "fetch", { value: fromMemory });
  }
}

/** PDF.js の頼み（kind と filename）に、メモリの字の対応表で答える */
async function fromMemory({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
  const data = kind === "cMapUrl" ? (cmaps.get(filename) ?? cmaps.get(`${filename}.bcmap`)) : undefined;
  if (!data) throw new Error("この部品は、手元にありません");
  return data.slice();
}

// ---- ページの絵の PDF.js の Worker：1 つを作って使い回す。時間の上限を超えたら捨て、最初の画面に戻ったときに作り直す（resetRenderWorker）
let renderWorker: { worker: PdfWorker; used: boolean } | null = null;

async function sharedWorker(): Promise<PdfWorker> {
  const lib = await pdfjs();
  renderWorker ??= { worker: new lib.PDFWorker(), used: false };
  return renderWorker.worker;
}

/** ページの絵の Worker を作り、小さな見本の画像を 1 回描かせて、画像を解く部品も読み込んでおく */
export async function prepareRenderWorker(): Promise<boolean> {
  const lib = await pdfjs();
  const worker = await sharedWorker();
  return warmPdfjs(lib as unknown as Parameters<typeof warmPdfjs>[0], { worker, ...LOAD_OPTIONS });
}

/** 前のファイルで使った Worker を捨て、新しく作って温める（最初の画面に戻ったとき） */
export function resetRenderWorker(): Promise<boolean> {
  if (renderWorker?.used) {
    renderWorker.worker.destroy();
    renderWorker = null;
  }
  return prepareRenderWorker();
}

/** PDF を開くときの設定（温めにも同じものを使う） */
const LOAD_OPTIONS = {
  useWorkerFetch: false,
  useWasm: false,
  wasmUrl: PDFJS_WASM_URL,
  cMapPacked: true,
  // 字の対応表は、メモリから渡す（MemoryBinaryData）。PDF.js は、ここに名前を足した場所から読む作りだが、この部品は場所を使わない
  cMapUrl: "/pdfjs-cmaps-in-memory/",
  BinaryDataFactory: MemoryBinaryData,
  enableXfa: false,
  // PDF の中の書体を、ブラウザの書体（@font-face）として読ませない。字は PDF.js が形をなぞって描く。
  // 細工した書体がブラウザの書体の処理に届く道を閉じる（2026-11-05。絵の変わり方は design/screenshots/ で比べた）
  disableFontFace: true,
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  stopAtErrors: false,
  verbosity: 0,
};

export class RenderTimeout extends Error {}

export class PdfView {
  private broken = false;
  private constructor(
    private readonly task: PDFDocumentLoadingTask,
    private readonly doc: PDFDocumentProxy,
  ) {}

  static async open(bytes: Uint8Array): Promise<OpenResult> {
    const lib = await pdfjs();
    const worker = await sharedWorker();
    if (renderWorker) renderWorker.used = true;
    const task = lib.getDocument({ data: bytes, worker, ...LOAD_OPTIONS } as Parameters<Pdfjs["getDocument"]>[0]);
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
        // 使い回している Worker ごと止める（固まった Worker を次の絵に使わない）。作り直すのは、最初の画面に戻ったとき
        renderWorker?.worker.destroy();
        renderWorker = null;
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

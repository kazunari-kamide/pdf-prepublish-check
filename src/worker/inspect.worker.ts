// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査の Worker。重い処理は画面とは別のところで動かし、上限を超えたら画面の側からこの Worker だけを止める（CLAUDE.md §5）。
// ここから外へ通信しない。importScripts も使わない。
// 返すのは数と場所と、見つけた字の中身（Item の content）。中身は画面の中だけで使う（src/inspect/report.ts）。

// PDF.js は、ページの絵と同じく、npm の pdfjs-dist のファイルを手を加えずに配る（?url。docs/no-network.md の例外の形のまま）
import pdfjsUrl from "pdfjs-dist/build/pdf.min.mjs?url";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createPdfjsImageDecoder, type ExternalImageDecoder, type PdfjsLike } from "../../rules/shared/pdfjs-images.ts";
import { inspectAll } from "../inspect/inspect";
import { PDFJS_WASM_URL } from "../render/pdfjs-parts";
import { precheck } from "../inspect/precheck";
import type { InspectRequest, InspectResponse } from "../inspect/protocol";

/**
 * 画像を解く道具（PDF.js）。JPEG の画像の画素を読み、P6 の画像の層を、この Worker の中で調べられるようにする。
 * - PDF.js の Worker の部品も、この Worker の中に読み込む（PDF.js は、それを見つけると、別の Worker を作らずに同じ所で動く）。
 *   時間の上限で、この Worker を止めれば、画像を解く処理もいっしょに止まる。
 * - CCITT・JBIG2・JPEG 2000 を解く部品（WASM の代わりの JS）は、配信の中の /pdfjs/wasm/ に置いたもの（pdfjs-dist の写し）を、
 *   PDF.js が import() で読む（2026-11-06 本人が決定。src/render/pdfjs-parts.ts）。前は渡さなかったので、それらの画像は「調べられなかった」になっていた。
 * - 読み込めなかったときは、道具なしで調べる（JPEG の画像は「調べられなかった」と知らせる）。
 */
async function imageDecoder(): Promise<ExternalImageDecoder | undefined> {
  try {
    const [lib] = await Promise.all([
      import(/* @vite-ignore */ pdfjsUrl) as Promise<PdfjsLike>,
      import(/* @vite-ignore */ pdfjsWorkerUrl),
    ]);
    return createPdfjsImageDecoder(lib, { jbig2Url: PDFJS_WASM_URL });
  } catch {
    return undefined;
  }
}

type WorkerScope = {
  onmessage: ((e: MessageEvent<InspectRequest>) => void) | null;
  postMessage(message: InspectResponse): void;
};
const scope = self as unknown as WorkerScope;

scope.onmessage = async (e) => {
  const req = e.data;
  if (!req || req.type !== "inspect" || !(req.buffer instanceof ArrayBuffer)) return;
  try {
    const bytes = new Uint8Array(req.buffer);
    const checked = precheck(bytes);
    if (!checked.ok) {
      scope.postMessage({ type: "result", id: req.id, precheck: checked, summary: null });
      return;
    }
    const decoder = await imageDecoder();
    const summary = await inspectAll(
      bytes,
      (done, total, label) => scope.postMessage({ type: "progress", id: req.id, done, total, label }),
      undefined,
      // 見つけた字の中身も返す（画面の中だけで使い、伏せて出す。2026-11-05 本人が決めた。src/ui/reveal.ts）
      { ...(decoder ? { imageDecoder: decoder } : {}), withContents: true },
    );
    scope.postMessage({ type: "result", id: req.id, precheck: checked, summary });
  } catch {
    // 例外の中身（ファイルの中身を含むことがある）は画面に出さない
    scope.postMessage({ type: "error", id: req.id, message: "検査の途中で問題が起きました。" });
  }
};

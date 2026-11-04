// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査の Worker。重い処理は画面とは別のところで動かし、上限を超えたら画面の側からこの Worker だけを止める（CLAUDE.md §5）。
// ここから外へ通信しない。importScripts も使わない。
// 返すのは数と場所だけ。覆われた字などの中身は返さない（src/inspect/report.ts）。

// PDF.js は、ページの絵と同じく、npm の pdfjs-dist のファイルを手を加えずに配る（?url。docs/no-network.md の例外の形のまま）
import pdfjsUrl from "pdfjs-dist/build/pdf.min.mjs?url";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createPdfjsImageDecoder, type ExternalImageDecoder, type PdfjsLike } from "../../rules/shared/pdfjs-images.ts";
import { inspectAll } from "../inspect/inspect";
import { precheck } from "../inspect/precheck";
import type { InspectRequest, InspectResponse } from "../inspect/protocol";

/**
 * 画像を解く道具（PDF.js）。JPEG の画像の画素を読み、P6 の画像の層を、この Worker の中で調べられるようにする。
 * - PDF.js の Worker の部品も、この Worker の中に読み込む（PDF.js は、それを見つけると、別の Worker を作らずに同じ所で動く）。
 *   時間の上限で、この Worker を止めれば、画像を解く処理もいっしょに止まる。
 * - CCITT・JBIG2 を解く部品（pdfjs-dist/wasm/）は渡さない。その部品は中に fetch を持ち、配る形の確かめ（scripts/check-dist.mjs）の
 *   例外に入っていないため。それらの画像は、これまでどおり「調べられなかった」と知らせる。
 * - 読み込めなかったときは、道具なしで調べる（JPEG の画像は「調べられなかった」と知らせる）。
 */
async function imageDecoder(): Promise<ExternalImageDecoder | undefined> {
  try {
    const [lib] = await Promise.all([
      import(/* @vite-ignore */ pdfjsUrl) as Promise<PdfjsLike>,
      import(/* @vite-ignore */ pdfjsWorkerUrl),
    ]);
    return createPdfjsImageDecoder(lib);
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
      decoder ? { imageDecoder: decoder } : {},
    );
    scope.postMessage({ type: "result", id: req.id, precheck: checked, summary });
  } catch {
    // 例外の中身（ファイルの中身を含むことがある）は画面に出さない
    scope.postMessage({ type: "error", id: req.id, message: "検査の途中で問題が起きました。" });
  }
};

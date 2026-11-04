// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付けの Worker。片付け（sanitize/）は C の担当で、ここでは呼ぶだけ。
// 重い処理は画面とは別のところで動かし、上限を超えたら画面の側からこの Worker だけを止める（CLAUDE.md §5）。
// ここから外へ通信しない。importScripts も使わない。

// PDF.js は、npm の pdfjs-dist のファイルを手を加えずに配る（?url。docs/no-network.md の例外の形のまま。検査の Worker と同じ）
import pdfjsUrl from "pdfjs-dist/build/pdf.min.mjs?url";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createPdfjsImageCodec, offscreenCanvasJpegEncoder, type PdfjsLike } from "../../sanitize/image-codec.ts";
import { sanitizePdf } from "../../sanitize/index.ts";
import type { ImageCodec } from "../../sanitize/types.ts";

/**
 * 覆いの下の JPEG の画像を塗って書き直す道具（11/5 B）。解くのは PDF.js、書くのは OffscreenCanvas（Worker の中でも使える）。
 * CCITT・JBIG2 の部品（pdfjs-dist/wasm/）は、中に fetch を持つので渡さない（これまでどおり「片付けられなかった所」になる）。
 * 読み込めなかったときは、道具なしで片付ける。
 */
async function imageCodec(): Promise<ImageCodec | undefined> {
  try {
    const [lib] = await Promise.all([
      import(/* @vite-ignore */ pdfjsUrl) as Promise<PdfjsLike>,
      import(/* @vite-ignore */ pdfjsWorkerUrl),
    ]);
    return createPdfjsImageCodec(lib, offscreenCanvasJpegEncoder);
  } catch {
    return undefined;
  }
}
import type { SanitizeRequest, SanitizeResponse } from "../sanitize/protocol";
import { addRedactAreas } from "../sanitize/redact";

type WorkerScope = {
  onmessage: ((e: MessageEvent<SanitizeRequest>) => void) | null;
  postMessage(message: SanitizeResponse, transfer?: Transferable[]): void;
};
const scope = self as unknown as WorkerScope;

scope.onmessage = async (e) => {
  const req = e.data;
  if (!req || req.type !== "sanitize" || !(req.buffer instanceof ArrayBuffer)) return;
  try {
    let input: Uint8Array = new Uint8Array(req.buffer);
    // 自分で選んだ所があれば、先に墨消しの注釈として足す（仮のつなぎ。src/sanitize/redact.ts）
    if (Array.isArray(req.areas) && req.areas.length) {
      const added = await addRedactAreas(input, req.areas);
      if (added.status === "refused") {
        scope.postMessage({ type: "refused", id: req.id, message: added.message });
        return;
      }
      input = added.bytes;
    }
    const codec = await imageCodec();
    const r = await sanitizePdf(input, codec ? { codec } : {});
    if (r.status === "error") {
      scope.postMessage({ type: "refused", id: req.id, message: r.message });
      return;
    }
    // 片付けた PDF は渡し切る（写しを作らない）。ほかの中身と共有していることがあるので、そのときだけ写す
    const b = r.bytes;
    const buffer =
      b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer ? b.buffer : b.slice().buffer;
    scope.postMessage(
      { type: "sanitized", id: req.id, buffer, pages: r.pages, removed: r.removed, notDone: r.notDone, decrypted: r.decrypted },
      [buffer],
    );
  } catch {
    // 例外の中身（ファイルの中身を含むことがある）は画面に出さない
    scope.postMessage({ type: "error", id: req.id, message: "片付けの途中で問題が起きました。" });
  }
};

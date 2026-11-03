// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付けの Worker。片付け（sanitize/）は C の担当で、ここでは呼ぶだけ。
// 重い処理は画面とは別のところで動かし、上限を超えたら画面の側からこの Worker だけを止める（CLAUDE.md §5）。
// ここから外へ通信しない。importScripts も使わない。

import { sanitizePdf } from "../../sanitize/index.ts";
import type { SanitizeRequest, SanitizeResponse } from "../sanitize/protocol";

type WorkerScope = {
  onmessage: ((e: MessageEvent<SanitizeRequest>) => void) | null;
  postMessage(message: SanitizeResponse, transfer?: Transferable[]): void;
};
const scope = self as unknown as WorkerScope;

scope.onmessage = async (e) => {
  const req = e.data;
  if (!req || req.type !== "sanitize" || !(req.buffer instanceof ArrayBuffer)) return;
  try {
    const r = await sanitizePdf(new Uint8Array(req.buffer));
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

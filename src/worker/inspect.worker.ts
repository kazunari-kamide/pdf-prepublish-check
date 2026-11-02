// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査の Worker。重い処理は画面とは別のところで動かし、上限を超えたら画面の側からこの Worker だけを止める（CLAUDE.md §5）。
// ここから外へ通信しない。importScripts も使わない。

import { precheck } from "../inspect/precheck";
import type { InspectRequest, InspectResponse } from "../inspect/protocol";

type WorkerScope = {
  onmessage: ((e: MessageEvent<InspectRequest>) => void) | null;
  postMessage(message: InspectResponse): void;
};
const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const req = e.data;
  if (!req || req.type !== "inspect" || !(req.buffer instanceof ArrayBuffer)) return;
  try {
    const result = precheck(new Uint8Array(req.buffer));
    scope.postMessage({ type: "result", id: req.id, precheck: result });
  } catch {
    // 例外の中身（ファイルの中身を含むことがある）は画面に出さない
    scope.postMessage({ type: "error", id: req.id, message: "検査の途中で問題が起きました。" });
  }
};

// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面で PDF の絵を描く所（src/render/pdf-view.ts）の PDF.js の設定。通信しない設定と、PDF の中の書体を
// ブラウザの書体として読ませない設定（disableFontFace。2026-11-05 に絵の変わり方を比べて足した）が残っているかを見る。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/render/pdf-view.ts", "utf8");
const opts = src.slice(src.indexOf("lib.getDocument({"), src.indexOf("});", src.indexOf("lib.getDocument({")));

describe("ページの絵の PDF.js の設定", () => {
  it("書体をブラウザの書体として読ませない・取り寄せの道を開けない", () => {
    for (const k of ["disableFontFace: true", "useWorkerFetch: false", "useWasm: false", "disableRange: true", "disableStream: true", "disableAutoFetch: true", "enableXfa: false"]) {
      expect(opts, k).toContain(k);
    }
    for (const k of ["url:", "cMapUrl", "standardFontDataUrl", "wasmUrl", "iccUrl"]) expect(opts, k).not.toContain(k);
  });
});

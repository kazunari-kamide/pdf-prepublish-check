// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面で PDF の絵を描く所（src/render/pdf-view.ts）の PDF.js の設定。通信しない設定と、PDF の中の書体を
// ブラウザの書体として読ませない設定（disableFontFace。2026-11-05 に絵の変わり方を比べて足した）が残っているかを見る。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/render/pdf-view.ts", "utf8");
// PDF を開くときの設定は LOAD_OPTIONS にまとめてある（温めにも同じものを使う。2026-11-06）
const opts = src.slice(src.indexOf("const LOAD_OPTIONS = {"), src.indexOf("};", src.indexOf("const LOAD_OPTIONS = {")));

describe("ページの絵の PDF.js の設定", () => {
  it("書体をブラウザの書体として読ませない・部品は自分の配信先の /pdfjs/ から読むか、メモリから渡す", () => {
    for (const k of ["disableFontFace: true", "useWorkerFetch: false", "useWasm: false", "disableRange: true", "disableStream: true", "disableAutoFetch: true", "enableXfa: false"]) {
      expect(opts, k).toContain(k);
    }
    // 2026-11-06 から：画像を解く部品は配信の中の /pdfjs/<版の印>/ から読み、字の対応表はメモリから渡す（MemoryBinaryData。
    // PDF を入れた後に読みに行かない）。URL から PDF を読む道・標準の書体（Liberation の書体のライセンスのため置かない）・ICC は開けない
    for (const k of ["wasmUrl: PDFJS_WASM_URL", "BinaryDataFactory: MemoryBinaryData", "cMapPacked: true"]) expect(opts, k).toContain(k);
    for (const k of ["url:", "standardFontDataUrl", "iccUrl"]) expect(opts, k).not.toContain(k);
  });
});

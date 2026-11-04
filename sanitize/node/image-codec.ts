// SPDX-License-Identifier: AGPL-3.0-only
//
// Node（採点・テスト）で使う、片付けの画像の道具。ブラウザでは使わない（node_modules の部品を読むため）。
// 解く：pdfjs-dist の legacy の版（CCITT・JBIG2 は、pdfjs-dist/wasm/ の jbig2_nowasm_fallback.js を使う）。
// JPEG に書く：@napi-rs/canvas（MIT。package.json に明記。docs/licenses.md）。

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { STRIP_ROWS, createPdfjsImageCodec, type PdfjsLike, type RgbaJpegEncoder } from "../image-codec.ts";
import type { ImageCodec } from "../types.ts";

const napiJpegEncoder: RgbaJpegEncoder = async (width, height, strip, quality) => {
  const canvas = createCanvas(width, height);
  const g = canvas.getContext("2d");
  for (let y0 = 0; y0 < height; y0 += STRIP_ROWS) {
    const rows = Math.min(STRIP_ROWS, height - y0);
    g.putImageData(new ImageData(strip(y0, rows), width, rows), 0, y0);
  }
  const out = await canvas.encode("jpeg", Math.round(Math.max(0, Math.min(1, quality)) * 100));
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
};

export function createNodeImageCodec(): ImageCodec {
  const require = createRequire(import.meta.url);
  const wasmDir = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "wasm");
  return createPdfjsImageCodec(pdfjs as unknown as PdfjsLike, napiJpegEncoder, { wasmUrl: pathToFileURL(wasmDir).href + "/" });
}

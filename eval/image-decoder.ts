// SPDX-License-Identifier: AGPL-3.0-only
//
// Node（採点・テスト・スキル）で、PDF.js を使って画像を解く道具を作る。ブラウザの検査器では使わない（node: のモジュールを読むため）。
// PDF.js は pdfjs-dist の legacy の版。CCITT・JBIG2 を解く部品（pdfjs-dist/wasm/jbig2_nowasm_fallback.js）は、
// node_modules の中のものを、ファイルの URL で渡す。

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createPdfjsImageDecoder, type ExternalImageDecoder, type PdfjsLike } from "../rules/shared/pdfjs-images.ts";

export function createNodeImageDecoder(): ExternalImageDecoder {
  const require = createRequire(import.meta.url);
  const dir = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "wasm");
  return createPdfjsImageDecoder(pdfjs as unknown as PdfjsLike, { jbig2Url: pathToFileURL(dir).href + "/" });
}

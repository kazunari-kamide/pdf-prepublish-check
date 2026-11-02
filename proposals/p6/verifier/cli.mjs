#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// 使い方: node verifier/cli.mjs 入力.pdf [--include-text]
//   標準出力に、残っている情報の一覧を JSON で書く（形は verifier/schema.json）。
//   --include-text を付けたときだけ、覆われた字そのものを text に入れる（調べるとき用。記録やログには使わない）。
// 終了コード: 0 = 読めた（残りがあっても 0）、1 = 使い方の誤り、2 = PDF を読めなかった

import { readFileSync } from "node:fs";
import { verifyP6 } from "./p6.mjs";

const args = process.argv.slice(2);
const includeText = args.includes("--include-text");
const files = args.filter((a) => !a.startsWith("--"));
if (files.length !== 1) {
  process.stderr.write("使い方: node verifier/cli.mjs 入力.pdf [--include-text]\n");
  process.exit(1);
}

let bytes;
try {
  bytes = readFileSync(files[0]);
} catch {
  process.stderr.write("ファイルを読めません\n");
  process.exit(1);
}

const result = await verifyP6(bytes, { includeText });
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exit(result.status === "ok" ? 0 : 2);

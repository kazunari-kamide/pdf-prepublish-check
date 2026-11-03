// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器 P5（旧版の残存）のコマンド。
//   node verifier/p5-cli.mjs 入力.pdf      標準出力に JSON（形は p5-schema.json）
// 終了コード：0 ＝ 読めた（残りがあっても 0）、1 ＝ 使い方の誤り、2 ＝ PDF を読めなかった。

import { readFileSync } from "node:fs";
import { verifyP5 } from "./p5.mjs";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) {
  process.stderr.write("使い方：node verifier/p5-cli.mjs 入力.pdf\n");
  process.exit(1);
}
let bytes;
try {
  bytes = new Uint8Array(readFileSync(file));
} catch {
  process.stderr.write("ファイルを読めませんでした\n");
  process.exit(1);
}
const result = await verifyP5(bytes);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exit(result.status === "ok" ? 0 : 2);

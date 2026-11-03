// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器 P7（隠れたテキスト）のコマンド。
//   node verifier/p7-cli.mjs 入力.pdf                  標準出力に JSON（形は p7-schema.json）
//   node verifier/p7-cli.mjs 入力.pdf --include-text   隠れた字そのものも出す（調べるときだけ。記録やログには使わない）
// 終了コード：0 ＝ 読めた（残りがあっても 0）、1 ＝ 使い方の誤り、2 ＝ PDF を読めなかった。

import { readFileSync } from "node:fs";
import { verifyP7 } from "./p7.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  process.stderr.write("使い方：node verifier/p7-cli.mjs 入力.pdf [--include-text]\n");
  process.exit(1);
}
let bytes;
try {
  bytes = new Uint8Array(readFileSync(file));
} catch {
  process.stderr.write("ファイルを読めませんでした\n");
  process.exit(1);
}
const result = await verifyP7(bytes, { includeText: args.includes("--include-text") });
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exit(result.status === "ok" ? 0 : 2);

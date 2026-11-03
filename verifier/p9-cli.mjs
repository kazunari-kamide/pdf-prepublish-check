// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器 P9（添付ファイル）のコマンド。
//   node verifier/p9-cli.mjs 入力.pdf                   標準出力に JSON（形は p9-schema.json）
//   node verifier/p9-cli.mjs 入力.pdf --include-names   添付のファイル名そのものも出す（調べるときだけ。記録やログには使わない）
// 終了コード：0 ＝ 読めた（残りがあっても 0）、1 ＝ 使い方の誤り、2 ＝ PDF を読めなかった。

import { readFileSync } from "node:fs";
import { verifyP9 } from "./p9.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  process.stderr.write("使い方：node verifier/p9-cli.mjs 入力.pdf [--include-names]\n");
  process.exit(1);
}
let bytes;
try {
  bytes = new Uint8Array(readFileSync(file));
} catch {
  process.stderr.write("ファイルを読めませんでした\n");
  process.exit(1);
}
const result = await verifyP9(bytes, { includeNames: args.includes("--include-names") });
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exit(result.status === "ok" ? 0 : 2);

// SPDX-License-Identifier: AGPL-3.0-only
//
// 採点する側に足す案の合成 PDF を書き出す：ページの外にはみ出した画像（P7 1.4.0）と、白い四角の注釈の下の図形（P6 1.13.0）。
// 中身は eval/cases/p7-images.ts・eval/cases/p6-vector.ts と同じ（同じ作り方を呼ぶ）。字はすべて架空。日時も乱数も使わない。
// 使い方：node proposals/a-clip-and-glyph-cover/build.mjs [出力先]。省くと proposals/a-clip-and-glyph-cover/out/（コミットしない）

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES as P7_IMAGES } from "../../eval/cases/p7-images.ts";
import { CASES as P6_VECTOR } from "../../eval/cases/p6-vector.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, "out");

for (const [dir, cases] of [["p7", P7_IMAGES], ["p6", P6_VECTOR]]) {
  mkdirSync(join(out, dir), { recursive: true });
  for (const c of cases) {
    writeFileSync(join(out, dir, `${c.id}.pdf`), await c.build());
    writeFileSync(join(out, dir, `${c.id}.expected.json`), `${JSON.stringify({ id: c.id, kind: c.kind, description: c.description, keys: c.leaks }, null, 2)}\n`);
  }
  console.log(`${dir}：${cases.length} 個`);
}
console.log(`書き出した：${out}`);

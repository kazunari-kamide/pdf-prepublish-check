// SPDX-License-Identifier: AGPL-3.0-only
//
// ファイルを小さくする（sanitize/compress.ts）の測定（eval/compress.ts）を回し、前後の大きさを出す（npm run eval:compress）。
// - すべての場面が期待どおり（書き直す／手を付けない）で、読み直しで保存させなかった回が 0
// - 黒塗りしたスキャンを小さくしても、黒く塗った所が塗られたまま（縁の 1 画素を除いた内側で見る。縁の数は出すだけ）
// - 前からの合成 PDF を小さくしても、読み直しで保存させなかった PDF が 0 個

import { expect, it } from "vitest";
import { runCompressEval } from "../eval/compress.ts";

it("ファイルを小さくする：合成 PDF の前後の大きさ", { timeout: 600_000 }, async () => {
  const lines: string[] = [];
  const r = await runCompressEval((l) => lines.push(l));
  console.log(lines.join("\n"));
  expect(r.asExpected).toBe(r.scenes);
  expect(r.blocked).toBe(0);
  expect(r.redactedLeft).toBe(0);
  for (const f of r.fixtures) {
    expect(f.blocked, `${f.maxDpi}／${f.jpegQuality}`).toBe(0);
    expect(f.files).toBeGreaterThan(100);
  }
});

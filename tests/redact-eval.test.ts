// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする（sanitize/redact.ts）の採点（eval/redact.ts）を回し、場面ごとの結果とまとめを出す（npm run eval:redact）。
// - すべての場面が期待どおり（保存できる／保存させない）
// - 保存できた場面の読み直しの残りが 0 件
// - 見せかけの黒塗りでは、3つの確かめ（選んだ場所・作品の検査・検証器）がどれも残りを見つける（空振りしていない）

import { expect, it } from "vitest";
import { runRedactEval } from "../eval/redact.ts";

it("自分で黒塗りする：合成 PDF の場面ごとの採点", { timeout: 120_000 }, async () => {
  const lines: string[] = [];
  const r = await runRedactEval((l) => lines.push(l));
  console.log(lines.join("\n"));
  expect(r.asExpected).toBe(r.cases);
  expect(r.leftInOk).toBe(0);
  for (const k of ["area", "rules", "verifier"]) expect(r.fake[k] ?? 0, k).toBeGreaterThan(0);
});

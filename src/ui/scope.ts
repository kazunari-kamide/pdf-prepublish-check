// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査で「調べていない所」を、読み直しの範囲の文に添える一言にする。出す所はここ1か所だけ（CLAUDE.md §11-5b）。
//
// P6 の検出ルールは、1.5.0 から画像の層（画像の上の黒い四角）も調べる。検査の Worker に画像を解く道具（PDF.js）を渡したので、
// JPEG の画像も調べる（11/5 B）。それでも読み解けなかった画像（大きすぎる・CCITT・JBIG2 など）があれば、
// その画像の下は調べていないと添える。

import type { RuleResult } from "../inspect/report";

/** 型ごとの「調べていない所」の一言。読み直しの範囲の文の後ろに、そのまま並べる */
export function scopeCaveats(rules: readonly RuleResult[]): string[] {
  const out: string[] = [];
  const p6 = rules.find((r) => r.pattern === "P6");
  if (p6 && p6.status === "ok" && p6.notices.some((n) => n.kind === "unchecked_images")) {
    out.push("P6 のうち、読み解けなかった画像の下の中身は、調べていません。");
  }
  return out;
}

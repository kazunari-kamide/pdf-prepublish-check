// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの絵の上の、見つかった所の薄い地（印の中の面）。
// 前は印ごとに 10% の紅の地を付けていたので、印が重なるほど濃くなった（切り抜いた画像が同じ所に何枚もある広報紙などで、
// ページの上半分が暗い赤に覆われ、絵が読めなくなった。2026-11-05、実物の公開 PDF 1 件で見つけた）。
// 今は、地をすべて 1 つの層（.mark-fills）に入れ、層ごと薄くする（CSS の opacity）。重なっても 1 枚分の濃さのまま。
// 同じ四角は 1 枚にまとめる（描く数を減らす）。

export type Fraction = { left: number; top: number; width: number; height: number };

/** 同じ位置・同じ大きさの四角を 1 枚にまとめる（ページに対する割合を 1/10000 で丸めて比べる）。並びは初めに出た順 */
export function uniqueFills(fills: readonly Fraction[]): Fraction[] {
  const seen = new Set<string>();
  const out: Fraction[] = [];
  for (const f of fills) {
    const key = [f.left, f.top, f.width, f.height].map((v) => Math.round(v * 10000)).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

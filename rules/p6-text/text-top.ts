// SPDX-License-Identifier: AGPL-3.0-only
//
// P6 文字の層：覆いの上に、あとから何が描かれているか（1.8.0 から）。
// 見出しの帯・番号札の上に字を描くのは、ふつうの見た目。下に別の字が残っていること自体は本当なので、
// 落とさずに「確かめてください」（confidence: check）にする。
// ただし、上の字が「不開示」「黒塗り」などの札の言葉なら、黒塗りの上に札を書いた本当の漏れとみて、確かなもの（high）のままにする
// （2026-11-04、人の決定）。

import type { Cover, GlyphBox, LaterMark } from "./page.ts";
import { glyphKey, normalizeGlyphText } from "./filters.ts";

/**
 * 覆いの上のあり方。
 * none＝何もない、label＝札の言葉の字、unknown_hidden＝字がある（下の字に、中身の分からない字がある）、
 * same_chars＝字がある（下の字が、上の字の中にすべてある）、different＝字がある（下に、上にない字がある）、
 * shapes＝字はないが、字の形の塗り（曲線を含む、濃くない色の塗り）がある
 */
export type TextOnTop = "none" | "label" | "unknown_hidden" | "same_chars" | "different" | "shapes";

/**
 * 黒塗りの上に書く札の言葉（2026-11-04、人の指定の言葉に、同じ意味の言い方を足した）。
 * 上の字から記号・括弧・空白を除いた中に、どれかが含まれていれば札とみなす（「不開示（第5条第1号）」なども札にするため、含むかで見る）
 */
export const LABEL_WORDS: readonly string[] = [
  "不開示",
  "非開示",
  "非公開",
  "黒塗り",
  "黒塗",
  "マスキング",
  "墨消し",
  "墨消",
  "秘匿",
  "伏せ字",
  "伏字",
  "REDACTED",
];

/** 札の言葉か（NFKC でそろえ、記号・括弧・空白を除いてから、札の言葉を含むかを見る。英字は大文字にそろえる） */
export function isLabelText(text: string): boolean {
  const t = text.normalize("NFKC").replace(/[\p{P}\p{S}\p{Z}\s]/gu, "").toUpperCase();
  return t !== "" && LABEL_WORDS.some((w) => t.includes(w));
}

function centerInside(r: [number, number, number, number], x: number, y: number): boolean {
  return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
}

/** 覆いの上のあり方を決める。hidden は、覆われた字（空白を除く）。marks は、覆いのあとに描いた字の形の塗り */
export function classifyOnTop(cover: Cover, hidden: GlyphBox[], glyphs: GlyphBox[], marks: LaterMark[]): TextOnTop {
  const onTop = glyphs
    .filter((g) => g.seq > cover.seq && !g.isSpace && centerInside(cover.rect, (g.rect[0] + g.rect[2]) / 2, (g.rect[1] + g.rect[3]) / 2))
    .sort((a, b) => a.seq - b.seq);
  if (onTop.length > 0) {
    if (isLabelText(onTop.map((g) => g.text).join(""))) return "label";
    if (hidden.some((g) => !normalizeGlyphText(g.text))) return "unknown_hidden";
    const topKeys = new Set(onTop.map(glyphKey));
    return hidden.every((g) => topKeys.has(glyphKey(g))) ? "same_chars" : "different";
  }
  if (marks.some((m) => m.seq > cover.seq && centerInside(cover.rect, m.cx, m.cy))) return "shapes";
  return "none";
}

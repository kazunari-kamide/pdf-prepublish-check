// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの見える字を、行ごとにつないだ文字列として読む（P4 の本文のパス・P3 の団体名の比べで使う）。
// 字の取り出しは rules/pii/text.ts の extractText を使う（同じ読み方にそろえる）。重いページは上限で止めて、止めたページを返す。

import type { PDFDocument } from "pdf-lib";
import { extractText, pageContent, type Glyph } from "../pii/text.ts";

export const PAGE_TEXT_LIMITS = { maxOperations: 1_000_000, maxFormDepth: 8, maxGlyphs: 100_000 } as const;
/** 字を読むページの数の上限【仮の値】 */
export const MAX_TEXT_PAGES = 500;

export type PageText = { page: number; text: string };
export type PageTextResult = { pages: PageText[]; skipped: number[] };

/** 字の箱の並びを、行の切れ目（縦の位置が字の高さの半分より離れたところ）で改行を入れてつなぐ */
export function joinGlyphs(glyphs: Glyph[]): string {
  let out = "";
  let prev: Glyph | null = null;
  for (const g of glyphs) {
    if (prev) {
      const h = Math.max(prev.size, g.size, 1);
      const dy = Math.abs((prev.rect[1] + prev.rect[3]) / 2 - (g.rect[1] + g.rect[3]) / 2);
      const gap = g.rect[0] - prev.rect[2];
      if (prev.dir !== g.dir || dy > h / 2) out += "\n";
      else if (gap > h * 0.3) out += " ";
    }
    out += g.text;
    prev = g;
  }
  return out;
}

export function readPageTexts(doc: PDFDocument): PageTextResult {
  const out: PageTextResult = { pages: [], skipped: [] };
  let pages;
  try {
    pages = doc.getPages();
  } catch {
    return out;
  }
  pages.forEach((p, i) => {
    if (i >= MAX_TEXT_PAGES) {
      out.skipped.push(i + 1);
      return;
    }
    try {
      const t = extractText(doc.context, pageContent(doc.context, p.node.Contents()), p.node.Resources(), PAGE_TEXT_LIMITS);
      out.pages.push({ page: i + 1, text: joinGlyphs(t.glyphs) });
    } catch {
      out.skipped.push(i + 1); // 命令が多すぎる（TooManyOperations）・読めないページ
    }
  });
  return out;
}

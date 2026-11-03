// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6（見せかけの黒塗り）の文字の層（docs/prd.md §3）。
// 字のあとに、その字を覆う濃い塗りを描いていれば、「黒い四角の下に字が残っている」とする。
// 見ないもの（この版）：濃い画像で覆った型、注釈で覆った型、スキャン画像の画素が残っている型。

import { EncryptedPDFError, PDFDocument } from "pdf-lib";
import { area, intersectionArea, type Rect } from "./geometry.ts";
import { contentBytes, scanPage, TooManyOperations, type Cover } from "./page.ts";
import { DEFAULT_SETTINGS, type P6TextSettings } from "./settings.ts";

export const RULE_ID = "p6-text";
export const RULE_VERSION = "1.0.0";

export type P6TextFinding = {
  pattern: "P6";
  layer: "text";
  cover: "fill";
  page: number;
  /** 覆っているものの箱。ページの既定の座標（ポイント、左下が原点、/Rotate はかけない） */
  rect: Rect;
  /** 覆われた字の数（空白は数えない） */
  chars: number;
  /** includeText のときだけ。覆われた字そのもの。記録やログには使わない */
  text?: string;
};

export type P6TextReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: { code: "empty" | "unreadable" | "encrypted"; message: string };
  pages: number | null;
  findings: P6TextFinding[];
  skippedPages: Array<{ page: number; reason: "too_many_operations" | "unreadable_page" }>;
};

export type DetectOptions = { settings?: Partial<P6TextSettings>; includeText?: boolean };

/** 覆い1つごとに、その前に描かれ、半分以上が隠れた字を集める */
export function findCoveredText(
  covers: Cover[],
  glyphs: { seq: number; rect: Rect; isSpace: boolean; text: string }[],
  coveredFractionMin: number,
): Array<{ cover: Cover; chars: number; text: string }> {
  const out: Array<{ cover: Cover; chars: number; text: string }> = [];
  for (const cover of covers) {
    let chars = 0;
    let text = "";
    for (const g of glyphs) {
      if (g.seq >= cover.seq) continue; // 覆いのあとに描いた字は、上に見えている
      const a = area(g.rect);
      if (a <= 0) continue;
      if (intersectionArea(g.rect, cover.rect) / a < coveredFractionMin) continue;
      text += g.text;
      if (!g.isSpace) chars++;
    }
    if (chars > 0) out.push({ cover, chars, text });
  }
  return out;
}

/** 同じ字の並びを、ほぼ同じ所で重ねて覆っている覆い（四角と、その縁の線など）は1つにまとめる */
function mergeSameArea(items: Array<{ cover: Cover; chars: number; text: string }>) {
  const out: typeof items = [];
  for (const it of items) {
    const same = out.find((o) => {
      const inter = intersectionArea(o.cover.rect, it.cover.rect);
      const small = Math.min(area(o.cover.rect), area(it.cover.rect));
      return small > 0 && inter / small >= 0.9;
    });
    if (!same) out.push(it);
    else if (area(it.cover.rect) > area(same.cover.rect)) {
      same.cover = it.cover;
      same.chars = Math.max(same.chars, it.chars);
    }
  }
  return out;
}

export async function detectP6Text(bytes: Uint8Array, options: DetectOptions = {}): Promise<P6TextReport> {
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], skippedPages: [] };
  if (bytes.length === 0) {
    return { ...base, status: "error", pages: null, error: { code: "empty", message: "ファイルが空です。" } };
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError) {
      return { ...base, status: "error", pages: null, error: { code: "encrypted", message: "暗号化された PDF は、いまは調べられません。" } };
    }
    return { ...base, status: "error", pages: null, error: { code: "unreadable", message: "PDF として読めませんでした。" } };
  }

  const report: P6TextReport = { ...base, status: "ok", pages: 0, findings: [], skippedPages: [] };
  let pages;
  try {
    pages = doc.getPages();
  } catch {
    return { ...base, status: "error", pages: null, error: { code: "unreadable", message: "ページの並びを読めませんでした。" } };
  }
  report.pages = pages.length;

  pages.forEach((page, index) => {
    const pageNo = index + 1;
    try {
      const node = page.node;
      const data = contentBytes(doc.context, node.Contents());
      const scan = scanPage(doc.context, data, node.Resources(), settings);
      const hits = mergeSameArea(findCoveredText(scan.covers, scan.glyphs, settings.coveredFractionMin));
      for (const h of hits) {
        const f: P6TextFinding = { pattern: "P6", layer: "text", cover: "fill", page: pageNo, rect: h.cover.rect, chars: h.chars };
        if (options.includeText) f.text = h.text;
        report.findings.push(f);
      }
    } catch (e) {
      report.skippedPages.push({ page: pageNo, reason: e instanceof TooManyOperations ? "too_many_operations" : "unreadable_page" });
    }
  });
  return report;
}

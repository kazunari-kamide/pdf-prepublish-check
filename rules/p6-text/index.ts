// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6（見せかけの黒塗り）の文字の層（docs/prd.md §3）。
// 字のあとに、その字を覆う濃い塗り・濃い画像・注釈を描いていれば、「黒い四角の下に字が残っている」とする。
// 見ないもの（この版）：スキャン画像の画素が残っている型（画像の層。image/*）。

import { loadPdf } from "../shared/load.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { scanAnnotations } from "./annotations.ts";
import { contentBytes, coverageOf, createPageScanner, TooManyCovers, TooManyOperations, type Cover, type CoverKind, type UncheckedImage } from "./page.ts";
import { IDENTITY, area, intersectionArea, type Rect } from "./geometry.ts";
import { DEFAULT_SETTINGS, type P6TextSettings } from "./settings.ts";

export const RULE_ID = "p6-text";
export const RULE_VERSION = "1.3.1";

export type P6TextFinding = {
  pattern: "P6";
  layer: "text";
  /** 覆っているもの。fill＝濃い塗り・太い線、image＝濃い画像、annotation＝注釈 */
  cover: CoverKind;
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
  skippedPages: Array<{ page: number; reason: "too_many_operations" | "too_many_covers" | "unreadable_page" }>;
  /** 濃いかどうかを調べられなかった画像（JPEG など）。覆いとしては数えていない。「問題なし」ではない */
  uncheckedImages: Array<{ page: number } & UncheckedImage>;
  /** パスワードなしで開ける暗号化 PDF を、復号して調べたときだけ。どの暗号化だったか（1.2.0 から） */
  decrypted?: EncryptionSummary & { failedObjects: number };
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
      // 形を持つ覆い（曲線・回した四角など）は、形と字の箱の重なった面積で測る（1.3.0 から）
      if (intersectionArea(g.rect, cover.rect) <= 0) continue;
      if (coverageOf(cover, g.rect) / a < coveredFractionMin) continue;
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
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], skippedPages: [], uncheckedImages: [] };
  if (bytes.length === 0) {
    return { ...base, status: "error", pages: null, error: { code: "empty", message: "ファイルが空です。" } };
  }
  // 読み込みは共通の入口（rules/shared/load.ts）。パスワードなしで開ける暗号化 PDF は、復号して調べる（1.2.0 から）。
  // パスワードが要る・対応していない暗号化は、encrypted で止める（中身は読まない）。
  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") {
    if (loaded.code === "encrypted") {
      const message =
        loaded.reason === "password_required"
          ? "パスワードが要る PDF は、調べられません。"
          : "この形の暗号化は、いまは調べられません。";
      return { ...base, status: "error", pages: null, error: { code: "encrypted", message } };
    }
    return { ...base, status: "error", pages: null, error: { code: "unreadable", message: "PDF として読めませんでした。" } };
  }
  const doc = loaded.doc;

  const report: P6TextReport = { ...base, status: "ok", pages: 0, findings: [], skippedPages: [], uncheckedImages: [] };
  if (loaded.decrypted) report.decrypted = loaded.decrypted;
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
      const scanner = createPageScanner(doc.context, settings);
      scanner.run(data, node.Resources(), IDENTITY, "fill");
      scanAnnotations(doc.context, node.Annots(), scanner, settings); // 注釈は、ページの中身のあとに重なる
      const scan = scanner.result();
      for (const u of scan.uncheckedImages) report.uncheckedImages.push({ page: pageNo, ...u });
      const hits = mergeSameArea(findCoveredText(scan.covers, scan.glyphs, settings.coveredFractionMin));
      for (const h of hits) {
        const f: P6TextFinding = { pattern: "P6", layer: "text", cover: h.cover.kind, page: pageNo, rect: h.cover.rect, chars: h.chars };
        if (options.includeText) f.text = h.text;
        report.findings.push(f);
      }
    } catch (e) {
      report.skippedPages.push({ page: pageNo, reason: e instanceof TooManyOperations ? "too_many_operations" : e instanceof TooManyCovers ? "too_many_covers" : "unreadable_page" });
    }
  });
  return report;
}

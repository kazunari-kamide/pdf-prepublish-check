// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6（見せかけの黒塗り）（docs/prd.md §3）。
// - 文字の層：字のあとに、その字を覆う濃い塗り・濃い画像・注釈を描いていれば、「黒い四角の下に字が残っている」とする。
// - 画像の層（1.5.0 から）：画像のあとに、不透明な覆い（黒・白）を重ねただけで、覆いの下の元の画素に何か写っていれば、
//   「覆いの下に、画像の中身が残っている」とする（image-layer.ts）。
// 報告の checkedLayers に、調べた層を入れる（1.4.0 から）。

import { isInflateLimitError } from "../shared/inflate-limit.ts";
import { loadPdf } from "../shared/load.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { scanAnnotations } from "./annotations.ts";
import { contentBytes, coverageOf, createPageScanner, TooManyCovers, TooManyOperations, type Cover, type CoverKind, type GlyphBox, type UncheckedImage } from "./page.ts";
import { createPixelSource, findCoveredImages, TooManyImageCovers } from "./image-layer.ts";
import { darkFractionOf } from "./images.ts";
import type { ExternalImageDecoder } from "../shared/pdfjs-images.ts";
import { IDENTITY, area, intersectRect, intersectionArea, type Rect } from "./geometry.ts";
import { classifyOnTop, type TextOnTop } from "./text-top.ts";
import { indexGlyphsByText, isGlyphSizedImage, normalizeGlyphText, isGlyphSizedShape, isNotSolidFill, isVisiblePoint, redrawnOnTop, visiblePart, type ExcludeCounter, type ExcludeReason } from "./filters.ts";
import { DEFAULT_SETTINGS, type P6TextSettings } from "./settings.ts";

export const RULE_ID = "p6-text";
// 1.12.1：解くと大きすぎる中身（圧縮の爆弾）のページは、stream_too_large として省く（rules/shared/inflate-limit.ts）
export const RULE_VERSION = "1.12.1";

/** P6 の層。text＝黒い四角の下に字が残っている型、image＝スキャン画像の画素が残っている型 */
export type P6Layer = "text" | "image";

/**
 * この版の検出ルールが調べる層（1.4.0 から報告の checkedLayers に入れる）。
 * 画面は、ここに "image" がない間、「画像の下の中身は、読み直しではまだ調べていません」と添える。
 * 画像の層を見るようにしたら、ここに "image" を足す（画面の一言は、この値で外れる）。
 */
export const CHECKED_LAYERS: readonly P6Layer[] = ["text", "image"];

/** 文字の層の1件：黒い四角などの下に、字が残っている */
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
  /** 覆いが濃くない色（白・灰・赤など）の不透明な塗り・画像・注釈のとき "opaque"（1.11.0 から）。濃い覆いのときは付けない */
  coverTone?: "opaque";
  /** includeText のときだけ。覆われた字そのもの。記録やログには使わない */
  text?: string;
  /**
   * 確からしさ（1.8.0 から）。high＝ふつうの黒塗りの形。
   * check＝覆いの上に字や字の形の塗りがある（見出しの帯・番号札の形。札の言葉の字は除く）、または覆われた字がとても小さい。
   * 画面では「確かめてください」と弱く出す（画面は B の担当）
   */
  confidence: "high" | "check";
  /** explain のときだけ（1.7.0 から）。実物で測るための値。字・場所は入れない */
  metrics?: P6TextMetrics;
};

/** 文字の層の1件の、測った値（explain のときだけ） */
export type P6TextMetrics = {
  /** 覆われた字の箱の高さ（ポイント）の最小・最大 */
  glyphHeightMin: number;
  glyphHeightMax: number;
  /** 覆いの箱の短い辺（ポイント） */
  coverMinSide: number;
  /** 覆いの描き方（塗り・線・画像・墨消し） */
  how: Cover["how"];
  /**
   * 覆いの上に、あとから描いた字があるか。none＝ない、unknown_hidden＝ある（下の字に、中身の読めない字がある）、
   * same_chars＝ある（下の字が、上の字の中にすべてある。並びや場所は違う）、different＝ある（下に、上にない字がある）
   */
  textOnTop: TextOnTop;
  /** 覆われた字に、回したり傾けたりして描いた字があるか（1.8.0 から） */
  hiddenRotated: boolean;
  /** 覆いの明るさ（0＝黒）（1.8.0 から） */
  coverLuminance: number;
  /** 覆われた字のうち、印字できない字（制御・書式・私用領域・幅のない空白など）の数（1.8.0 から） */
  hiddenNonPrintable: number;
};

/** 画像の層の1件（1.5.0 から）：画像の上に覆いを重ねただけで、覆いの下の画像の画素に何か写っている */
export type P6ImageFinding = {
  pattern: "P6";
  layer: "image";
  /** 覆っているもの。fill＝塗り、image＝濃い画像、annotation＝注釈 */
  cover: CoverKind;
  /** 覆いの色の向き。dark＝黒など濃い色、light＝白など */
  tone: "dark" | "light";
  page: number;
  /** 覆っているものの箱（文字の層と同じ座標） */
  rect: Rect;
  /**
   * 覆いの下の元の画素の、明るさの標準偏差（0〜0.5。大きいほど、濃淡が混ざっている）。
   * 注釈の覆いの下の画像を解けなかったとき（reason: under_unreadable）と、白い覆いの測れる点が足りないとき
   * （reason: under_later_paint）は null（1.9.0・1.10.0 から）
   */
  spread: number | null;
  /**
   * under_unreadable＝注釈の覆いの下の画像を解けなかった（大きすぎる・読めない色・読めない圧縮）。confidence は check（1.9.0 から）。
   * under_later_paint＝白い覆いの上に、あとから細い線などを密に描いていて、下を測れる点が足りない。confidence は check（1.10.0 から）
   */
  reason?: "under_unreadable" | "under_later_paint";
  /**
   * 確からしさ（1.7.0 から）。high＝注釈・黒い画像・紙らしい画像の上の塗り。
   * check＝下が紙らしくない（写真など）画像の上の濃い塗り。画面では「確かめてください」と弱く出す（画面は B の担当）
   */
  confidence: "high" | "check";
  /**
   * explain のときだけ（1.7.0 から）。実物で測るための値。colored は 1.9.0 から（覆いの下とまわりの帯の、色のある点の割合）。
   * laterPaintPoints は 1.10.0 から（白い覆いで、あとから上に描いたものの下にあるため数えなかった点の数）
   */
  metrics?: { ringLight: number | null; underLight: number | null; colored: number | null; laterPaintPoints: number };
};

export type P6Finding = P6TextFinding | P6ImageFinding;

export type P6TextReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  /**
   * 調べた層（1.4.0 から）。status が ok のときは、この版が調べる層（CHECKED_LAYERS）。
   * error のときは、何も調べていないので空。ここにない層の漏れは、「残っていない」とは言えない
   */
  checkedLayers: P6Layer[];
  error?: { code: "empty" | "unreadable" | "encrypted"; message: string };
  pages: number | null;
  /** 見つけた所。文字の層（layer: "text"）と画像の層（layer: "image"。1.5.0 から） */
  findings: P6Finding[];
  skippedPages: Array<{ page: number; reason: "too_many_operations" | "too_many_covers" | "unreadable_page" | "stream_too_large" }>;
  /**
   * 画素を読めなかった画像。覆いとしても、画像の層の下地としても、調べていない。「問題なし」ではない。
   * JPEG・CCITT・JBIG2 などは、imageDecoder（PDF.js）を渡せば読む（1.5.0 から）。渡さなければ、ここに入る
   */
  uncheckedImages: Array<{ page: number } & UncheckedImage>;
  /**
   * explain のときだけ（1.6.0 から）。数えない条件で除いた覆いの数（層と理由ごと。キーは "image:repeated" など）。
   * 実物で、どの条件がどれだけ効いたかを測るため。値・字・場所は入れない
   */
  excluded?: Record<string, number>;
  /**
   * explain のときだけ（1.7.0 から）。報告した覆いの数え分け（除いてはいない）。
   * "text:on_top_<metrics.textOnTop>"：文字の層の報告を、覆いの上の字のあり方ごとに数えたもの。
   * "image:with_later_paint"：画像の層の報告のうち、あとから上に描いたものの下の点を数えなかったもの（1.10.0 から）。
   * "image:over_paint_overflow"：上に描いたものの形を集めきれず、1.9.0 までの測り方に戻したページの数（1.10.0 から）
   */
  diagnostics?: Record<string, number>;
  /** パスワードなしで開ける暗号化 PDF を、復号して調べたときだけ。どの暗号化だったか（1.2.0 から） */
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = {
  settings?: Partial<P6TextSettings>;
  includeText?: boolean;
  /**
   * pdf-lib で解けない圧縮の画像（JPEG・CCITT・JBIG2 など）を解く道具（1.5.0 から）。
   * rules/shared/pdfjs-images.ts の createPdfjsImageDecoder に、呼ぶ側で読み込んだ PDF.js を渡して作る。
   * 渡さないと、それらの画像は uncheckedImages に入り、覆いとしても、画像の層の下地としても調べない
   */
  imageDecoder?: ExternalImageDecoder;
  /** 数えない条件で除いた覆いの数を、報告の excluded に入れる（測るときだけ。1.6.0 から） */
  explain?: boolean;
};

/**
 * 覆い1つごとに、その前に描かれ、半分以上が隠れた字を集める。
 * 1.6.0 から、次の字・覆いは数えない（options を渡したとき。理由は filters.ts）：
 * - 見える範囲（ページの箱と切り抜き）の外の覆い・字
 * - 形の詰まり具合が低い塗り（アウトライン化した字の輪郭など）
 * - 覆いのあとに、同じ字をほぼ同じ所に描き直した字（白抜きの字・飾り文字）
 */
export function findCoveredText(
  covers: Cover[],
  glyphs: GlyphBox[],
  coveredFractionMin: number,
  options: { view?: Rect | null; settings?: P6TextSettings; exclude?: ExcludeCounter } = {},
): Array<{ cover: Cover; chars: number; text: string; hidden: GlyphBox[] }> {
  const out: Array<{ cover: Cover; chars: number; text: string; hidden: GlyphBox[] }> = [];
  const view = options.view ?? null;
  let byText: Map<string, GlyphBox[]> | null = null;
  for (const cover of covers) {
    // 白っぽい覆い（light）は、画像の層でだけ使う。字の層は、濃い覆いと、濃くない不透明な覆い（opaque。1.11.0 から）を使う
    if (cover.tone === "light") continue;
    let chars = 0;
    let text = "";
    let rawChars = 0;
    let reason: ExcludeReason | null = null;
    const hidden: GlyphBox[] = [];
    const vis = options.settings ? visiblePart(cover.rect, view, cover.clip) : cover.rect;
    for (const g of glyphs) {
      if (g.seq >= cover.seq) continue; // 覆いのあとに描いた字は、上に見えている
      if (cover.tone === "opaque" && g.invisible) continue; // 見えない描き方の字（文字認識の層など）は、濃くない覆いの下では数えない（1.11.0 から）
      const a = area(g.rect);
      if (a <= 0) continue;
      // 形を持つ覆い（曲線・回した四角など）は、形と字の箱の重なった面積で測る（1.3.0 から）
      if (intersectionArea(g.rect, cover.rect) <= 0) continue;
      if (coverageOf(cover, g.rect) / a < coveredFractionMin) continue;
      if (!g.isSpace) rawChars++;
      if (options.settings) {
        const cx = (g.rect[0] + g.rect[2]) / 2;
        const cy = (g.rect[1] + g.rect[3]) / 2;
        if (!vis || cx < vis[0] || cx > vis[2] || cy < vis[1] || cy > vis[3] || !isVisiblePoint(cx, cy, view, g.clip)) {
          reason ??= "outside_view";
          continue;
        }
        byText ??= indexGlyphsByText(glyphs);
        if (!g.isSpace && redrawnOnTop(g, cover, byText)) {
          reason ??= "same_text_on_top";
          continue;
        }
      }
      text += g.text;
      if (!g.isSpace) {
        chars++;
        hidden.push(g);
      }
    }
    if (rawChars === 0) continue;
    if (chars > 0 && options.settings && isNotSolidFill(cover, options.settings)) {
      options.exclude?.("text", "not_solid");
      continue;
    }
    // 字1つ分の大きさの、形のある塗り（アウトライン化した同じ字を重ねたもの。1.7.0 から）
    if (chars === 1 && options.settings && isGlyphSizedShape(cover, hidden[0]!, options.settings.glyphSizedRatio)) {
      options.exclude?.("text", "glyph_sized");
      continue;
    }
    if (chars > 0) out.push({ cover, chars, text, hidden });
    else if (reason) options.exclude?.("text", reason);
  }
  return out;
}

/** 同じ字の並びを、ほぼ同じ所で重ねて覆っている覆い（四角と、その縁の線など）は1つにまとめる */
function mergeSameArea<T extends { cover: Cover; chars: number }>(items: T[]): T[] {
  const out: typeof items = [];
  for (const it of items) {
    const same = out.find((o) => {
      const inter = intersectionArea(o.cover.rect, it.cover.rect);
      const small = Math.min(area(o.cover.rect), area(it.cover.rect));
      return small > 0 && inter / small >= 0.9;
    });
    if (!same) out.push(it);
    else if (area(it.cover.rect) > area(same.cover.rect)) {
      const chars = Math.max(same.chars, it.chars);
      const high = (same as { confidence?: string }).confidence === "high";
      Object.assign(same, it, { chars });
      if (high) (same as { confidence?: string }).confidence = "high"; // まとめた中に1つでも確かなものがあれば、確かなものとする
    } else if ((it as { confidence?: string }).confidence === "high" && "confidence" in same) {
      (same as { confidence?: string }).confidence = "high";
    }
  }
  return out;
}

export async function detectP6Text(bytes: Uint8Array, options: DetectOptions = {}): Promise<P6TextReport> {
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, checkedLayers: [] as P6Layer[], findings: [], skippedPages: [], uncheckedImages: [] };
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

  const report: P6TextReport = { ...base, status: "ok", checkedLayers: [...CHECKED_LAYERS], pages: 0, findings: [], skippedPages: [], uncheckedImages: [] };
  if (loaded.decrypted) report.decrypted = loaded.decrypted;
  let pages;
  try {
    pages = doc.getPages();
  } catch {
    return { ...base, status: "error", pages: null, error: { code: "unreadable", message: "ページの並びを読めませんでした。" } };
  }
  report.pages = pages.length;
  const excluded = new Map<string, number>();
  const diagnostics = new Map<string, number>();
  const exclude: ExcludeCounter = (layer, reason) => {
    const k = `${layer}:${reason}`;
    excluded.set(k, (excluded.get(k) ?? 0) + 1);
  };

  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    const pageNo = index + 1;
    try {
      const node = page.node;
      const view = pageView(page);
      const data = contentBytes(doc.context, node.Contents());
      const scanner = createPageScanner(doc.context, settings);
      scanner.run(data, node.Resources(), IDENTITY, "fill");
      scanAnnotations(doc.context, node.Annots(), scanner, settings); // 注釈は、ページの中身のあとに重なる
      const scan = scanner.result();
      const pixels = createPixelSource(doc.context, settings, options.imageDecoder);

      // pdf-lib で解けなかった画像は、PDF.js で解けたら、濃いかどうかを確かめ直す（1.5.0 から）。
      // 1.9.0 から：先に描いた字か画像に重なる画像（覆いになりうるもの）だけを解く
      if (options.imageDecoder) {
        for (const im of scan.images) {
          if (im.pendingUnchecked === undefined || !im.needDark) continue;
          const r = await pixels(im);
          if (r.kind !== "pixels") continue;
          const dark = darkFractionOf(r.reader, settings.darkLuminanceMax, settings.opacityMin);
          if (dark >= settings.darkImageFractionMin) {
            scanner.addLateCover({ seq: im.seq, rect: im.rect, kind: im.coverKind, how: "image", tone: "dark", luminance: 1 - dark, ...(im.shape ? { shape: im.shape } : {}) });
          }
        }
      }
      // 同じ順番の覆い（PDF.js で解いて濃いと分かった画像と、その画像の opaque の覆い）は、濃い方を先に置く（1.11.0 から）
      const covers = [...scan.covers].sort((a, b) => a.seq - b.seq || (a.tone === "dark" ? 0 : 1) - (b.tone === "dark" ? 0 : 1));

      const pageFindings: P6Finding[] = [];
      // 覆いの上のあり方で、数えない・確かめてくださいを決める（1.8.0 から）
      const classified = findCoveredText(covers, scan.glyphs, settings.coveredFractionMin, { view, settings, exclude }).flatMap((h) => {
        const onTop = classifyOnTop(h.cover, h.hidden, scan.glyphs, scan.marks);
        if (onTop === "same_chars") {
          exclude("text", "same_chars_on_top"); // 下の字は、どれも上に見えている
          return [];
        }
        const tiny = h.hidden.every((g) => g.rect[3] - g.rect[1] < settings.tinyGlyphHeightMax);
        // 字1つ分の大きさの黒い画像（字の形の型抜きの画像を、同じ字の上に重ねたもの）も「確かめてください」（1.9.0 から。人の決定で、数えなくはしない）
        const glyphImage = h.chars === 1 && isGlyphSizedImage(h.cover, h.hidden[0]!, settings.glyphSizedRatio);
        const confidence: "high" | "check" = onTop === "different" || onTop === "unknown_hidden" || onTop === "shapes" || tiny || glyphImage ? "check" : "high";
        return [{ ...h, onTop, confidence, tiny, glyphImage }];
      });
      const hits = mergeSameArea(classified);
      for (const h of hits) {
        const f: P6TextFinding = { pattern: "P6", layer: "text", cover: h.cover.kind, page: pageNo, rect: h.cover.rect, chars: h.chars, confidence: h.confidence };
        if (h.cover.tone === "opaque") f.coverTone = "opaque";
        if (options.includeText) f.text = h.text;
        if (options.explain) {
          f.metrics = textMetrics(h.cover, h.hidden, h.onTop);
          const k = `text:on_top_${f.metrics.textOnTop}`;
          diagnostics.set(k, (diagnostics.get(k) ?? 0) + 1);
          if (f.metrics.hiddenNonPrintable > 0) diagnostics.set("text:hidden_nonprintable", (diagnostics.get("text:hidden_nonprintable") ?? 0) + 1);
          if (h.tiny && h.onTop === "none") diagnostics.set("text:check_tiny", (diagnostics.get("text:check_tiny") ?? 0) + 1);
          if (h.glyphImage) diagnostics.set("text:check_glyph_image", (diagnostics.get("text:check_glyph_image") ?? 0) + 1);
        }
        pageFindings.push(f);
      }
      const imageHits = mergeSameArea((await findCoveredImages(covers, scan.images, scan.glyphs, pixels, settings, { view, exclude, overPaint: scan.overPaint })).map((h) => ({ ...h, chars: 0 })));
      if (scan.overPaint === null) diagnostics.set("image:over_paint_overflow", (diagnostics.get("image:over_paint_overflow") ?? 0) + 1);
      for (const h of imageHits) {
        const f: P6ImageFinding = {
          pattern: "P6",
          layer: "image",
          cover: h.cover.kind,
          tone: h.cover.tone === "dark" ? "dark" : "light",
          page: pageNo,
          rect: h.cover.rect,
          spread: h.spread === null ? null : round3(h.spread),
          confidence: h.confidence,
          ...(h.reason ? { reason: h.reason } : {}),
        };
        if (options.explain) {
          f.metrics = {
            ringLight: h.ringLight === null ? null : round3(h.ringLight),
            underLight: h.underLight === null ? null : round3(h.underLight),
            colored: h.colored === null ? null : round3(h.colored),
            laterPaintPoints: h.laterPaintPoints,
          };
          if (h.laterPaintPoints > 0) diagnostics.set("image:with_later_paint", (diagnostics.get("image:with_later_paint") ?? 0) + 1);
        }
        pageFindings.push(f);
      }
      report.findings.push(...pageFindings);
      // 調べられなかった画像（1.9.0 から、要るときに解いた結果で決める）
      // - pdf-lib で解けない圧縮の画像：PDF.js で解けたものは外す。解けなかったものは、その理由にする。
      //   PDF.js を渡したのに一度も解かなかった画像は、覆いの候補にかかわらない（調べる必要がない）ので外す
      // - pdf-lib で解ける画像：覆いの下になって解いてみて、壊れていたものを足す
      const unchecked = scan.uncheckedImages.map((u) => ({ ...u }));
      const keep = unchecked.map(() => true);
      for (const im of scan.images) {
        const r = pixels.settled.get(im.stream);
        if (im.pendingUnchecked !== undefined) {
          if (!options.imageDecoder) continue;
          if (!r || r.kind === "pixels") keep[im.pendingUnchecked] = false;
          else unchecked[im.pendingUnchecked]!.reason = r.reason;
        } else if (r && r.kind === "unknown") {
          unchecked.push({ reason: r.reason });
          keep.push(true);
        }
      }
      unchecked.forEach((u, i) => {
        if (keep[i]) report.uncheckedImages.push({ page: pageNo, ...u });
      });
    } catch (e) {
      report.skippedPages.push({
        page: pageNo,
        reason: e instanceof TooManyOperations
          ? "too_many_operations"
          : e instanceof TooManyCovers || e instanceof TooManyImageCovers
            ? "too_many_covers"
            : isInflateLimitError(e)
              ? "stream_too_large"
              : "unreadable_page",
      });
    }
  }
  if (options.explain) {
    report.excluded = Object.fromEntries([...excluded].sort(([a], [b]) => a.localeCompare(b)));
    report.diagnostics = Object.fromEntries([...diagnostics].sort(([a], [b]) => a.localeCompare(b)));
  }
  return report;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** 文字の層の1件の、測った値（explain のときだけ。1.7.0 から） */
function textMetrics(cover: Cover, hidden: GlyphBox[], textOnTop: TextOnTop): P6TextMetrics {
  const heights = hidden.map((g) => g.rect[3] - g.rect[1]);
  const [x0, y0, x1, y1] = cover.rect;
  return {
    glyphHeightMin: round3(Math.min(...heights)),
    glyphHeightMax: round3(Math.max(...heights)),
    coverMinSide: round3(Math.min(x1 - x0, y1 - y0)),
    how: cover.how,
    textOnTop,
    hiddenRotated: hidden.some((g) => g.rotated === true),
    coverLuminance: round3(cover.luminance),
    hiddenNonPrintable: hidden.filter((g) => g.text.trim() !== "" && !normalizeGlyphText(g.text)).length,
  };
}

/** 見える範囲：CropBox と MediaBox の重なり（ページの既定の座標）。読めなければ null（どこでも見えるとする）（1.6.0 から） */
function pageView(page: { getMediaBox(): { x: number; y: number; width: number; height: number }; getCropBox(): { x: number; y: number; width: number; height: number } }): Rect | null {
  const toRect = (b: { x: number; y: number; width: number; height: number }): Rect | null => {
    const r: Rect = [Math.min(b.x, b.x + b.width), Math.min(b.y, b.y + b.height), Math.max(b.x, b.x + b.width), Math.max(b.y, b.y + b.height)];
    return r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3] ? r : null;
  };
  try {
    const media = toRect(page.getMediaBox());
    const crop = toRect(page.getCropBox());
    if (media && crop) return intersectRect(media, crop) ?? media;
    return media ?? crop;
  } catch {
    return null;
  }
}

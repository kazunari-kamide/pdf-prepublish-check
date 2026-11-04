// SPDX-License-Identifier: AGPL-3.0-only
//
// P6 の画像の層（1.5.0 から）：画像の上に覆いを重ねただけで、覆いの下の元の画像の画素がそのまま残っている所を見つける。
// スキャンした書類（ページ全体の画像）の上に、黒や白の不透明な四角・注釈を置いただけのもの。
// 覆いを外す・画像を取り出すと、下に写っている字が読める。
//
// 見分け方：覆いの下の、元の画像の画素の明るさのばらつき（標準偏差）を測る。
// - 下に字や絵が写っていれば、濃い点と薄い点が混ざるので、ばらつきが大きい → 漏れ
// - 正しい墨消し（下の画素も黒く塗った）・紙の余白の上の覆いは、下が一様なので、ばらつきが小さい → 漏れでない
// 白っぽい覆いの上に、あとから字を書いたもの（年号や誤字の直し・地図の凡例の下地）は、直したものとして数えない。

import type { PDFContext, PDFStream } from "pdf-lib";
import { apply, area, insideParts, intersectionArea, type Matrix, type Rect } from "./geometry.ts";
import { isNotRectFill, isTooSmallFill, isVisiblePoint, repeatedFills, visiblePart, type ExcludeCounter } from "./filters.ts";
import { readImagePixels, type PixelRead, type PixelReader } from "./images.ts";
import type { Cover, CoverShape, GlyphBox, ImagePlacement, OverPaint } from "./page.ts";
import type { P6TextSettings } from "./settings.ts";
import type { ExternalImageDecoder } from "../shared/pdfjs-images.ts";

/** 覆い1つの、縦横それぞれの点の数の上限 */
const GRID_MAX = 64;
/** ばらつきを測るのに要る点の数の下限 */
const MIN_SAMPLES = 16;

export class TooManyImageCovers extends Error {}

export type CoveredImage = {
  cover: Cover;
  /** 覆いの下の元の画像の画素の、明るさの標準偏差（0〜0.5）。下の画像を解けなかった注釈の覆いは null（1.9.0 から） */
  spread: number | null;
  /** 測った点の数 */
  samples: number;
  /**
   * 確からしさ（1.7.0 から）。high＝注釈・黒い画像・紙らしい画像の上の塗り、
   * check＝下が紙らしくない（写真など）画像の上の濃い塗り。画面では「確かめてください」と弱く出す
   */
  confidence: "high" | "check";
  /** 測った値（1.7.0 から。explain のときに報告へ出す） */
  ringLight: number | null;
  underLight: number | null;
  /** 覆いの下とまわりの帯の、色のある点の割合（1.9.0 から）。測れなければ null */
  colored: number | null;
  /**
   * under_unreadable＝注釈の覆いの下の画像を解けなかった（1.9.0 から。confidence は check）。
   * under_later_paint＝白い覆いの点の大半が、あとから描いた細い線などの下で、測れる点が足りない（1.10.0 から。confidence は check）
   */
  reason?: "under_unreadable" | "under_later_paint";
  /** 白い覆いで、あとから上に描いたものの下にあるため数えなかった点の数（1.10.0 から） */
  laterPaintPoints: number;
};

function invert(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function insideShape(shape: CoverShape | undefined, x: number, y: number): boolean {
  return !shape || insideParts(shape.parts, shape.rule, x, y);
}

function insideRect(r: Rect, x: number, y: number): boolean {
  return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
}

/**
 * 画像の画素を読む道具を、ページの中で1回だけ作る（同じ画像を何度も解かない）。
 * 要るときに初めて解く（1.9.0 から）。解いた結果は settled に入れる（呼ぶ側が、調べられなかった画像を決めるため）
 */
export function createPixelSource(ctx: PDFContext, settings: P6TextSettings, decoder: ExternalImageDecoder | undefined) {
  const cache = new Map<PDFStream, Promise<PixelRead>>();
  const settled = new Map<PDFStream, PixelRead>();
  const read = (im: ImagePlacement): Promise<PixelRead> => {
    let p = cache.get(im.stream);
    if (!p) {
      const native = readImagePixels({
        ctx,
        stream: im.stream,
        colorSpaces: im.colorSpaces,
        fillLuminance: im.fillLuminance,
        maxImageBytes: settings.maxImageBytes,
        maxImagePixels: settings.maxImagePixels,
      });
      p = (
        native.kind === "unknown" && native.reason === "unsupported_filter" && decoder
          ? decoder(ctx, im.stream, { maxImagePixels: settings.maxImagePixels, fillLuminance: im.fillLuminance })
          : Promise.resolve(native)
      ).then((r) => {
        settled.set(im.stream, r);
        return r;
      });
      cache.set(im.stream, p);
    }
    return p;
  };
  return Object.assign(read, { settled });
}

/** 点の画素：明るさと色の濃さ */
type PixelPoint = { lum: number; chroma: number };

/** 帯の点の数の下限。これより少なければ（まわりに画像がない）、まわりの明るさは測らない */
const MIN_RING_SAMPLES = 8;

/** 箱 r の外側 width の帯に点を並べ、画像の上の点のうち、明るさ lumMin 以上の点の数と、色のある点の数を返す */
function measureRing(
  r: Rect,
  width: number,
  readPoint: (x: number, y: number) => PixelPoint | "none" | "unreadable",
  lumMin: number,
  chromaMin: number,
): { light: number; colored: number; n: number } {
  let colored = 0;
  if (!(width > 0)) return { light: 0, colored: 0, n: 0 };
  const outer: Rect = [r[0] - width, r[1] - width, r[2] + width, r[3] + width];
  const step = Math.max(width / 3, Math.max(outer[2] - outer[0], outer[3] - outer[1]) / GRID_MAX);
  let light = 0;
  let n = 0;
  for (let y = outer[1] + step / 2; y < outer[3]; y += step) {
    for (let x = outer[0] + step / 2; x < outer[2]; x += step) {
      if (x > r[0] && x < r[2] && y > r[1] && y < r[3]) continue; // 覆いの中は見ない
      const p = readPoint(x, y);
      if (typeof p !== "object") continue;
      n++;
      if (p.lum >= lumMin) light++;
      if (p.chroma >= chromaMin) colored++;
    }
  }
  return { light, colored, n };
}

/** 白っぽい覆いの上に、あとから字を書いているか（直したもの） */
function hasTextOnTop(cover: Cover, glyphs: GlyphBox[]): boolean {
  for (const g of glyphs) {
    if (g.seq <= cover.seq || g.isSpace) continue;
    const cx = (g.rect[0] + g.rect[2]) / 2;
    const cy = (g.rect[1] + g.rect[3]) / 2;
    if (insideRect(cover.rect, cx, cy) && insideShape(cover.shape, cx, cy)) return true;
  }
  return false;
}

/**
 * 白い覆いの点の並び（nx × ny）に、あとから上に描いたものの下にある点の印をつける（1.10.0 から）。
 * 1＝あとから描いた不透明な塗り・線（色・太さを問わない）の下、2＝あとから描いた濃い覆い（画像の層でそれ自身が測られるもの）の下。
 * 縁には、下の画像の画素1つ分のゆとりを持たせる（片付けで塗った画素の丸めの分）。
 * 上に描いたものの形を集めきれなかったページ（overPaint が null）では、印をまったくつけない（1.9.0 までと同じ測り方。人の決定）
 */
function markLater(
  cover: Cover,
  candidates: Cover[],
  overPaint: OverPaint[] | null,
  under: ImagePlacement[],
  readers: Map<ImagePlacement, PixelReader | null>,
  vis: Rect,
  nx: number,
  ny: number,
): Uint8Array | null {
  if (overPaint === null) return null;
  const darkLater = candidates.filter((c) => c.seq > cover.seq && c.tone === "dark" && c.how !== "stroke" && intersectionArea(c.rect, vis) > 0);
  const paintLater = overPaint.filter((o) => cover.seq <= o.after && intersectionArea(o.rect, vis) > 0);
  if (darkLater.length === 0 && paintLater.length === 0) return null;
  let px = 0;
  for (const im of under) {
    const r = readers.get(im);
    if (!r) continue;
    const [a, b, c, d] = im.ctm;
    px = Math.max(px, Math.hypot(a, b) / r.width, Math.hypot(c, d) / r.height);
  }
  const offsets: [number, number][] = px > 0 ? [[0, 0], [px, 0], [-px, 0], [0, px], [0, -px]] : [[0, 0]];
  const [x0, y0, x1, y1] = vis;
  const w = x1 - x0;
  const h = y1 - y0;
  const mask = new Uint8Array(nx * ny);
  const paintOne = (box: Rect, value: 1 | 2, inside: (x: number, y: number) => boolean, clip: Rect | undefined) => {
    const i0 = Math.max(0, Math.floor(((box[0] - px - x0) / w) * nx - 0.5));
    const i1 = Math.min(nx - 1, Math.ceil(((box[2] + px - x0) / w) * nx - 0.5));
    const j0 = Math.max(0, Math.floor(((box[1] - px - y0) / h) * ny - 0.5));
    const j1 = Math.min(ny - 1, Math.ceil(((box[3] + px - y0) / h) * ny - 0.5));
    for (let j = j0; j <= j1; j++) {
      const y = y0 + ((j + 0.5) * h) / ny;
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        if (mask[k]! >= value) continue;
        const x = x0 + ((i + 0.5) * w) / nx;
        if (clip && !isVisiblePoint(x, y, null, clip)) continue;
        if (offsets.some(([dx, dy]) => inside(x + dx, y + dy))) mask[k] = value;
      }
    }
  };
  for (const o of paintLater) {
    paintOne(o.rect, 1, (x, y) => o.parts.some((poly) => insideParts([poly], "nonzero", x, y)), o.clip);
  }
  for (const c of darkLater) {
    paintOne(c.rect, 2, (x, y) => insideRect(c.rect, x, y) && insideShape(c.shape, x, y), c.clip);
  }
  return mask;
}

/**
 * 画像の上の覆いごとに、下の元の画像の画素のばらつきを測る。
 * ばらつきが imageSpreadMin 以上のものを返す。解けない画像の上の覆いは、測らない（uncheckedImages に入っている）。
 */
export async function findCoveredImages(
  covers: Cover[],
  images: ImagePlacement[],
  glyphs: GlyphBox[],
  pixels: (im: ImagePlacement) => Promise<PixelRead>,
  settings: P6TextSettings,
  options: { includeAll?: boolean; view?: Rect | null; exclude?: ExcludeCounter; overPaint?: OverPaint[] | null } = {},
): Promise<CoveredImage[]> {
  if (images.length === 0) return [];
  const view = options.view ?? null;
  const skip = (reason: Parameters<ExcludeCounter>[1]) => options.exclude?.("image", reason);
  // 線は見ない（写真の縁の飾りの線が、画像の端の上に乗るため。限界は README）
  const onImages = covers.filter((c) => c.how !== "stroke" && images.some((im) => im.seq < c.seq && intersectionArea(im.rect, c.rect) > 0));
  // 数えない条件（1.6.0 から）。軽いものから順に。覆いの数の上限は、このあとで数える
  // （装飾の格子・アウトライン化した字の多いページを、上限で「省いた」にしないため）
  const visibleOf = new Map<Cover, Rect>();
  let candidates: Cover[] = [];
  for (const c of onImages) {
    const vis = visiblePart(c.rect, view, c.clip);
    if (!vis) skip("outside_view");
    else if (isTooSmallFill(c, settings)) skip("too_small");
    else {
      visibleOf.set(c, vis);
      candidates.push(c);
    }
  }
  const repeated = repeatedFills(candidates, settings);
  candidates = candidates.filter((c) => {
    if (repeated.has(c)) skip("repeated");
    else if (isNotRectFill(c)) skip("not_rect"); // 1.7.0 から：ページの中身の塗りは、縦横の四角だけ（1.6.0 の詰まり具合より強い）
    else return true;
    return false;
  });
  if (candidates.length > settings.maxImageCoversPerPage) throw new TooManyImageCovers();

  const inverses = new Map<ImagePlacement, Matrix | null>();
  const inv = (im: ImagePlacement) => {
    if (!inverses.has(im)) inverses.set(im, invert(im.ctm));
    return inverses.get(im)!;
  };

  const out: CoveredImage[] = [];
  for (const cover of candidates) {
    if (cover.tone === "light" && hasTextOnTop(cover, glyphs)) {
      skip("text_on_top");
      continue;
    }
    // 覆いより前に描いた画像を、新しい順に（同じ点では、いちばん上に見えていた画像の画素を読む）
    const vis = visibleOf.get(cover)!;
    const ring = settings.ringWidth;
    const outer: Rect = [vis[0] - ring, vis[1] - ring, vis[2] + ring, vis[3] + ring];
    const under = images.filter((im) => im.seq < cover.seq && intersectionArea(im.rect, outer) > 0).sort((a, b) => b.seq - a.seq);
    const readers = new Map<ImagePlacement, PixelReader | null>();
    for (const im of under) {
      const r = await pixels(im);
      readers.set(im, r.kind === "pixels" ? r.reader : null);
    }
    /** 点 (x, y) で見えていた、覆いより前の画像の画素の明るさと色の濃さ。画像がなければ none、解けない画像なら unreadable */
    const readPoint = (x: number, y: number): PixelPoint | "none" | "unreadable" => {
      for (const im of under) {
        if (!insideRect(im.rect, x, y) || !insideShape(im.shape, x, y) || !isVisiblePoint(x, y, view, im.clip)) continue;
        const m = inv(im);
        if (!m) continue;
        const [u, v] = apply(m, x, y);
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const reader = readers.get(im);
        if (!reader) return "unreadable";
        // 画像の単位の正方形は、下が v=0。画素の行は上から数える
        const px = Math.min(reader.width - 1, Math.floor(u * reader.width));
        const py = Math.min(reader.height - 1, Math.floor((1 - v) * reader.height));
        const p = reader.at(px, py);
        if (p.lum === null || p.alpha < settings.opacityMin) continue; // 透けている点は、下の画像を見る
        return { lum: p.lum, chroma: p.chroma ?? 0 };
      }
      return "none";
    };

    // 見える部分だけに点を並べる（ページの外・切り抜きの外は、何も隠していない。1.6.0 から）
    const [x0, y0, x1, y1] = vis;
    const w = x1 - x0;
    const h = y1 - y0;
    if (!(w > 0 && h > 0) || area(vis) <= 0) continue;
    const nx = Math.max(1, Math.min(GRID_MAX, Math.ceil(w)));
    const ny = Math.max(1, Math.min(GRID_MAX, Math.ceil(h)));
    // 白い覆いの点のうち、あとから上に不透明に描いたものの下にある点（1.10.0 から）。その点では上に描いたものが見えていて、
    // 下の中身は上のもの自身の問題になる。1＝描いたもの（塗り・線）の下、2＝濃い覆い（それ自身が測られる）の下
    const laterMask = cover.tone === "light" ? markLater(cover, candidates, options.overPaint ?? null, under, readers, vis, nx, ny) : null;
    let laterPaint = 0;
    let laterDark = 0;
    let laterSum = 0;
    let laterSum2 = 0;
    let inShape = 0;
    let onImage = 0;
    let unreadable = 0;
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    let paper = 0;
    let colored = 0;
    for (let j = 0; j < ny; j++) {
      const y = y0 + ((j + 0.5) * h) / ny;
      for (let i = 0; i < nx; i++) {
        const x = x0 + ((i + 0.5) * w) / nx;
        if (!insideShape(cover.shape, x, y)) continue;
        const pt = readPoint(x, y);
        const mark = laterMask ? laterMask[j * nx + i]! : 0;
        if (mark > 0 && pt !== "none") {
          laterPaint++;
          if (mark === 2) laterDark++;
          if (pt !== "unreadable") {
            laterSum += pt.lum;
            laterSum2 += pt.lum * pt.lum;
          }
          continue;
        }
        inShape++;
        if (pt === "none") continue;
        onImage++;
        if (pt === "unreadable") {
          unreadable++;
          continue;
        }
        const lum = pt.lum;
        if (pt.chroma >= settings.coloredChromaMin) colored++;
        sum += lum;
        sum2 += lum * lum;
        n++;
        if (lum >= settings.paperLuminanceMin) paper++;
      }
    }
    // あとから上に描いたものの下を数えなかったため、測れる点が足りなくなった白い覆い（1.10.0 から。人の決定）
    // - 数えなかった点の大半が、濃い覆い（それ自身が測られる）の下：その濃い覆いで見つかるので、報告を省く
    // - それ以外（細い線が密に重なった形など）：白い札の上に線を引くだけで下の漏れが消えないよう、「確かめてください」で出す。
    //   ただし、数えなかった点も含めて下が一様なら、何も隠していないので出さない
    if (laterPaint > 0 && n < MIN_SAMPLES && !(unreadable > 0 && unreadable >= n)) {
      const all = inShape + laterPaint;
      if (all === 0 || (onImage + laterPaint) / all < settings.imageUnderFractionMin) continue;
      if (laterDark * 2 > laterPaint) {
        skip("under_later_cover");
        continue;
      }
      const m = laterPaint + n;
      const mean = (laterSum + sum) / m;
      const spreadAll = Math.sqrt(Math.max(0, (laterSum2 + sum2) / m - mean * mean));
      if (!options.includeAll && spreadAll < settings.imageSpreadMin) continue;
      const ringStats = measureRing(vis, ring, readPoint, settings.ringLightLuminanceMin, settings.coloredChromaMin);
      const ringLight = ringStats.n >= MIN_RING_SAMPLES ? ringStats.light / ringStats.n : null;
      if (cover.kind === "fill" && cover.how === "fill" && ringLight !== null && ringLight < settings.ringLightFractionMin) {
        skip("not_blending");
        continue;
      }
      out.push({ cover, spread: null, samples: n, confidence: "check", ringLight, underLight: null, colored: null, reason: "under_later_paint", laterPaintPoints: laterPaint });
      continue;
    }
    if (inShape === 0 || onImage / inShape < settings.imageUnderFractionMin) continue;
    if (n < MIN_SAMPLES || unreadable > n) {
      // 注釈の覆いの下の画像を解けなかった（大きすぎる・読めない色・読めない圧縮）ときは、黙って見逃さず、
      // 「確かめてください」として報告する（1.9.0 から。実物で、注釈の覆いの誤検知はこれまで 0 件。2026-11-04、人の承認）
      if (cover.kind === "annotation" && unreadable > 0 && unreadable >= n) {
        out.push({ cover, spread: null, samples: 0, confidence: "check", ringLight: null, underLight: null, colored: null, reason: "under_unreadable", laterPaintPoints: laterPaint });
      }
      continue;
    }
    const mean = sum / n;
    const spread = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    if (!options.includeAll && spread < settings.imageSpreadMin) continue;
    const underLight = paper / n;

    // まわりの帯（覆いの外側 ringWidth）の、下の画像の明るい点の割合（1.7.0 から）。
    // 白い覆いで隠すのは、まわりが白い紙で、覆いが見えなくなるから。写真の上の白い札・枠・タイルは、まわりが写真
    const ringStats = measureRing(vis, ring, readPoint, settings.ringLightLuminanceMin, settings.coloredChromaMin);
    const ringLight = ringStats.n >= MIN_RING_SAMPLES ? ringStats.light / ringStats.n : null;
    // 覆いの下とまわりの帯の、色のある点の割合（1.9.0 から）。書類の紙は、白か薄い灰色の地に黒い字で、色がほとんどない。
    // 地図・航空写真は、地そのものに色がある（緑の地・青い川・色分けした区画）
    const coloredFraction = (colored + ringStats.colored) / (n + ringStats.n);
    const pageFill = cover.kind === "fill" && cover.how === "fill";
    if (pageFill && cover.tone === "light" && ringLight !== null && ringLight < settings.ringLightFractionMin) {
      skip("not_blending");
      continue;
    }
    // 濃い塗りで、下が紙らしくない（写真など）ものは、落とさずに「確かめてください」にする（1.7.0 から。人の決定）
    // 色のある地（地図・航空写真）の上の、ページの中身の塗りと黒い画像も「確かめてください」（1.9.0 から。注釈にはかけない）
    const pageImage = cover.kind === "image" && cover.how === "image";
    const onColored = (pageFill || pageImage) && coloredFraction >= settings.coloredFractionMin;
    const confidence: CoveredImage["confidence"] = (pageFill && cover.tone === "dark" && underLight < settings.paperFractionMin) || onColored ? "check" : "high";
    out.push({ cover, spread, samples: n, confidence, ringLight, underLight, colored: coloredFraction, laterPaintPoints: laterPaint });
  }
  return out;
}

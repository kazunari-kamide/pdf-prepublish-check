// SPDX-License-Identifier: AGPL-3.0-only
//
// 注釈を覆いとして読む（P6 の text/annotation：注釈で字を覆った型）。
// 注釈は、ページの中身をすべて描いたあとに上に重ねて描かれる。そのため、注釈の覆いは
// ページのどの字よりもあとに描いたものとして扱う（PageScanner に、ページのあとで渡す）。
//
// - 見た目（/AP の /N）がある注釈：見た目の命令の列を読み、濃い塗り・濃い画像を覆いとする
// - 見た目のない四角の注釈（/Square）：中の色（/IC）が濃ければ、注釈の箱を覆いとする
// - 未適用の墨消しの注釈（/Redact）：見た目や色にかかわらず、黒塗りのつもりの所として覆いとする
//   （適用すれば消える所だが、いまは下の字が残っている）
// - 隠した注釈（/F の Hidden・NoView）は、見えないので覆いにしない（墨消しの注釈は除く）
// - 見た目のない蛍光ペンの注釈（/Highlight）：色（/C）が濃いときだけ覆いとする（1.11.0 から。乗算で重なるので、濃くない色は透ける）
// - 1.11.0 から、白・灰・色の不透明な注釈も、字の層の覆い（濃くない覆い）にする（覆いの下の字は、色によらず P6）

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { decodeStream } from "../shared/inflate-limit.ts";
import { apply, boundsOf, isFiniteMatrix, multiply, type Matrix, type Point, type Rect } from "./geometry.ts";
import { luminanceOf, type PageScanner } from "./page.ts";
import type { P6TextSettings } from "./settings.ts";

const FLAG_HIDDEN = 2;
const FLAG_NOVIEW = 32;

function numbers(ctx: PDFContext, obj: PDFObject | undefined): number[] | null {
  const v = obj ? ctx.lookup(obj) : undefined;
  if (!(v instanceof PDFArray)) return null;
  const out: number[] = [];
  for (const o of v.asArray()) {
    const n = ctx.lookup(o);
    if (!(n instanceof PDFNumber)) return null;
    out.push(n.asNumber());
  }
  return out.every(Number.isFinite) ? out : null;
}

function rectOf(a: number[] | null): Rect | null {
  if (!a || a.length < 4) return null;
  return [Math.min(a[0]!, a[2]!), Math.min(a[1]!, a[3]!), Math.max(a[0]!, a[2]!), Math.max(a[1]!, a[3]!)];
}

/** 見た目の流れ（/AP の /N）。状態ごとの辞書なら、/AS で選ばれたもの */
function normalAppearance(ctx: PDFContext, annot: PDFDict): PDFStream | null {
  const ap = annot.lookupMaybe(PDFName.of("AP"), PDFDict);
  const n = ap ? ctx.lookup(ap.get(PDFName.of("N"))) : undefined;
  if (n instanceof PDFStream) return n;
  if (n instanceof PDFDict) {
    const as = annot.lookup(PDFName.of("AS"));
    const chosen = as instanceof PDFName ? ctx.lookup(n.get(as)) : undefined;
    if (chosen instanceof PDFStream) return chosen;
  }
  return null;
}

/** 見た目の座標をページの座標に移す行列（PDF 1.7 §12.5.5：BBox を Matrix で移した箱を、Rect に合わせる） */
function appearanceMatrix(ctx: PDFContext, ap: PDFStream, rect: Rect): Matrix | null {
  const bbox = rectOf(numbers(ctx, ap.dict.get(PDFName.of("BBox"))));
  const mArr = numbers(ctx, ap.dict.get(PDFName.of("Matrix")));
  const m: Matrix = mArr && mArr.length === 6 ? (mArr as Matrix) : [1, 0, 0, 1, 0, 0];
  if (!bbox) return null;
  const corners: Point[] = [
    apply(m, bbox[0], bbox[1]),
    apply(m, bbox[2], bbox[1]),
    apply(m, bbox[2], bbox[3]),
    apply(m, bbox[0], bbox[3]),
  ];
  const t = boundsOf(corners);
  const tw = t[2] - t[0];
  const th = t[3] - t[1];
  if (tw <= 0 || th <= 0) return null;
  const sx = (rect[2] - rect[0]) / tw;
  const sy = (rect[3] - rect[1]) / th;
  const a: Matrix = [sx, 0, 0, sy, rect[0] - t[0] * sx, rect[1] - t[1] * sy];
  const out = multiply(m, a);
  return isFiniteMatrix(out) ? out : null;
}

function streamBytes(s: PDFStream): Uint8Array {
  return decodeStream(s);
}

/** ページの注釈を、覆いとして scanner に渡す。ページの命令の列を読んだあとに呼ぶ */
export function scanAnnotations(ctx: PDFContext, annots: PDFArray | undefined, scanner: PageScanner, settings: P6TextSettings): void {
  if (!annots) return;
  for (const ref of annots.asArray()) {
    const annot = ctx.lookup(ref);
    if (!(annot instanceof PDFDict)) continue;
    const subtypeObj = annot.lookup(PDFName.of("Subtype"));
    const subtype = subtypeObj instanceof PDFName ? subtypeObj.decodeText() : "";
    const rect = rectOf(numbers(ctx, annot.get(PDFName.of("Rect"))));
    if (!rect) continue;

    if (subtype === "Redact") {
      // QuadPoints があれば、その四辺形ごと。なければ Rect
      const q = numbers(ctx, annot.get(PDFName.of("QuadPoints")));
      if (q && q.length >= 8) {
        for (let i = 0; i + 8 <= q.length; i += 8) {
          const pts: Point[] = [[q[i]!, q[i + 1]!], [q[i + 2]!, q[i + 3]!], [q[i + 4]!, q[i + 5]!], [q[i + 6]!, q[i + 7]!]];
          scanner.addCover(boundsOf(pts), "annotation", "redact", 0);
        }
      } else scanner.addCover(rect, "annotation", "redact", 0);
      continue;
    }

    if (subtype === "Popup") continue;
    const flagsObj = annot.lookup(PDFName.of("F"));
    const flags = flagsObj instanceof PDFNumber ? flagsObj.asNumber() : 0;
    if (flags & (FLAG_HIDDEN | FLAG_NOVIEW)) continue;
    const caObj = annot.lookup(PDFName.of("CA"));
    const ca = caObj instanceof PDFNumber ? caObj.asNumber() : 1;
    if (ca < settings.opacityMin) continue;

    const ap = normalAppearance(ctx, annot);
    if (ap) {
      const m = appearanceMatrix(ctx, ap, rect);
      if (!m) continue;
      const res = ap.dict.lookupMaybe(PDFName.of("Resources"), PDFDict);
      scanner.run(streamBytes(ap), res, m, "annotation");
      continue;
    }

    // 見た目のない四角・多角形の注釈は、中の色（/IC）で見る。濃い色は字の層と画像の層、
    // 白っぽい色は画像の層だけの覆いになる（1.5.0 から。addCover が色の向きで分ける）。
    // 多角形は、注釈の箱（/Rect）で近似する（1.5.0 から）
    // 見た目のない蛍光ペンの注釈（/Highlight）は、色（/C）が濃いときだけ、QuadPoints（なければ Rect）を覆いにする（1.11.0 から）。
    // 蛍光ペンは乗算で重ねて表示されるので、濃くない色では下の字が透けて見える（覆いにしない）
    if (subtype === "Highlight") {
      const c = numbers(ctx, annot.get(PDFName.of("C")));
      const lum = c && c.length > 0 ? luminanceOf(c, c.length) : null;
      if (lum === null || lum > settings.darkLuminanceMax) continue;
      const q = numbers(ctx, annot.get(PDFName.of("QuadPoints")));
      if (q && q.length >= 8) {
        for (let i = 0; i + 8 <= q.length; i += 8) {
          const pts: Point[] = [[q[i]!, q[i + 1]!], [q[i + 2]!, q[i + 3]!], [q[i + 4]!, q[i + 5]!], [q[i + 6]!, q[i + 7]!]];
          scanner.addCover(boundsOf(pts), "annotation", "fill", lum);
        }
      } else scanner.addCover(rect, "annotation", "fill", lum);
      continue;
    }
    if (subtype === "Square" || subtype === "Polygon") {
      const ic = numbers(ctx, annot.get(PDFName.of("IC")));
      const lum = ic && ic.length > 0 ? luminanceOf(ic, ic.length) : null;
      if (lum !== null) scanner.addCover(rect, "annotation", "fill", lum);
    }
  }
}

/**
 * 図形の層（1.13.0 から）：白い不透明な四角の注釈（/Square）の箱。見つける段の3回目で、パスで描いた字を覆っていた形。
 * 中の色（/IC）が白っぽい（明るさが lightLuminanceMin 以上）もの。隠した注釈・半透明の注釈・中の色のない注釈は入れない。
 * 見た目（/AP）の有無は問わない（見た目があっても、中の色で決める）
 */
export function whiteSquareAnnots(ctx: PDFContext, annots: PDFArray | undefined, settings: P6TextSettings): Rect[] {
  if (!annots) return [];
  const out: Rect[] = [];
  for (const ref of annots.asArray()) {
    const annot = ctx.lookup(ref);
    if (!(annot instanceof PDFDict)) continue;
    const subtypeObj = annot.lookup(PDFName.of("Subtype"));
    if (!(subtypeObj instanceof PDFName) || subtypeObj.decodeText() !== "Square") continue;
    const rect = rectOf(numbers(ctx, annot.get(PDFName.of("Rect"))));
    if (!rect || !((rect[2] - rect[0]) * (rect[3] - rect[1]) > 0)) continue;
    const flagsObj = annot.lookup(PDFName.of("F"));
    const flags = flagsObj instanceof PDFNumber ? flagsObj.asNumber() : 0;
    if (flags & (FLAG_HIDDEN | FLAG_NOVIEW)) continue;
    const caObj = annot.lookup(PDFName.of("CA"));
    const ca = caObj instanceof PDFNumber ? caObj.asNumber() : 1;
    if (ca < settings.opacityMin) continue;
    const ic = numbers(ctx, annot.get(PDFName.of("IC")));
    const lum = ic && ic.length > 0 ? luminanceOf(ic, ic.length) : null;
    if (lum === null || lum < settings.lightLuminanceMin) continue;
    out.push(rect);
  }
  return out;
}

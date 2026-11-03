// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付けても壊れていないことを確かめる（Node で使う道具。画面には入れない）。
// 片付けの側のコードは使わず、PDF を読み直して比べる。
//
// 1. 開ける：pdf-lib と PDF.js の両方で開け、全ページを描ける
// 2. ページ数・ページの大きさ・回転が同じ
// 3. 字が増えていない：片付けたあとに取り出せる字が、片付ける前の字の中に収まっている（字ごとの数で比べる）
// 4. 見た目が同じ：PDF.js で前後のページを同じ倍率で描き、色の差が大きい画素の数を数える。
//    片付けで描き込んだ所（適用した墨消しの黒い四角）は、変わってよい所として除いて数える
//
// 描くのは PDF.js（pdfjs-dist）。Node では、pdfjs-dist が任意で使う @napi-rs/canvas で描く（ライブラリは足していない）。
// それがない環境では、4 は「描けない」と返す（合格にはしない）。

import { PDFDocument } from "pdf-lib";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Rect = [number, number, number, number];

export type PageCheck = {
  page: number;
  sameSize: boolean;
  /** 色の差が大きい画素の数（変わってよい所を除く） */
  diffPixels: number | null;
  totalPixels: number | null;
  /** 取り出せる字の数（空白を除く） */
  charsBefore: number;
  charsAfter: number;
  /** 片付けたあとにだけある字の数（0 でなければ、字が増えた・変わった） */
  charsAdded: number;
};

export type CheckResult = {
  opens: { pdfLib: boolean; pdfjs: boolean; render: boolean | null };
  pagesBefore: number | null;
  pagesAfter: number | null;
  pages: PageCheck[];
  /** 見た目の差の合計（画素） */
  diffPixels: number | null;
  ok: boolean;
  problems: string[];
};

export type CheckOptions = {
  /** 描く倍率（1 = 72dpi）。既定 1.5 */
  scale?: number;
  /** 色の差（0〜255）がこれより大きい画素を「違う」と数える。既定 64 */
  colorDelta?: number;
  /** 「同じ見た目」とみなす、違う画素の割合の上限（ページごと）。既定 0.0005（0.05%） */
  maxDiffFraction?: number;
  /** 変わってよい所（ページの番号ごとの、ページの既定の座標の箱） */
  allowedChanges?: Map<number, Rect[]>;
};

// PDF.js は「/」で終わる場所を求める。Windows でも「/」で区切る
const STANDARD_FONTS =
  path.join(path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json"))), "standard_fonts").split(path.sep).join("/") + "/";

async function openPdfjs(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({
    data: bytes.slice(),
    // pdfjs-dist 6 には isEvalSupported がない（eval を使う道が除かれている）。残りの安全側の設定を使う
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONTS,
    verbosity: 0,
  }).promise;
}

async function textChars(doc: PDFDocumentProxy, pageNo: number): Promise<Map<string, number>> {
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent();
  const m = new Map<string, number>();
  for (const it of tc.items) {
    if (!("str" in it)) continue;
    for (const ch of it.str) {
      if (/\s/.test(ch)) continue;
      m.set(ch, (m.get(ch) ?? 0) + 1);
    }
  }
  return m;
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

type Rendered = { data: Uint8ClampedArray; width: number; height: number; transform: number[] };

async function render(doc: PDFDocumentProxy, pageNo: number, scale: number): Promise<Rendered> {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const w = Math.ceil(viewport.width);
  const h = Math.ceil(viewport.height);
  // Node では、PDF.js の canvasFactory が @napi-rs/canvas の画面を作る（DOM の型はないので、使う所だけの形で受ける）
  type Ctx2D = { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } };
  const factory = (doc as unknown as { canvasFactory: { create(w: number, h: number): { canvas: unknown; context: Ctx2D } } }).canvasFactory;
  const { canvas, context } = factory.create(w, h);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, w, h);
  await page.render({ canvasContext: context, canvas, viewport } as unknown as Parameters<typeof page.render>[0]).promise;
  return { data: context.getImageData(0, 0, w, h).data, width: w, height: h, transform: viewport.transform };
}

/** ページの座標の箱を、描いた画素の箱に移す */
function toDevice(t: number[], r: Rect): Rect {
  const pts = [
    [r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]],
  ].map(([x, y]) => [t[0]! * x! + t[2]! * y! + t[4]!, t[1]! * x! + t[3]! * y! + t[5]!]);
  const xs = pts.map((p) => p[0]!);
  const ys = pts.map((p) => p[1]!);
  return [Math.floor(Math.min(...xs)) - 2, Math.floor(Math.min(...ys)) - 2, Math.ceil(Math.max(...xs)) + 2, Math.ceil(Math.max(...ys)) + 2];
}

export async function checkSanitized(before: Uint8Array, after: Uint8Array, options: CheckOptions = {}): Promise<CheckResult> {
  const scale = options.scale ?? 1.5;
  const colorDelta = options.colorDelta ?? 64;
  const maxDiffFraction = options.maxDiffFraction ?? 0.0005;
  const problems: string[] = [];
  const result: CheckResult = { opens: { pdfLib: false, pdfjs: false, render: null }, pagesBefore: null, pagesAfter: null, pages: [], diffPixels: null, ok: false, problems };

  try {
    await PDFDocument.load(after, { updateMetadata: false });
    result.opens.pdfLib = true;
  } catch {
    problems.push("pdf-lib で開けない");
  }
  let a: PDFDocumentProxy, b: PDFDocumentProxy;
  try {
    a = await openPdfjs(after);
    result.opens.pdfjs = true;
  } catch (e) {
    problems.push("PDF.js で開けない（" + String((e as Error)?.message ?? e).slice(0, 120) + "）");
    return result;
  }
  try {
    b = await openPdfjs(before);
  } catch {
    problems.push("片付ける前の PDF を PDF.js で開けない（比べられない）");
    return result;
  }
  result.pagesBefore = b.numPages;
  result.pagesAfter = a.numPages;
  if (a.numPages !== b.numPages) problems.push(`ページ数が違う（前 ${b.numPages}、後 ${a.numPages}）`);

  let canRender = true;
  let diffTotal = 0;
  for (let p = 1; p <= Math.min(a.numPages, b.numPages); p++) {
    const pa = await a.getPage(p);
    const pb = await b.getPage(p);
    const va = pa.getViewport({ scale: 1 });
    const vb = pb.getViewport({ scale: 1 });
    const sameSize = Math.abs(va.width - vb.width) < 0.01 && Math.abs(va.height - vb.height) < 0.01 && pa.rotate === pb.rotate;
    if (!sameSize) problems.push(`${p} ページ：大きさか回転が違う`);

    const cb = await textChars(b, p);
    const ca = await textChars(a, p);
    let added = 0;
    for (const [ch, n] of ca) added += Math.max(0, n - (cb.get(ch) ?? 0));
    if (added > 0) problems.push(`${p} ページ：片付ける前になかった字が ${added} 字ある`);

    let diffPixels: number | null = null;
    let totalPixels: number | null = null;
    if (canRender) {
      try {
        const ra = await render(a, p, scale);
        const rb = await render(b, p, scale);
        if (ra.width !== rb.width || ra.height !== rb.height) {
          problems.push(`${p} ページ：描いた大きさが違う`);
        } else {
          const allowed = (options.allowedChanges?.get(p) ?? []).map((r) => toDevice(ra.transform, r));
          let diff = 0;
          for (let y = 0; y < ra.height; y++) {
            for (let x = 0; x < ra.width; x++) {
              const i = (y * ra.width + x) * 4;
              const d = Math.max(Math.abs(ra.data[i]! - rb.data[i]!), Math.abs(ra.data[i + 1]! - rb.data[i + 1]!), Math.abs(ra.data[i + 2]! - rb.data[i + 2]!));
              if (d <= colorDelta) continue;
              if (allowed.some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3])) continue;
              diff++;
            }
          }
          diffPixels = diff;
          totalPixels = ra.width * ra.height;
          diffTotal += diff;
          if (diff / totalPixels > maxDiffFraction) problems.push(`${p} ページ：見た目が違う（${diff} 画素、${((diff / totalPixels) * 100).toFixed(3)}%）`);
        }
      } catch (e) {
        canRender = false;
        problems.push(`ページを描けない（${e instanceof Error ? e.message.slice(0, 80) : "不明"}）`);
      }
    }
    result.pages.push({ page: p, sameSize, diffPixels, totalPixels, charsBefore: sum(cb), charsAfter: sum(ca), charsAdded: added });
  }
  result.opens.render = canRender;
  result.diffPixels = canRender ? diffTotal : null;
  await (a as unknown as { loadingTask?: { destroy(): Promise<void> } }).loadingTask?.destroy();
  await (b as unknown as { loadingTask?: { destroy(): Promise<void> } }).loadingTask?.destroy();
  result.ok = problems.length === 0;
  return result;
}

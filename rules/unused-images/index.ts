// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：描かれていない資源に残る画像（`unused-images`）1.0.0。型は P5（旧版の残存）の仲間【仮】。
// 墨消しを適用したあとも、塗る前の元の画像が、ページの /Resources /XObject に名前つきで残り、どこからも描かれていない型。
// いまの版から指されているので、P5 の「使っていない定義」（どこからも指されていないオブジェクト）には当たらない。
//
// 見つけ方：
//   1. 文書全体で、実際に描かれた画像を集める（ページ・描かれた部品（フォーム XObject）・注釈の見た目の中の Do。部品の中もたどる）。
//      ページどうしで資源の辞書を共有する PDF（ほかのページで描く画像が並ぶ）でも誤検知しないよう、文書全体で集める。
//   2. 各ページの資源（と、描かれた部品の資源）の /XObject にある画像のうち、文書のどこでも描かれていないものを出す。
//   3. 同じページで描かれた画像に、同じ大きさ（幅・高さ）のものがあれば、画素を比べる。
//      違う点の割合が 0 より多く SIMILAR_MAX 以下なら similar（墨消し前の元の画像のおそれ。画面では高）。
//      まったく同じなら identical、大きく違えば different、比べられなければ uncompared。
// 値（画素）は返さない。ページ・大きさ・違いの割合だけ。

import { PDFDict, PDFName, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { operations } from "../shared/content-lexer.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import type { ExternalImageDecoder } from "../shared/pdfjs-images.ts";
import { readImagePixels, type PixelRead } from "../p6-text/images.ts";
import { appearanceStreams, arrayItems, dictOf, lookup, N, nameOf, numOf, openPdf, streamData, type RuleError } from "../common/index.ts";

export const RULE_ID = "unused-images";
export const RULE_VERSION = "1.0.0";

/** 違う点の割合がこれ以下（かつ 0 より多い）なら、ほとんど同じとみなす【仮の値】 */
export const SIMILAR_MAX = 0.05;
/** 明るさの差がこれより大きい点を「違う点」とする（0〜1）【仮の値】 */
export const LUM_DIFF = 0.1;
/** 比べる点の数の上限。超える大きさの画像は、縦横を同じ間隔で間引いて比べる */
export const MAX_SAMPLES = 1_000_000;
/** 1ページで見る資源の辞書の数の上限【仮の値】 */
const MAX_DICTS = 1000;
export const LIMITS = { streamBytes: 64 * 1024 * 1024, opsPerStream: 3_000_000, depth: 12, imageBytes: 256 * 1024 * 1024, imagePixels: 64_000_000 } as const;

export type UnusedImageMatch = "similar" | "identical" | "different" | "uncompared" | "no_same_size";

export type UnusedImageFinding = {
  pattern: "P5";
  /** 資源の辞書に載っていた最初のページ（1 から） */
  page: number;
  width: number;
  height: number;
  /** 同じページで描かれた、同じ大きさの画像との比べ */
  match: UnusedImageMatch;
  /** match が similar・different・identical のとき：違う点の割合（0〜1） */
  diffRatio?: number;
  bytes: number;
};

export type UnusedImageReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  findings: UnusedImageFinding[];
  /** 描かれた画像の数 */
  drawnImages: number;
  limits: Array<"too_many_ops" | "unreadable_stream">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { imageDecoder?: ExternalImageDecoder };

const keyOf = (ctx: PDFContext, raw: PDFObject | undefined): PDFObject | undefined => (raw instanceof PDFRef ? (ctx.lookup(raw) ?? undefined) : raw);
const isImage = (ctx: PDFContext, o: PDFObject | undefined): o is PDFStream => o instanceof PDFStream && nameOf(ctx, o.dict.get(N("Subtype"))) === "Image";
const isForm = (ctx: PDFContext, o: PDFObject | undefined): o is PDFStream => o instanceof PDFStream && nameOf(ctx, o.dict.get(N("Subtype"))) === "Form";

/** 描く命令の列を読み、Do で描いた画像と部品を集める（部品の中もたどる） */
function walk(ctx: PDFContext, content: Uint8Array, res: PDFDict | undefined, drawn: Set<PDFObject>, drawnOnPage: Set<PDFStream>, forms: Set<PDFStream>, onLimit: (l: UnusedImageReport["limits"][number]) => void, depth = 0) {
  const xobjects = dictOf(ctx, res?.get(N("XObject")));
  let ops = 0;
  try {
    for (const { op, args } of operations(content)) {
      if (++ops > LIMITS.opsPerStream) {
        onLimit("too_many_ops");
        return;
      }
      if (op !== "Do") continue;
      const name = args[0]?.t === "name" ? args[0].v : undefined;
      if (name === undefined || !xobjects) continue;
      const xo = keyOf(ctx, xobjects.get(N(name)));
      if (!xo) continue;
      if (isImage(ctx, xo)) {
        drawn.add(xo);
        drawnOnPage.add(xo);
      } else if (isForm(ctx, xo) && !drawn.has(xo) && depth < LIMITS.depth) {
        drawn.add(xo);
        forms.add(xo);
        const inner = streamData(xo, LIMITS.streamBytes);
        if (!inner) onLimit("unreadable_stream");
        else walk(ctx, inner, dictOf(ctx, xo.dict.get(N("Resources"))) ?? res, drawn, drawnOnPage, forms, onLimit, depth + 1);
      } else if (isForm(ctx, xo)) {
        forms.add(xo);
      }
    }
  } catch {
    /* 読めない所で止める（集めた分は使う） */
  }
}

function contentBytes(ctx: PDFContext, raw: PDFObject | undefined): Uint8Array {
  const v = lookup(ctx, raw);
  const list = v instanceof PDFStream ? [v] : arrayItems(ctx, v).map((x) => lookup(ctx, x)).filter((x): x is PDFStream => x instanceof PDFStream);
  const parts = list.map((s) => streamData(s, LIMITS.streamBytes)).filter((b): b is Uint8Array => !!b);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
    out[at++] = 0x0a;
  }
  return out;
}

async function pixelsOf(ctx: PDFContext, s: PDFStream, colorSpaces: PDFDict | undefined, decoder: ExternalImageDecoder | undefined): Promise<PixelRead> {
  let r: PixelRead;
  try {
    r = readImagePixels({ ctx, stream: s, colorSpaces, fillLuminance: 0, maxImageBytes: LIMITS.imageBytes, maxImagePixels: LIMITS.imagePixels });
  } catch {
    r = { kind: "unknown", reason: "broken" };
  }
  if (r.kind === "unknown" && r.reason === "unsupported_filter" && decoder) {
    try {
      r = await decoder(ctx, s, { maxImagePixels: LIMITS.imagePixels, fillLuminance: 0 });
    } catch {
      r = { kind: "unknown", reason: "broken" };
    }
  }
  return r;
}

/** 同じ大きさの 2 つの画像の、違う点の割合（明るさの差が LUM_DIFF より大きい点）。比べられなければ null */
export async function diffRatio(ctx: PDFContext, a: PDFStream, b: PDFStream, colorSpaces: PDFDict | undefined, decoder?: ExternalImageDecoder): Promise<number | null> {
  // 中身のバイト列が同じなら、画素も同じ
  const ra = streamData(a, LIMITS.streamBytes);
  const rb = streamData(b, LIMITS.streamBytes);
  if (ra && rb && ra.length === rb.length && ra.every((x, i) => x === rb[i])) return 0;
  const pa = await pixelsOf(ctx, a, colorSpaces, decoder);
  const pb = await pixelsOf(ctx, b, colorSpaces, decoder);
  if (pa.kind !== "pixels" || pb.kind !== "pixels") return null;
  const w = Math.min(pa.reader.width, pb.reader.width);
  const h = Math.min(pa.reader.height, pb.reader.height);
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_SAMPLES)));
  let n = 0;
  let diff = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const p = pa.reader.at(x, y);
      const q = pb.reader.at(x, y);
      n++;
      const dl = Math.abs((p.lum ?? 0) - (q.lum ?? 0));
      const dc = Math.abs((p.chroma ?? 0) - (q.chroma ?? 0));
      if (dl > LUM_DIFF || dc > LUM_DIFF) diff++;
    }
  }
  return n ? diff / n : null;
}

export async function detectUnusedImages(bytes: Uint8Array, options: DetectOptions = {}): Promise<UnusedImageReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], drawnImages: 0, limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { doc, ctx } = opened;
  const report: UnusedImageReport = { ...base, status: "ok", findings: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;
  const limit = (l: UnusedImageReport["limits"][number]) => {
    if (!report.limits.includes(l)) report.limits.push(l);
  };

  let pages;
  try {
    pages = doc.getPages();
  } catch {
    return report;
  }
  // 1. 文書全体で描かれたもの。ページごとに、描かれた画像と、資源を見る部品も残す
  const drawn = new Set<PDFObject>();
  const perPage: Array<{ res: PDFDict | undefined; drawnOnPage: Set<PDFStream>; forms: Set<PDFStream> }> = [];
  for (const page of pages) {
    const res = dictOf(ctx, page.node.get(N("Resources"))) ?? page.node.Resources();
    const drawnOnPage = new Set<PDFStream>();
    const forms = new Set<PDFStream>();
    walk(ctx, contentBytes(ctx, page.node.get(N("Contents"))), res, drawn, drawnOnPage, forms, limit);
    for (const a of arrayItems(ctx, page.node.get(N("Annots")))) {
      const annot = dictOf(ctx, a);
      if (!annot) continue;
      for (const s of appearanceStreams(ctx, annot)) {
        const d = streamData(s, LIMITS.streamBytes);
        if (d) walk(ctx, d, dictOf(ctx, s.dict.get(N("Resources"))) ?? res, drawn, drawnOnPage, forms, limit);
      }
    }
    perPage.push({ res, drawnOnPage, forms });
  }
  report.drawnImages = [...drawn].filter((o) => isImage(ctx, o)).length;

  // 2. 資源に載っているのに、どこでも描かれていない画像
  const reported = new Set<PDFStream>();
  for (let i = 0; i < perPage.length; i++) {
    const { res, drawnOnPage, forms } = perPage[i]!;
    // ページの資源と、そこから届く部品（描かれたものも、描かれていないものも）の資源
    const dicts: PDFDict[] = res ? [res] : [];
    const seenForms = new Set<PDFStream>();
    const addForm = (f: PDFStream) => {
      if (seenForms.has(f)) return;
      seenForms.add(f);
      const fr = dictOf(ctx, f.dict.get(N("Resources")));
      if (fr && !dicts.includes(fr)) dicts.push(fr);
    };
    for (const f of forms) addForm(f);
    for (let k = 0; k < dicts.length && dicts.length < MAX_DICTS; k++) {
      const xs = dictOf(ctx, dicts[k]!.get(N("XObject")));
      if (xs) for (const [, raw] of xs.entries()) {
        const o = keyOf(ctx, raw);
        if (isForm(ctx, o)) addForm(o);
      }
    }
    const colorSpaces = dictOf(ctx, res?.get(N("ColorSpace")));
    for (const r of dicts) {
      const xobjects = dictOf(ctx, r?.get(N("XObject")));
      if (!xobjects) continue;
      for (const [, raw] of xobjects.entries()) {
        const xo = keyOf(ctx, raw);
        if (!isImage(ctx, xo) || drawn.has(xo) || reported.has(xo)) continue;
        reported.add(xo);
        const width = Math.floor(numOf(ctx, xo.dict.get(N("Width"))) ?? 0);
        const height = Math.floor(numOf(ctx, xo.dict.get(N("Height"))) ?? 0);
        const f: UnusedImageFinding = { pattern: "P5", page: i + 1, width, height, match: "no_same_size", bytes: xo instanceof PDFStream ? (streamData(xo, LIMITS.streamBytes)?.length ?? 0) : 0 };
        // 3. 同じページで描かれた、同じ大きさの画像と比べる（いちばん近いもの）
        const same = [...drawnOnPage].filter((d) => numOf(ctx, d.dict.get(N("Width"))) === width && numOf(ctx, d.dict.get(N("Height"))) === height);
        if (same.length) {
          let best: number | null = null;
          for (const d of same) {
            const r2 = await diffRatio(ctx, xo, d, colorSpaces, options.imageDecoder);
            if (r2 !== null && (best === null || r2 < best)) best = r2;
          }
          if (best === null) f.match = "uncompared";
          else {
            f.diffRatio = best;
            f.match = best === 0 ? "identical" : best <= SIMILAR_MAX ? "similar" : "different";
          }
        }
        report.findings.push(f);
      }
    }
  }
  const order: UnusedImageMatch[] = ["similar", "uncompared", "different", "no_same_size", "identical"];
  report.findings.sort((a, b) => order.indexOf(a.match) - order.indexOf(b.match) || a.page - b.page);
  return report;
}

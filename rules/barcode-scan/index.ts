// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：黒塗りのそばの記号（`barcode-scan`）1.0.0。型は P6（見せかけの黒塗り）の仲間【仮】。
// スキャンした書類の画像（ページの画像）の中で、黒く塗った四角のそばに、細い縦の線がそろった間隔で並ぶ形
// （郵便の宛先や管理番号を表す、機械で読む記号の型）が、塗られずに残っている所を返す。
// 塗った欄と同じ情報が、記号の形で残っていることがある。記号の中身（値）は解かない・返さない。数と場所だけ。
//
// 見つけ方（ページを画像にせず、ページに描いた画像の画素を読む。スキャンの中の絵柄は、図形の命令には出てこないため）：
//   1. ページの中身で Do で描いた画像のうち、縦横の比がページとほぼ同じ（ページの全面のスキャンとみなす）ものを選ぶ。
//      画素は pdf-lib で解き、解けない形（JPEG・CCITT など）は、呼ぶ側が渡した imageDecoder（PDF.js）で解く。
//      解き手が渡されないとき（道具から動かすとき）は、このルールの小さな解き手（decode.ts。JPEG の基本の形・CCITT の G4）で解く（1.1.0 から）。
//      フォームの中で描いた画像も見る（3 段まで）。型抜きの塗らない点は紙の白として数える。
//   2. 紙の明るさ（明るい方から 1 割の所）の半分より暗い点を「暗い点」とし、つながった暗い点のかたまりを集める。
//   3. 黒い四角：窓（約 2.5pt 四方）の 7 割以上が暗い所だけを残した絵（罫線・字の画を外す）の上のかたまりで、
//      幅 30pt 以上・高さ 6〜300pt・ページの幅の 9 割より狭く、かたまりの箱の 85% 以上が暗いもの。
//   4. 細い線：幅 3pt 以下・高さ 2.5〜14pt・高さが幅の 1.4 倍以上のもの（荒いスキャンで短い線が太って見えるため）。中心の高さがそろい（2.5pt 以内）、
//      となりとの間が 8pt 以内で横に続くものを 1 列とする。12 本以上・間隔のばらつき（標準偏差 ÷ 平均）が 0.25 以下
//      （高さが 1 種類だけの列は 0.15 以下）・高さの種類が 1〜4 なら「記号の列」。
//   5. 記号の列と黒い四角の、上下の離れが 72pt 以内で、横にも 72pt 以内に重なれば、1 件として返す。

import { PDFDict, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { operations } from "../shared/content-lexer.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import type { ExternalImageDecoder } from "../shared/pdfjs-images.ts";
import { readImagePixels, type PixelRead, type PixelReader } from "../p6-text/images.ts";
import { decodeScanImage } from "./decode.ts";
import { arrayItems, dictOf, lookup, N, nameOf, numOf, openPdf, streamData, type RuleError } from "../common/index.ts";

export const RULE_ID = "barcode-scan";
export const RULE_VERSION = "1.1.0";

/** しきい（pt は、ページの寸法で測った値）【仮の値】 */
export const SETTINGS = {
  boxMinW: 30,
  boxMinH: 6,
  boxMaxH: 300,
  boxFill: 0.85,
  barMaxW: 3,
  barMinH: 2.5,
  barMaxH: 14,
  barAspect: 1.4,
  barFill: 0.6,
  rowCenterTol: 2.5,
  rowMaxGap: 8,
  rowMinBars: 12,
  gapCv: 0.25,
  gapCvSingle: 0.15,
  near: 72,
  /** 画像を読むときの、1pt あたりの点の数の上限（約 216dpi）と、点の数の上限 */
  maxPxPerPt: 3,
  maxPoints: 12_000_000,
  maxComponents: 400_000,
} as const;

export const LIMITS = { streamBytes: 64 * 1024 * 1024, opsPerStream: 3_000_000, imageBytes: 256 * 1024 * 1024, imagePixels: 64_000_000, pages: 200 } as const;

export type BarcodeFinding = {
  pattern: "P6";
  page: number;
  /** 記号の列の箱（ページの座標。左下が原点・pt） */
  rect: [number, number, number, number];
  bars: number;
  /** 線の高さの種類（1〜4） */
  heights: number;
  /** 記号の列と、いちばん近い黒い四角との上下の離れ（pt） */
  distance: number;
};

export type BarcodeReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  findings: BarcodeFinding[];
  /** 調べたページの画像の数と、解けなかった画像のあるページ */
  checkedImages: number;
  uncheckedPages: number[];
  limits: Array<"too_many_ops" | "too_many_pages" | "too_many_components">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { imageDecoder?: ExternalImageDecoder };

type Comp = { x0: number; y0: number; x1: number; y1: number; n: number };

// 型の絞り込み（o is PDFStream）にすると、偽のときに PDFStream が never になり、フォームの枝で型が落ちるので、真偽だけを返す
const isImage = (ctx: PDFContext, o: PDFObject | undefined): boolean => o instanceof PDFStream &&nameOf(ctx, o.dict.get(N("Subtype"))) === "Image";

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
  // 解き手が渡されない（道具から動かすとき）・解き手が解けないときは、このルールの小さな解き手（JPEG の基本の形・CCITT の G4）で解く（1.1.0 から）
  if (r.kind === "unknown" && (r.reason === "unsupported_filter" || r.reason === "broken")) {
    const own = decodeScanImage(ctx, s, LIMITS.imagePixels);
    if (own) r = { kind: "pixels", reader: own };
  }
  return r;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const cv = (a: number[]) => {
  const m = mean(a);
  if (m <= 0) return Infinity;
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) / m;
};

/** 高さを、近いものどうしでまとめた種類の数 */
function heightLevels(hs: number[], tol: number): number {
  const s = [...hs].sort((a, b) => a - b);
  let levels = 0;
  let start = -Infinity;
  for (const h of s) {
    if (h > start + tol) {
      levels++;
      start = h;
    }
  }
  return levels;
}

/** 画像の中の、黒い四角と記号の列を探す。座標は、間引いた画像の点（上が 0） */
export function findInPixels(reader: PixelReader, pxPerPt: number, onLimit?: () => void): Array<{ row: Comp; bars: number; heights: number; distance: number }> {
  const S = SETTINGS;
  let step = Math.max(1, Math.floor(pxPerPt / S.maxPxPerPt));
  while ((reader.width / step) * (reader.height / step) > S.maxPoints) step++;
  const W = Math.floor(reader.width / step);
  const H = Math.floor(reader.height / step);
  const s = pxPerPt / step; // 間引いたあとの 1pt あたりの点の数
  if (W < 50 || H < 50) return [];

  // 紙の明るさ：明るい方から 1 割の所
  const hist = new Uint32Array(256);
  let samples = 0;
  const sStep = Math.max(1, Math.floor(Math.sqrt((W * H) / 200_000)));
  for (let y = 0; y < H; y += sStep) {
    for (let x = 0; x < W; x += sStep) {
      const p = reader.at(x * step, y * step);
      // 型抜き（白黒のスキャンに多い）の塗らない点は、紙の白として数える（1.1.0 から）
      const lum = p.lum === null || p.alpha < 0.5 ? 1 : p.lum;
      const bin = Math.max(0, Math.min(255, Math.round(lum * 255)));
      hist[bin] = (hist[bin] ?? 0) + 1;
      samples++;
    }
  }
  if (!samples) return [];
  let acc = 0;
  let paper = 255;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v]!;
    if (acc >= samples * 0.1) {
      paper = v;
      break;
    }
  }
  if (paper < 100) return []; // 紙の白が無い（写真など）
  const thr = (paper / 255) * 0.5;

  const dark = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = reader.at(x * step, y * step);
      if (p.lum !== null && p.alpha >= 0.5 && p.lum < thr) dark[y * W + x] = 1;
    }
  }

  // 塗りだけの絵（1.1.0 から）：窓（約 2.5pt 四方）の 7 割以上が暗い点だけを残す。罫線・枠・となりの字に触れた塗りも、
  // 細い線と字の画が外れて、塗りだけのかたまりになる（実物のスキャンでは、塗りが表の線につながっていることが多い）
  const solid = new Uint8Array(W * H);
  {
    const k = Math.max(3, Math.round(2.5 * s));
    const r = k >> 1;
    const integ = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) {
        row += dark[y * W + x]!;
        integ[(y + 1) * (W + 1) + x + 1] = integ[y * (W + 1) + x + 1]! + row;
      }
    }
    const need = 0.7 * k * k;
    const core = new Uint8Array(W * H);
    for (let y = r; y < H - r; y++) {
      for (let x = r; x < W - r; x++) {
        const x0 = x - r, y0 = y - r, x1 = x0 + k, y1 = y0 + k;
        const sum = integ[y1 * (W + 1) + x1]! - integ[y0 * (W + 1) + x1]! - integ[y1 * (W + 1) + x0]! + integ[y0 * (W + 1) + x0]!;
        if (sum >= need) core[y * W + x] = 1;
      }
    }
    // 中心だけが残るので、窓の大きさだけ広げ直す（暗い点の上だけ）
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!core[y * W + x]) continue;
        for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) if (dark[yy * W + xx]) solid[yy * W + xx] = 1;
        }
        // 右へ続く中心は、次の点で広げ直すので、行の中は飛ばしてよい
      }
    }
  }

  const stack = new Int32Array(W * H);
  /** つながった点のかたまり（4 方向）。map の 1 を 2 にしながら数える */
  const label = (map: Uint8Array): Comp[] => {
    const comps: Comp[] = [];
    for (let i = 0; i < W * H; i++) {
      if (map[i] !== 1) continue;
      if (comps.length >= S.maxComponents) {
        onLimit?.();
        break;
      }
      const c: Comp = { x0: W, y0: H, x1: -1, y1: -1, n: 0 };
      let sp = 0;
      stack[sp++] = i;
      map[i] = 2;
      while (sp > 0) {
        const j = stack[--sp]!;
        const x = j % W;
        const y = (j - x) / W;
        c.n++;
        if (x < c.x0) c.x0 = x;
        if (x > c.x1) c.x1 = x;
        if (y < c.y0) c.y0 = y;
        if (y > c.y1) c.y1 = y;
        if (x > 0 && map[j - 1] === 1) (map[j - 1] = 2), (stack[sp++] = j - 1);
        if (x < W - 1 && map[j + 1] === 1) (map[j + 1] = 2), (stack[sp++] = j + 1);
        if (y > 0 && map[j - W] === 1) (map[j - W] = 2), (stack[sp++] = j - W);
        if (y < H - 1 && map[j + W] === 1) (map[j + W] = 2), (stack[sp++] = j + W);
      }
      comps.push(c);
    }
    return comps;
  };

  const boxes: Comp[] = [];
  const bars: Comp[] = [];
  for (const c of label(solid)) {
    const w = c.x1 - c.x0 + 1;
    const h = c.y1 - c.y0 + 1;
    const fill = c.n / (w * h);
    if (w >= S.boxMinW * s && h >= S.boxMinH * s && h <= S.boxMaxH * s && w <= W * 0.9 && fill >= S.boxFill) boxes.push(c);
  }
  if (!boxes.length) return [];
  for (const c of label(dark)) {
    const w = c.x1 - c.x0 + 1;
    const h = c.y1 - c.y0 + 1;
    const fill = c.n / (w * h);
    if (w <= Math.max(1, S.barMaxW * s) && h >= S.barMinH * s && h <= S.barMaxH * s && h >= S.barAspect * w && fill >= S.barFill) bars.push(c);
  }
  if (!boxes.length || bars.length < S.rowMinBars) return [];

  // 細い線を、中心の高さがそろい、横に続く列にまとめる
  bars.sort((a, b) => a.x0 + a.x1 - (b.x0 + b.x1));
  const rows: Array<{ cy: number; lastCx: number; items: Comp[] }> = [];
  for (const b of bars) {
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) <= S.rowCenterTol * s && cx - r.lastCx <= S.rowMaxGap * s && cx > r.lastCx);
    if (row) {
      row.items.push(b);
      row.lastCx = cx;
      // 傾いたスキャンでは、列の中心の高さが少しずつずれるので、近い棒に合わせて追う（1.1.0 から）
      row.cy = row.cy * 0.8 + cy * 0.2;
    } else rows.push({ cy, lastCx: cx, items: [b] });
  }

  const out: Array<{ row: Comp; bars: number; heights: number; distance: number }> = [];
  for (const r of rows) {
    if (r.items.length < S.rowMinBars) continue;
    const cxs = r.items.map((b) => (b.x0 + b.x1) / 2);
    const gaps = cxs.slice(1).map((x, i) => x - cxs[i]!);
    const hs = r.items.map((b) => b.y1 - b.y0 + 1);
    const levels = heightLevels(hs, Math.max(1.5, 0.15 * Math.max(...hs)));
    if (levels < 1 || levels > 4) continue;
    if (cv(gaps) > (levels === 1 ? S.gapCvSingle : S.gapCv)) continue;
    const box: Comp = { x0: Math.min(...r.items.map((b) => b.x0)), y0: Math.min(...r.items.map((b) => b.y0)), x1: Math.max(...r.items.map((b) => b.x1)), y1: Math.max(...r.items.map((b) => b.y1)), n: r.items.length };
    let best = Infinity;
    for (const k of boxes) {
      const dy = Math.max(0, k.y0 - box.y1, box.y0 - k.y1);
      const dx = Math.max(0, k.x0 - box.x1, box.x0 - k.x1);
      if (dy <= S.near * s && dx <= S.near * s) best = Math.min(best, dy / s);
    }
    if (best === Infinity) continue;
    out.push({ row: { ...box, x0: box.x0 / s, x1: (box.x1 + 1) / s, y0: box.y0 / s, y1: (box.y1 + 1) / s }, bars: r.items.length, heights: levels, distance: Math.round(best * 10) / 10 });
  }
  return out;
}

export async function detectBarcodeScan(bytes: Uint8Array, options: DetectOptions = {}): Promise<BarcodeReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], checkedImages: 0, uncheckedPages: [], limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { doc, ctx } = opened;
  const report: BarcodeReport = { ...base, status: "ok", findings: [], uncheckedPages: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;
  const limit = (l: BarcodeReport["limits"][number]) => {
    if (!report.limits.includes(l)) report.limits.push(l);
  };

  let pages: ReturnType<typeof doc.getPages>;
  try {
    pages = doc.getPages();
  } catch {
    return report;
  }
  if (pages.length > LIMITS.pages) limit("too_many_pages");
  for (let i = 0; i < Math.min(pages.length, LIMITS.pages); i++) {
    const page = pages[i]!;
    let pw: number, ph: number;
    try {
      ({ width: pw, height: ph } = page.getSize());
    } catch {
      continue;
    }
    if (!(pw > 0 && ph > 0)) continue;
    const seen = new Set<PDFStream>();
    let ops = 0;
    // ページの中身と、そこから描くフォーム（スキャンの画像をフォームに包む作り方がある。1.1.0 から、3 段まで）をたどる
    const walk = async (content: Uint8Array, resRaw: PDFObject | undefined, depth: number): Promise<void> => {
      const res = dictOf(ctx, resRaw);
      const xobjects = dictOf(ctx, res?.get(N("XObject")));
      if (!xobjects) return;
      const colorSpaces = dictOf(ctx, res?.get(N("ColorSpace")));
      for (const { op, args } of operations(content)) {
        if (++ops > LIMITS.opsPerStream) {
          limit("too_many_ops");
          return;
        }
        if (op !== "Do") continue;
        const name = args[0]?.t === "name" ? args[0].v : undefined;
        if (name === undefined) continue;
        const raw = xobjects.get(N(name));
        const xo = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
        if (!(xo instanceof PDFStream) || seen.has(xo)) continue;
        if (!isImage(ctx, xo)) {
          if (depth < 3 && nameOf(ctx, xo.dict.get(N("Subtype"))) === "Form") {
            seen.add(xo);
            const body = streamData(xo, LIMITS.streamBytes);
            if (body) await walk(body, xo.dict.get(N("Resources")) ?? resRaw, depth + 1);
          }
          continue;
        }
        seen.add(xo);
        const iw = numOf(ctx, xo.dict.get(N("Width"))) ?? 0;
        const ih = numOf(ctx, xo.dict.get(N("Height"))) ?? 0;
        if (iw < 300 || ih < 300) continue;
        // ページの全面のスキャンとみなせるもの（縦横の比がページとほぼ同じ。回したページは入れ替えて比べる）
        const ratio = iw / ih;
        const same = Math.abs(ratio / (pw / ph) - 1) <= 0.2;
        const swapped = Math.abs(ratio / (ph / pw) - 1) <= 0.2;
        if (!same && !swapped) continue;
        const pxPerPt = iw / (same ? pw : ph);
        const px = await pixelsOf(ctx, xo, colorSpaces, options.imageDecoder);
        if (px.kind !== "pixels") {
          if (!report.uncheckedPages.includes(i + 1)) report.uncheckedPages.push(i + 1);
          continue;
        }
        report.checkedImages++;
        const scale = px.reader.width / iw; // 解いた道具が間引いたときの比
        for (const f of findInPixels(px.reader, pxPerPt * scale, () => limit("too_many_components"))) {
          // 画像の点（上が 0）から、ページの座標（左下が 0）へ。回したページは近似で、そのまま返す
          const r = f.row;
          report.findings.push({ pattern: "P6", page: i + 1, rect: [r.x0, ph - r.y1, r.x1, ph - r.y0].map((v) => Math.round(v * 10) / 10) as BarcodeFinding["rect"], bars: f.bars, heights: f.heights, distance: f.distance });
        }
      }
    };
    try {
      await walk(contentBytes(ctx, page.node.get(N("Contents"))), page.node.get(N("Resources")) ?? page.node.Resources(), 0);
    } catch {
      /* 読めない所で止める（見つけた分は使う） */
    }
  }
  return report;
}

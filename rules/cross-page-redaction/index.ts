// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：同じ書式のページの塗り忘れ（`cross-page-redaction`）1.0.0。型は P6（見せかけの黒塗り）の仲間【仮】。
// スキャンした書類で、あるページでは黒く塗った所（墨消し）が、同じ書式の別のページの同じ位置では塗られずに、
// 何かが描かれたまま残っている所を返す。塗った欄と同じ欄が、ほかのページで読めてしまう型。
// 中身（字・画素）は返さない。ページと場所だけ。
//
// 見つけ方（根拠の実物はスキャンの画像のページなので、図形の命令ではなく、ページに描いた画像の画素を読む）：
//   1. ページの中身で Do で描いた画像（フォームの中は 3 段まで）のうち、縦横の比がページとほぼ同じもの（全面のスキャン）を選ぶ。
//      画素は pdf-lib で解き、解けない形は、呼ぶ側が渡した imageDecoder（PDF.js）か、barcode-scan の小さな解き手で解く。
//   2. ページを 1pt のます目にし、ますごとに「暗い点」（紙の明るさの半分より暗い点）の割合を出す。
//   3. 黒い四角：割合 0.85 以上のますのかたまりで、幅 30pt 以上・高さ 6〜300pt・ページの幅の 9 割より狭く、箱の 85% 以上が暗いもの。
//   4. 大きさが同じ（2pt 以内）ページの組で、書式が似ている（8pt のますで見た濃い所が、となりのますまでの ずれで 6 割以上重なる。四角の所は外す）とき、
//      片方の四角と同じ位置が、もう片方では
//        - 塗られていない（暗い割合の平均が 0.6 未満）
//        - 何かが描かれている（暗い割合 0.3 以上のますが 8% 以上）
//        - 四角の左（なければ右）の見出しの所が、両方のページで同じ形（罫線を外した濃さを、3pt まで ずらして比べた相関が 0.75 以上。
//          罫線の位置が同じだけで見出しの字が違う表は、同じと見ない）
//      なら、塗られていない側のページの 1 件として返す。

import { PDFDict, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { operations } from "../shared/content-lexer.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import type { ExternalImageDecoder } from "../shared/pdfjs-images.ts";
import { readImagePixels, type PixelRead, type PixelReader } from "../p6-text/images.ts";
import { decodeScanImage } from "../barcode-scan/decode.ts";
import { arrayItems, dictOf, lookup, N, nameOf, numOf, openPdf, streamData, type RuleError } from "../common/index.ts";

export const RULE_ID = "cross-page-redaction";
export const RULE_VERSION = "1.0.0";

/** しきい（pt は、ページの寸法で測った値）【仮の値】 */
export const SETTINGS = {
  solid: 0.85,
  boxMinW: 30,
  boxMinH: 6,
  boxMaxH: 300,
  boxFill: 0.85,
  /** 相手のページで「塗られている」とみなす暗い割合の平均 */
  coveredMean: 0.6,
  /** 相手のページで「何かが描かれている」とみなす、濃いますの割合（欄の下線 1 本だけの空の欄は数えない） */
  inkShare: 0.08,
  inkCell: 0.3,
  /** 書式の似かた（粗います 8pt） */
  coarse: 8,
  coarseInk: 0.05,
  layoutMatch: 0.6,
  layoutMinCells: 20,
  /** 見出しの所（四角の左・右の幅）。罫線とみなす濃さの割合、ずらす幅（pt）、相関のしきい */
  context: 60,
  lineShare: 0.8,
  contextShift: 3,
  contextCorr: 0.75,
  contextMinCells: 8,
  tol: 2,
} as const;

export const LIMITS = { streamBytes: 64 * 1024 * 1024, opsPerStream: 3_000_000, imageBytes: 256 * 1024 * 1024, imagePixels: 64_000_000, pages: 60, gridCells: 2_000_000, boxes: 200 } as const;

export type CrossPageFinding = {
  pattern: "P6";
  /** 塗られずに残っているページ */
  page: number;
  /** 同じ位置を塗ったページ */
  redactedPage: number;
  /** 場所（ページの座標。左下が原点・pt） */
  rect: [number, number, number, number];
};

export type CrossPageReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  findings: CrossPageFinding[];
  checkedPages: number;
  uncheckedPages: number[];
  limits: Array<"too_many_ops" | "too_many_pages" | "too_large_page" | "too_many_boxes">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { imageDecoder?: ExternalImageDecoder };

type Box = { x0: number; y0: number; x1: number; y1: number };
/** ページのます目（1pt。上が 0）。frac＝ますの暗い点の割合 */
type Grid = { page: number; pw: number; ph: number; gw: number; gh: number; frac: Float32Array; boxes: Box[] };

const isImage = (ctx: PDFContext, o: PDFObject | undefined): boolean => o instanceof PDFStream && nameOf(ctx, o.dict.get(N("Subtype"))) === "Image";

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
  if (r.kind === "unknown" && (r.reason === "unsupported_filter" || r.reason === "broken")) {
    const own = decodeScanImage(ctx, s, LIMITS.imagePixels);
    if (own) r = { kind: "pixels", reader: own };
  }
  return r;
}

/** 画像の画素から、1pt のます目の暗い割合を作る。紙の白が無い（写真など）なら null */
export function gridOf(reader: PixelReader, pw: number, ph: number): { gw: number; gh: number; frac: Float32Array } | null {
  const gw = Math.round(pw);
  const gh = Math.round(ph);
  if (gw < 50 || gh < 50 || gw * gh > LIMITS.gridCells) return null;
  const sx = reader.width / gw;
  const sy = reader.height / gh;
  const lumAt = (x: number, y: number) => {
    const p = reader.at(Math.min(reader.width - 1, Math.floor(x)), Math.min(reader.height - 1, Math.floor(y)));
    return p.lum === null || p.alpha < 0.5 ? 1 : p.lum;
  };
  // 紙の明るさ：明るい方から 1 割の所
  const hist = new Uint32Array(256);
  let samples = 0;
  const st = Math.max(1, Math.floor(Math.sqrt((gw * gh) / 100_000)));
  for (let y = 0; y < gh; y += st) {
    for (let x = 0; x < gw; x += st) {
      const bin = Math.max(0, Math.min(255, Math.round(lumAt((x + 0.5) * sx, (y + 0.5) * sy) * 255)));
      hist[bin] = (hist[bin] ?? 0) + 1;
      samples++;
    }
  }
  let acc = 0;
  let paper = 255;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v]!;
    if (acc >= samples * 0.1) {
      paper = v;
      break;
    }
  }
  if (paper < 100) return null;
  const thr = (paper / 255) * 0.5;
  // ますごとに、3×3 の点を読む（画素がますより粗いときは 1 点）
  const k = sx >= 2 && sy >= 2 ? 3 : 1;
  const frac = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let d = 0;
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) if (lumAt((x + (i + 0.5) / k) * sx, (y + (j + 0.5) / k) * sy) < thr) d++;
      frac[y * gw + x] = d / (k * k);
    }
  }
  return { gw, gh, frac };
}

/** 黒い四角（ます目の上の、塗りのかたまり） */
export function boxesOf(g: { gw: number; gh: number; frac: Float32Array }): Box[] {
  const S = SETTINGS;
  const { gw, gh, frac } = g;
  const map = new Uint8Array(gw * gh);
  for (let i = 0; i < map.length; i++) if (frac[i]! >= S.solid) map[i] = 1;
  const stack = new Int32Array(gw * gh);
  const out: Box[] = [];
  for (let i = 0; i < map.length; i++) {
    if (map[i] !== 1) continue;
    let x0 = gw, y0 = gh, x1 = -1, y1 = -1, n = 0, sp = 0;
    stack[sp++] = i;
    map[i] = 2;
    while (sp > 0) {
      const j = stack[--sp]!;
      const x = j % gw;
      const y = (j - x) / gw;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && map[j - 1] === 1) (map[j - 1] = 2), (stack[sp++] = j - 1);
      if (x < gw - 1 && map[j + 1] === 1) (map[j + 1] = 2), (stack[sp++] = j + 1);
      if (y > 0 && map[j - gw] === 1) (map[j - gw] = 2), (stack[sp++] = j - gw);
      if (y < gh - 1 && map[j + gw] === 1) (map[j + gw] = 2), (stack[sp++] = j + gw);
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (w >= S.boxMinW && h >= S.boxMinH && h <= S.boxMaxH && w <= gw * 0.9 && n / (w * h) >= S.boxFill) out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1 });
  }
  return out;
}

const inBoxes = (boxes: Box[], x: number, y: number) => boxes.some((b) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1);

/** 濃いますの集まり a のうち、b のとなり（tol ます）に濃いますのある割合。a が少なすぎるときは -1 */
function overlap(a: Uint8Array, b: Uint8Array, w: number, h: number, tol: number, minCells: number): number {
  let total = 0;
  let hit = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!a[y * w + x]) continue;
      total++;
      let found = false;
      for (let dy = -tol; dy <= tol && !found; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -tol; dx <= tol; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && b[yy * w + xx]) {
            found = true;
            break;
          }
        }
      }
      if (found) hit++;
    }
  }
  return total < minCells ? -1 : hit / total;
}

/** 書式の似かた（粗います。四角の所は両方から外す） */
function layoutSimilar(a: Grid, b: Grid): boolean {
  const S = SETTINGS;
  const c = S.coarse;
  const w = Math.floor(Math.min(a.gw, b.gw) / c);
  const h = Math.floor(Math.min(a.gh, b.gh) / c);
  const skip = [...a.boxes, ...b.boxes];
  const coarse = (g: Grid) => {
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (inBoxes(skip, x * c + c / 2, y * c + c / 2)) continue;
        let s = 0;
        for (let yy = y * c; yy < (y + 1) * c; yy++) for (let xx = x * c; xx < (x + 1) * c; xx++) s += g.frac[yy * g.gw + xx]!;
        if (s / (c * c) >= S.coarseInk) m[y * w + x] = 1;
      }
    }
    return m;
  };
  const ma = coarse(a);
  const mb = coarse(b);
  const ab = overlap(ma, mb, w, h, 1, S.layoutMinCells);
  const ba = overlap(mb, ma, w, h, 1, S.layoutMinCells);
  return ab >= S.layoutMatch && ba >= S.layoutMatch;
}

/**
 * 見出しの所 c が、2 つのページで同じ形か。
 * 表の罫線（端から端までほぼ濃い列・行）は、どちらのページでも外す（罫線の位置が同じだけの、別の書類の表を同じと見ないため）。
 * 残った濃さ（細かいます）を、上下左右に contextShift まで ずらしながら比べ、相関のいちばん高い値が contextCorr 以上なら同じとする。
 * 字の形が違えば、字の並びの間隔が同じでも相関は上がりにくい（ずれを許した重なりだけで見ると、別の字でも同じと見てしまう）。
 */
function contextSimilar(a: Grid, b: Grid, c: Box): boolean {
  const S = SETTINGS;
  const w = c.x1 - c.x0;
  const h = c.y1 - c.y0;
  const take = (g: Grid) => {
    const m = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = g.frac[(c.y0 + y) * g.gw + c.x0 + x]!;
    return m;
  };
  const fa = take(a);
  const fb = take(b);
  const lineCols = new Uint8Array(w);
  const lineRows = new Uint8Array(h);
  for (const f of [fa, fb]) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let y = 0; y < h; y++) if (f[y * w + x]! >= S.inkCell) n++;
      if (n >= h * S.lineShare) for (let k = Math.max(0, x - 1); k <= Math.min(w - 1, x + 1); k++) lineCols[k] = 1;
    }
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = 0; x < w; x++) if (f[y * w + x]! >= S.inkCell) n++;
      if (n >= w * S.lineShare) for (let k = Math.max(0, y - 1); k <= Math.min(h - 1, y + 1); k++) lineRows[k] = 1;
    }
  }
  for (const f of [fa, fb]) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lineCols[x] || lineRows[y]) f[y * w + x] = 0;
  const inkOf = (f: Float32Array) => {
    let n = 0;
    for (let i = 0; i < f.length; i++) if (f[i]! >= S.inkCell) n++;
    return n;
  };
  // 罫線を外して、字（見出し）が残らない所では比べない
  if (inkOf(fa) < S.contextMinCells || inkOf(fb) < S.contextMinCells) return false;
  // 行ごとの平均を引く（字の並ぶ帯の高さが同じだけで、相関が上がらないように。比べるのは、行の中の字の形）
  for (const f of [fa, fb]) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) s += f[y * w + x]!;
      const m = s / w;
      for (let x = 0; x < w; x++) f[y * w + x] = f[y * w + x]! - m;
    }
  }
  const sh = S.contextShift;
  let best = -1;
  for (let dy = -sh; dy <= sh; dy++) {
    for (let dx = -sh; dx <= sh; dx++) {
      let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
        for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
          const va = fa[y * w + x]!;
          const vb = fb[(y + dy) * w + x + dx]!;
          n++;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      if (n < 20) continue;
      const cov = sab - (sa * sb) / n;
      const vA = saa - (sa * sa) / n;
      const vB = sbb - (sb * sb) / n;
      if (vA <= 1e-9 || vB <= 1e-9) continue;
      const r = cov / Math.sqrt(vA * vB);
      if (r > best) best = r;
    }
  }
  return best >= S.contextCorr;
}

/** 四角 box（ページ a で塗った）の同じ位置が、ページ b で塗られずに描かれているか */
function leftOpen(a: Grid, b: Grid, box: Box): boolean {
  const S = SETTINGS;
  const gw = Math.min(a.gw, b.gw);
  const gh = Math.min(a.gh, b.gh);
  const r: Box = { x0: box.x0 + 1, y0: box.y0 + 1, x1: Math.min(gw, box.x1 - 1), y1: Math.min(gh, box.y1 - 1) };
  if (r.x1 - r.x0 < 4 || r.y1 - r.y0 < 2) return false;
  let sum = 0;
  let ink = 0;
  const cells = (r.x1 - r.x0) * (r.y1 - r.y0);
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const f = b.frac[y * b.gw + x]!;
      sum += f;
      if (f >= S.inkCell) ink++;
    }
  }
  if (sum / cells >= S.coveredMean) return false; // b でも塗ってある
  if (ink / cells < S.inkShare) return false; // b では空の欄
  // 見出しの所：四角の左。左に場所がなければ右
  const y0 = Math.max(0, box.y0 - S.tol);
  const y1 = Math.min(gh, box.y1 + S.tol);
  const left: Box = { x0: Math.max(0, box.x0 - S.context), y0, x1: Math.max(0, box.x0 - S.tol), y1 };
  const right: Box = { x0: Math.min(gw, box.x1 + S.tol), y0, x1: Math.min(gw, box.x1 + S.context), y1 };
  for (const c of [left, right]) {
    if (c.x1 - c.x0 < 10 || c.y1 - c.y0 < 2) continue;
    // 見出しの所に、ほかの四角が入るなら比べない
    if ([...a.boxes, ...b.boxes].some((k) => k !== box && k.x0 < c.x1 && k.x1 > c.x0 && k.y0 < c.y1 && k.y1 > c.y0)) continue;
    if (contextSimilar(a, b, c)) return true;
  }
  return false;
}

export async function detectCrossPageRedaction(bytes: Uint8Array, options: DetectOptions = {}): Promise<CrossPageReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], checkedPages: 0, uncheckedPages: [], limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { doc, ctx } = opened;
  const report: CrossPageReport = { ...base, status: "ok", findings: [], uncheckedPages: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;
  const limit = (l: CrossPageReport["limits"][number]) => {
    if (!report.limits.includes(l)) report.limits.push(l);
  };

  let pages: ReturnType<typeof doc.getPages>;
  try {
    pages = doc.getPages();
  } catch {
    return report;
  }
  if (pages.length < 2) return report; // 比べる相手が無い
  if (pages.length > LIMITS.pages) limit("too_many_pages");

  const grids: Grid[] = [];
  for (let i = 0; i < Math.min(pages.length, LIMITS.pages); i++) {
    const page = pages[i]!;
    let pw: number, ph: number;
    try {
      ({ width: pw, height: ph } = page.getSize());
    } catch {
      continue;
    }
    if (!(pw > 0 && ph > 0)) continue;
    let ops = 0;
    // 閉じた関数の中で書き換えるので、入れ物に入れる（型の絞り込みがずれないように）
    const st: { found: Grid | null; unread: boolean } = { found: null, unread: false };
    const seen = new Set<PDFStream>();
    const walk = async (content: Uint8Array, resRaw: PDFObject | undefined, depth: number): Promise<void> => {
      const res = dictOf(ctx, resRaw);
      const xobjects = dictOf(ctx, res?.get(N("XObject")));
      if (!xobjects) return;
      const colorSpaces = dictOf(ctx, res?.get(N("ColorSpace")));
      for (const { op, args } of operations(content)) {
        if (st.found) return;
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
        seen.add(xo);
        if (!isImage(ctx, xo)) {
          if (depth < 3 && nameOf(ctx, xo.dict.get(N("Subtype"))) === "Form") {
            const body = streamData(xo, LIMITS.streamBytes);
            if (body) await walk(body, xo.dict.get(N("Resources")) ?? resRaw, depth + 1);
          }
          continue;
        }
        const iw = numOf(ctx, xo.dict.get(N("Width"))) ?? 0;
        const ih = numOf(ctx, xo.dict.get(N("Height"))) ?? 0;
        if (iw < 300 || ih < 300) continue;
        // ページの全面のスキャンとみなせるもの（縦横の比がページとほぼ同じ）
        if (Math.abs(iw / ih / (pw / ph) - 1) > 0.2) continue;
        const px = await pixelsOf(ctx, xo, colorSpaces, options.imageDecoder);
        if (px.kind !== "pixels") {
          st.unread = true;
          continue;
        }
        const g = gridOf(px.reader, pw, ph);
        if (!g) {
          if (Math.round(pw) * Math.round(ph) > LIMITS.gridCells) limit("too_large_page");
          continue;
        }
        st.found = { page: i + 1, pw, ph, ...g, boxes: boxesOf(g) };
      }
    };
    try {
      await walk(contentBytes(ctx, page.node.get(N("Contents"))), page.node.get(N("Resources")) ?? page.node.Resources(), 0);
    } catch {
      /* 読めない所で止める */
    }
    if (st.found) {
      grids.push(st.found);
      report.checkedPages++;
    } else if (st.unread) report.uncheckedPages.push(i + 1);
  }

  const seenRect = new Set<string>();
  let compared = 0;
  for (const a of grids) {
    for (const box of a.boxes) {
      if (++compared > LIMITS.boxes) {
        limit("too_many_boxes");
        return report;
      }
      for (const b of grids) {
        if (b === a || Math.abs(a.pw - b.pw) > 2 || Math.abs(a.ph - b.ph) > 2) continue;
        if (!leftOpen(a, b, box)) continue;
        if (!layoutSimilar(a, b)) continue;
        const rect: CrossPageFinding["rect"] = [box.x0, b.ph - box.y1, box.x1, b.ph - box.y0].map((v) => Math.round(v * 10) / 10) as CrossPageFinding["rect"];
        const key = `${b.page}:${rect.join(",")}`;
        if (seenRect.has(key)) continue;
        seenRect.add(key);
        report.findings.push({ pattern: "P6", page: b.page, redactedPage: a.page, rect });
      }
    }
  }
  return report;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// 下読みに渡す「墨消しの手がかり」（2026-11-07 本人の承認）。ページを画像にして、数と形だけを数える。字・値・画像は渡さない。
//   a：一様に黒い四角（墨消し）の数と位置。図形・注釈・画像の中の塗りを、描いた結果でまとめて見る
//   b：墨消しの四角の上下の範囲に、塗られていない「細い縦の棒が、そろった間隔で横に並ぶ形」があるか（棒の本数・高さの種類・間隔のそろい方・距離だけ。中の値は読まない）
//   c：同じ書式とみられるページの組で、同じ位置の墨消しの、ある・なしが食い違う数
//   d：文字の層で「■」などが続く所の数（塗ってから文字を読み取らせた印）
// 重さ：作りで塗りのありそうなページだけを低い解像度（150dpi）で画像にする（60 ページまで。超えたら塗りの多いページから）。
// 高い解像度（216dpi）にするのは、四角のあるページ（20 ページまで）だけ。時間の上限で打ち切り、打ち切ったことを書く。
//
// 子のプロセスとして：node ratchet/redaction.ts <PDF のパス>   → 標準出力に JSON を 1 つ

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";

export type Gray = { gray: Uint8Array; w: number; h: number; /** 紙の明るさ（明るい方から 1 割の所。無ければ数える） */ paper?: number };
/** ページの座標（pt）。左上が原点 */
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type BarChain = { bars: number; heightKinds: number; pitchMm: number; pitchCv: number; box: Box };

export type RedactionClues = {
  pagesTotal: number;
  pagesRendered: number;
  /** 内容が大きすぎて画像にしなかったページの数（CLAUDE.md §5 の重いページ） */
  pagesSkippedHeavy: number;
  /** 時間かページの上限で、途中までしか見ていない */
  partial: boolean;
  boxes: number;
  pagesWithBoxes: number;
  /** 四角のあるページ（20 ページまで）。位置と大きさはページに対する割合（小数 2 けた） */
  pages: Array<{
    page: number;
    boxes: Array<{ x: number; y: number; w: number; h: number }>;
    nearby: Array<{ bars: number; heightKinds: number; pitchCv: number; gapPt: number; side: "above" | "below" | "beside" }>;
  }>;
  /** 近くに「棒の並び」が塗られずに残っている四角の数 */
  boxesWithBarsNearby: number;
  sameLayout: { similarPairs: number; mismatches: number; examples: Array<{ withBox: number; without: number }> };
  maskRuns: { runs: number; longest: number; pages: number[] };
  /** 原因を調べるための、落とした理由ごとの数（数だけ）。pagesBlank は、画像があるのに白く描かれたページ */
  diag: BoxDiag & { pagesBlank: number; paperMin: number | null; paperMax: number | null };
};

// ---------------------------------------------------------------- 画素の解析（純粋な関数。テストで直接確かめる）

export const BOX = {
  darkRel: 0.5, // 紙の明るさの半分より暗い画素を「墨」とみなす（絶対の値にしない。紙の色・スキャンの濃さに合わせる）
  fillMin: 0.85, // 外枠の中の暗い画素の割合（スキャンのムラを見込んで 85%。2026-11-07 本人の指定）
  lightRel: 0.8, // 紙の明るさの 8 割より明るい画素を「白」とみなす
  lightFracMax: 0.05, // 外枠の中の白い画素（縁のにじみを見込む）
  innerRel: 0.55, innerLightMax: 0.02, // 内側の明るい画素。白い字が載った黒い見出しを除く
  stdMax: 40, // 暗い画素の明るさのばらつき
  minW: 6, minH: 4, minArea: 40, // pt
  candMin: 2, // これより小さいかたまり（字の点など）は、候補にも数えない（pt）
  maxPageFrac: 0.5,
  maxWidthFrac: 0.8, // ページの幅いっぱいの帯は飾りとみなす
  lineCutPt: 2.5, // 罫線を外すときの窓の幅（これより細い線・字の画は消える）
};

/** 落とした理由ごとの数（--probe-only で原因を調べるため。数だけ） */
export type BoxDiag = { candidates: number; small: number; large: number; refined: number; dark: number; whiteText: number; uneven: number; chart: number; kept: number };
export const emptyDiag = (): BoxDiag => ({ candidates: 0, small: 0, large: 0, refined: 0, dark: 0, whiteText: 0, uneven: 0, chart: 0, kept: 0 });

/** 紙の明るさ：明るい方から 1 割の所の明るさ */
export function paperLevel(img: Gray): number {
  if (img.paper !== undefined) return img.paper;
  const hist = new Uint32Array(256);
  const step = Math.max(1, Math.floor(img.gray.length / 200_000));
  let n = 0;
  for (let i = 0; i < img.gray.length; i += step) (hist[img.gray[i]!] = hist[img.gray[i]!]! + 1, n++);
  let acc = 0, v = 255;
  for (; v > 0; v--) if ((acc += hist[v]!) >= n * 0.1) break;
  img.paper = Math.max(v, 64);
  return img.paper;
}
const darkMaxOf = (img: Gray) => Math.round(paperLevel(img) * BOX.darkRel);

type Comp = { x0: number; y0: number; x1: number; y1: number; n: number };
type Rect = { x0: number; y0: number; x1: number; y1: number };

/** しきい値より暗い画素のつながり（4 近傍）を数える。region を渡すと、その中だけ */
export function components(img: Gray, darkMax: number, region?: Rect): Comp[] {
  const { gray, w } = img;
  const rx0 = Math.max(0, region?.x0 ?? 0), ry0 = Math.max(0, region?.y0 ?? 0);
  const rx1 = Math.min(img.w, region?.x1 ?? img.w), ry1 = Math.min(img.h, region?.y1 ?? img.h);
  const rw = rx1 - rx0, rh = ry1 - ry0;
  if (rw <= 0 || rh <= 0) return [];
  const seen = new Uint8Array(rw * rh);
  const stack = new Int32Array(rw * rh);
  const out: Comp[] = [];
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = y * rw + x;
    if (seen[i] || gray[(y + ry0) * w + x + rx0]! >= darkMax) continue;
    let sp = 0;
    stack[sp++] = i;
    seen[i] = 1;
    const c: Comp = { x0: x, y0: y, x1: x, y1: y, n: 0 };
    while (sp) {
      const j = stack[--sp]!;
      const jx = j % rw, jy = (j - jx) / rw;
      c.n++;
      if (jx < c.x0) c.x0 = jx; if (jx > c.x1) c.x1 = jx;
      if (jy < c.y0) c.y0 = jy; if (jy > c.y1) c.y1 = jy;
      const nb = [jx > 0 ? j - 1 : -1, jx < rw - 1 ? j + 1 : -1, jy > 0 ? j - rw : -1, jy < rh - 1 ? j + rw : -1];
      for (const k of nb) {
        if (k < 0 || seen[k]) continue;
        const kx = k % rw, ky = (k - kx) / rw;
        if (gray[(ky + ry0) * w + kx + rx0]! >= darkMax) continue;
        seen[k] = 1;
        stack[sp++] = k;
      }
    }
    out.push({ x0: c.x0 + rx0, y0: c.y0 + ry0, x1: c.x1 + rx0, y1: c.y1 + ry0, n: c.n });
  }
  return out;
}

/** a：一様に黒い四角を探す。scale は 1pt あたりの画素の数。返す箱は pt。diag に落とした理由を足す */
export function findBoxes(img: Gray, scale: number, diag: BoxDiag = emptyDiag()): Box[] {
  const found: Box[] = [];
  const darkMax = darkMaxOf(img);
  const tryRect = (r: Rect): boolean => {
    if (boxCheck(img, scale, r) !== "ok") return false;
    found.push(toPt(r, scale));
    return true;
  };
  for (const c of components(img, darkMax)) {
    const wPt = (c.x1 - c.x0 + 1) / scale, hPt = (c.y1 - c.y0 + 1) / scale;
    if (wPt < BOX.candMin || hPt < BOX.candMin) continue;
    diag.candidates++;
    const why = boxCheck(img, scale, c);
    if (why === "ok") {
      found.push(toPt(c, scale));
      continue;
    }
    // 表の罫線・枠・となりの字につながったかたまり：細い線と字の画を外してから、残ったかたまりを見直す
    if (why === "large" || why === "dark") {
      const cut = withoutThinLines(img, scale, c, darkMax);
      // 線を外した絵の座標から、ページの座標へ（削れた縁の分だけ広げる）
      const back = (k: Rect): Rect => ({ x0: Math.max(0, k.x0 + cut.ox - cut.grow), y0: Math.max(0, k.y0 + cut.oy - cut.grow), x1: Math.min(img.w - 1, k.x1 + cut.ox + cut.grow), y1: Math.min(img.h - 1, k.y1 + cut.oy + cut.grow) });
      let any = false;
      for (const k of cut.parts) {
        if (tryRect(back(k))) {
          any = true;
          continue;
        }
        // となり合う塗り（住所の行と宛名の行など）は、線を外した絵の上で、行の幅が変わる所で横の帯に分けて見る
        for (const band of bandsOf(cut.mask, k, 128)) if (tryRect(back(band))) any = true;
      }
      if (!any) for (const band of bandsOf(img, c, darkMax)) if (tryRect(band)) any = true;
      if (any) {
        diag.refined++;
        continue;
      }
    }
    diag[why]++;
  }
  const unique = dedupe(found);
  const kept = dropChartBars(unique);
  diag.chart += unique.length - kept.length;
  diag.kept += kept.length;
  return kept;
}

/** 重なる箱（同じ塗りを 2 つの道で見つけたもの）を 1 つにする */
function dedupe(boxes: Box[]): Box[] {
  const out: Box[] = [];
  for (const b of boxes) {
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    const same = out.find((o) => {
      const ix = Math.min(o.x1, b.x1) - Math.max(o.x0, b.x0), iy = Math.min(o.y1, b.y1) - Math.max(o.y0, b.y0);
      return ix > 0 && iy > 0 && ix * iy >= 0.5 * Math.min(area, (o.x1 - o.x0) * (o.y1 - o.y0));
    });
    if (!same) out.push(b);
  }
  return out;
}

const toPt = (c: Rect, scale: number): Box => ({ x0: c.x0 / scale, y0: c.y0 / scale, x1: (c.x1 + 1) / scale, y1: (c.y1 + 1) / scale });

/** 四角とみなすか。だめなら理由（small 小さい・large 大きすぎ・dark 暗さが足りない・whiteText 白い字・uneven ばらつき） */
export function boxCheck(img: Gray, scale: number, c: Rect): "ok" | "small" | "large" | "dark" | "whiteText" | "uneven" {
  const wPt = (c.x1 - c.x0 + 1) / scale, hPt = (c.y1 - c.y0 + 1) / scale;
  if (wPt < BOX.minW || hPt < BOX.minH || wPt * hPt < BOX.minArea) return "small";
  if (wPt * hPt > (img.w / scale) * (img.h / scale) * BOX.maxPageFrac || wPt > (img.w / scale) * BOX.maxWidthFrac) return "large";
  const paper = paperLevel(img), darkMax = Math.round(paper * BOX.darkRel), lightMin = paper * BOX.lightRel, innerMin = paper * BOX.innerRel;
  let dark = 0, light = 0, sum = 0, sum2 = 0, inner = 0, innerLight = 0;
  // 内側（縁から 15% 入った所）に明るい画素があれば、白い字が載っているとみなす
  const ix0 = c.x0 + (c.x1 - c.x0) * 0.15, ix1 = c.x1 - (c.x1 - c.x0) * 0.15, iy0 = c.y0 + (c.y1 - c.y0) * 0.15, iy1 = c.y1 - (c.y1 - c.y0) * 0.15;
  for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
    const g = img.gray[y * img.w + x]!;
    if (g < darkMax) (dark++, (sum += g), (sum2 += g * g));
    else if (g > lightMin) light++;
    if (x >= ix0 && x <= ix1 && y >= iy0 && y <= iy1) (inner++, g > innerMin && innerLight++);
  }
  const area = (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1);
  if (dark / area < BOX.fillMin || light / area > BOX.lightFracMax) return "dark";
  if (inner && innerLight / inner > BOX.innerLightMax) return "whiteText";
  const mean = sum / dark;
  return Math.sqrt(Math.max(0, sum2 / dark - mean * mean)) <= BOX.stdMax ? "ok" : "uneven";
}

/**
 * 細い線と字の画を外す（窓の中の 7 割以上が暗い所だけを残す。開く処理に近い）。残ったかたまりを、削れた縁の分だけ広げて返す。
 * 罫線・枠・となりの字は、窓の幅（2.5pt）より細いので消え、塗りは残る
 */
export function withoutThinLines(img: Gray, scale: number, c: Rect, darkMax: number): { parts: Rect[]; mask: Gray; ox: number; oy: number; grow: number } {
  const r = Math.max(1, Math.round((BOX.lineCutPt / 2) * scale));
  const x0 = Math.max(0, c.x0 - r), y0 = Math.max(0, c.y0 - r), x1 = Math.min(img.w - 1, c.x1 + r), y1 = Math.min(img.h - 1, c.y1 + r);
  const W = x1 - x0 + 1, H = y1 - y0 + 1;
  const integ = new Uint32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += img.gray[(y + y0) * img.w + x + x0]! < darkMax ? 1 : 0;
      integ[(y + 1) * (W + 1) + x + 1] = integ[y * (W + 1) + x + 1]! + row;
    }
  }
  const kept = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ax = Math.max(0, x - r), ay = Math.max(0, y - r), bx = Math.min(W, x + r + 1), by = Math.min(H, y + r + 1);
    const n = integ[by * (W + 1) + bx]! - integ[ay * (W + 1) + bx]! - integ[by * (W + 1) + ax]! + integ[ay * (W + 1) + ax]!;
    if (n >= 0.7 * (bx - ax) * (by - ay)) kept[y * W + x] = 0;
  }
  const grow = Math.ceil(0.5 * r);
  const mask: Gray = { gray: kept, w: W, h: H, paper: 255 };
  const parts = components(mask, 128)
    .filter((k) => (k.x1 - k.x0 + 1) / scale >= BOX.candMin && (k.y1 - k.y0 + 1) / scale >= BOX.candMin)
    .map((k) => ({ x0: k.x0, y0: k.y0, x1: k.x1, y1: k.y1 }));
  return { parts, mask, ox: x0, oy: y0, grow };
}

/** つながった塗りを、行ごとの左右の端が変わる所で、横の帯に分ける */
function bandsOf(img: Gray, c: Rect, darkMax: number): Rect[] {
  const rows: Array<[number, number] | null> = [];
  for (let y = c.y0; y <= c.y1; y++) {
    let l = -1, r = -1;
    for (let x = c.x0; x <= c.x1; x++) if (img.gray[y * img.w + x]! < darkMax) ((l < 0 && (l = x)), (r = x));
    rows.push(l < 0 ? null : [l, r]);
  }
  const bands: Rect[] = [];
  let cur: Rect | null = null;
  rows.forEach((lr, k) => {
    const y = c.y0 + k;
    if (lr && cur && Math.abs(lr[0] - cur.x0) <= 2 && Math.abs(lr[1] - cur.x1) <= 2) cur.y1 = y;
    else {
      if (cur) bands.push(cur);
      cur = lr ? { x0: lr[0], y0: y, x1: lr[1], y1: y } : null;
    }
  });
  if (cur) bands.push(cur);
  return bands;
}

/** グラフの棒の並び（3 個以上で、下の辺と幅がそろい、高さが違う）を除く */
export function dropChartBars(boxes: Box[]): Box[] {
  const drop = new Set<number>();
  boxes.forEach((a, i) => {
    const group = boxes.map((b, j) => ({ b, j })).filter(({ b }) => Math.abs(b.y1 - a.y1) <= 1.5 && Math.abs((b.x1 - b.x0) - (a.x1 - a.x0)) <= 0.15 * (a.x1 - a.x0));
    if (group.length < 3) return;
    const hs = group.map(({ b }) => b.y1 - b.y0);
    if (Math.max(...hs) / Math.min(...hs) >= 1.3) for (const { j } of group) drop.add(j);
    void i;
  });
  return boxes.filter((_, i) => !drop.has(i));
}

/** b：細い縦の棒が、そろった間隔で横に並ぶ形を探す（中の値は読まない）。scale は 1pt あたりの画素の数 */
export function findBarChains(img: Gray, scale: number, region: { x0: number; y0: number; x1: number; y1: number }): BarChain[] {
  const mm = (scale * 72) / 25.4;
  const bars = components(img, Math.round(paperLevel(img) * 0.55), region)
    .map((c) => ({ ...c, bw: c.x1 - c.x0 + 1, bh: c.y1 - c.y0 + 1, cx: (c.x0 + c.x1) / 2 }))
    .filter((c) => c.bw >= 0.3 * mm && c.bw <= 1.0 * mm && c.bh >= 0.9 * mm && c.bh <= 4.5 * mm && c.bh / c.bw >= 1.5 && c.n / (c.bw * c.bh) >= 0.7)
    .sort((a, b) => a.cx - b.cx);
  const used = new Uint8Array(bars.length);
  const chains: BarChain[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (used[i]) continue;
    const chain = [i];
    let last = i;
    for (;;) {
      const L = bars[last]!;
      let best = -1;
      for (let j = last + 1; j < bars.length && bars[j]!.cx <= L.cx + 1.7 * mm; j++) {
        const B = bars[j]!;
        if (used[j] || B.cx < L.cx + 0.8 * mm) continue;
        const ov = Math.min(L.y1, B.y1) - Math.max(L.y0, B.y0);
        if (ov < 0.4 * Math.min(L.bh, B.bh)) continue;
        if (best < 0 || Math.abs(B.cx - L.cx - 1.2 * mm) < Math.abs(bars[best]!.cx - L.cx - 1.2 * mm)) best = j;
      }
      if (best < 0) break;
      chain.push(best);
      last = best;
    }
    if (chain.length < 10) continue;
    for (const k of chain) used[k] = 1;
    const cs = chain.map((k) => bars[k]!);
    const gaps = cs.slice(1).map((b, k) => b.cx - cs[k]!.cx);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    const level = (vals: number[]) => {
      const tol = 0.35 * mm;
      const ls: number[] = [];
      return vals.map((v) => {
        let k = ls.findIndex((l) => Math.abs(l - v) <= tol);
        if (k < 0) (ls.push(v), (k = ls.length - 1));
        return k;
      });
    };
    // 傾いたスキャンでは、棒の上下の端が左から右へずれていく。棒の真ん中の高さの傾きを引いてから、高さの種類を分ける
    const mx = cs.reduce((a, b) => a + b.cx, 0) / cs.length, my = cs.reduce((a, b) => a + (b.y0 + b.y1) / 2, 0) / cs.length;
    const sxx = cs.reduce((a, b) => a + (b.cx - mx) ** 2, 0);
    const slope = sxx ? cs.reduce((a, b) => a + (b.cx - mx) * ((b.y0 + b.y1) / 2 - my), 0) / sxx : 0;
    const tops = level(cs.map((b) => b.y0 - slope * (b.cx - mx))), bottoms = level(cs.map((b) => b.y1 - slope * (b.cx - mx)));
    const kinds = new Set(cs.map((_, k) => `${tops[k]}:${bottoms[k]}`)).size;
    chains.push({
      bars: cs.length, heightKinds: kinds, pitchMm: round(mean / mm, 2), pitchCv: round(sd / mean, 2),
      box: { x0: Math.min(...cs.map((b) => b.x0)) / scale, y0: Math.min(...cs.map((b) => b.y0)) / scale, x1: (Math.max(...cs.map((b) => b.x1)) + 1) / scale, y1: (Math.max(...cs.map((b) => b.y1)) + 1) / scale },
    });
  }
  return chains;
}

/** 四角と棒の並びの、上下の距離（pt。重なれば 0）と向き */
export function relation(box: Box, c: Box): { gapPt: number; side: "above" | "below" | "beside" } {
  if (c.y0 >= box.y1) return { gapPt: round(c.y0 - box.y1, 1), side: "below" };
  if (c.y1 <= box.y0) return { gapPt: round(box.y0 - c.y1, 1), side: "above" };
  return { gapPt: 0, side: "beside" };
}

const GRID = { cols: 24, rows: 34, inkRel: 0.67, inkFrac: 0.03 }; // 紙の明るさの 2/3 より暗い画素を「描かれている」とみなす

/** c：ページの「墨の多さの粗い升目」。四角のある升目は印を付けて比べない */
export function layoutGrid(img: Gray, scale: number, boxes: Box[]): { ink: Uint8Array; masked: Uint8Array } {
  const ink = new Uint8Array(GRID.cols * GRID.rows), masked = new Uint8Array(GRID.cols * GRID.rows);
  const cw = img.w / GRID.cols, ch = img.h / GRID.rows;
  for (let r = 0; r < GRID.rows; r++) for (let c = 0; c < GRID.cols; c++) {
    const x0 = Math.floor(c * cw), x1 = Math.floor((c + 1) * cw), y0 = Math.floor(r * ch), y1 = Math.floor((r + 1) * ch);
    const cell = { x0: x0 / scale - 2, y0: y0 / scale - 2, x1: x1 / scale + 2, y1: y1 / scale + 2 };
    if (boxes.some((b) => b.x0 < cell.x1 && b.x1 > cell.x0 && b.y0 < cell.y1 && b.y1 > cell.y0)) masked[r * GRID.cols + c] = 1;
    ink[r * GRID.cols + c] = inkFraction(img, x0, y0, x1, y1) >= GRID.inkFrac ? 1 : 0;
  }
  return { ink, masked };
}

export function inkFraction(img: Gray, x0: number, y0: number, x1: number, y1: number): number {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(img.w, Math.ceil(x1)); y1 = Math.min(img.h, Math.ceil(y1));
  let n = 0, all = 0;
  const inkMax = paperLevel(img) * GRID.inkRel;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) (all++, img.gray[y * img.w + x]! < inkMax && n++);
  return all ? n / all : 0;
}

/** 2 ページの升目の似かた（どちらにも印の無い升目の、墨のある升目の重なり）。比べる升目が少なければ null */
export function similarity(a: ReturnType<typeof layoutGrid>, b: ReturnType<typeof layoutGrid>): number | null {
  let inter = 0, union = 0;
  for (let i = 0; i < a.ink.length; i++) {
    if (a.masked[i] || b.masked[i]) continue;
    if (a.ink[i] && b.ink[i]) inter++;
    if (a.ink[i] || b.ink[i]) union++;
  }
  return union >= 15 ? inter / union : null;
}

export type PageLook = { page: number; img: Gray; scale: number; boxes: Box[]; grid: ReturnType<typeof layoutGrid> };

/** c：似たページの組で、片方にだけ四角があり、もう片方の同じ所には何かが描かれている数 */
export function layoutMismatches(pages: PageLook[], simMin = 0.75): RedactionClues["sameLayout"] {
  let similarPairs = 0, mismatches = 0;
  const examples: Array<{ withBox: number; without: number }> = [];
  for (let i = 0; i < pages.length; i++) for (let j = i + 1; j < pages.length; j++) {
    const A = pages[i]!, B = pages[j]!;
    if (!A.boxes.length && !B.boxes.length) continue;
    const wa = A.img.w / A.scale, ha = A.img.h / A.scale, wb = B.img.w / B.scale, hb = B.img.h / B.scale;
    if (Math.abs(wa - wb) > 0.02 * wa || Math.abs(ha - hb) > 0.02 * ha) continue;
    const s = similarity(A.grid, B.grid);
    if (s === null || s < simMin) continue;
    similarPairs++;
    for (const [P, Q] of [[A, B], [B, A]] as const) for (const bx of P.boxes) {
      const covered = Q.boxes.some((q) => {
        const ix = Math.min(bx.x1, q.x1) - Math.max(bx.x0, q.x0), iy = Math.min(bx.y1, q.y1) - Math.max(bx.y0, q.y0);
        return ix > 0 && iy > 0 && ix * iy >= 0.3 * Math.min((bx.x1 - bx.x0) * (bx.y1 - bx.y0), (q.x1 - q.x0) * (q.y1 - q.y0));
      });
      if (covered) continue;
      if (inkFraction(Q.img, bx.x0 * Q.scale, bx.y0 * Q.scale, bx.x1 * Q.scale, bx.y1 * Q.scale) < 0.05) continue;
      mismatches++;
      if (examples.length < 5) examples.push({ withBox: P.page, without: Q.page });
    }
  }
  return { similarPairs, mismatches, examples };
}

const MASK_CHARS = "■□▪▮█▓▒◼⬛●";
const MASK_RUN = new RegExp(`[${MASK_CHARS}](?:\\s*[${MASK_CHARS}])+`, "gu");

/** d：「■」などが 2 つ以上続く所の数と、いちばん長い続き（字そのものは返さない） */
export function maskRunsOf(text: string): { runs: number; longest: number } {
  let runs = 0, longest = 0;
  for (const m of text.matchAll(MASK_RUN)) {
    runs++;
    longest = Math.max(longest, [...m[0]].filter((ch) => MASK_CHARS.includes(ch)).length);
  }
  return { runs, longest };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- PDF を画像にする（子のプロセスの中だけで使う）

export const LIMITS = { maxPages: 60, maxHiResPages: 20, maxBoxesPerPage: 10, heavyContentBytes: 3_000_000, lowScale: 150 / 72, highScale: 3, bandPt: 72, deadlineMs: 75_000 };

/** 作りで、塗りのありそうなページを選ぶ（塗りの命令・画像・注釈の数）。重すぎるページは除く */
export async function pageScores(bytes: Uint8Array): Promise<{ scores: Array<{ page: number; score: number; heavy: boolean; images: number }> } | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    return null;
  }
  const ctx = doc.context;
  const deref = (v: unknown) => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const scores = doc.getPages().map((p, i) => {
    let score = 0, raw = 0, images = 0;
    try {
      const c = deref(p.node.get(PDFName.of("Contents")));
      const streams = (c instanceof PDFArray ? c.asArray().map(deref) : [c]).filter((s): s is PDFRawStream => s instanceof PDFRawStream);
      for (const s of streams) raw += s.getContents().length;
      if (raw > LIMITS.heavyContentBytes) return { page: i + 1, score: 0, heavy: true, images };
      for (const s of streams) {
        const text = new TextDecoder("latin1").decode(decodePDFRawStream(s).decode());
        // 図形の塗りの命令（f・f*・F・b・b*・B・B*）の数。文字だけのページは 0 になり、画像にしない
        score += text.match(/(?:^|\s)(?:f\*?|F|[bB]\*?)(?=\s|$)/g)?.length ?? 0;
      }
      const res = deref(p.node.get(PDFName.of("Resources")));
      const xo = res instanceof PDFDict ? deref(res.get(PDFName.of("XObject"))) : null;
      if (xo instanceof PDFDict) for (const [, v] of xo.entries()) if (deref(v) instanceof PDFStream) (score += 3), images++;
      const an = deref(p.node.get(PDFName.of("Annots")));
      if (an instanceof PDFArray) score += 3 * an.size();
    } catch {
      score += 1; // 数えられなくても、画像にはしてみる
    }
    return { page: i + 1, score, heavy: false, images };
  });
  return { scores };
}

/** 60 ページを超えたら、塗りの多いページから選ぶ（2026-11-07 本人の指定） */
export function choosePages(scores: Array<{ page: number; score: number; heavy: boolean }>, max = LIMITS.maxPages): number[] {
  return scores.filter((s) => !s.heavy && s.score > 0).sort((a, b) => b.score - a.score || a.page - b.page).slice(0, max).map((s) => s.page).sort((a, b) => a - b);
}

const STANDARD_FONTS = path.join(path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json"))), "standard_fonts").split(path.sep).join("/") + "/";
// CCITT・JBIG2・JPX（スキャンによくある白黒・高圧縮の画像）は、PDF.js の解く部品のある場所を渡したときだけ描ける。
// 渡さないと白いページとして描かれ、墨消しを 1 つも数えられない（2026-11-07、実物のスキャン 3 件で 0 件だった原因とみられる。架空の CCITT の見本で、渡さないと 0 件・渡すと 1 件を確かめた）
const WASM_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json"))), "wasm")).href + "/";

export async function probeRedaction(bytes: Uint8Array, limits = LIMITS): Promise<RedactionClues | { failed: string }> {
  const started = Date.now();
  const late = () => Date.now() - started > limits.deadlineMs;
  const sc = await pageScores(bytes);
  if (!sc) return { failed: "pdf-lib で読めなかった" };
  const chosen = choosePages(sc.scores, limits.maxPages);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc: any;
  try {
    doc = await getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, standardFontDataUrl: STANDARD_FONTS, wasmUrl: WASM_URL, verbosity: 0 }).promise;
  } catch {
    return { failed: "PDF.js で開けなかった" };
  }
  const out: RedactionClues = {
    pagesTotal: sc.scores.length, pagesRendered: 0, pagesSkippedHeavy: sc.scores.filter((s) => s.heavy).length,
    partial: sc.scores.filter((s) => !s.heavy && s.score > 0).length > chosen.length,
    boxes: 0, pagesWithBoxes: 0, pages: [], boxesWithBarsNearby: 0, sameLayout: { similarPairs: 0, mismatches: 0, examples: [] }, maskRuns: { runs: 0, longest: 0, pages: [] },
    diag: { ...emptyDiag(), pagesBlank: 0, paperMin: null, paperMax: null },
  };
  const render = async (pageNo: number, scale: number): Promise<Gray> => {
    const page = await doc.getPage(pageNo);
    const vp = page.getViewport({ scale });
    const w = Math.ceil(vp.width), h = Math.ceil(vp.height);
    const { canvas, context } = doc.canvasFactory.create(w, h);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, w, h);
    await page.render({ canvasContext: context, canvas, viewport: vp }).promise;
    const rgba: Uint8ClampedArray = context.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = (rgba[i * 4]! * 299 + rgba[i * 4 + 1]! * 587 + rgba[i * 4 + 2]! * 114) / 1000;
    page.cleanup();
    return { gray, w, h };
  };

  const looks: PageLook[] = [];
  const queue = [...chosen];
  let addedRest = false;
  while (queue.length) {
    const n = queue.shift()!;
    if (late()) { out.partial = true; break; }
    try {
      const img = await render(n, limits.lowScale);
      const boxes = findBoxes(img, limits.lowScale, out.diag);
      const paper = paperLevel(img);
      out.diag.paperMin = Math.min(out.diag.paperMin ?? 255, paper);
      out.diag.paperMax = Math.max(out.diag.paperMax ?? 0, paper);
      // 画像があるのに、ほとんど何も描かれていないページ（画像を解けなかったなど）を数える
      if ((sc.scores[n - 1]?.images ?? 0) > 0 && inkFraction(img, 0, 0, img.w, img.h) < 0.001) out.diag.pagesBlank++;
      looks.push({ page: n, img, scale: limits.lowScale, boxes, grid: layoutGrid(img, limits.lowScale, boxes) });
      out.pagesRendered++;
      try {
        const tc = await (await doc.getPage(n)).getTextContent();
        const r = maskRunsOf(tc.items.map((it: any) => it.str ?? "").join(""));
        if (r.runs) (out.maskRuns.runs += r.runs, (out.maskRuns.longest = Math.max(out.maskRuns.longest, r.longest)), out.maskRuns.pages.length < 20 && out.maskRuns.pages.push(n));
      } catch { /* 文字を読めないページは数えない */ }
    } catch {
      out.partial = true;
    }
    // 四角が見つかった書類では、塗りの無いページも比べる相手として画像にする（同じ書式で、塗っていない側のページ。上限の中で）
    if (!queue.length && !addedRest && looks.some((l) => l.boxes.length)) {
      addedRest = true;
      const rest = sc.scores.filter((s) => !s.heavy && !chosen.includes(s.page)).map((s) => s.page);
      const room = Math.max(0, limits.maxPages - chosen.length);
      if (rest.length > room) out.partial = true;
      queue.push(...rest.slice(0, room));
    }
  }
  looks.sort((a, b) => a.page - b.page);
  const withBoxes = looks.filter((l) => l.boxes.length);
  out.boxes = withBoxes.reduce((a, l) => a + l.boxes.length, 0);
  out.pagesWithBoxes = withBoxes.length;

  // b：四角の多いページから、高い解像度で、四角の上下の範囲を見る
  for (const l of [...withBoxes].sort((a, b) => b.boxes.length - a.boxes.length).slice(0, limits.maxHiResPages)) {
    const entry: RedactionClues["pages"][number] = { page: l.page, boxes: [], nearby: [] };
    const W = l.img.w / l.scale, H = l.img.h / l.scale;
    entry.boxes = l.boxes.slice(0, limits.maxBoxesPerPage).map((b) => ({ x: round(b.x0 / W, 2), y: round(b.y0 / H, 2), w: round((b.x1 - b.x0) / W, 2), h: round((b.y1 - b.y0) / H, 2) }));
    if (late()) { out.partial = true; out.pages.push(entry); continue; }
    try {
      const S = limits.highScale;
      const hi = await render(l.page, S);
      for (const b of l.boxes.slice(0, limits.maxBoxesPerPage)) {
        const region = { x0: 0, y0: Math.floor((b.y0 - limits.bandPt) * S), x1: hi.w, y1: Math.ceil((b.y1 + limits.bandPt) * S) };
        const chains = findBarChains(hi, S, region).filter((c) => !(c.box.x0 >= b.x0 && c.box.x1 <= b.x1 && c.box.y0 >= b.y0 && c.box.y1 <= b.y1));
        if (!chains.length) continue;
        out.boxesWithBarsNearby++;
        const best = chains.sort((p, q) => q.bars - p.bars)[0]!;
        if (entry.nearby.length < limits.maxBoxesPerPage) entry.nearby.push({ bars: best.bars, heightKinds: best.heightKinds, pitchCv: best.pitchCv, ...relation(b, best.box) });
      }
    } catch {
      out.partial = true;
    }
    out.pages.push(entry);
  }
  out.pages.sort((a, b) => a.page - b.page);
  if (withBoxes.length) out.sameLayout = layoutMismatches(looks);
  await doc.loadingTask?.destroy();
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await probeRedaction(new Uint8Array(readFileSync(process.argv[2]!)));
  process.stdout.write(JSON.stringify(r));
}

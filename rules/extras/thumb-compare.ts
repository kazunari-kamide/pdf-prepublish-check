// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの縮小画像（/Thumb）と、いまのページの見た目を、おおまかに比べる（extras 1.1.0 から。見ないで作るテスト集の T20）。
//
// ページを縮小画像と同じ大きさのマス目にし、白い紙の上に、ページの画像（縦横に置いたもので、pdf-lib で解けるもの）を描いて、
// いまのページの「見込みの見た目」を作る。字・図形・部品のある所は「分からない所」として比べない（字の形までは描かないため）。
// 分かる所が少ないとき・描けない命令があるときは "unknown"（比べられなかった）を返す。
//
// - same＝分かる所で、縮小画像がいまのページとほぼ同じ（ページを縮めて作った縮小画像）
// - differs＝分かる所に、いまのページにない濃淡がある（前のページの見た目が残っている、など）
// - unknown＝比べられなかった

import { PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, type PDFContext } from "pdf-lib";
import { decodeStream, rethrowIfInflateLimit } from "../shared/inflate-limit.ts";
import { operations, nameArg, numArg } from "../shared/content-lexer.ts";
import { readImagePixels, type PixelReader } from "../p6-text/images.ts";

export type ThumbCompare = "same" | "differs" | "unknown";

/** 比べる値【仮の値】 */
export const THUMB_COMPARE = {
  /** 縮小画像のマスの明るさが、そのマスの下の画素の明るさの幅（いちばん暗い〜明るい）から、これより外れたら「違うマス」とする */
  cellDelta: 0.2,
  /** 違うマスの割合がこれ以下なら same、超えたら differs */
  differFractionMax: 0.02,
  /** 分かるマスの割合がこれより少なければ unknown */
  knownFractionMin: 0.3,
  /** 縮小画像の画素の数の上限（大きすぎるものは比べない） */
  maxThumbPixels: 1_000_000,
  /** ページの命令の数の上限 */
  maxOperations: 200_000,
  /** 解く画像のバイトの上限 */
  maxImageBytes: 64 * 1024 * 1024,
  maxImagePixels: 20_000_000,
};

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];

function contentBytes(ctx: PDFContext, contents: unknown): Uint8Array | null {
  const v = contents instanceof PDFRef ? ctx.lookup(contents) : contents;
  const list = v && typeof (v as { asArray?: unknown }).asArray === "function" ? (v as { asArray(): unknown[] }).asArray() : v ? [v] : [];
  const chunks: Uint8Array[] = [];
  for (const p of list) {
    const s = p instanceof PDFRef ? ctx.lookup(p) : p;
    if (!(s instanceof PDFStream)) continue;
    try {
      chunks.push(decodeStream(s), new Uint8Array([0x0a]));
    } catch (e) {
      rethrowIfInflateLimit(e);
      return null;
    }
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * thumb：縮小画像の流れ。page：ページの辞書。box：ページの見える箱（[x0, y0, x1, y1]）
 */
export function compareThumbnail(ctx: PDFContext, thumb: PDFStream, page: PDFDict, resources: PDFDict | undefined, box: [number, number, number, number]): ThumbCompare {
  let t: PixelReader;
  try {
    const r = readImagePixels({ ctx, stream: thumb, colorSpaces: undefined, fillLuminance: null, maxImageBytes: THUMB_COMPARE.maxImageBytes, maxImagePixels: THUMB_COMPARE.maxThumbPixels });
    if (r.kind !== "pixels") return "unknown";
    t = r.reader;
  } catch {
    return "unknown";
  }
  const W = t.width;
  const H = t.height;
  const pw = box[2] - box[0];
  const ph = box[3] - box[1];
  if (!(pw > 0 && ph > 0) || W < 4 || H < 4) return "unknown";
  // マス目（y は上から）。lum：見込みの明るさ（白い紙から始める）。known：比べてよいマスか
  // 縮小画像の作り方（1点を拾う・平均する）は分からないので、マスの下の画素の明るさの幅（lo〜hi）を持つ
  const lo = new Float32Array(W * H).fill(1);
  const hi = new Float32Array(W * H).fill(1);
  const known = new Uint8Array(W * H).fill(1);
  const toCell = (x: number, y: number): [number, number] => [((x - box[0]) / pw) * W, ((box[3] - y) / ph) * H];
  const markUnknown = (x0: number, y0: number, x1: number, y1: number) => {
    const [cx0, cy1] = toCell(Math.min(x0, x1), Math.min(y0, y1));
    const [cx1, cy0] = toCell(Math.max(x0, x1), Math.max(y0, y1));
    for (let y = Math.max(0, Math.floor(cy0) - 1); y < Math.min(H, Math.ceil(cy1) + 1); y++) {
      for (let x = Math.max(0, Math.floor(cx0) - 1); x < Math.min(W, Math.ceil(cx1) + 1); x++) known[y * W + x] = 0;
    }
  };

  const data = contentBytes(ctx, page.get(PDFName.of("Contents")));
  if (!data) return "unknown";
  let ctm: M = IDENTITY;
  const stack: M[] = [];
  let tm: M = IDENTITY;
  let tlm: M = IDENTITY;
  let fontSize = 0;
  let leading = 0;
  let path: Array<[number, number]> = [];
  let ops = 0;
  const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  const colorSpaces = resources?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  const pt = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const textBand = () => {
    // 字の位置から右の端まで、字の高さの帯を「分からない所」にする（字の形は描かないため）
    const m = mul(tm, ctm);
    const [x, y] = pt(m, 0, 0);
    const s = Math.hypot(m[2], m[3]) * Math.max(fontSize, 1);
    if (Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6) markUnknown(box[0], box[1], box[2], box[3]); // 回した字は、ページ全体を分からないとする
    else markUnknown(x - s * 0.2, y - s * 0.4, box[2], y + s * 1.1);
  };
  try {
    for (const { op, args } of operations(data)) {
      if (++ops > THUMB_COMPARE.maxOperations) return "unknown";
      const n = args.map(numArg);
      switch (op) {
        case "q":
          stack.push(ctm);
          break;
        case "Q":
          ctm = stack.pop() ?? ctm;
          break;
        case "cm":
          if (n.length >= 6 && n.every((v) => v !== undefined)) ctm = mul(n.slice(0, 6) as M, ctm);
          break;
        case "BT":
          tm = tlm = IDENTITY;
          break;
        case "Tf":
          fontSize = n[1] ?? fontSize;
          break;
        case "TL":
          leading = n[0] ?? leading;
          break;
        case "Td":
        case "TD":
          if (n[0] !== undefined && n[1] !== undefined) {
            if (op === "TD") leading = -n[1];
            tlm = mul([1, 0, 0, 1, n[0], n[1]], tlm);
            tm = tlm;
          }
          break;
        case "Tm":
          if (n.length >= 6 && n.every((v) => v !== undefined)) tm = tlm = n.slice(0, 6) as M;
          break;
        case "T*":
          tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
          tm = tlm;
          break;
        case "'":
        case '"':
          tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
          tm = tlm;
          textBand();
          break;
        case "Tj":
        case "TJ":
          textBand();
          break;
        case "re":
          if (n.length >= 4 && n.every((v) => v !== undefined)) {
            const [x, y, w, h] = n as number[];
            path.push(pt(ctm, x!, y!), pt(ctm, x! + w!, y! + h!), pt(ctm, x! + w!, y!), pt(ctm, x!, y! + h!));
          }
          break;
        case "m":
        case "l":
          if (n[0] !== undefined && n[1] !== undefined) path.push(pt(ctm, n[0], n[1]));
          break;
        case "c":
        case "v":
        case "y":
          for (let k = 0; k + 1 < n.length; k += 2) if (n[k] !== undefined && n[k + 1] !== undefined) path.push(pt(ctm, n[k]!, n[k + 1]!));
          break;
        case "f":
        case "F":
        case "f*":
        case "B":
        case "B*":
        case "b":
        case "b*":
        case "S":
        case "s":
          // 塗り・線は描かず、その箱を分からない所にする
          if (path.length) {
            const xs = path.map((p) => p[0]);
            const ys = path.map((p) => p[1]);
            markUnknown(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
          }
          path = [];
          break;
        case "n":
          path = [];
          break;
        case "W":
        case "W*":
        case "sh":
        case "BI":
        case "d0":
        case "d1":
          return "unknown"; // 切り抜き・ぼかし・埋め込みの画像は、見込みを作らない
        case "Do": {
          const name = nameArg(args[0]);
          const ref = name && xobjects ? xobjects.get(PDFName.of(name)) : undefined;
          const xo = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
          if (!(xo instanceof PDFStream)) return "unknown";
          const sub = xo.dict.lookup(PDFName.of("Subtype"));
          if (!(sub instanceof PDFName) || sub.decodeText() !== "Image") return "unknown"; // 部品は描かない
          if (Math.abs(ctm[1]) > 1e-6 || Math.abs(ctm[2]) > 1e-6) return "unknown";
          const r = readImagePixels({ ctx, stream: xo, colorSpaces, fillLuminance: 0, maxImageBytes: THUMB_COMPARE.maxImageBytes, maxImagePixels: THUMB_COMPARE.maxImagePixels });
          const [ix0, iy0] = pt(ctm, 0, 0);
          const [ix1, iy1] = pt(ctm, 1, 1);
          if (r.kind !== "pixels") {
            markUnknown(ix0, iy0, ix1, iy1);
            break;
          }
          const im = r.reader;
          const [cx0, cy0] = toCell(Math.min(ix0, ix1), Math.max(iy0, iy1));
          const [cx1, cy1] = toCell(Math.max(ix0, ix1), Math.min(iy0, iy1));
          for (let y = Math.max(0, Math.floor(cy0)); y < Math.min(H, Math.ceil(cy1)); y++) {
            for (let x = Math.max(0, Math.floor(cx0)); x < Math.min(W, Math.ceil(cx1)); x++) {
              // マスがすべて画像の中にあるときだけ描く（ふちのマスは、まざった色になるので比べない）
              if (x < cx0 || x + 1 > cx1 || y < cy0 || y + 1 > cy1) {
                known[y * W + x] = 0;
                continue;
              }
              // マスの下の画像の画素の明るさの幅（拾う点のずれを見込んで、マスを半分ずつ広げる）
              const u0 = Math.max(0, (x - 0.5 - cx0) / (cx1 - cx0));
              const u1 = Math.min(1, (x + 1.5 - cx0) / (cx1 - cx0));
              const v0 = Math.max(0, (y - 0.5 - cy0) / (cy1 - cy0));
              const v1 = Math.min(1, (y + 1.5 - cy0) / (cy1 - cy0));
              const flipY = ctm[3] < 0;
              const flipX = ctm[0] < 0;
              let mn = Infinity;
              let mx = -Infinity;
              let cnt = 0;
              const px0 = Math.floor(u0 * im.width);
              const px1 = Math.max(px0 + 1, Math.ceil(u1 * im.width));
              const py0 = Math.floor(v0 * im.height);
              const py1 = Math.max(py0 + 1, Math.ceil(v1 * im.height));
              for (let py = py0; py < py1 && py < im.height; py++) {
                for (let px = px0; px < px1 && px < im.width; px++) {
                  const p = im.at(flipX ? im.width - 1 - px : px, flipY ? im.height - 1 - py : py);
                  if (p.lum === null) continue;
                  const v = p.lum * p.alpha + (1 - p.alpha) * 1;
                  if (v < mn) mn = v;
                  if (v > mx) mx = v;
                  cnt++;
                }
              }
              if (cnt) {
                lo[y * W + x] = mn;
                hi[y * W + x] = mx;
              } else known[y * W + x] = 0;
            }
          }
          break;
        }
        default:
          break;
      }
    }
  } catch {
    return "unknown";
  }

  let knownCells = 0;
  let differ = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!known[y * W + x]) continue;
      const p = t.at(x, y);
      if (p.lum === null) continue;
      knownCells++;
      if (p.lum < lo[y * W + x]! - THUMB_COMPARE.cellDelta || p.lum > hi[y * W + x]! + THUMB_COMPARE.cellDelta) differ++;
    }
  }
  if (knownCells < W * H * THUMB_COMPARE.knownFractionMin) return "unknown";
  return differ / knownCells <= THUMB_COMPARE.differFractionMax ? "same" : "differs";
}

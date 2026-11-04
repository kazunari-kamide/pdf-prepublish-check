// SPDX-License-Identifier: AGPL-3.0-only
//
// 画像の画素を塗りつぶす（P6 の画像の層：スキャン画像の上に、黒や白の四角・注釈を重ねただけの型）。
// 覆いの下に当たる画素を、意味のない値（黒い覆いならいちばん濃い色、白い覆いならいちばん明るい色。型抜きの画像では「塗らない」）に
// 書き換えた、新しい画像を作る。元の画像は書き換えない（ほかの所でも使われているかもしれないため）。使われなくなった元の画像は、最後の掃除で消える。
//
// 塗り方は3つ（burnImage が選ぶ）：
// 1. 丸ごと解く：圧縮のない画像と、Flate・LZW・ASCIIHex・ASCII85・RunLength の画像。展開した大きさが maxBytes（64MB）まで
// 2. 流して塗る：Flate だけの画像で、展開した大きさが maxBytes を超えるもの。丸ごと解かずに、行ごとに解いて塗り、書き直す
//    （DecompressionStream・CompressionStream。ブラウザと Node に元からある。600dpi の A4 で、メモリの増えは約 +50MB。2026-11-04 測定）
// 3. JPEG（DCTDecode）・CCITT（FAX 形式）・JBIG2：呼ぶ側が画像の道具（ImageCodec。PDF.js で解き、ブラウザは OffscreenCanvas・Node は sanitize/node/ の道具で JPEG を書く）を渡したときだけ。
//    JPEG は、塗ったあと JPEG に書き直す（画質が少し落ちる。2026-11-04 人が決めた）。色は DeviceRGB になる。
//    CCITT・JBIG2 は、塗ったあと 1 ビットのまま Flate で書き直す（DeviceGray。画質は変わらない）
// どれも、画素の数が maxPixels（7,200 万。600dpi の A3 まで。検出ルールと同じ）を超える画像は塗らない。
// JPEG 2000 と、道具を渡されなかった JPEG・CCITT・JBIG2 は塗れない（呼ぶ側で「片付けられなかった所」にする）。

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFRawStream,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { apply, type Matrix } from "../rules/p6-text/geometry.ts";
import type { SanCover } from "./geometry.ts";
import { coverContains } from "./geometry.ts";
import type { DecodedImage, ImageCodec } from "./types.ts";

export type BurnFailure = "unsupported_filter" | "unsupported_color" | "too_large" | "broken" | "no_codec";

export type BurnResult =
  /**
   * perCover：覆いごとに塗った画素の数（covers と同じ並び。2つの覆いに入る画素は、あとに描いた覆いで数える）。
   * reached：覆いごとに、中心が入った画素が1つでもあったか（あとの覆いの色で塗られた画素も入れる。塗り損ねの安全網に使う）
   */
  | { ok: true; stream: PDFRawStream; pixels: number; perCover: number[]; reached: boolean[]; via: "memory" | "stream" | "jpeg" | "bitonal" }
  | { ok: false; reason: BurnFailure };

export type BurnLimits = {
  /** 丸ごと解く画像の、展開した大きさの上限（バイト）。超えた Flate の画像は、流して塗る */
  maxBytes: number;
  /** 塗る画像の、画素の数の上限 */
  maxPixels: number;
  /** pdf-lib で解けない画像（JPEG・CCITT・JBIG2）の道具。ないときは、それらの画像は塗れない（no_codec） */
  codec?: ImageCodec;
  /** JPEG に書き直すときの品質（0〜1） */
  jpegQuality: number;
};

const DECODABLE = new Set(["FlateDecode", "Fl", "LZWDecode", "LZW", "ASCIIHexDecode", "AHx", "ASCII85Decode", "A85", "RunLengthDecode", "RL"]);
const FLATE = new Set(["FlateDecode", "Fl"]);
/** 「明るい覆いの中にすっかり入っているか」を画素で見る、濃い覆い1つの画素の数の上限（超えたら見ずに「はみ出す」とする） */
const DARK_INSIDE_MAX = 4_000_000;
const DCT = new Set(["DCTDecode", "DCT"]);
const BITONAL = new Set(["CCITTFaxDecode", "CCF", "JBIG2Decode"]);
/** 流して塗るとき、圧縮した中身を何バイトずつ入れるか */
const FEED_BYTES = 16 * 1024;

function filterNames(ctx: PDFContext, dict: PDFDict): string[] {
  const f = dict.lookup(PDFName.of("Filter"));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((o) => ctx.lookup(o)).filter((o): o is PDFName => o instanceof PDFName).map((n) => n.decodeText());
  return [];
}

function numOf(dict: PDFDict, key: string, fallback: number): number {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

function decodeParms(ctx: PDFContext, dict: PDFDict): PDFDict | undefined {
  const p = dict.lookup(PDFName.of("DecodeParms")) ?? dict.lookup(PDFName.of("DP"));
  if (p instanceof PDFDict) return p;
  if (p instanceof PDFArray) {
    for (const o of p.asArray()) {
      const d = ctx.lookup(o);
      if (d instanceof PDFDict) return d;
    }
  }
  return undefined;
}

/** PNG の予測を、1行だけ戻す（prev は戻したあとの前の行。最初の行は null） */
function undoPngRow(src: Uint8Array, srcAt: number, out: Uint8Array, outAt: number, rowLen: number, bpp: number, prev: Uint8Array | null, prevAt: number) {
  const type = src[srcAt]!;
  const s = srcAt + 1;
  for (let i = 0; i < rowLen; i++) {
    const x = src[s + i]!;
    const left = i >= bpp ? out[outAt + i - bpp]! : 0;
    const up = prev ? prev[prevAt + i]! : 0;
    const ul = prev && i >= bpp ? prev[prevAt + i - bpp]! : 0;
    let v = x;
    if (type === 1) v = x + left;
    else if (type === 2) v = x + up;
    else if (type === 3) v = x + ((left + up) >> 1);
    else if (type === 4) {
      const p = left + up - ul;
      const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
      v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
    }
    out[outAt + i] = v & 0xff;
  }
}

function undoPng(data: Uint8Array, colors: number, bpc: number, columns: number): Uint8Array {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) undoPngRow(data, r * (rowLen + 1), out, r * rowLen, rowLen, bpp, r > 0 ? out : null, (r - 1) * rowLen);
  return out;
}

/** TIFF の予測（8 ビットだけ）を、1行だけ戻す（その場で書き換える） */
function undoTiffRow(row: Uint8Array, at: number, rowLen: number, colors: number) {
  for (let i = colors; i < rowLen; i++) row[at + i] = (row[at + i]! + row[at + i - colors]!) & 0xff;
}

function undoTiff(data: Uint8Array, colors: number, bpc: number, columns: number): Uint8Array | null {
  if (bpc !== 8) return null;
  const rowLen = colors * columns;
  const out = data.slice();
  for (let r = 0; r + rowLen <= out.length; r += rowLen) undoTiffRow(out, r, rowLen, colors);
  return out;
}

type Model = { kind: "direct"; comps: number; cmyk: boolean } | { kind: "indexed"; base: number; hival: number; lookup: Uint8Array; baseCmyk: boolean };

function colorModel(ctx: PDFContext, cs: PDFObject | undefined, spaces: PDFDict | undefined, depth = 0): Model | null {
  if (depth > 4) return null;
  const v = cs ? ctx.lookup(cs) : undefined;
  if (v instanceof PDFName) {
    const n = v.decodeText();
    if (n === "DeviceGray" || n === "G" || n === "CalGray") return { kind: "direct", comps: 1, cmyk: false };
    if (n === "DeviceRGB" || n === "RGB" || n === "CalRGB") return { kind: "direct", comps: 3, cmyk: false };
    if (n === "DeviceCMYK" || n === "CMYK") return { kind: "direct", comps: 4, cmyk: true };
    const named = spaces?.get(PDFName.of(n));
    return named ? colorModel(ctx, named, undefined, depth + 1) : null;
  }
  if (v instanceof PDFArray && v.size() >= 1) {
    const head = ctx.lookup(v.get(0));
    const k = head instanceof PDFName ? head.decodeText() : "";
    if (k === "CalGray") return { kind: "direct", comps: 1, cmyk: false };
    if (k === "CalRGB") return { kind: "direct", comps: 3, cmyk: false };
    if (k === "ICCBased") {
      const st = ctx.lookup(v.get(1));
      const n = st instanceof PDFStream ? st.dict.lookup(PDFName.of("N")) : undefined;
      const c = n instanceof PDFNumber ? n.asNumber() : 0;
      return c === 1 || c === 3 || c === 4 ? { kind: "direct", comps: c, cmyk: c === 4 } : null;
    }
    if (k === "Indexed" || k === "I") {
      const base = colorModel(ctx, v.get(1), spaces, depth + 1);
      const hv = ctx.lookup(v.get(2));
      const lk = ctx.lookup(v.get(3));
      if (!base || base.kind !== "direct" || !(hv instanceof PDFNumber)) return null;
      let lookup: Uint8Array | null = null;
      if (lk instanceof PDFString || lk instanceof PDFHexString) lookup = lk.asBytes();
      else if (lk instanceof PDFRawStream) lookup = decodePDFRawStream(lk).decode();
      else if (lk instanceof PDFStream) lookup = lk.getContents();
      if (!lookup) return null;
      return { kind: "indexed", base: base.comps, hival: Math.max(0, Math.min(255, Math.floor(hv.asNumber()))), lookup, baseCmyk: base.cmyk };
    }
  }
  return null;
}

function luminance(c: number[], cmyk: boolean): number {
  const v = (i: number) => Math.min(1, Math.max(0, c[i] ?? 0));
  if (cmyk) {
    const k = v(3);
    return 0.299 * (1 - v(0)) * (1 - k) + 0.587 * (1 - v(1)) * (1 - k) + 0.114 * (1 - v(2)) * (1 - k);
  }
  if (c.length >= 3) return 0.299 * v(0) + 0.587 * v(1) + 0.114 * v(2);
  return v(0);
}

function writeSample(data: Uint8Array, rowStart: number, index: number, bpc: number, value: number) {
  if (bpc === 8) {
    data[rowStart + index] = value;
    return;
  }
  if (bpc === 16) {
    data[rowStart + index * 2] = value >> 8;
    data[rowStart + index * 2 + 1] = value & 0xff;
    return;
  }
  const bit = index * bpc;
  const at = rowStart + (bit >> 3);
  const shift = 8 - bpc - (bit & 7);
  const mask = ((1 << bpc) - 1) << shift;
  data[at] = (data[at]! & ~mask) | ((value << shift) & mask);
}

/** 画像の形（塗るのに要るもの） */
type Layout = {
  width: number;
  height: number;
  bpc: number;
  comps: number;
  rowLen: number;
  /** 塗る値（成分ごとの生の値）。黒い覆い・白い覆いのそれぞれ */
  fill: { dark: number[]; light: number[] };
};

/** 画像の辞書を読み、塗る値を決める */
function layoutOf(ctx: PDFContext, d: PDFDict, colorSpaces: PDFDict | undefined): Layout | BurnFailure {
  const width = Math.floor(numOf(d, "Width", 0));
  const height = Math.floor(numOf(d, "Height", 0));
  if (width <= 0 || height <= 0) return "broken";
  const maskFlag = d.lookup(PDFName.of("ImageMask"));
  const isMask = maskFlag instanceof PDFBool && maskFlag.asBoolean();
  const bpc = isMask ? 1 : Math.floor(numOf(d, "BitsPerComponent", 8));
  if (![1, 2, 4, 8, 16].includes(bpc)) return "broken";
  const model: Model | null = isMask ? { kind: "direct", comps: 1, cmyk: false } : colorModel(ctx, d.get(PDFName.of("ColorSpace")), colorSpaces);
  if (!model) return "unsupported_color";
  const comps = model.kind === "direct" ? model.comps : 1;
  const rowLen = Math.ceil((width * comps * bpc) / 8);

  // Decode 配列（反転など）
  const maxV = bpc === 16 ? 0xffff : (1 << bpc) - 1;
  const decArr = d.lookup(PDFName.of("Decode"));
  const dec: number[] = [];
  if (decArr instanceof PDFArray) for (const o of decArr.asArray()) {
    const v = ctx.lookup(o);
    dec.push(v instanceof PDFNumber ? v.asNumber() : 0);
  }
  /** 成分 c を、復号したあとの値 target（0 か 1）に近づける生の値 */
  const rawFor = (c: number, target: 0 | 1): number => {
    const lo = dec[c * 2] ?? 0;
    const hi = dec[c * 2 + 1] ?? 1;
    return Math.abs(lo - target) <= Math.abs(hi - target) ? 0 : maxV;
  };

  const fillFor = (tone: "dark" | "light"): number[] => {
    // 型抜き：どちらの覆いでも、塗らない点にする（既定の Decode [0 1] では 1 が「塗らない」）
    if (isMask) return [dec.length >= 2 && dec[0] === 1 ? 0 : 1];
    if (model.kind === "indexed") {
      let best = 0, bestLum = tone === "dark" ? Infinity : -Infinity;
      for (let i = 0; i <= model.hival; i++) {
        const c: number[] = [];
        for (let k = 0; k < model.base; k++) c.push((model.lookup[i * model.base + k] ?? 0) / 255);
        const l = luminance(c, model.baseCmyk);
        if (tone === "dark" ? l < bestLum : l > bestLum) {
          bestLum = l;
          best = i;
        }
      }
      // Decode で引き直す（索引の画像の Decode は [0 hival] が既定）
      const lo = dec[0] ?? 0;
      const hi = dec[1] ?? maxV;
      return [hi === lo ? 0 : Math.max(0, Math.min(maxV, Math.round(((best - lo) * maxV) / (hi - lo))))];
    }
    if (model.cmyk) return tone === "dark" ? [rawFor(0, 0), rawFor(1, 0), rawFor(2, 0), rawFor(3, 1)] : [0, 1, 2, 3].map((c) => rawFor(c, 0));
    return Array.from({ length: model.comps }, (_, c) => rawFor(c, tone === "dark" ? 0 : 1));
  };
  return { width, height, bpc, comps, rowLen, fill: { dark: fillFor("dark"), light: fillFor("light") } };
}

/**
 * 1行ずつ塗る道具。塗るのは、画素の中心が覆いの中にある画素（検証器と同じ数え方）。
 * ふちにまたがる画素も塗るので、覆いのふちが 1 画素ほど太って見えることがある（残り 0 件を優先する。2026-11-04 人が決めた）。
 * 捨てた案：四隅がすべて覆いの中にある画素だけを塗る。見た目は変わらないが、ふちの画素のインクが残り、
 * 合成 PDF（fixtures/p6）で検証器の残りが 5 件になった（2026-11-04 測定）。
 * 覆いごとに、画像の中のどの行・列に当たりうるかを先に求め、当たらない行は見ない（大きな画像で速くするため）。
 * covers は描いた順に並べて渡す。1つの画素に覆いが重なるときは、あとに描いた（上にある）覆いの色で塗り、その覆いで数える
 * （見た目と合わせるため。先の覆いの色で塗ると、黒い塗りの上に白い塗りを重ねた所で、白い覆いの下に黒が残った。2026-11-04、実物の trace から）。
 * ただし、上にある濃い覆いが、明るい覆い（どれか）の中にすっかり入っているときは、その所を明るい覆いの色で塗る
 * （白い札の上に書いた字や線。濃い色で塗ると、白い覆いの下に黒い模様が残り、読み直しで「白い覆いの下に何かある」と出た。2026-11-04、実物の trace から）。
 * 濃い覆いが明るい覆いからはみ出すときは、上にある濃い覆いの色のまま塗る（はみ出した所は黒く塗るしかないので、
 * 白で塗ると濃い覆いの下が白と黒の混ざりになり、検証器が「濃い覆いの下に中身が残っている」と数えるため）。
 * 「すっかり入っている」かは、濃い覆いの中に中心が入る画素を先に全部見て決める（形で測る。画素の数が DARK_INSIDE_MAX を超える濃い覆いは見ずに「はみ出す」とする）。
 */
function makePainter(L: Layout, ctm: Matrix, covers: SanCover[]) {
  const perCover = covers.map(() => 0);
  const reached = covers.map(() => false);
  let pixels = 0;
  // 覆いの箱の四隅を、画像の画素の位置に戻す（ctm の逆）。戻せないときは、すべての行・列を見る
  const det = ctm[0] * ctm[3] - ctm[1] * ctm[2];
  const spans = covers.map((c) => {
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { x0: 0, x1: L.width - 1, y0: 0, y1: L.height - 1 };
    const [a, b, cc, d, e, f] = ctm;
    const pts = [[c.rect[0], c.rect[1]], [c.rect[2], c.rect[1]], [c.rect[0], c.rect[3]], [c.rect[2], c.rect[3]]].map(([x, y]) => {
      const u = (d * (x! - e) - cc * (y! - f)) / det;
      const v = (-b * (x! - e) + a * (y! - f)) / det;
      return [u * L.width, (1 - v) * L.height];
    });
    const xs = pts.map((p) => p[0]!), ys = pts.map((p) => p[1]!);
    return {
      x0: Math.max(0, Math.floor(Math.min(...xs)) - 2), x1: Math.min(L.width - 1, Math.ceil(Math.max(...xs)) + 2),
      y0: Math.max(0, Math.floor(Math.min(...ys)) - 2), y1: Math.min(L.height - 1, Math.ceil(Math.max(...ys)) + 2),
    };
  });
  const fills = covers.map((c) => (c.tone === "light" ? L.fill.light : L.fill.dark));
  // 濃い覆いが、明るい覆いの中にすっかり入っているか（画素の中心で見る）
  const lights = covers.map((c, i) => (c.tone === "light" ? i : -1)).filter((i) => i >= 0);
  const darkInside = covers.map(() => false);
  if (lights.length) {
    for (let k = 0; k < covers.length; k++) {
      if (covers[k]!.tone === "light") continue;
      const sp = spans[k]!;
      const near = lights.filter((j) => {
        const sj = spans[j]!;
        return sj.x0 <= sp.x1 && sj.x1 >= sp.x0 && sj.y0 <= sp.y1 && sj.y1 >= sp.y0;
      });
      if (!near.length || (sp.x1 - sp.x0 + 1) * (sp.y1 - sp.y0 + 1) > DARK_INSIDE_MAX) continue;
      let any = false, outside = false;
      for (let y = sp.y0; y <= sp.y1 && !outside; y++) {
        const v = 1 - (y + 0.5) / L.height;
        for (let x = sp.x0; x <= sp.x1; x++) {
          const [px, py] = apply(ctm, (x + 0.5) / L.width, v);
          if (!coverContains(covers[k]!, px, py)) continue;
          any = true;
          if (!near.some((j) => coverContains(covers[j]!, px, py))) {
            outside = true;
            break;
          }
        }
      }
      darkInside[k] = any && !outside;
    }
  }
  return {
    perCover,
    reached,
    get pixels() {
      return pixels;
    },
    /** data の rowStart から始まる1行（画像の y 行目）を塗る */
    paintRow(data: Uint8Array, rowStart: number, y: number) {
      let xMin = Infinity, xMax = -Infinity;
      const ks: number[] = [];
      for (let k = 0; k < covers.length; k++) {
        const sp = spans[k]!;
        if (y < sp.y0 || y > sp.y1) continue;
        ks.push(k);
        if (sp.x0 < xMin) xMin = sp.x0;
        if (sp.x1 > xMax) xMax = sp.x1;
      }
      if (!ks.length) return;
      const v = 1 - (y + 0.5) / L.height; // 画像の1行目は、単位の正方形の上端
      for (let x = xMin; x <= xMax; x++) {
        const [px, py] = apply(ctm, (x + 0.5) / L.width, v);
        let hit = -1;
        for (let i = ks.length - 1; i >= 0; i--) {
          const k = ks[i]!;
          const sp = spans[k]!;
          if (x < sp.x0 || x > sp.x1) continue;
          if (coverContains(covers[k]!, px, py)) {
            hit = k;
            reached[k] = true;
            // 下にある覆いのうち、まだ中心が入った画素のないものだけ、この画素が入るかを見る（安全網のため。見る数は覆いごとに少しだけ）
            for (let j = i - 1; j >= 0; j--) {
              const kk = ks[j]!;
              if (reached[kk]) continue;
              const sj = spans[kk]!;
              if (x >= sj.x0 && x <= sj.x1 && coverContains(covers[kk]!, px, py)) reached[kk] = true;
            }
            break;
          }
        }
        if (hit < 0) continue;
        // 上にある濃い覆いが明るい覆いの中にすっかり入っていれば、この画素を含むいちばん上の明るい覆いの色で塗り、その覆いで数える
        if (darkInside[hit]) {
          for (let i = ks.length - 1; i >= 0; i--) {
            const k = ks[i]!;
            if (covers[k]!.tone !== "light") continue;
            const sp = spans[k]!;
            if (x >= sp.x0 && x <= sp.x1 && coverContains(covers[k]!, px, py)) {
              hit = k;
              reached[k] = true;
              break;
            }
          }
        }
        const fill = fills[hit]!;
        for (let c = 0; c < L.comps; c++) writeSample(data, rowStart, x * L.comps + c, L.bpc, fill[c]!);
        perCover[hit]!++;
        pixels++;
      }
    },
  };
}

/** 元の辞書の項目を写す（skip に入れたもの・圧縮の項目は写さない） */
function copyEntries(from: PDFDict, to: PDFDict, skip: string[]) {
  const drop = new Set(["Filter", "DecodeParms", "DP", "Length", "DL", ...skip]);
  for (const [k, v] of from.entries()) if (!drop.has(k.decodeText())) to.set(k, v);
}

/**
 * 画像を、置いた行列 ctm（単位の正方形 → ページの座標）で描いたとき、covers の中に中心が入る画素を塗りつぶした新しい画像を作る。
 * 塗った画素が 0 なら pixels: 0（新しい画像は作るが、呼ぶ側で使わなくてよい）。
 */
export async function burnImage(ctx: PDFContext, stream: PDFStream, colorSpaces: PDFDict | undefined, ctm: Matrix, covers: SanCover[], limits: BurnLimits): Promise<BurnResult> {
  const d = stream.dict;
  const filters = filterNames(ctx, d);
  if (filters.length === 1 && DCT.has(filters[0]!)) return burnDecoded(ctx, stream, colorSpaces, ctm, covers, limits, "jpeg");
  if (filters.length === 1 && BITONAL.has(filters[0]!)) return burnDecoded(ctx, stream, colorSpaces, ctm, covers, limits, "bitonal");

  const L = layoutOf(ctx, d, colorSpaces);
  if (typeof L === "string") return { ok: false, reason: L };
  if (L.width * L.height > limits.maxPixels) return { ok: false, reason: "too_large" };
  if (filters.some((f) => !DECODABLE.has(f))) return { ok: false, reason: "unsupported_filter" };
  if (L.rowLen * L.height > limits.maxBytes) {
    // 大きな画像：Flate だけのものは、流して塗る。ほかの圧縮は塗れない
    if (filters.length === 1 && FLATE.has(filters[0]!) && stream instanceof PDFRawStream) return burnStreaming(ctx, stream, L, ctm, covers);
    return { ok: false, reason: "too_large" };
  }

  let data: Uint8Array;
  try {
    data = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  } catch {
    return { ok: false, reason: "broken" };
  }
  const parms = decodeParms(ctx, d);
  if (parms) {
    const predictor = numOf(parms, "Predictor", 1);
    const colors = numOf(parms, "Colors", L.comps);
    const pbpc = numOf(parms, "BitsPerComponent", L.bpc);
    const columns = numOf(parms, "Columns", L.width);
    if (predictor >= 10) data = undoPng(data, colors, pbpc, columns);
    else if (predictor === 2) {
      const t = undoTiff(data, colors, pbpc, columns);
      if (!t) return { ok: false, reason: "unsupported_filter" };
      data = t;
    }
  }
  if (data.length < L.rowLen * L.height) return { ok: false, reason: "broken" };
  data = data.slice(0, L.rowLen * L.height);

  const painter = makePainter(L, ctm, covers);
  for (let y = 0; y < L.height; y++) painter.paintRow(data, y * L.rowLen, y);

  const out = ctx.flateStream(data, {});
  copyEntries(d, out.dict, []);
  return { ok: true, stream: out, pixels: painter.pixels, perCover: painter.perCover, reached: painter.reached, via: "memory" };
}

/** 大きな Flate の画像を、丸ごと解かずに、行ごとに解いて塗り、Flate で書き直す（予測は戻して、予測なしで書く） */
async function burnStreaming(ctx: PDFContext, stream: PDFRawStream, L: Layout, ctm: Matrix, covers: SanCover[]): Promise<BurnResult> {
  const parms = decodeParms(ctx, stream.dict);
  const predictor = parms ? numOf(parms, "Predictor", 1) : 1;
  if (parms && predictor > 1) {
    // 予測の形が画像と合わないものは扱わない
    if (numOf(parms, "Colors", L.comps) !== L.comps || numOf(parms, "BitsPerComponent", L.bpc) !== L.bpc || numOf(parms, "Columns", L.width) !== L.width) {
      return { ok: false, reason: "unsupported_filter" };
    }
    if (predictor === 2 && L.bpc !== 8) return { ok: false, reason: "unsupported_filter" };
    if (predictor !== 2 && predictor < 10) return { ok: false, reason: "unsupported_filter" };
  }
  const png = predictor >= 10;
  const srcRowLen = L.rowLen + (png ? 1 : 0);
  const bpp = Math.max(1, Math.ceil((L.comps * L.bpc) / 8));
  const painter = makePainter(L, ctm, covers);

  const ds = new DecompressionStream("deflate");
  const cs = new CompressionStream("deflate");
  const dw = ds.writable.getWriter();
  const cw = cs.writable.getWriter();
  const outChunks: Uint8Array[] = [];
  // 壊れた圧縮で途中で止まっても、捕まえない失敗（unhandled rejection）を出さないよう、両方に catch をつけておく
  let failed = false;
  const collect = (async () => {
    for await (const c of cs.readable as unknown as AsyncIterable<Uint8Array>) outChunks.push(c);
  })().catch(() => {
    failed = true;
  });
  const contents = stream.contents as Uint8Array<ArrayBuffer>;
  const feed = (async () => {
    // 入れるかけらは小さくする（よく縮んだ画像は、1MB のかけらが数十 MB に戻り、読む側より先にたまるため。2026-11-04 測定）
    for (let i = 0; i < contents.length; i += FEED_BYTES) await dw.write(contents.subarray(i, i + FEED_BYTES));
    await dw.close();
  })().catch(() => {
    failed = true;
  });

  const BATCH_ROWS = Math.max(1, Math.floor((4 << 20) / L.rowLen));
  let batch = new Uint8Array(BATCH_ROWS * L.rowLen);
  let inBatch = 0;
  let prev: Uint8Array | null = null;
  let prevAt = 0;
  let carry = new Uint8Array(0);
  let y = 0;
  try {
    for await (const chunk of ds.readable as unknown as AsyncIterable<Uint8Array>) {
      let buf: Uint8Array = chunk;
      if (carry.length) {
        buf = new Uint8Array(carry.length + chunk.length);
        buf.set(carry);
        buf.set(chunk, carry.length);
      }
      let at = 0;
      while (at + srcRowLen <= buf.length && y < L.height) {
        const outAt = inBatch * L.rowLen;
        if (png) undoPngRow(buf, at, batch, outAt, L.rowLen, bpp, prev, prevAt);
        else {
          batch.set(buf.subarray(at, at + L.rowLen), outAt);
          if (predictor === 2) undoTiffRow(batch, outAt, L.rowLen, L.comps);
        }
        // PNG の予測は、塗る前の行を「前の行」にする
        if (png) {
          if (!prev || prev.length !== L.rowLen) prev = new Uint8Array(L.rowLen);
          prev.set(batch.subarray(outAt, outAt + L.rowLen));
          prevAt = 0;
        }
        painter.paintRow(batch, outAt, y);
        y++;
        inBatch++;
        at += srcRowLen;
        if (inBatch === BATCH_ROWS) {
          await cw.write(batch);
          batch = new Uint8Array(BATCH_ROWS * L.rowLen);
          inBatch = 0;
        }
      }
      carry = buf.slice(at);
    }
    await feed;
  } catch {
    await cw.abort().catch(() => {});
    return { ok: false, reason: "broken" };
  }
  if (y < L.height) {
    await cw.abort().catch(() => {});
    return { ok: false, reason: "broken" };
  }
  try {
    if (inBatch) await cw.write(batch.subarray(0, inBatch * L.rowLen));
    await cw.close();
  } catch {
    return { ok: false, reason: "broken" };
  }
  await collect;
  if (failed) return { ok: false, reason: "broken" };
  const total = outChunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of outChunks) {
    bytes.set(c, o);
    o += c.length;
  }
  const out = PDFRawStream.of(ctx.obj({}), bytes);
  copyEntries(stream.dict, out.dict, []);
  out.dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
  return { ok: true, stream: out, pixels: painter.pixels, perCover: painter.perCover, reached: painter.reached, via: "stream" };
}

/**
 * pdf-lib で解けない画像（JPEG・CCITT・JBIG2）：呼ぶ側の道具（PDF.js）で全部の画素まで解き、塗り、書き直す。
 * - JPEG：RGB に解いて塗り、JPEG に書き直す（色は DeviceRGB になる）
 * - CCITT・JBIG2：1 ビットの灰色（1 が白）に解いて塗り、1 ビットのまま Flate で書き直す（DeviceGray）
 * 解くために、画像1つだけを描いた小さな PDF（1×1 のページ）を作って道具に渡す。色は Decode などをかけたあとのものになる
 */
async function burnDecoded(ctx: PDFContext, stream: PDFStream, colorSpaces: PDFDict | undefined, ctm: Matrix, covers: SanCover[], limits: BurnLimits, format: "jpeg" | "bitonal"): Promise<BurnResult> {
  const d = stream.dict;
  const width = Math.floor(numOf(d, "Width", 0));
  const height = Math.floor(numOf(d, "Height", 0));
  if (width <= 0 || height <= 0) return { ok: false, reason: "broken" };
  if (width * height > limits.maxPixels) return { ok: false, reason: "too_large" };
  const mask = d.lookup(PDFName.of("ImageMask"));
  if (mask instanceof PDFBool && mask.asBoolean()) return { ok: false, reason: "unsupported_filter" };
  const codec = limits.codec;
  if (!codec || (format === "bitonal" && !codec.bitonal)) return { ok: false, reason: "no_codec" };

  let pdf: Uint8Array;
  try {
    const one = await PDFDocument.create({ updateMetadata: false });
    const copy = PDFObjectCopier.for(ctx, one.context).copy(stream) as PDFStream;
    // 名前で呼ぶ色空間（リソースの /ColorSpace の中のもの）は、中身に置き換える
    const cs = d.get(PDFName.of("ColorSpace"));
    if (cs instanceof PDFName && colorSpaces?.get(cs)) copy.dict.set(PDFName.of("ColorSpace"), PDFObjectCopier.for(ctx, one.context).copy(colorSpaces.get(cs)!));
    // 透明の型抜き（/SMask・/Mask）は、解く画素に要らない
    copy.dict.delete(PDFName.of("SMask"));
    copy.dict.delete(PDFName.of("Mask"));
    const ref = one.context.register(copy);
    const page = one.addPage([1, 1]);
    page.node.set(PDFName.of("Resources"), one.context.obj({ XObject: { I: ref } }));
    page.node.set(PDFName.of("Contents"), one.context.register(one.context.stream("q 1 0 0 1 0 0 cm /I Do Q")));
    pdf = await one.save({ useObjectStreams: false });
  } catch {
    return { ok: false, reason: "broken" };
  }
  let decoded: DecodedImage | null;
  try {
    decoded = await codec.decode(pdf, width * height);
  } catch {
    decoded = null;
  }
  if (!decoded || decoded.width !== width || decoded.height !== height) return { ok: false, reason: "broken" };

  const gray1 = decoded.kind === "gray1";
  const L: Layout = gray1
    ? { width, height, bpc: 1, comps: 1, rowLen: Math.ceil(width / 8), fill: { dark: [0], light: [1] } }
    : { width, height, bpc: 8, comps: 3, rowLen: width * 3, fill: { dark: [0, 0, 0], light: [255, 255, 255] } };
  if (decoded.data.length < L.rowLen * height) return { ok: false, reason: "broken" };
  const data = decoded.data;
  const painter = makePainter(L, ctm, covers);
  for (let y = 0; y < height; y++) painter.paintRow(data, y * L.rowLen, y);
  const via = format;
  if (painter.pixels === 0) return { ok: true, stream: PDFRawStream.of(ctx.obj({}), new Uint8Array(0)), pixels: 0, perCover: painter.perCover, reached: painter.reached, via };

  const skip = ["ColorSpace", "Decode", "BitsPerComponent", "ColorTransform", "ImageMask"];
  if (format === "jpeg" && !gray1) {
    let jpeg: Uint8Array | null;
    try {
      jpeg = await codec.encodeJpeg(data, width, height, limits.jpegQuality);
    } catch {
      jpeg = null;
    }
    if (!jpeg || jpeg.length === 0) return { ok: false, reason: "broken" };
    const out = PDFRawStream.of(ctx.obj({}), jpeg);
    copyEntries(d, out.dict, skip);
    out.dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
    out.dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
    out.dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    return { ok: true, stream: out, pixels: painter.pixels, perCover: painter.perCover, reached: painter.reached, via };
  }
  // 1 ビットの灰色はそのまま、RGB は 8 ビットの RGB で、Flate に書き直す
  const out = ctx.flateStream(data.subarray(0, L.rowLen * height), {});
  copyEntries(d, out.dict, skip);
  out.dict.set(PDFName.of("ColorSpace"), PDFName.of(gray1 ? "DeviceGray" : "DeviceRGB"));
  out.dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(gray1 ? 1 : 8));
  return { ok: true, stream: out, pixels: painter.pixels, perCover: painter.perCover, reached: painter.reached, via };
}

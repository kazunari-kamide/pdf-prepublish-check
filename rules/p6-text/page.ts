// SPDX-License-Identifier: AGPL-3.0-only
//
// 1ページの命令を順に追い、次の2つを集める（docs/prd.md §3）。
// - 覆い：濃い色の塗り（四角に近い図形）と、濃い色の太い直線。描いた順番つき
// - 字：1字ごとの箱。描いた順番つき
// 図形を全部組み立てない。必要なものだけを拾う（CLAUDE.md §5）。

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import {
  IDENTITY,
  apply,
  area,
  boundsOf,
  clipPolygonToRect,
  isFiniteMatrix,
  multiply,
  flattenCubic,
  rectsOverlap,
  signedPolygonArea,
  scaleOf,
  type Matrix,
  type Point,
  type Rect,
} from "./geometry.ts";
import { readFont, type FontInfo } from "./fonts.ts";
import { operations, type Operand } from "./lexer.ts";
import type { P6TextSettings } from "./settings.ts";
import { measureImageDarkness } from "./images.ts";

/** 覆っているものの種類（rubric/p6.md §1 の内訳の「覆っているもの」） */
export type CoverKind = "fill" | "image" | "annotation";
export type Cover = {
  seq: number;
  rect: Rect;
  kind: CoverKind;
  how: "fill" | "stroke" | "image" | "redact";
  /** 塗りの明るさ。画像は濃い画素の割合ではなく、1 − 割合（小さいほど濃い）。墨消しの注釈は 0 */
  luminance: number;
  /**
   * 覆いの形（ページの座標の多角形。曲線は直線に分けたもの）。ないときは rect の箱そのものが形（1.3.0 から）。
   * parts の面積を足し合わせて、字の箱が隠れる割合を出す（coverageOf）。
   */
  shape?: CoverShape;
};
export type CoverShape = { parts: Point[][]; rule: "nonzero" | "evenodd" };

/** 曲線1本を分ける直線の数 */
const CURVE_SEGMENTS = 8;

/** 覆いの形が、箱 r をどれだけ隠すか（面積。0〜箱の面積） */
export function coverageOf(cover: Pick<Cover, "rect" | "shape">, r: Rect): number {
  const boxArea = area(r);
  if (boxArea <= 0) return 0;
  if (!cover.shape) {
    const w = Math.min(r[2], cover.rect[2]) - Math.max(r[0], cover.rect[0]);
    const h = Math.min(r[3], cover.rect[3]) - Math.max(r[1], cover.rect[1]);
    return w > 0 && h > 0 ? w * h : 0;
  }
  const { parts, rule } = cover.shape;
  let sum = 0;
  if (rule === "nonzero") {
    // 向きつきの面積を足す。逆向きの内側（枠の穴）は引かれる。同じ向きで重なった分は、箱の面積で頭打ちにする
    for (const part of parts) sum += signedPolygonArea(clipPolygonToRect(part, r));
    sum = Math.abs(sum);
  } else {
    // 偶奇の決まり：ほかの部分の外枠の箱の中にいくつ入っているか（入れ子の深さ）で、足すか引くかを決める（目安）
    const boxes = parts.map((pt) => boundsOf(pt));
    parts.forEach((part, i) => {
      const b = boxes[i]!;
      let depth = 0;
      boxes.forEach((o, j) => {
        if (j !== i && o[0] <= b[0] && o[1] <= b[1] && o[2] >= b[2] && o[3] >= b[3] && area(o) > area(b)) depth++;
      });
      sum += (depth % 2 === 0 ? 1 : -1) * Math.abs(signedPolygonArea(clipPolygonToRect(part, r)));
    });
  }
  return Math.min(boxArea, Math.max(0, sum));
}

/** 外枠の箱が重なり合う部分どうしを、1つのまとまりにする（離れた四角は別の覆いにするため） */
function groupOverlapping(parts: Point[][]): Point[][][] {
  const boxes = parts.map((p) => boundsOf(p));
  const parent = parts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (rectsOverlap(boxes[i]!, boxes[j]!)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Point[][]>();
  parts.forEach((p, i) => {
    const g = find(i);
    groups.set(g, [...(groups.get(g) ?? []), p]);
  });
  return [...groups.values()];
}

/** 線の1本（p0→p1）を、太さ w の四角（向きは線のまま）にする */
function segmentQuad(p0: Point, p1: Point, half: number): Point[] | null {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len <= 0 || half <= 0) return null;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  return [
    [p0[0] + nx, p0[1] + ny],
    [p1[0] + nx, p1[1] + ny],
    [p1[0] - nx, p1[1] - ny],
    [p0[0] - nx, p0[1] - ny],
  ];
}
export type UncheckedImage = { reason: "unsupported_filter" | "too_large" | "unsupported_color" | "broken" };
export type GlyphBox = { seq: number; rect: Rect; isSpace: boolean; text: string };
export type PageScan = { covers: Cover[]; glyphs: GlyphBox[]; operations: number; uncheckedImages: UncheckedImage[] };

export class TooManyOperations extends Error {}
/** 先に描いた字に重なる濃い塗りが多すぎる（1.3.0 から） */
export class TooManyCovers extends Error {}

type Color = { luminance: number | null };

type GState = {
  ctm: Matrix;
  fill: Color;
  stroke: Color;
  fillAlpha: number;
  strokeAlpha: number;
  lineWidth: number;
  fillSpace: number; // 色の成分の数（0 は分からない色空間）
  strokeSpace: number;
  font: FontInfo | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
};

const MAX_FORM_DEPTH = 12;

function cloneState(s: GState): GState {
  return { ...s, fill: { ...s.fill }, stroke: { ...s.stroke } };
}

/** 色の成分から明るさ（0＝黒、1＝白）を出す。分からない色空間なら null */
export function luminanceOf(components: number[], space: number): number | null {
  const c = components.map((v) => Math.min(1, Math.max(0, v)));
  if (space === 1 && c.length >= 1) return c[0]!;
  if (space === 3 && c.length >= 3) return 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]!;
  if (space === 4 && c.length >= 4) {
    const [cy, m, y, k] = c as [number, number, number, number];
    const r = (1 - cy) * (1 - k);
    const g = (1 - m) * (1 - k);
    const b = (1 - y) * (1 - k);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return null;
}

function nums(args: Operand[]): number[] {
  return args.filter((a): a is number => typeof a === "number");
}

function nameArg(a: Operand | undefined): string | undefined {
  return a && typeof a === "object" && !Array.isArray(a) && "kind" in a && a.kind === "name" ? a.value : undefined;
}

function bytesArg(a: Operand | undefined): Uint8Array | undefined {
  return a && typeof a === "object" && !Array.isArray(a) && "kind" in a && a.kind === "bytes" ? a.value : undefined;
}

export function contentBytes(ctx: PDFContext, obj: PDFObject | undefined): Uint8Array {
  const v = obj ? ctx.lookup(obj) : undefined;
  const one = (s: PDFObject | undefined): Uint8Array => {
    const x = s ? ctx.lookup(s) : undefined;
    if (x instanceof PDFRawStream) return decodePDFRawStream(x).decode();
    if (x instanceof PDFStream) return x.getContents();
    return new Uint8Array(0);
  };
  if (v instanceof PDFArray) {
    const parts = v.asArray().map(one);
    const total = parts.reduce((s, p) => s + p.length + 1, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
      out[at++] = 0x0a; // 区切り（命令が2つのストリームにまたがらないように）
    }
    return out;
  }
  return one(obj);
}

/** 色空間の名前（または配列）から、成分の数を出す */
function componentsOfSpace(ctx: PDFContext, resources: PDFDict | undefined, name: string): number {
  if (name === "DeviceGray" || name === "G" || name === "CalGray") return 1;
  if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return 3;
  if (name === "DeviceCMYK" || name === "CMYK") return 4;
  const spaces = resources?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  const def = spaces ? ctx.lookup(spaces.get(PDFName.of(name))) : undefined;
  if (def instanceof PDFName) return componentsOfSpace(ctx, undefined, def.decodeText());
  if (def instanceof PDFArray) {
    const kind = ctx.lookup(def.get(0));
    const k = kind instanceof PDFName ? kind.decodeText() : "";
    if (k === "ICCBased") {
      const st = ctx.lookup(def.get(1));
      const n = st instanceof PDFStream ? st.dict.lookup(PDFName.of("N")) : undefined;
      return n instanceof PDFNumber ? n.asNumber() : 0;
    }
    if (k === "CalGray") return 1;
    if (k === "CalRGB") return 3;
  }
  return 0; // Pattern・Separation・Indexed・Lab などは、いまは見分けない
}

export type PageScanner = {
  /** ページの命令の列（または注釈の見た目）を読む。coverKind は、そこで見つけた塗りを何の覆いとして数えるか */
  run(data: Uint8Array, res: PDFDict | undefined, ctm: Matrix, coverKind: CoverKind): void;
  /** 命令を読まずに覆いを足す（未適用の墨消し注釈など）。いま読んだものより上に重なる */
  addCover(rect: Rect, kind: CoverKind, how: Cover["how"], luminance: number): void;
  result(): PageScan;
};

export function createPageScanner(ctx: PDFContext, settings: P6TextSettings): PageScanner {
  const covers: Cover[] = [];
  const glyphs: GlyphBox[] = [];
  // 字の位置の索引（マス目）。覆いになりうるのは、先に描いた字に重なる塗りだけなので、
  // 重ならない塗りは覆いの一覧に入れずに捨てる（図形の多い重いページで、メモリと時間を抑えるため。1.3.0 から）
  const CELL = 32;
  const MAX_CELLS = 4096;
  const grid = new Map<number, GlyphBox[]>();
  const wide: GlyphBox[] = []; // マス目に入れきれない大きな字
  const cellKey = (cx: number, cy: number) => cx * 100_003 + cy;
  const cellsOf = (r: Rect) => {
    const x0 = Math.floor(r[0] / CELL);
    const x1 = Math.floor(r[2] / CELL);
    const y0 = Math.floor(r[1] / CELL);
    const y1 = Math.floor(r[3] / CELL);
    return { x0, x1, y0, y1, n: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };
  const addGlyph = (g: GlyphBox) => {
    glyphs.push(g);
    const c = cellsOf(g.rect);
    if (!Number.isFinite(c.n) || c.n > 16) {
      wide.push(g);
      return;
    }
    for (let cx = c.x0; cx <= c.x1; cx++) {
      for (let cy = c.y0; cy <= c.y1; cy++) {
        const k = cellKey(cx, cy);
        const list = grid.get(k);
        if (list) list.push(g);
        else grid.set(k, [g]);
      }
    }
  };
  const overlapsAnyGlyph = (r: Rect): boolean => {
    const hit = (g: GlyphBox) => !g.isSpace && g.rect[0] < r[2] && r[0] < g.rect[2] && g.rect[1] < r[3] && r[1] < g.rect[3];
    if (wide.some(hit)) return true;
    const c = cellsOf(r);
    if (!Number.isFinite(c.n) || c.n > MAX_CELLS) return glyphs.some(hit); // 大きな覆いは、字を全部見る
    for (let cx = c.x0; cx <= c.x1; cx++) {
      for (let cy = c.y0; cy <= c.y1; cy++) {
        const list = grid.get(cellKey(cx, cy));
        if (list && list.some(hit)) return true;
      }
    }
    return false;
  };
  const pushCover = (c: Cover) => {
    if (!overlapsAnyGlyph(c.rect)) return;
    if (covers.length >= settings.maxCoversPerPage) throw new TooManyCovers();
    covers.push(c);
  };
  const uncheckedImages: UncheckedImage[] = [];
  let seq = 0;
  let opCount = 0;
  const fontCache = new Map<PDFObject, FontInfo>();

  const run = (
    data: Uint8Array,
    res: PDFDict | undefined,
    start: GState,
    depth: number,
    seen: Set<PDFObject>,
    coverKind: CoverKind,
  ) => {
    let gs = cloneState(start);
    const stack: GState[] = [];
    // 道（パス）：いまの行列にかける前の点を、部分ごとに持つ
    let subpaths: { points: Point[]; curved: boolean; closed: boolean }[] = [];
    let current: { points: Point[]; curved: boolean; closed: boolean } | null = null;
    // 字の行列
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;

    const startSub = (x: number, y: number) => {
      current = { points: [[x, y]], curved: false, closed: false };
      subpaths.push(current);
    };

    // 1.3.0 から：四角らしさで選ばず、塗った形そのもの（曲線は直線に分けたもの）を覆いとして持つ。
    // 字が隠れる割合は、形と字の箱の重なった面積で測る（coverageOf）。
    const paint = (doFill: boolean, doStroke: boolean, rule: "nonzero" | "evenodd" = "nonzero") => {
      if (!isFiniteMatrix(gs.ctm)) return;
      const devs = subpaths.filter((sp) => sp.points.length >= 2).map((sp) => ({ sp, dev: sp.points.map(([x, y]) => apply(gs.ctm, x, y)) }));
      if (doFill) {
        const lum = gs.fill.luminance;
        if (lum !== null && lum <= settings.darkLuminanceMax && gs.fillAlpha >= settings.opacityMin) {
          const parts = devs.map((d) => d.dev).filter((d) => d.length >= 3 && area(boundsOf(d)) > 0);
          for (const group of groupOverlapping(parts)) {
            const box = boundsOf(group.flat());
            // 縦横の四角1つなら、形を持たずに箱で測る（これまでと同じ結果になる）
            const plainRect = group.length === 1 && group[0]!.length === 4 && Math.abs(Math.abs(signedPolygonArea(group[0]!)) - area(box)) <= 1e-6 * Math.max(1, area(box));
            pushCover({ seq: ++seq, rect: box, kind: coverKind, how: "fill", luminance: lum, ...(plainRect ? {} : { shape: { parts: group, rule } }) });
          }
        }
      }
      if (doStroke) {
        const lum = gs.stroke.luminance;
        const half = (gs.lineWidth * scaleOf(gs.ctm)) / 2;
        // 細い線（太さが minStrokeWidth より細い）は、字を半分も隠せないので覆いにしない
        if (lum !== null && lum <= settings.darkLuminanceMax && gs.strokeAlpha >= settings.opacityMin && half * 2 >= settings.minStrokeWidth) {
          for (const { sp, dev } of devs) {
            const pts = sp.closed ? [...dev, dev[0]!] : dev;
            const quads: Point[][] = [];
            for (let k = 0; k + 1 < pts.length; k++) {
              const q = segmentQuad(pts[k]!, pts[k + 1]!, half);
              if (q) quads.push(q);
            }
            if (sp.curved) {
              // 曲線は、分けた直線をまとめて1つの覆いにする
              if (quads.length) pushCover({ seq: ++seq, rect: boundsOf(quads.flat()), kind: coverKind, how: "stroke", luminance: lum, shape: { parts: quads, rule: "nonzero" } });
            } else {
              // 直線は、1本ずつ別の覆いにする（これまでと同じ。縦横の線は箱そのもの）
              for (const q of quads) {
                const box = boundsOf(q);
                const axis = Math.abs(Math.abs(signedPolygonArea(q)) - area(box)) <= 1e-6 * Math.max(1, area(box));
                pushCover({ seq: ++seq, rect: box, kind: coverKind, how: "stroke", luminance: lum, ...(axis ? {} : { shape: { parts: [q], rule: "nonzero" } }) });
              }
            }
          }
        }
      }
      subpaths = [];
      current = null;
    };

    // 画像：単位の正方形を、いまの行列で置いた所に描く。ほぼ全部が濃い画像なら覆いとする
    const paintImage = (img: PDFStream, imgRes: PDFDict | undefined) => {
      if (!isFiniteMatrix(gs.ctm)) return;
      if (gs.fillAlpha < settings.opacityMin) return;
      const dev = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 1, 1), apply(gs.ctm, 0, 1)];
      const box = boundsOf(dev);
      const boxArea = area(box);
      if (boxArea <= 0) return;
      // 回したり傾けたりして置いた画像は、置いた形（平行四辺形）を覆いの形にする（1.3.0 から）
      const imageShape: CoverShape | undefined =
        Math.abs(Math.abs(signedPolygonArea(dev)) - boxArea) <= 1e-6 * Math.max(1, boxArea) ? undefined : { parts: [dev], rule: "nonzero" };
      const m = measureImageDarkness({
        ctx,
        stream: img,
        colorSpaces: imgRes?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict),
        fillLuminance: gs.fill.luminance,
        darkLuminanceMax: settings.darkLuminanceMax,
        opacityMin: settings.opacityMin,
        maxImageBytes: settings.maxImageBytes,
      });
      if (m.kind === "unknown") {
        uncheckedImages.push({ reason: m.reason });
        return;
      }
      if (m.darkFraction >= settings.darkImageFractionMin) {
        pushCover({ seq: ++seq, rect: box, kind: coverKind === "annotation" ? "annotation" : "image", how: "image", luminance: 1 - m.darkFraction, ...(imageShape ? { shape: imageShape } : {}) });
      }
    };

    const showText = (bytes: Uint8Array) => {
      const font = gs.font;
      if (!font) return;
      for (const g of font.decode(bytes)) {
        const trm = multiply(
          [gs.fontSize * gs.hScale, 0, 0, gs.fontSize, 0, gs.rise],
          multiply(tm, gs.ctm),
        );
        if (isFiniteMatrix(trm) && g.width > 0) {
          const corners: Point[] = [
            apply(trm, 0, font.descent),
            apply(trm, g.width, font.descent),
            apply(trm, g.width, font.ascent),
            apply(trm, 0, font.ascent),
          ];
          addGlyph({ seq: ++seq, rect: boundsOf(corners), isSpace: g.isSpace, text: g.text });
        }
        const tx = (g.width * gs.fontSize + gs.charSpacing + (g.isWordSpace ? gs.wordSpacing : 0)) * gs.hScale;
        tm = multiply([1, 0, 0, 1, tx, 0], tm);
      }
    };

    const setColor = (target: "fill" | "stroke", comps: number[], space: number) => {
      const lum = luminanceOf(comps, space);
      if (target === "fill") gs.fill = { luminance: lum };
      else gs.stroke = { luminance: lum };
    };

    for (const { op, args } of operations(data)) {
      if (++opCount > settings.maxOperationsPerPage) throw new TooManyOperations();
      const a = nums(args);
      switch (op) {
        // 状態
        case "q":
          stack.push(cloneState(gs));
          if (stack.length > 1000) stack.shift();
          break;
        case "Q":
          gs = stack.pop() ?? gs;
          break;
        case "cm":
          if (a.length >= 6) gs.ctm = multiply(a.slice(0, 6) as Matrix, gs.ctm);
          break;
        case "w":
          if (a.length >= 1) gs.lineWidth = Math.abs(a[0]!);
          break;
        case "gs": {
          const name = nameArg(args[0]);
          const ext = res?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
          const d = name && ext ? ctx.lookup(ext.get(PDFName.of(name))) : undefined;
          if (d instanceof PDFDict) {
            const ca = d.lookup(PDFName.of("ca"));
            const CA = d.lookup(PDFName.of("CA"));
            const lw = d.lookup(PDFName.of("LW"));
            if (ca instanceof PDFNumber) gs.fillAlpha = ca.asNumber();
            if (CA instanceof PDFNumber) gs.strokeAlpha = CA.asNumber();
            if (lw instanceof PDFNumber) gs.lineWidth = Math.abs(lw.asNumber());
          }
          break;
        }
        // 色
        case "g":
          gs.fillSpace = 1;
          setColor("fill", a, 1);
          break;
        case "G":
          gs.strokeSpace = 1;
          setColor("stroke", a, 1);
          break;
        case "rg":
          gs.fillSpace = 3;
          setColor("fill", a, 3);
          break;
        case "RG":
          gs.strokeSpace = 3;
          setColor("stroke", a, 3);
          break;
        case "k":
          gs.fillSpace = 4;
          setColor("fill", a, 4);
          break;
        case "K":
          gs.strokeSpace = 4;
          setColor("stroke", a, 4);
          break;
        case "cs":
        case "CS": {
          const n = componentsOfSpace(ctx, res, nameArg(args[0]) ?? "");
          // 色空間を決めると、色は「黒」（成分がすべて 0。CMYK は K=1）に戻る
          const init = n === 4 ? [0, 0, 0, 1] : new Array(n).fill(0);
          if (op === "cs") {
            gs.fillSpace = n;
            setColor("fill", init, n);
          } else {
            gs.strokeSpace = n;
            setColor("stroke", init, n);
          }
          break;
        }
        case "sc":
        case "scn":
          if (args.some((x) => nameArg(x) !== undefined)) gs.fill = { luminance: null }; // 模様（Pattern）
          else setColor("fill", a, gs.fillSpace);
          break;
        case "SC":
        case "SCN":
          if (args.some((x) => nameArg(x) !== undefined)) gs.stroke = { luminance: null };
          else setColor("stroke", a, gs.strokeSpace);
          break;
        // 道
        case "m":
          if (a.length >= 2) startSub(a[0]!, a[1]!);
          break;
        case "l":
          if (a.length >= 2) {
            if (!current) startSub(a[0]!, a[1]!);
            else (current as { points: Point[] }).points.push([a[0]!, a[1]!]);
          }
          break;
        case "c":
        case "v":
        case "y":
          if ((op === "c" && a.length >= 6) || (op !== "c" && a.length >= 4)) {
            if (!current) startSub(a[a.length - 2]!, a[a.length - 1]!);
            const cur = current as unknown as { points: Point[]; curved: boolean };
            const p0 = cur.points[cur.points.length - 1]!;
            const p3: Point = [a[a.length - 2]!, a[a.length - 1]!];
            // v：1つめの制御点が今の点。y：2つめの制御点が終点
            const p1: Point = op === "v" ? p0 : [a[0]!, a[1]!];
            const p2: Point = op === "c" ? [a[2]!, a[3]!] : op === "v" ? [a[0]!, a[1]!] : p3;
            cur.curved = true;
            cur.points.push(...flattenCubic(p0, p1, p2, p3, CURVE_SEGMENTS));
          }
          break;
        case "h":
          if (current) (current as { closed: boolean }).closed = true;
          break;
        case "re":
          if (a.length >= 4) {
            const [x, y, w, h] = a as [number, number, number, number];
            subpaths.push({ points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], curved: false, closed: true });
            current = null;
          }
          break;
        case "f":
        case "F":
          paint(true, false);
          break;
        case "f*":
          paint(true, false, "evenodd");
          break;
        case "S":
          paint(false, true);
          break;
        case "s":
          if (current) (current as { closed: boolean }).closed = true;
          paint(false, true);
          break;
        case "B":
          paint(true, true);
          break;
        case "B*":
          paint(true, true, "evenodd");
          break;
        case "b":
        case "b*":
          if (current) (current as { closed: boolean }).closed = true;
          paint(true, true, op === "b*" ? "evenodd" : "nonzero");
          break;
        case "n":
          subpaths = [];
          current = null;
          break;
        // 字
        case "BT":
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case "Tf": {
          const name = nameArg(args[0]);
          const size = typeof args[1] === "number" ? args[1] : undefined;
          if (size !== undefined) gs.fontSize = size;
          const fonts = res?.lookupMaybe(PDFName.of("Font"), PDFDict);
          const ref = name && fonts ? fonts.get(PDFName.of(name)) : undefined;
          if (ref) {
            let f = fontCache.get(ref);
            if (!f) {
              f = readFont(ctx, ref);
              fontCache.set(ref, f);
            }
            gs.font = f;
          } else gs.font = null;
          break;
        }
        case "Tc":
          if (a.length >= 1) gs.charSpacing = a[0]!;
          break;
        case "Tw":
          if (a.length >= 1) gs.wordSpacing = a[0]!;
          break;
        case "Tz":
          if (a.length >= 1) gs.hScale = a[0]! / 100;
          break;
        case "TL":
          if (a.length >= 1) gs.leading = a[0]!;
          break;
        case "Ts":
          if (a.length >= 1) gs.rise = a[0]!;
          break;
        case "Td":
          if (a.length >= 2) {
            tlm = multiply([1, 0, 0, 1, a[0]!, a[1]!], tlm);
            tm = tlm;
          }
          break;
        case "TD":
          if (a.length >= 2) {
            gs.leading = -a[1]!;
            tlm = multiply([1, 0, 0, 1, a[0]!, a[1]!], tlm);
            tm = tlm;
          }
          break;
        case "Tm":
          if (a.length >= 6) {
            tlm = a.slice(0, 6) as Matrix;
            tm = tlm;
          }
          break;
        case "T*":
          tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
          tm = tlm;
          break;
        case "Tj": {
          const b = bytesArg(args[0]);
          if (b) showText(b);
          break;
        }
        case "'": {
          tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
          tm = tlm;
          const b = bytesArg(args[0]);
          if (b) showText(b);
          break;
        }
        case '"': {
          if (typeof args[0] === "number") gs.wordSpacing = args[0];
          if (typeof args[1] === "number") gs.charSpacing = args[1];
          tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
          tm = tlm;
          const b = bytesArg(args[2]);
          if (b) showText(b);
          break;
        }
        case "TJ": {
          const arr = Array.isArray(args[0]) ? args[0] : [];
          for (const item of arr) {
            if (typeof item === "number") {
              const tx = (-item / 1000) * gs.fontSize * gs.hScale;
              tm = multiply([1, 0, 0, 1, tx, 0], tm);
            } else {
              const b = bytesArg(item);
              if (b) showText(b);
            }
          }
          break;
        }
        // 部品（Form XObject）
        case "Do": {
          if (depth >= MAX_FORM_DEPTH) break;
          const name = nameArg(args[0]);
          const xo = res?.lookupMaybe(PDFName.of("XObject"), PDFDict);
          const ref = name && xo ? xo.get(PDFName.of(name)) : undefined;
          const obj = ref ? ctx.lookup(ref) : undefined;
          if (!(obj instanceof PDFStream) || !ref || seen.has(ref)) break;
          const sub = obj.dict.lookup(PDFName.of("Subtype"));
          if (sub instanceof PDFName && sub.decodeText() === "Image") {
            paintImage(obj, res);
            break;
          }
          if (!(sub instanceof PDFName) || sub.decodeText() !== "Form") break;
          const mObj = obj.dict.lookup(PDFName.of("Matrix"));
          let m: Matrix = IDENTITY;
          if (mObj instanceof PDFArray && mObj.size() === 6) {
            const vals = mObj.asArray().map((o) => ctx.lookup(o));
            if (vals.every((v) => v instanceof PDFNumber)) m = vals.map((v) => (v as PDFNumber).asNumber()) as Matrix;
          }
          const subRes = obj.dict.lookupMaybe(PDFName.of("Resources"), PDFDict) ?? res;
          const data2 = obj instanceof PDFRawStream ? decodePDFRawStream(obj).decode() : obj.getContents();
          const inner = cloneState(gs);
          inner.ctm = multiply(m, gs.ctm);
          const nextSeen = new Set(seen);
          nextSeen.add(ref);
          run(data2, subRes, inner, depth + 1, nextSeen, coverKind);
          break;
        }
        default:
          break;
      }
    }
  };

  const initial: GState = {
    ctm: IDENTITY,
    fill: { luminance: 0 },
    stroke: { luminance: 0 },
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    fillSpace: 1,
    strokeSpace: 1,
    font: null,
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
  };
  return {
    run(data, res, ctm, coverKind) {
      run(data, res, { ...cloneState(initial), ctm }, 0, new Set(), coverKind);
    },
    addCover(rect, kind, how, luminance) {
      pushCover({ seq: ++seq, rect, kind, how, luminance });
    },
    result() {
      return { covers, glyphs, operations: opCount, uncheckedImages };
    },
  };
}

/** ページの命令の列だけを読む（注釈は読まない） */
export function scanPage(
  ctx: PDFContext,
  content: Uint8Array,
  resources: PDFDict | undefined,
  settings: P6TextSettings,
): PageScan {
  const scanner = createPageScanner(ctx, settings);
  scanner.run(content, resources, IDENTITY, "fill");
  return scanner.result();
}

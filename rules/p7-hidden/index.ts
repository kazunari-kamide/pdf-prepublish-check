// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P7（隠れたテキスト）。
// 取り出せるのに、画面では見えない字を見つける（rubric/p7.md §2）。
// 1件 ＝ 1回の字を描く命令（Tj・TJ・'・"）の中で、同じ理由で続く見えない字のまとまり。字そのものは返さない（字数と箱だけ）。
//
// 読み方：pdf-lib でページの中身を取り出し、描く命令を順に読みながら、次のものを描いた順番つきで集める。
//   字（1字ごとの箱・色・描き方・不透明さ・レイヤー・切り抜き）、塗り（形・色・不透明さ・重ね方）、画像（置いた箱）。
// 集め終わってから、1字ごとに理由を決める（画像と重なる見えない字は、描く順番に関係なく文字認識の層とするため。PR #22 の返事の 4）。
// 注釈は描かない（注釈の中の字は P8 の範囲）。

import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";
import { operations, type Op, type Tok } from "../shared/content-lexer.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { readFont, type FontInfo } from "../shared/fonts.ts";
import { loadPdf } from "../shared/load.ts";

export const RULE_ID = "p7-hidden";
export const RULE_VERSION = "1.0.2";

export type P7Reason = "hidden_layer" | "off_page" | "clipped" | "invisible" | "tiny" | "same_color" | "covered_light";

/** 判定の値。rubric/p7.json の thresholds と同じ値（rubric は採点する側なので読まず、ここに持つ） */
export const DEFAULT_SETTINGS = {
  outsideFraction: 0.5,
  invisibleAlphaBelow: 0.1,
  tinyHeightBelowPt: 1.0,
  sameColorDeltaBelow: 0.1,
  coverAlphaMin: 0.9,
  darkLuminanceMaxForP6: 0.3,
  /** 塗りを「四角に近い」とみなす割合（外枠の箱を埋める割合） */
  rectangularFillMin: 0.9,
  /** 覆いが字の箱を隠す割合の下限 */
  coveredFractionMin: 0.5,
  /** 1ページの命令の数の上限。超えたページは省く（1.0.2 から P6 と同じ 300 万。画面の上限と同じ） */
  maxOperations: 3_000_000,
  /** 部品（Form XObject）の入れ子の上限 */
  maxFormDepth: 12,
};
export type P7Settings = typeof DEFAULT_SETTINGS;

export type Rect = [number, number, number, number];

export type P7Finding = {
  pattern: "P7";
  page: number;
  reason: P7Reason;
  /** 見えない字の箱。ページの既定の座標（ポイント、左下が原点、/Rotate はかけない） */
  rect: Rect;
  /** 見えない字の数（空白を除く） */
  chars: number;
  /** includeText のときだけ。字そのもの（1バイトの書体は latin1 で読む目安）。記録やログには使わない */
  text?: string;
};

export type P7Report = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: { code: "empty" | "unreadable" | "encrypted"; message: string };
  pages: number | null;
  findings: P7Finding[];
  skippedPages: Array<{ page: number; reason: "too_many_operations" | "unreadable_page" }>;
  /** 見えないが P7 では数えなかった字の数。p6＝濃い覆いの下（P6 で数える）、ocrLayer＝画像と重なる見えない字（文字認識の層） */
  excluded: { p6: number; ocrLayer: number };
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { settings?: Partial<P7Settings>; includeText?: boolean };

// ---------------------------------------------------------------- 幾何

type M = [number, number, number, number, number, number];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];
/** a を先に、b をあとにかける */
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function boxOf(points: Array<[number, number]>): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
function intersect(a: Rect, b: Rect): Rect {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}
const interArea = (a: Rect, b: Rect) => {
  const r = intersect(a, b);
  return r[2] > r[0] && r[3] > r[1] ? area(r) : 0;
};
const union = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const inRect = (r: Rect, x: number, y: number) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

function polygonArea(poly: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

/** 点が形の中にあるか（偶奇の決まり。部分の道すべてで数える） */
function inShape(polys: Array<Array<[number, number]>>, x: number, y: number): boolean {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------- 色

type Space = { kind: "gray" | "rgb" | "cmyk"; n: 1 | 3 | 4 } | { kind: "unknown" };

/** 明るさ（0〜1）。分からない色は null */
function luminance(space: Space, comps: number[]): number | null {
  const c = (i: number) => Math.min(1, Math.max(0, comps[i] ?? 0));
  if (space.kind === "gray") return c(0);
  if (space.kind === "rgb") return 0.299 * c(0) + 0.587 * c(1) + 0.114 * c(2);
  if (space.kind === "cmyk") {
    const k = c(3);
    const r = (1 - c(0)) * (1 - k), g = (1 - c(1)) * (1 - k), b = (1 - c(2)) * (1 - k);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return null;
}

// ---------------------------------------------------------------- 辞書を引く道具
// 書体の寸法は、P6 と同じ rules/shared/fonts.ts で読む（PR #25 の返事の 1）

function numOf(ctx: PDFContext, o: PDFObject | undefined): number | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFNumber ? v.asNumber() : null;
}
function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return null;
}
function arrOf(ctx: PDFContext, o: PDFObject | undefined): PDFArray | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFArray ? v : null;
}
function nameOf(ctx: PDFContext, o: PDFObject | undefined): string | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFName ? v.decodeText() : null;
}

// ---------------------------------------------------------------- 集めるもの

type Glyph = {
  seq: number;
  op: number; // 字を描く命令の通し番号（まとめる単位）
  rect: Rect;
  height: number;
  isSpace: boolean;
  text: string;
  hidden: boolean;
  clip: Rect;
  mode: number;
  alpha: number;
  lum: number | null;
};
type Fill = { seq: number; box: Rect; polys: Array<Array<[number, number]>>; lum: number | null; alpha: number; normal: boolean; rectangular: boolean };
type Img = { seq: number; box: Rect };

type GState = {
  ctm: M;
  clip: Rect;
  fillSpace: Space;
  strokeSpace: Space;
  fill: number | null;
  stroke: number | null;
  ca: number;
  CA: number;
  normal: boolean;
  font: FontInfo | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  mode: number;
};

class TooManyOperations extends Error {}

type Visibility = (oc: PDFObject | undefined) => boolean;

/** 表示しないレイヤーかを決める（/OCProperties の /D の /OFF・/ON・/BaseState。OCMD は /OCGs と /P） */
function makeVisibility(ctx: PDFContext, catalog: PDFDict): Visibility {
  const props = dictOf(ctx, catalog.get(PDFName.of("OCProperties")));
  const d = props ? dictOf(ctx, props.get(PDFName.of("D"))) : null;
  const tag = (o: PDFObject | undefined) => (o instanceof PDFRef ? o.tag : null);
  const off = new Set<string>();
  const on = new Set<string>();
  const offArr = d ? arrOf(ctx, d.get(PDFName.of("OFF"))) : null;
  const onArr = d ? arrOf(ctx, d.get(PDFName.of("ON"))) : null;
  for (let i = 0; offArr && i < offArr.size(); i++) {
    const t = tag(offArr.get(i));
    if (t) off.add(t);
  }
  for (let i = 0; onArr && i < onArr.size(); i++) {
    const t = tag(onArr.get(i));
    if (t) on.add(t);
  }
  const baseOff = d ? nameOf(ctx, d.get(PDFName.of("BaseState"))) === "OFF" : false;
  const ocgOn = (o: PDFObject | undefined): boolean => {
    const t = tag(o);
    if (!t) return true;
    if (off.has(t)) return false;
    if (baseOff) return on.has(t);
    return true;
  };
  return (oc) => {
    const dict = dictOf(ctx, oc);
    if (!dict) return true;
    if (nameOf(ctx, dict.get(PDFName.of("Type"))) === "OCMD") {
      const ocgs = dict.get(PDFName.of("OCGs"));
      const list = arrOf(ctx, ocgs);
      const states = list ? Array.from({ length: list.size() }, (_, i) => ocgOn(list.get(i))) : [ocgOn(ocgs)];
      const p = nameOf(ctx, dict.get(PDFName.of("P"))) ?? "AnyOn";
      if (states.length === 0) return true;
      if (p === "AllOn") return states.every(Boolean);
      if (p === "AnyOff") return states.some((s) => !s);
      if (p === "AllOff") return states.every((s) => !s);
      return states.some(Boolean);
    }
    return ocgOn(oc);
  };
}

function contentBytes(ctx: PDFContext, contents: PDFObject | undefined): Uint8Array {
  const v = contents instanceof PDFRef ? ctx.lookup(contents) : contents;
  const parts: Uint8Array[] = [];
  const push = (o: PDFObject | undefined) => {
    const s = o instanceof PDFRef ? ctx.lookup(o) : o;
    if (s instanceof PDFRawStream) parts.push(decodePDFRawStream(s).decode());
  };
  if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) push(v.get(i));
  else push(v);
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
    out[at++] = 0x0a;
  }
  return out;
}

const num = (t: Tok | undefined) => (t && t.t === "num" ? t.v : 0);

class PageScanner {
  readonly glyphs: Glyph[] = [];
  readonly fills: Fill[] = [];
  readonly images: Img[] = [];
  private seq = 0;
  private ops = 0;
  private textOps = 0;
  private readonly ctx: PDFContext;
  private readonly visible: Visibility;
  private readonly settings: P7Settings;
  private readonly fontCache = new Map<PDFDict, FontInfo>();

  constructor(ctx: PDFContext, visible: Visibility, settings: P7Settings) {
    this.ctx = ctx;
    this.visible = visible;
    this.settings = settings;
  }

  run(data: Uint8Array, resources: PDFDict | null, gs: GState, hiddenDepth: boolean, depth: number, forms: Set<PDFObject>) {
    const ctx = this.ctx;
    const stack: GState[] = [];
    let g: GState = { ...gs };
    // マーク付きの中身の入れ子：それぞれ「表示しないレイヤーか」
    const marks: boolean[] = [];
    const isHidden = () => hiddenDepth || marks.some(Boolean);
    let path: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> | null = null;
    let pendingClip = false;
    let tm: M = IDENTITY;
    let tlm: M = IDENTITY;

    const res = (cat: string, name: string): PDFObject | undefined => {
      const d = resources ? dictOf(ctx, resources.get(PDFName.of(cat))) : null;
      return d ? d.get(PDFName.of(name)) : undefined;
    };
    const pt = (x: number, y: number) => apply(g.ctm, x, y);
    const startSub = (p: [number, number]) => {
      cur = [p];
      path.push(cur);
    };
    const lineTo = (p: [number, number]) => {
      if (!cur) startSub(p);
      else cur.push(p);
    };
    const endPath = () => {
      path = [];
      cur = null;
      pendingClip = false;
    };
    const paintFill = () => {
      const polys = path.filter((p) => p.length >= 2);
      if (pendingClip && polys.length) g.clip = intersect(g.clip, boxOf(polys.flat()));
      if (polys.length) {
        const box = boxOf(polys.flat());
        const filled = polys.reduce((s, p) => s + polygonArea(p), 0);
        this.fills.push({
          seq: this.seq++,
          box,
          polys,
          lum: g.fill,
          alpha: g.ca,
          normal: g.normal,
          rectangular: area(box) > 0 && filled / area(box) >= this.settings.rectangularFillMin,
        });
      }
      endPath();
    };
    const setSpace = (name: string): Space => {
      if (name === "DeviceGray" || name === "G" || name === "CalGray") return { kind: "gray", n: 1 };
      if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return { kind: "rgb", n: 3 };
      if (name === "DeviceCMYK" || name === "CMYK") return { kind: "cmyk", n: 4 };
      const o = res("ColorSpace", name);
      const v = o instanceof PDFRef ? ctx.lookup(o) : o;
      if (v instanceof PDFName) return setSpace(v.decodeText());
      if (v instanceof PDFArray && v.size() >= 1) {
        const fam = nameOf(ctx, v.get(0));
        if (fam === "ICCBased") {
          const st = ctx.lookup(v.get(1));
          const n = st instanceof PDFStream ? numOf(ctx, st.dict.get(PDFName.of("N"))) : null;
          if (n === 1) return { kind: "gray", n: 1 };
          if (n === 3) return { kind: "rgb", n: 3 };
          if (n === 4) return { kind: "cmyk", n: 4 };
        }
        if (fam === "CalGray") return { kind: "gray", n: 1 };
        if (fam === "CalRGB") return { kind: "rgb", n: 3 };
      }
      return { kind: "unknown" };
    };
    const initialColor = (s: Space): number | null => (s.kind === "unknown" ? null : luminance(s, s.kind === "cmyk" ? [0, 0, 0, 1] : [0, 0, 0]));

    const showText = (bytes: Uint8Array, opNo: number) => {
      const f = g.font;
      if (!f) return;
      for (const gl of f.decode(bytes)) {
        const w0 = gl.width;
        const trm = mul([g.size * g.th, 0, 0, g.size, 0, g.rise], mul(tm, g.ctm));
        const corners: Array<[number, number]> = [
          apply(trm, 0, f.descent),
          apply(trm, w0, f.descent),
          apply(trm, 0, f.ascent),
          apply(trm, w0, f.ascent),
        ];
        const rect = boxOf(corners);
        const [bx, by] = apply(trm, 0, f.descent);
        const [tx, ty] = apply(trm, 0, f.ascent);
        const height = Math.hypot(tx - bx, ty - by);
        const isSpace = gl.isSpace;
        const strokeMode = g.mode === 1 || g.mode === 5;
        this.glyphs.push({
          seq: this.seq++,
          op: opNo,
          rect,
          height,
          isSpace,
          text: gl.text,
          hidden: isHidden(),
          clip: g.clip,
          mode: g.mode,
          alpha: strokeMode ? g.CA : g.ca,
          lum: strokeMode ? g.stroke : g.fill,
        });
        const adv = (w0 * g.size + g.tc + (gl.isWordSpace ? g.tw : 0)) * g.th;
        tm = mul([1, 0, 0, 1, adv, 0], tm);
      }
    };

    for (const { op, args } of operations(data)) {
      if (++this.ops > this.settings.maxOperations) throw new TooManyOperations();
      switch (op) {
        case "q":
          stack.push({ ...g });
          break;
        case "Q":
          if (stack.length) g = stack.pop()!;
          break;
        case "cm":
          g.ctm = mul(args.map(num) as M, g.ctm);
          break;
        case "gs": {
          const name = args[0]?.t === "name" ? args[0].v : "";
          const egs = dictOf(ctx, res("ExtGState", name));
          if (egs) {
            const ca = numOf(ctx, egs.get(PDFName.of("ca")));
            const CA = numOf(ctx, egs.get(PDFName.of("CA")));
            if (ca !== null) g.ca = ca;
            if (CA !== null) g.CA = CA;
            const bm = egs.get(PDFName.of("BM"));
            if (bm) {
              const arr = arrOf(ctx, bm);
              const first = arr ? nameOf(ctx, arr.get(0)) : nameOf(ctx, bm);
              g.normal = first === "Normal" || first === "Compatible";
            }
          }
          break;
        }
        // 色
        case "g": g.fillSpace = { kind: "gray", n: 1 }; g.fill = luminance(g.fillSpace, args.map(num)); break;
        case "G": g.strokeSpace = { kind: "gray", n: 1 }; g.stroke = luminance(g.strokeSpace, args.map(num)); break;
        case "rg": g.fillSpace = { kind: "rgb", n: 3 }; g.fill = luminance(g.fillSpace, args.map(num)); break;
        case "RG": g.strokeSpace = { kind: "rgb", n: 3 }; g.stroke = luminance(g.strokeSpace, args.map(num)); break;
        case "k": g.fillSpace = { kind: "cmyk", n: 4 }; g.fill = luminance(g.fillSpace, args.map(num)); break;
        case "K": g.strokeSpace = { kind: "cmyk", n: 4 }; g.stroke = luminance(g.strokeSpace, args.map(num)); break;
        case "cs": g.fillSpace = setSpace(args[0]?.t === "name" ? args[0].v : ""); g.fill = initialColor(g.fillSpace); break;
        case "CS": g.strokeSpace = setSpace(args[0]?.t === "name" ? args[0].v : ""); g.stroke = initialColor(g.strokeSpace); break;
        case "sc":
        case "scn":
          g.fill = args.some((a) => a.t === "name") ? null : luminance(g.fillSpace, args.map(num));
          break;
        case "SC":
        case "SCN":
          g.stroke = args.some((a) => a.t === "name") ? null : luminance(g.strokeSpace, args.map(num));
          break;
        // 道
        case "m": startSub(pt(num(args[0]), num(args[1]))); break;
        case "l": lineTo(pt(num(args[0]), num(args[1]))); break;
        case "c":
        case "v":
        case "y": {
          // cur は startSub・lineTo の中でも書き換わる。型の上では null に絞られてしまうので、型を戻して読む
          const sub = cur as Array<[number, number]> | null;
          const last = sub?.[sub.length - 1];
          if (!last) break;
          const inv = args.map(num);
          // 曲線は4つの直線に分ける（目安）
          const p0 = last;
          let p1: [number, number], p2: [number, number], p3: [number, number];
          if (op === "c") { p1 = pt(inv[0]!, inv[1]!); p2 = pt(inv[2]!, inv[3]!); p3 = pt(inv[4]!, inv[5]!); }
          else if (op === "v") { p1 = p0; p2 = pt(inv[0]!, inv[1]!); p3 = pt(inv[2]!, inv[3]!); }
          else { p1 = pt(inv[0]!, inv[1]!); p2 = pt(inv[2]!, inv[3]!); p3 = p2; }
          for (const t of [0.25, 0.5, 0.75, 1]) {
            const u = 1 - t;
            lineTo([
              u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
              u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
            ]);
          }
          break;
        }
        case "re": {
          const [x, y, w, h] = args.map(num) as [number, number, number, number];
          startSub(pt(x, y));
          lineTo(pt(x + w, y));
          lineTo(pt(x + w, y + h));
          lineTo(pt(x, y + h));
          cur = null;
          break;
        }
        case "h": cur = null; break;
        case "W":
        case "W*": pendingClip = true; break;
        case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*":
          paintFill();
          break;
        case "S": case "s": case "n": {
          if (pendingClip) {
            const polys = path.filter((p) => p.length >= 1);
            if (polys.length) g.clip = intersect(g.clip, boxOf(polys.flat()));
          }
          endPath();
          break;
        }
        // 字
        case "BT": tm = IDENTITY; tlm = IDENTITY; break;
        case "ET": break;
        case "Tf": {
          const name = args[0]?.t === "name" ? args[0].v : "";
          const fd = dictOf(ctx, res("Font", name));
          if (fd) {
            let fi = this.fontCache.get(fd);
            if (!fi) {
              fi = readFont(ctx, fd);
              this.fontCache.set(fd, fi);
            }
            g.font = fi;
          } else g.font = null;
          g.size = num(args[1]);
          break;
        }
        case "Tc": g.tc = num(args[0]); break;
        case "Tw": g.tw = num(args[0]); break;
        case "Tz": g.th = num(args[0]) / 100; break;
        case "TL": g.tl = num(args[0]); break;
        case "Ts": g.rise = num(args[0]); break;
        case "Tr": g.mode = num(args[0]); break;
        case "Td": tlm = mul([1, 0, 0, 1, num(args[0]), num(args[1])], tlm); tm = tlm; break;
        case "TD": g.tl = -num(args[1]); tlm = mul([1, 0, 0, 1, num(args[0]), num(args[1])], tlm); tm = tlm; break;
        case "Tm": tlm = args.map(num) as M; tm = tlm; break;
        case "T*": tlm = mul([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm; break;
        case "Tj": if (args[0]?.t === "str") showText(args[0].v, this.textOps++); break;
        case "'":
          tlm = mul([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm;
          if (args[0]?.t === "str") showText(args[0].v, this.textOps++);
          break;
        case '"':
          g.tw = num(args[0]); g.tc = num(args[1]);
          tlm = mul([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm;
          if (args[2]?.t === "str") showText(args[2].v, this.textOps++);
          break;
        case "TJ": {
          // TJ 全体を1つの命令として数える（まとめる単位）
          const arr = args[0]?.t === "arr" ? args[0].v : [];
          const opNo = this.textOps++;
          for (const el of arr) {
            if (el.t === "str") showText(el.v, opNo);
            else if (el.t === "num") tm = mul([1, 0, 0, 1, (-el.v / 1000) * g.size * g.th, 0], tm);
          }
          break;
        }
        // 画像と部品
        case "BI":
          this.images.push({ seq: this.seq++, box: boxOf([pt(0, 0), pt(1, 0), pt(0, 1), pt(1, 1)]) });
          break;
        case "Do": {
          const name = args[0]?.t === "name" ? args[0].v : "";
          const raw = res("XObject", name);
          const xo = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
          if (!(xo instanceof PDFStream)) break;
          const st = nameOf(ctx, xo.dict.get(PDFName.of("Subtype")));
          if (st === "Image") {
            this.images.push({ seq: this.seq++, box: boxOf([pt(0, 0), pt(1, 0), pt(0, 1), pt(1, 1)]) });
          } else if (st === "Form" && xo instanceof PDFRawStream) {
            if (depth >= this.settings.maxFormDepth || forms.has(xo)) break;
            const fm = arrOf(ctx, xo.dict.get(PDFName.of("Matrix")));
            const m: M = fm && fm.size() === 6 ? (Array.from({ length: 6 }, (_, i) => numOf(ctx, fm.get(i)) ?? 0) as M) : IDENTITY;
            const inner: GState = { ...g, ctm: mul(m, g.ctm) };
            const bb = arrOf(ctx, xo.dict.get(PDFName.of("BBox")));
            if (bb && bb.size() === 4) {
              const [x0, y0, x1, y1] = Array.from({ length: 4 }, (_, i) => numOf(ctx, bb.get(i)) ?? 0) as [number, number, number, number];
              inner.clip = intersect(g.clip, boxOf([apply(inner.ctm, x0, y0), apply(inner.ctm, x1, y0), apply(inner.ctm, x0, y1), apply(inner.ctm, x1, y1)]));
            }
            const formHidden = isHidden() || !this.visible(xo.dict.get(PDFName.of("OC")));
            const fres = dictOf(ctx, xo.dict.get(PDFName.of("Resources"))) ?? resources;
            let data2: Uint8Array;
            try {
              data2 = decodePDFRawStream(xo).decode();
            } catch {
              break;
            }
            forms.add(xo);
            this.run(data2, fres, inner, formHidden, depth + 1, forms);
            forms.delete(xo);
          }
          break;
        }
        // マーク付きの中身（レイヤー）
        case "BMC":
          marks.push(false);
          break;
        case "BDC": {
          let hide = false;
          if (args[0]?.t === "name" && args[0].v === "OC") {
            const p = args[1];
            if (p?.t === "name") hide = !this.visible(res("Properties", p.v));
          }
          marks.push(hide);
          break;
        }
        case "EMC":
          marks.pop();
          break;
        default:
          break;
      }
    }
  }
}

// ---------------------------------------------------------------- 判定

type Judged = { reason: P7Reason } | { excluded: "p6" | "ocr" } | null;

function judge(gl: Glyph, view: Rect, fills: Fill[], images: Img[], s: P7Settings): Judged {
  const a = area(gl.rect);
  const outside = (box: Rect) => (a > 0 ? 1 - interArea(gl.rect, box) / a : inRect(box, gl.rect[0], gl.rect[1]) ? 0 : 1);
  if (gl.hidden) return { reason: "hidden_layer" };
  if (outside(view) >= s.outsideFraction) return { reason: "off_page" };
  if (outside(gl.clip) >= s.outsideFraction) return { reason: "clipped" };
  const cx = (gl.rect[0] + gl.rect[2]) / 2;
  const cy = (gl.rect[1] + gl.rect[3]) / 2;
  if (gl.mode === 3 || gl.mode === 7 || gl.alpha < s.invisibleAlphaBelow) {
    // 画像と重なる見えない字は、描く順番に関係なく文字認識の層（PR #22 の返事の 4）
    if (images.some((im) => inRect(im.box, cx, cy))) return { excluded: "ocr" };
    return { reason: "invisible" };
  }
  if (gl.height < s.tinyHeightBelowPt) return { reason: "tiny" };
  // 字のあとに重ねた、不透明で四角に近い塗り
  if (a > 0) {
    for (const f of fills) {
      if (f.seq < gl.seq || !f.normal || f.alpha < s.coverAlphaMin || !f.rectangular || f.lum === null) continue;
      if (interArea(gl.rect, f.box) / a < s.coveredFractionMin) continue;
      return f.lum <= s.darkLuminanceMaxForP6 ? { excluded: "p6" } : { reason: "covered_light" };
    }
  }
  // 下の色：字より前に描いた、いちばん上の不透明な塗りか画像。なければページの白
  if (gl.lum === null) return null;
  let under: { seq: number; lum: number | null } = { seq: -1, lum: 1 };
  for (const f of fills) {
    if (f.seq > gl.seq || f.seq < under.seq || !f.normal || f.alpha < s.coverAlphaMin) continue;
    if (!inRect(f.box, cx, cy) || !inShape(f.polys, cx, cy)) continue;
    under = { seq: f.seq, lum: f.lum };
  }
  for (const im of images) {
    if (im.seq > gl.seq || im.seq < under.seq || !inRect(im.box, cx, cy)) continue;
    under = { seq: im.seq, lum: null }; // 画像の色は見ない（決められないので、same_color にしない）
  }
  if (under.lum === null) return null;
  return Math.abs(gl.lum - under.lum) < s.sameColorDeltaBelow ? { reason: "same_color" } : null;
}

// ---------------------------------------------------------------- 本体

export async function detectP7Hidden(bytes: Uint8Array, options: DetectOptions = {}): Promise<P7Report> {
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const base: P7Report = {
    rule: { id: RULE_ID, version: RULE_VERSION },
    status: "ok",
    pages: null,
    findings: [],
    skippedPages: [],
    excluded: { p6: 0, ocrLayer: 0 },
  };
  if (bytes.length === 0) return { ...base, status: "error", error: { code: "empty", message: "ファイルが空です。" } };
  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") {
    if (loaded.code === "encrypted") {
      const message = loaded.reason === "password_required" ? "パスワードが要る PDF は、調べられません。" : "この形の暗号化は、いまは調べられません。";
      return { ...base, status: "error", error: { code: "encrypted", message } };
    }
    return { ...base, status: "error", error: { code: "unreadable", message: "PDF として読めませんでした。" } };
  }
  const doc = loaded.doc;
  const ctx = doc.context;
  let pages;
  try {
    pages = doc.getPages();
  } catch {
    return { ...base, status: "error", error: { code: "unreadable", message: "ページの並びを読めませんでした。" } };
  }
  const report: P7Report = { ...base, pages: pages.length, findings: [], skippedPages: [], excluded: { p6: 0, ocrLayer: 0 } };
  if (loaded.decrypted) report.decrypted = loaded.decrypted;
  const visible = makeVisibility(ctx, doc.catalog);

  pages.forEach((page, index) => {
    const pageNo = index + 1;
    try {
      const mb = page.getMediaBox();
      const cb = page.getCropBox();
      const view = intersect([mb.x, mb.y, mb.x + mb.width, mb.y + mb.height], [cb.x, cb.y, cb.x + cb.width, cb.y + cb.height]);
      const scanner = new PageScanner(ctx, visible, settings);
      const gs: GState = {
        ctm: IDENTITY, clip: [-Infinity, -Infinity, Infinity, Infinity], fillSpace: { kind: "gray", n: 1 }, strokeSpace: { kind: "gray", n: 1 },
        fill: 0, stroke: 0, ca: 1, CA: 1, normal: true, font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, mode: 0,
      };
      scanner.run(contentBytes(ctx, page.node.get(PDFName.of("Contents"))), page.node.Resources() ?? null, gs, false, 0, new Set());

      // 1字ごとに理由を決め、同じ命令の中で同じ理由で続く字を1件にまとめる
      let group: { op: number; reason: P7Reason; rect: Rect; chars: number; text: string } | null = null;
      const flush = () => {
        if (group && group.chars > 0) {
          const f: P7Finding = { pattern: "P7", page: pageNo, reason: group.reason, rect: group.rect, chars: group.chars };
          if (options.includeText) f.text = group.text;
          report.findings.push(f);
        }
        group = null;
      };
      for (const gl of scanner.glyphs) {
        const j = judge(gl, view, scanner.fills, scanner.images, settings);
        if (j === null || "excluded" in j) {
          if (j && !gl.isSpace) {
            if (j.excluded === "p6") report.excluded.p6++;
            else report.excluded.ocrLayer++;
          }
          flush();
          continue;
        }
        if (group && (group as { op: number }).op === gl.op && (group as { reason: P7Reason }).reason === j.reason) {
          const g2 = group as { rect: Rect; chars: number; text: string };
          g2.rect = union(g2.rect, gl.rect);
          g2.text += gl.text;
          if (!gl.isSpace) g2.chars++;
        } else {
          flush();
          group = { op: gl.op, reason: j.reason, rect: gl.rect, chars: gl.isSpace ? 0 : 1, text: gl.text };
        }
      }
      flush();
    } catch (e) {
      report.skippedPages.push({ page: pageNo, reason: e instanceof TooManyOperations ? "too_many_operations" : "unreadable_page" });
    }
  });
  return report;
}

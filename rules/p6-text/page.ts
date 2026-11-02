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
  isFiniteMatrix,
  multiply,
  polygonArea,
  scaleOf,
  type Matrix,
  type Point,
  type Rect,
} from "./geometry.ts";
import { readFont, type FontInfo } from "./fonts.ts";
import { operations, type Operand } from "./lexer.ts";
import type { P6TextSettings } from "./settings.ts";

export type Cover = { seq: number; rect: Rect; how: "fill" | "stroke"; luminance: number };
export type GlyphBox = { seq: number; rect: Rect; isSpace: boolean; text: string };
export type PageScan = { covers: Cover[]; glyphs: GlyphBox[]; operations: number };

export class TooManyOperations extends Error {}

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

export function scanPage(
  ctx: PDFContext,
  content: Uint8Array,
  resources: PDFDict | undefined,
  settings: P6TextSettings,
): PageScan {
  const covers: Cover[] = [];
  const glyphs: GlyphBox[] = [];
  let seq = 0;
  let opCount = 0;
  const fontCache = new Map<PDFObject, FontInfo>();

  const run = (data: Uint8Array, res: PDFDict | undefined, start: GState, depth: number, seen: Set<PDFObject>) => {
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

    const paint = (doFill: boolean, doStroke: boolean) => {
      if (!isFiniteMatrix(gs.ctm)) return;
      for (const sp of subpaths) {
        if (sp.points.length < 2) continue;
        const dev = sp.points.map(([x, y]) => apply(gs.ctm, x, y));
        if (doFill && !sp.curved && sp.points.length >= 3) {
          const lum = gs.fill.luminance;
          if (lum !== null && lum <= settings.darkLuminanceMax && gs.fillAlpha >= settings.opacityMin) {
            const box = boundsOf(dev);
            const boxArea = area(box);
            // 四角に近い図形だけ（外枠の箱をほぼ埋めるもの）
            if (boxArea > 0 && polygonArea(dev) / boxArea >= settings.rectangularityMin) {
              covers.push({ seq: ++seq, rect: box, how: "fill", luminance: lum });
            }
          }
        }
        if (doStroke && !sp.curved) {
          const lum = gs.stroke.luminance;
          if (lum !== null && lum <= settings.darkLuminanceMax && gs.strokeAlpha >= settings.opacityMin) {
            const half = (gs.lineWidth * scaleOf(gs.ctm)) / 2;
            const pts = sp.closed ? [...dev, dev[0]!] : dev;
            for (let k = 0; k + 1 < pts.length; k++) {
              const [x0, y0] = pts[k]!;
              const [x1, y1] = pts[k + 1]!;
              // 縦か横の直線だけを覆いとして扱う（斜めの線は外枠の箱が大きくなりすぎるため）
              const horizontal = Math.abs(y1 - y0) <= 0.01 * Math.max(1, Math.abs(x1 - x0));
              const vertical = Math.abs(x1 - x0) <= 0.01 * Math.max(1, Math.abs(y1 - y0));
              if (!horizontal && !vertical) continue;
              const r: Rect = horizontal
                ? [Math.min(x0, x1), y0 - half, Math.max(x0, x1), y0 + half]
                : [x0 - half, Math.min(y0, y1), x0 + half, Math.max(y0, y1)];
              if (area(r) > 0) covers.push({ seq: ++seq, rect: r, how: "stroke", luminance: lum });
            }
          }
        }
      }
      subpaths = [];
      current = null;
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
          glyphs.push({ seq: ++seq, rect: boundsOf(corners), isSpace: g.isSpace, text: g.text });
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
          if (a.length >= 4) {
            if (!current) startSub(a[a.length - 2]!, a[a.length - 1]!);
            const cur = current as unknown as { points: Point[]; curved: boolean };
            cur.curved = true;
            cur.points.push([a[a.length - 2]!, a[a.length - 1]!]);
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
        case "f*":
          paint(true, false);
          break;
        case "S":
          paint(false, true);
          break;
        case "s":
          if (current) (current as { closed: boolean }).closed = true;
          paint(false, true);
          break;
        case "B":
        case "B*":
          paint(true, true);
          break;
        case "b":
        case "b*":
          if (current) (current as { closed: boolean }).closed = true;
          paint(true, true);
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
          if (!(sub instanceof PDFName) || sub.decodeText() !== "Form") break; // 画像は、この版では覆いとして数えない
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
          run(data2, subRes, inner, depth + 1, nextSeen);
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
  run(content, resources, initial, 0, new Set());
  return { covers, glyphs, operations: opCount };
}

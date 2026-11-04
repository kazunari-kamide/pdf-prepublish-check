// SPDX-License-Identifier: AGPL-3.0-only
//
// 個人情報らしい字を探すための、字の取り出し（rules/pii）。
// ページの中身（描く命令の列）を順に読み、1字ごとに「字の中身」と「箱」と「進む向き」を集める。図形は組み立てない（CLAUDE.md §5）。
// - 字の中身は、書体の ToUnicode（rules/shared/fonts.ts）から引く。引けない字は数だけ数える（中身が分からないので探せない）。
// - 縦書き：書体の CMap の名前が -V で終わるか、CMap の /WMode が 1 のとき、字を下へ進める（既定の縦の寸法 [880 −1000] を使う）。
// - 描き方（白い字・見えない字など）は区別しない。見えない字は P7 の範囲だが、文字認識の層（スキャンの上の見えない字）は
//   見えている紙の字と同じ中身なので、ここでは全部の字を対象にする。
// - 部品（Form XObject）の中も、入れ子の上限まで読む。注釈の中の字は読まない（P8 の範囲）。

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFContext, type PDFObject } from "pdf-lib";
import { arrArg, bytesArg, nameArg, numArg, operations, type Tok } from "../shared/content-lexer.ts";
import { readFont, type FontInfo } from "../shared/fonts.ts";

export type Rect = [number, number, number, number];
type Matrix = [number, number, number, number, number, number];

/** 字の進む向き。h＝右へ（ふつうの横書き）、v＝下へ（ふつうの縦書き）、hl＝左へ、vu＝上へ（回したページなど） */
export type Direction = "h" | "v" | "hl" | "vu";

export type Glyph = {
  /** 字の中身（1字。ToUnicode が2字以上を返すときは、その並び） */
  text: string;
  /** 字の箱。ページの既定の座標（ポイント、左下が原点、/Rotate はかけない） */
  rect: Rect;
  dir: Direction;
  /** 字の大きさ（ポイント。行をまとめるときの目安） */
  size: number;
};

export type ExtractSettings = {
  /** 1ページの命令の数の上限。超えたら TooManyOperations を投げる */
  maxOperations: number;
  /** 部品（Form XObject）の入れ子の上限 */
  maxFormDepth: number;
  /** 1ページから集める字の数の上限。超えた分は読まない（truncated を立てる） */
  maxGlyphs: number;
};

export class TooManyOperations extends Error {}

export type PageText = {
  glyphs: Glyph[];
  /** 中身を引けなかった字の数（ToUnicode のない書体など） */
  unreadable: number;
  /** maxGlyphs で打ち切ったか */
  truncated: boolean;
};

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const finite = (m: Matrix) => m.every((v) => Number.isFinite(v));

function lookup(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}
function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = lookup(ctx, o);
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

/** ストリームの中身（ほどけないものは空） */
export function streamData(ctx: PDFContext, o: PDFObject | undefined): Uint8Array {
  const v = lookup(ctx, o);
  try {
    if (v instanceof PDFRawStream) return decodePDFRawStream(v).decode();
    if (v instanceof PDFStream) return v.getContents();
  } catch {
    return new Uint8Array();
  }
  return new Uint8Array();
}

/** ページの /Contents（1つのストリームか、ストリームの配列）をつないだもの */
export function pageContent(ctx: PDFContext, contents: PDFObject | undefined): Uint8Array {
  const v = lookup(ctx, contents);
  const parts: Uint8Array[] = [];
  if (v instanceof PDFArray) for (const o of v.asArray()) parts.push(streamData(ctx, o), new Uint8Array([0x0a]));
  else parts.push(streamData(ctx, v));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 書体が縦書きか（CMap の名前が -V で終わる、または CMap の /WMode が 1） */
function isVertical(ctx: PDFContext, fontObj: PDFObject | undefined): boolean {
  const font = dictOf(ctx, fontObj);
  if (!font) return false;
  const enc = lookup(ctx, font.get(PDFName.of("Encoding")));
  if (enc instanceof PDFName) return /-V$/.test(enc.decodeText());
  if (enc instanceof PDFStream) {
    const w = lookup(ctx, enc.dict.get(PDFName.of("WMode")));
    if (w instanceof PDFNumber) return w.asNumber() === 1;
    const n = lookup(ctx, enc.dict.get(PDFName.of("CMapName")));
    return n instanceof PDFName && /-V$/.test(n.decodeText());
  }
  return false;
}

type FontEntry = { info: FontInfo; vertical: boolean };

type TextState = { font: FontEntry | null; size: number; tc: number; tw: number; th: number; tl: number; rise: number };

type GState = { ctm: Matrix; text: TextState };

/**
 * 1つのページ（または部品）の字を集める。
 * resources は、その中身の資源の辞書（/Font・/XObject を引く）。
 */
export function extractText(ctx: PDFContext, content: Uint8Array, resources: PDFDict | undefined, settings: ExtractSettings): PageText {
  const out: PageText = { glyphs: [], unreadable: 0, truncated: false };
  const fontCache = new Map<PDFObject, FontEntry>();
  let ops = 0;

  const fontFor = (res: PDFDict | undefined, name: string): FontEntry | null => {
    const fonts = dictOf(ctx, res?.get(PDFName.of("Font")));
    const raw = fonts?.get(PDFName.of(name));
    if (!raw) return null;
    const key = raw;
    let e = fontCache.get(key);
    if (!e) {
      e = { info: readFont(ctx, raw), vertical: isVertical(ctx, raw) };
      fontCache.set(key, e);
    }
    return e;
  };

  const walk = (data: Uint8Array, res: PDFDict | undefined, base: Matrix, depth: number, seen: Set<PDFObject>) => {
    let gs: GState = { ctm: base, text: { font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 } };
    const stack: GState[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;

    const show = (bytes: Uint8Array, adjust?: number) => {
      const t = gs.text;
      const f = t.font;
      if (adjust !== undefined) {
        // TJ の数（1000 分の 1 em）。横は左へ、縦は下へずらす
        const d = (-adjust / 1000) * t.size;
        tm = f?.vertical ? mul([1, 0, 0, 1, 0, d], tm) : mul([1, 0, 0, 1, d * t.th, 0], tm);
        return;
      }
      if (!f) return;
      for (const g of f.info.decode(bytes)) {
        const trm = mul([t.size * t.th, 0, 0, t.size, 0, t.rise], mul(tm, gs.ctm));
        if (!finite(trm)) return;
        let corners: Array<[number, number]>;
        let adv: [number, number];
        if (f.vertical) {
          // 縦：原点を上の中央に置いた、幅 w・高さ 1em の箱
          const w = g.width > 0 ? g.width : 1;
          corners = [apply(trm, -w / 2, -1), apply(trm, w / 2, -1), apply(trm, w / 2, 0), apply(trm, -w / 2, 0)];
          adv = apply(trm, 0, -1);
          const o = apply(trm, 0, 0);
          adv = [adv[0] - o[0], adv[1] - o[1]];
          // 字の間隔（Tc・Tw）は、縦でも字を離す向き（下）にかける
          const ty = -(t.size + t.tc + (g.isWordSpace ? t.tw : 0));
          tm = mul([1, 0, 0, 1, 0, ty], tm);
        } else {
          corners = [apply(trm, 0, f.info.descent), apply(trm, g.width, f.info.descent), apply(trm, g.width, f.info.ascent), apply(trm, 0, f.info.ascent)];
          const o = apply(trm, 0, 0);
          const e = apply(trm, 1, 0);
          adv = [e[0] - o[0], e[1] - o[1]];
          const tx = (g.width * t.size + t.tc + (g.isWordSpace ? t.tw : 0)) * t.th;
          tm = mul([1, 0, 0, 1, tx, 0], tm);
        }
        if (g.text === "") {
          if (!g.isSpace) out.unreadable++;
          continue;
        }
        if (out.glyphs.length >= settings.maxGlyphs) {
          out.truncated = true;
          continue;
        }
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        const rect: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        const size = Math.hypot(trm[2], trm[3]) || Math.hypot(trm[0], trm[1]);
        out.glyphs.push({ text: g.text, rect, dir: directionOf(adv), size });
      }
    };

    for (const { op, args } of operations(data)) {
      if (++ops > settings.maxOperations) throw new TooManyOperations();
      switch (op) {
        case "q":
          if (stack.length < 256) stack.push({ ctm: gs.ctm, text: { ...gs.text } });
          break;
        case "Q":
          if (stack.length) gs = stack.pop()!;
          break;
        case "cm": {
          const m = args.map(numArg);
          if (m.length === 6 && m.every((v) => v !== undefined)) {
            const n = mul(m as Matrix, gs.ctm);
            if (finite(n)) gs.ctm = n;
          }
          break;
        }
        case "BT":
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case "Tf": {
          const name = nameArg(args[0]);
          const size = numArg(args[1]);
          gs.text.font = name ? fontFor(res, name) : null;
          if (size !== undefined && Number.isFinite(size)) gs.text.size = size;
          break;
        }
        case "Tc":
          gs.text.tc = numArg(args[0]) ?? gs.text.tc;
          break;
        case "Tw":
          gs.text.tw = numArg(args[0]) ?? gs.text.tw;
          break;
        case "Tz":
          gs.text.th = (numArg(args[0]) ?? 100) / 100;
          break;
        case "TL":
          gs.text.tl = numArg(args[0]) ?? gs.text.tl;
          break;
        case "Ts":
          gs.text.rise = numArg(args[0]) ?? gs.text.rise;
          break;
        case "Td":
        case "TD": {
          const x = numArg(args[0]) ?? 0;
          const y = numArg(args[1]) ?? 0;
          if (op === "TD") gs.text.tl = -y;
          tlm = mul([1, 0, 0, 1, x, y], tlm);
          tm = tlm;
          break;
        }
        case "Tm": {
          const m = args.map(numArg);
          if (m.length === 6 && m.every((v) => v !== undefined) && finite(m as Matrix)) {
            tlm = m as Matrix;
            tm = tlm;
          }
          break;
        }
        case "T*":
          tlm = mul([1, 0, 0, 1, 0, -gs.text.tl], tlm);
          tm = tlm;
          break;
        case "Tj": {
          const b = bytesArg(args[0]);
          if (b) show(b);
          break;
        }
        case "'":
        case '"': {
          if (op === '"') {
            gs.text.tw = numArg(args[0]) ?? gs.text.tw;
            gs.text.tc = numArg(args[1]) ?? gs.text.tc;
          }
          tlm = mul([1, 0, 0, 1, 0, -gs.text.tl], tlm);
          tm = tlm;
          const b = bytesArg(args[args.length - 1]);
          if (b) show(b);
          break;
        }
        case "TJ": {
          const arr = arrArg(args[0]) ?? [];
          for (const a of arr as Tok[]) {
            if (a.t === "str") show(a.v);
            else if (a.t === "num") show(new Uint8Array(), a.v);
          }
          break;
        }
        case "Do": {
          const name = nameArg(args[0]);
          if (!name || depth >= settings.maxFormDepth) break;
          const xobjs = dictOf(ctx, res?.get(PDFName.of("XObject")));
          const ref = xobjs?.get(PDFName.of(name));
          if (!ref || seen.has(ref)) break;
          const xo = lookup(ctx, ref);
          if (!(xo instanceof PDFStream)) break;
          const st = xo.dict.get(PDFName.of("Subtype"));
          if (!(st instanceof PDFName) || st.decodeText() !== "Form") break;
          const mArr = lookup(ctx, xo.dict.get(PDFName.of("Matrix")));
          let m: Matrix = IDENTITY;
          if (mArr instanceof PDFArray && mArr.size() === 6) {
            const v = mArr.asArray().map((o) => lookup(ctx, o));
            if (v.every((x) => x instanceof PDFNumber)) m = v.map((x) => (x as PDFNumber).asNumber()) as Matrix;
          }
          const subRes = dictOf(ctx, xo.dict.get(PDFName.of("Resources"))) ?? res;
          const next = new Set(seen);
          next.add(ref);
          walk(streamData(ctx, xo), subRes, mul(m, gs.ctm), depth + 1, next);
          break;
        }
        default:
          break;
      }
    }
  };

  walk(content, resources, IDENTITY, 0, new Set());
  return out;
}

/** 進む向き（ページの座標での1字ぶんの進み）から、4つの向きのどれかに分ける */
function directionOf(adv: [number, number]): Direction {
  const [x, y] = adv;
  if (Math.abs(x) >= Math.abs(y)) return x >= 0 ? "h" : "hl";
  return y <= 0 ? "v" : "vu";
}

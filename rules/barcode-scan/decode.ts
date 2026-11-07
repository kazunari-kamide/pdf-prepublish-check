// SPDX-License-Identifier: AGPL-3.0-only
//
// 黒塗りのそばの記号（barcode-scan）の、画像を解く小さな道具。
// 検査器を道具（コマンド）から動かすときは、PDF.js の画像の解き手が渡されない。実物のスキャンは JPEG か、白黒の FAX 形式（CCITT）が
// 多いので、このルールが自分で明るさだけを解く。外の部品・通信は使わない。
//   - JPEG：基本の形（ハフマン・8 ビット・順に並ぶもの）だけ。最初の成分（明るさ）だけを戻す。段階の形・算術の形・4 成分は解かない。
//   - CCITT：2 次元の形（K < 0、G4）だけ。
// 解けないときは null を返す（呼ぶ側は「調べられなかった」にする）。細工された画像の前提で、点の数の上限を見る。

import { PDFArray, PDFBool, PDFDict, PDFName, PDFNumber, PDFRawStream, type PDFContext, type PDFObject, type PDFStream } from "pdf-lib";
import type { PixelReader } from "../p6-text/images.ts";

const look = (ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined => (o ? ctx.lookup(o) : undefined);

function filterOf(ctx: PDFContext, d: PDFDict): { name: string; parms: PDFDict | undefined } | null {
  const f = look(ctx, d.get(PDFName.of("Filter")));
  const p = look(ctx, d.get(PDFName.of("DecodeParms")));
  if (f instanceof PDFName) return { name: f.decodeText(), parms: p instanceof PDFDict ? p : undefined };
  if (f instanceof PDFArray && f.size() === 1) {
    const n = look(ctx, f.get(0));
    const pp = p instanceof PDFArray ? look(ctx, p.get(0)) : p;
    if (n instanceof PDFName) return { name: n.decodeText(), parms: pp instanceof PDFDict ? pp : undefined };
  }
  return null;
}

const numIn = (ctx: PDFContext, d: PDFDict | undefined, k: string, def: number) => {
  const v = d ? look(ctx, d.get(PDFName.of(k))) : undefined;
  return v instanceof PDFNumber ? v.asNumber() : def;
};
const boolIn = (ctx: PDFContext, d: PDFDict | undefined, k: string) => {
  const v = d ? look(ctx, d.get(PDFName.of(k))) : undefined;
  return v instanceof PDFBool && v.asBoolean();
};

/** Decode が [1 0]（明るさを逆にする）か */
function decodeInverted(ctx: PDFContext, d: PDFDict): boolean {
  const a = look(ctx, d.get(PDFName.of("Decode")));
  if (!(a instanceof PDFArray) || a.size() < 2) return false;
  const x = look(ctx, a.get(0));
  const y = look(ctx, a.get(1));
  return x instanceof PDFNumber && y instanceof PDFNumber && x.asNumber() > y.asNumber();
}

/** JPEG・CCITT の画像を、明るさだけの道具にする。解けなければ null */
export function decodeScanImage(ctx: PDFContext, s: PDFStream, maxPixels: number): PixelReader | null {
  if (!(s instanceof PDFRawStream)) return null;
  const d = s.dict;
  const f = filterOf(ctx, d);
  if (!f) return null;
  const isMask = boolIn(ctx, d, "ImageMask");
  const inv = decodeInverted(ctx, d);
  try {
    if (f.name === "DCTDecode" && !isMask) {
      const j = decodeJpegLuma(s.contents, maxPixels);
      if (!j) return null;
      return { width: j.w, height: j.h, at: (x, y) => ({ lum: (inv ? 255 - j.lum[y * j.stride + x]! : j.lum[y * j.stride + x]!) / 255, alpha: 1 }) };
    }
    if (f.name === "CCITTFaxDecode") {
      const K = numIn(ctx, f.parms, "K", 0);
      if (K >= 0) return null;
      const cols = Math.floor(numIn(ctx, f.parms, "Columns", 1728));
      const w = Math.floor(numIn(ctx, d, "Width", cols));
      const h = Math.floor(numIn(ctx, d, "Height", numIn(ctx, f.parms, "Rows", 0)));
      if (!(cols > 0 && h > 0) || cols * h > maxPixels) return null;
      const black = decodeG4(s.contents, cols, h);
      if (!black) return null;
      // フィルタの出す値：黒は BlackIs1 なら 1、ちがえば 0。Decode を通したあとの値が 0 の点が暗い（型抜きなら塗る点）
      const blackIs1 = boolIn(ctx, f.parms, "BlackIs1");
      const darkWhenBlack = (blackIs1 ? 1 : 0) ^ (inv ? 1 : 0) ? false : true;
      const W = Math.min(w, cols);
      return { width: W, height: h, at: (x, y) => ({ lum: (black[y * cols + x] === 1) === darkWhenBlack ? 0 : 1, alpha: 1 }) };
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- JPEG（基本の形）

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

const COS = (() => {
  const t = new Float64Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return t;
})();

type Huff = { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; vals: Uint8Array };

function buildHuff(counts: Uint8Array, vals: Uint8Array): Huff {
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = counts[l - 1]!;
    if (n) {
      valptr[l] = k;
      mincode[l] = code;
      code += n;
      k += n;
      maxcode[l] = code - 1;
    }
    code <<= 1;
  }
  return { maxcode, valptr, mincode, vals };
}

type Comp = { id: number; h: number; v: number; tq: number; td: number; ta: number; pred: number };

export function decodeJpegLuma(data: Uint8Array, maxPixels: number): { w: number; h: number; stride: number; lum: Uint8Array } | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  const qt: Int32Array[] = [];
  const dc: Huff[] = [];
  const ac: Huff[] = [];
  let comps: Comp[] = [];
  let W = 0, H = 0, hmax = 1, vmax = 1, ri = 0;
  let plane: Uint8Array | null = null;
  let stride = 0;
  let mcusX = 0, mcusY = 0;
  let pos = 2;
  const u16 = (p: number) => (data[p]! << 8) | data[p + 1]!;

  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) {
      pos++;
      continue;
    }
    const m = data[pos + 1]!;
    if (m === 0xff) {
      pos++;
      continue;
    }
    if (m === 0xd9) break;
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      pos += 2;
      continue;
    }
    const len = u16(pos + 2);
    const seg = pos + 4;
    const end = pos + 2 + len;
    if (end > data.length) return plane ? { w: W, h: H, stride, lum: plane } : null;
    if (m === 0xdb) {
      let p = seg;
      while (p < end) {
        const pq = data[p]! >> 4, tq = data[p]! & 15;
        p++;
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          t[i] = pq ? u16(p + i * 2) : data[p + i]!;
        }
        p += pq ? 128 : 64;
        qt[tq & 3] = t;
      }
    } else if (m === 0xc4) {
      let p = seg;
      while (p < end) {
        const tc = data[p]! >> 4, th = data[p]! & 3;
        const counts = data.subarray(p + 1, p + 17);
        let n = 0;
        for (const c of counts) n += c;
        const vals = data.subarray(p + 17, p + 17 + n);
        (tc ? ac : dc)[th] = buildHuff(counts, vals);
        p += 17 + n;
      }
    } else if (m === 0xc0 || m === 0xc1) {
      if (data[seg] !== 8) return null;
      H = u16(seg + 1);
      W = u16(seg + 3);
      const n = data[seg + 5]!;
      if (!(W > 0 && H > 0) || W * H > maxPixels || n < 1 || n === 4 || n > 4) return null;
      comps = [];
      for (let i = 0; i < n; i++) {
        const b = seg + 6 + i * 3;
        comps.push({ id: data[b]!, h: Math.max(1, data[b + 1]! >> 4), v: Math.max(1, data[b + 1]! & 15), tq: data[b + 2]! & 3, td: 0, ta: 0, pred: 0 });
      }
      hmax = Math.max(...comps.map((c) => c.h));
      vmax = Math.max(...comps.map((c) => c.v));
      mcusX = Math.ceil(W / (8 * hmax));
      mcusY = Math.ceil(H / (8 * vmax));
      const c0 = comps[0]!;
      stride = mcusX * c0.h * 8;
      plane = new Uint8Array(stride * mcusY * c0.v * 8).fill(255);
    } else if ((m >= 0xc2 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return null; // 段階の形・算術の形などは解かない
    } else if (m === 0xdd) {
      ri = u16(seg);
    } else if (m === 0xda) {
      if (!plane) return null;
      const ns = data[seg]!;
      const sc: Comp[] = [];
      for (let i = 0; i < ns; i++) {
        const c = comps.find((x) => x.id === data[seg + 1 + i * 2]);
        if (!c) return null;
        c.td = data[seg + 2 + i * 2]! >> 4;
        c.ta = data[seg + 2 + i * 2]! & 15;
        sc.push(c);
      }
      pos = scan(end, sc);
      if (pos < 0) return { w: W, h: H, stride, lum: plane };
      continue;
    }
    pos = end;
  }
  return plane ? { w: W, h: H, stride, lum: plane } : null;

  function scan(start: number, sc: Comp[]): number {
    let p = start;
    let buf = 0, cnt = 0;
    const bit = () => {
      if (cnt === 0) {
        if (p >= data.length) {
          buf = 0;
        } else if (data[p] === 0xff) {
          if (data[p + 1] === 0) {
            buf = 0xff;
            p += 2;
          } else buf = 0; // 印に当たった：0 で埋める（進まない）
        } else buf = data[p++]!;
        cnt = 8;
      }
      cnt--;
      return (buf >> cnt) & 1;
    };
    const huff = (t: Huff | undefined) => {
      if (!t) throw new Error("huff");
      let code = 0;
      for (let l = 1; l <= 16; l++) {
        code = (code << 1) | bit();
        if (code <= t.maxcode[l]!) return t.vals[t.valptr[l]! + code - t.mincode[l]!] ?? 0;
      }
      return 0;
    };
    const recv = (s: number) => {
      let v = 0;
      for (let i = 0; i < s; i++) v = (v << 1) | bit();
      return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
    };
    const zz = new Float64Array(64);
    const tmp = new Float64Array(64);
    const c0 = comps[0]!;
    const block = (c: Comp, bx: number, by: number) => {
      const t = huff(dc[c.td]);
      c.pred += t ? recv(t) : 0;
      const keep = c === c0;
      if (keep) {
        zz.fill(0);
        zz[0] = c.pred * (qt[c.tq]?.[0] ?? 1);
      }
      const q = qt[c.tq];
      for (let k = 1; k < 64; ) {
        const rs = huff(ac[c.ta]);
        const r = rs >> 4, s = rs & 15;
        if (s === 0) {
          if (r !== 15) break;
          k += 16;
          continue;
        }
        k += r;
        const v = recv(s);
        if (k < 64 && keep) zz[ZIGZAG[k]!] = v * (q?.[k] ?? 1);
        k++;
      }
      if (!keep) return;
      // 逆の変換（縦、横の順）
      for (let y = 0; y < 8; y++)
        for (let u = 0; u < 8; u++) {
          let a = 0;
          for (let v = 0; v < 8; v++) a += COS[y * 8 + v]! * zz[v * 8 + u]!;
          tmp[y * 8 + u] = a;
        }
      const ox = bx * 8, oy = by * 8;
      if (ox >= stride) return;
      for (let y = 0; y < 8; y++) {
        const row = (oy + y) * stride + ox;
        if (row >= plane!.length) break;
        for (let x = 0; x < 8; x++) {
          let a = 0;
          for (let u = 0; u < 8; u++) a += COS[x * 8 + u]! * tmp[y * 8 + u]!;
          const v = Math.round(a + 128);
          plane![row + x] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    };
    for (const c of sc) c.pred = 0;
    const single = sc.length === 1;
    const total = single ? Math.ceil(Math.ceil((W * sc[0]!.h) / hmax) / 8) * Math.ceil(Math.ceil((H * sc[0]!.v) / vmax) / 8) : mcusX * mcusY;
    const perLine = single ? Math.ceil(Math.ceil((W * sc[0]!.h) / hmax) / 8) : mcusX;
    for (let n = 0; n < total; n++) {
      if (ri && n > 0 && n % ri === 0) {
        cnt = 0;
        while (p + 1 < data.length && !(data[p] === 0xff && data[p + 1]! >= 0xd0 && data[p + 1]! <= 0xd7)) p++;
        p += 2;
        for (const c of sc) c.pred = 0;
      }
      const mx = n % perLine, my = Math.floor(n / perLine);
      if (single) block(sc[0]!, mx, my);
      else for (const c of sc) for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(c, mx * c.h + h, my * c.v + v);
    }
    // 次の印まで進める
    while (p + 1 < data.length && !(data[p] === 0xff && data[p + 1] !== 0 && !(data[p + 1]! >= 0xd0 && data[p + 1]! <= 0xd7))) p++;
    return p + 1 < data.length ? p : -1;
  }
}

// ---------------------------------------------------------------- CCITT（G4）

const WT = "00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100";
const WM = "11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011";
const BT = "0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111";
const BM = "0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101";
const XM = "00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111";

function runTable(term: string, makeup: string): Map<number, number> {
  const t = new Map<number, number>();
  const add = (code: string, run: number) => t.set(code.length * 65536 + parseInt(code, 2), run);
  term.split(" ").forEach((c, i) => add(c, i));
  makeup.split(" ").forEach((c, i) => add(c, (i + 1) * 64));
  XM.split(" ").forEach((c, i) => add(c, 1792 + i * 64));
  return t;
}
let tables: { w: Map<number, number>; b: Map<number, number> } | null = null;

/** G4 を解く。戻りは 1 点 1 バイト（1＝黒）。解けなければ null */
export function decodeG4(data: Uint8Array, cols: number, rows: number): Uint8Array | null {
  tables ??= { w: runTable(WT, WM), b: runTable(BT, BM) };
  const out = new Uint8Array(cols * rows);
  let bp = 0;
  const total = data.length * 8;
  const bit = () => (bp < total ? (data[bp >> 3]! >> (7 - (bp++ & 7))) & 1 : (bp++, 0));
  const run = (black: boolean) => {
    const t = black ? tables!.b : tables!.w;
    let sum = 0;
    for (;;) {
      let code = 0;
      let got = -1;
      for (let l = 1; l <= 13; l++) {
        code = (code << 1) | bit();
        const r = t.get(l * 65536 + code);
        if (r !== undefined) {
          got = r;
          break;
        }
      }
      if (got < 0) return -1;
      sum += got;
      if (got < 64) return sum;
    }
  };
  let ref: number[] = [cols, cols];
  for (let y = 0; y < rows; y++) {
    const cur: number[] = [];
    let a0 = -1;
    let black = false;
    let ri = 0;
    while (a0 < cols) {
      // b1：a0 より右で、今の色と逆に変わる所（偶数番目＝白→黒）
      ri = Math.max(0, ri - 2);
      while (ri < ref.length && (ref[ri]! <= a0 || (ri & 1) !== (black ? 1 : 0))) ri++;
      const b1 = ri < ref.length ? ref[ri]! : cols;
      const b2 = ri + 1 < ref.length ? ref[ri + 1]! : cols;
      if (bp > total + 64) return y > 0 ? out : null;
      let mode = -1; // 0 pass, 1 horizontal, 2 vertical
      let dv = 0;
      if (bit()) {
        mode = 2;
      } else if (bit()) {
        mode = 2;
        dv = bit() ? 1 : -1;
      } else if (bit()) {
        mode = 1;
      } else if (bit()) {
        mode = 0;
      } else if (bit()) {
        mode = 2;
        dv = bit() ? 2 : -2;
      } else if (bit()) {
        mode = 2;
        dv = bit() ? 3 : -3;
      } else {
        return y > 0 ? out : null; // 終わりの印（EOFB）か、解けない形
      }
      if (mode === 0) {
        a0 = b2;
      } else if (mode === 1) {
        const s = Math.max(0, a0);
        const r1 = run(black);
        const r2 = run(!black);
        if (r1 < 0 || r2 < 0) return y > 0 ? out : null;
        const a1 = Math.min(cols, s + r1);
        const a2 = Math.min(cols, a1 + r2);
        cur.push(a1, a2);
        a0 = a2;
      } else {
        const a1 = Math.max(0, Math.min(cols, b1 + dv));
        cur.push(a1);
        a0 = a1;
        black = !black;
      }
    }
    for (let i = 0; i < cur.length; i += 2) {
      const s = cur[i]!;
      const e = i + 1 < cur.length ? cur[i + 1]! : cols;
      out.fill(1, y * cols + s, y * cols + Math.max(s, e));
    }
    ref = [...cur, cols, cols];
  }
  return out;
}

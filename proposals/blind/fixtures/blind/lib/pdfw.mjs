// SPDX-License-Identifier: AGPL-3.0-only
//
// 見ないで作るテスト集（blind）のための、小さな PDF の書き手。
// 型の説明だけから合成 PDF を作るため、ほかの道具・ほかの fixtures の作り方には頼らず、
// バイト列を一から組み立てる（増分更新・オブジェクトストリーム・暗号化の形を、思いどおりに決めるため）。
// 中身はすべて架空。

import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

export const A4 = [0, 0, 595, 842];

/** PDF の文字列（リテラル）。ASCII だけを想定し、かっこと \ を逃がす */
export function lit(s) {
  return "(" + String(s).replace(/[\\()]/g, (c) => "\\" + c) + ")";
}

/** UTF-16BE（BOM つき）の16進の文字列 */
export function u16(s) {
  let h = "FEFF";
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      h += hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
    } else h += hex4(cp);
  }
  return "<" + h + ">";
}

/** バイト列を16進の文字列に */
export function hexStr(bytes) {
  return "<" + Buffer.from(bytes).toString("hex").toUpperCase() + ">";
}

export function hex4(n) {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

/** ストリームの体。dict は "<< ... >>" の中身（/Length は自動で足す） */
export function stream(dict, data, { flate = false } = {}) {
  let buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
  let d = dict || "";
  if (flate) {
    buf = deflateSync(buf);
    d = "/Filter /FlateDecode " + d;
  }
  return { dict: d, data: buf };
}

/** 文字の命令（Helvetica /F1） */
export function text(x, y, size, s, { font = "F1", pre = "", tr = null } = {}) {
  return `BT /${font} ${size} Tf ${tr !== null ? tr + " Tr " : ""}${pre}${x} ${y} Td ${lit(s)} Tj ET\n`;
}

/** 塗った四角 */
export function rect(x, y, w, h, color = "0 g") {
  return `q ${color} ${x} ${y} ${w} ${h} re f Q\n`;
}

export const HELV = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/**
 * オブジェクトの入れ物。番号は 1 から。体は文字列か stream()。
 */
export class Pdf {
  constructor() {
    this.objs = [];
  }
  alloc() {
    this.objs.push(null);
    return this.objs.length;
  }
  add(body) {
    const n = this.alloc();
    this.objs[n - 1] = body;
    return n;
  }
  set(n, body) {
    this.objs[n - 1] = body;
  }
}

/** 日本語の字（CID・Identity-H/V）。使った字を数え、最後に書体と ToUnicode を作る */
export class JpFont {
  constructor({ vertical = false, map = null } = {}) {
    this.cids = new Map();
    this.vertical = vertical;
    /** 字の対応を書き換えたいとき（T68）：cid -> 文字列 */
    this.override = map;
  }
  cid(ch) {
    if (!this.cids.has(ch)) this.cids.set(ch, this.cids.size + 1);
    return this.cids.get(ch);
  }
  /** 字の並びを <....> の16進に */
  enc(s) {
    let h = "";
    for (const ch of String(s)) h += hex4(this.cid(ch));
    return "<" + h + ">";
  }
  /** pdf に書体を足し、番号を返す。字をすべて enc したあとに呼ぶ */
  finish(pdf) {
    const lines = [];
    for (const [ch, cid] of this.cids) {
      const uni = this.override?.get(cid) ?? ch;
      // u16 は "<FEFF....>"。BOM を外して "<....>" にする
      lines.push(`<${hex4(cid)}> <${u16(uni).slice(5)}`);
    }
    const chunks = [];
    for (let i = 0; i < lines.length; i += 100) {
      const part = lines.slice(i, i + 100);
      chunks.push(`${part.length} beginbfchar\n${part.join("\n")}\nendbfchar`);
    }
    const cmap =
      "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
      "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
      "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
      chunks.join("\n") +
      "\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
    const tu = pdf.add(stream("", cmap));
    const desc = pdf.add(
      "<< /Type /FontDescriptor /FontName /KasouMincho /Flags 6 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
    );
    const cidf = pdf.add(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /KasouMincho /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 1000 /CIDToGIDMap /Identity >>`,
    );
    return pdf.add(
      `<< /Type /Font /Subtype /Type0 /BaseFont /KasouMincho /Encoding /${this.vertical ? "Identity-V" : "Identity-H"} /DescendantFonts [${cidf} 0 R] /ToUnicode ${tu} 0 R >>`,
    );
  }
}

/** 日本語の文字の命令 */
export function jtext(jf, x, y, size, s, { font = "F2", pre = "" } = {}) {
  return `BT /${font} ${size} Tf ${pre}${x} ${y} Td ${jf.enc(s)} Tj ET\n`;
}

// ---- 書き出し ----

const HEADER = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1");
export const FIXED_ID = "<4B41534F55424C494E44303030303031> <4B41534F55424C494E44303030303031>";

function objBytes(n, body, crypt) {
  if (body && typeof body === "object" && "data" in body) {
    let data = body.data;
    let dict = body.dict;
    if (crypt) {
      data = crypt.data(n, data);
      dict = crypt.strings(n, dict);
    }
    return Buffer.concat([
      Buffer.from(`${n} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"),
      data,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    ]);
  }
  let s = String(body);
  if (crypt) s = crypt.strings(n, s);
  return Buffer.from(`${n} 0 obj\n${s}\nendobj\n`, "latin1");
}

/**
 * 普通の xref 表で書き出す。
 * opts.trailer：trailer に足す文字列（/Root と /Size 以外）
 * opts.omit：xref に載せない番号（どこからも指さない・載せないもの）。体は書く
 * opts.free：体を書かず、xref で f にする番号
 * opts.tail：%%EOF のあとに足すバイト列
 * opts.crypt：暗号化（makeRc4Crypt の戻り値）
 */
export function serialize(pdf, { root, trailer = "", omit = [], free = [], tail = null, crypt = null } = {}) {
  const parts = [HEADER];
  let off = HEADER.length;
  const offsets = new Map();
  for (let i = 0; i < pdf.objs.length; i++) {
    const n = i + 1;
    if (free.includes(n) || pdf.objs[i] === null) continue;
    const b = objBytes(n, pdf.objs[i], crypt && !crypt.skip?.includes(n) ? crypt : null);
    offsets.set(n, off);
    parts.push(b);
    off += b.length;
  }
  const size = pdf.objs.length + 1;
  let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    if (offsets.has(n) && !omit.includes(n)) x += String(offsets.get(n)).padStart(10, "0") + " 00000 n \n";
    else x += "0000000000 00001 f \n";
  }
  x += `trailer\n<< /Size ${size} /Root ${root} 0 R ${trailer} /ID [${FIXED_ID}] >>\nstartxref\n${off}\n%%EOF\n`;
  parts.push(Buffer.from(x, "latin1"));
  if (tail) parts.push(Buffer.isBuffer(tail) ? tail : Buffer.from(tail, "latin1"));
  return Buffer.concat(parts);
}

/**
 * xref ストリームで書き出す。inObjStm の番号は1つのオブジェクトストリームに入れる（ストリームでないものだけ）。
 * opts.hybrid：普通の xref 表も書き、trailer の /XRefStm で xref ストリームを指す（Word などの形。F01）
 */
export function serializeXrefStream(pdf, { root, trailer = "", inObjStm = [], omitFromXref = [], hybrid = false } = {}) {
  const parts = [HEADER];
  let off = HEADER.length;
  const loc = new Map(); // n -> [type, a, b]
  const stmNum = inObjStm.length ? pdf.alloc() : 0;
  // オブジェクトストリームを先に作る
  if (stmNum) {
    let head = "";
    let bodyStr = "";
    inObjStm.forEach((n, idx) => {
      const b = String(pdf.objs[n - 1]);
      head += `${n} ${bodyStr.length} `;
      bodyStr += b + "\n";
      loc.set(n, [2, stmNum, idx]);
    });
    const data = Buffer.from(head + "\n" + bodyStr, "latin1");
    pdf.set(stmNum, stream(`/Type /ObjStm /N ${inObjStm.length} /First ${Buffer.byteLength(head + "\n", "latin1")}`, data, { flate: true }));
  }
  for (let i = 0; i < pdf.objs.length; i++) {
    const n = i + 1;
    if (inObjStm.includes(n) || pdf.objs[i] === null) continue;
    const b = objBytes(n, pdf.objs[i], null);
    loc.set(n, [1, off, 0]);
    parts.push(b);
    off += b.length;
  }
  const xrefNum = pdf.objs.length + 1;
  const size = xrefNum + 1;
  loc.set(xrefNum, [1, off, 0]);
  const rows = [];
  for (let n = 0; n < size; n++) {
    const e = n === 0 || omitFromXref.includes(n) ? [0, 0, 255] : (loc.get(n) ?? [0, 0, 0]);
    const r = Buffer.alloc(7);
    r.writeUInt8(e[0], 0);
    r.writeUInt32BE(e[1], 1);
    r.writeUInt16BE(e[2], 5);
    rows.push(r);
  }
  const xdata = deflateSync(Buffer.concat(rows));
  const xs = Buffer.concat([
    Buffer.from(
      `${xrefNum} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] /Root ${root} 0 R ${trailer} /ID [${FIXED_ID}] /Filter /FlateDecode /Length ${xdata.length} >>\nstream\n`,
      "latin1",
    ),
    xdata,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]);
  const xsOff = off;
  parts.push(xs);
  off += xs.length;
  if (hybrid) {
    // 普通の表には、ファイルに直接あるものだけを、続く番号ごとの区画で載せる（オブジェクトストリームの中身は載せない）
    const direct = [];
    for (let n = 1; n < size; n++) {
      const e = loc.get(n);
      if (e && e[0] === 1 && n !== xrefNum) direct.push([n, e[1]]);
    }
    let x = "xref\n0 1\n0000000000 65535 f \n";
    for (let i = 0; i < direct.length; ) {
      let j = i;
      while (j + 1 < direct.length && direct[j + 1][0] === direct[j][0] + 1) j++;
      x += `${direct[i][0]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) x += String(direct[k][1]).padStart(10, "0") + " 00000 n \n";
      i = j + 1;
    }
    x += `trailer\n<< /Size ${size} /Root ${root} 0 R ${trailer} /ID [${FIXED_ID}] /XRefStm ${xsOff} >>\nstartxref\n${off}\n%%EOF\n`;
    parts.push(Buffer.from(x, "latin1"));
  } else {
    parts.push(Buffer.from(`startxref\n${xsOff}\n%%EOF\n`, "latin1"));
  }
  return Buffer.concat(parts);
}

function lastStartxref(buf) {
  const s = buf.toString("latin1");
  const m = [...s.matchAll(/startxref\s+(\d+)/g)].pop();
  return Number(m[1]);
}

function lastSize(buf) {
  const s = buf.toString("latin1");
  const m = [...s.matchAll(/\/Size (\d+)/g)].pop();
  return Number(m[1]);
}

/**
 * 増分更新を足す（普通の xref 表）。updates：Map(番号 -> 体)。newSize：新しい /Size
 */
export function appendUpdate(base, updates, { root, size = 0, trailer = "" }) {
  const prev = lastStartxref(base);
  size = Math.max(size, lastSize(base));
  const parts = [base];
  let off = base.length;
  const offsets = [];
  for (const [n, body] of [...updates].sort((a, b) => a[0] - b[0])) {
    const b = objBytes(n, body, null);
    offsets.push([n, off]);
    parts.push(b);
    off += b.length;
  }
  let x = "xref\n0 1\n0000000000 65535 f \n";
  for (const [n, o] of offsets) x += `${n} 1\n${String(o).padStart(10, "0")} 00000 n \n`;
  x += `trailer\n<< /Size ${size} /Root ${root} 0 R ${trailer} /Prev ${prev} /ID [${FIXED_ID}] >>\nstartxref\n${off}\n%%EOF\n`;
  parts.push(Buffer.from(x, "latin1"));
  return Buffer.concat(parts);
}

/** 増分更新を足す（xref ストリーム） */
export function appendUpdateXrefStream(base, updates, { root, size = 0, trailer = "" }) {
  const prev = lastStartxref(base);
  size = Math.max(size, lastSize(base));
  const parts = [base];
  let off = base.length;
  const offsets = [];
  for (const [n, body] of [...updates].sort((a, b) => a[0] - b[0])) {
    const b = objBytes(n, body, null);
    offsets.push([n, off]);
    parts.push(b);
    off += b.length;
  }
  const xrefNum = size;
  offsets.push([xrefNum, off]);
  const index = [];
  const rows = [];
  for (const [n, o] of offsets) {
    index.push(`${n} 1`);
    const r = Buffer.alloc(7);
    r.writeUInt8(1, 0);
    r.writeUInt32BE(o, 1);
    r.writeUInt16BE(0, 5);
    rows.push(r);
  }
  const xdata = deflateSync(Buffer.concat(rows));
  parts.push(
    Buffer.from(
      `${xrefNum} 0 obj\n<< /Type /XRef /Size ${size + 1} /Index [${index.join(" ")}] /W [1 4 2] /Root ${root} 0 R ${trailer} /Prev ${prev} /ID [${FIXED_ID}] /Filter /FlateDecode /Length ${xdata.length} >>\nstream\n`,
      "latin1",
    ),
    xdata,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${off}\n%%EOF\n`, "latin1"),
  );
  return Buffer.concat(parts);
}

// ---- よく使う組み立て ----

/**
 * 1〜数ページの文書を組み立てる。
 * pages：[{ content: string|Buffer, resources?: string（/Font 以外の追加）, annots?: string[]（体）, extra?: string, flate?: boolean, mediaBox?, cropBox? }]
 * opts.info：Info 辞書の中身（文字列）。opts.catalog：Catalog に足す文字列。
 * opts.jp：JpFont（使うとき）。opts.xobjects：{名前: 番号} をすべてのページの資源に足す
 * 戻り値：{ pdf, root, info, pageNums, finish(opts) } — finish で書き出す
 */
export function build({ pages, info = null, catalog = "", jp = null, jp2 = null, fonts = "", hook = null }) {
  const pdf = new Pdf();
  const root = pdf.alloc();
  const pagesNum = pdf.alloc();
  const f1 = pdf.add(HELV);
  const pageNums = [];
  const pendingJp = [];
  for (const p of pages) {
    const content = typeof p.content === "function" ? p.content() : p.content;
    const c = pdf.add(stream(p.contentDict ?? "", content, { flate: !!p.flate }));
    const pn = pdf.alloc();
    pageNums.push(pn);
    const annotNums = (p.annots ?? []).map((a) => {
      const an = pdf.alloc();
      const body = typeof a === "function" ? a({ pdf, page: pn, self: an }) : a;
      pdf.set(an, body.replace(/\$PAGE/g, `${pn} 0 R`));
      return an;
    });
    pendingJp.push({ pn, c, p, annotNums });
  }
  const jpNum = jp ? jp.finish(pdf) : 0;
  const jp2Num = jp2 ? jp2.finish(pdf) : 0;
  const extraFonts = typeof fonts === "function" ? fonts(pdf) : fonts;
  const fontDict = `/Font << /F1 ${f1} 0 R ${jpNum ? `/F2 ${jpNum} 0 R` : ""} ${jp2Num ? `/F3 ${jp2Num} 0 R` : ""} ${extraFonts} >>`;
  for (const { pn, c, p, annotNums } of pendingJp) {
    const res = typeof p.resources === "function" ? p.resources(pdf) : (p.resources ?? "");
    pdf.set(
      pn,
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [${(p.mediaBox ?? A4).join(" ")}] ${p.cropBox ? `/CropBox [${p.cropBox.join(" ")}]` : ""} /Resources << ${fontDict} ${res} >> /Contents ${c} 0 R ${annotNums.length ? `/Annots [${annotNums.map((n) => `${n} 0 R`).join(" ")}]` : ""} ${typeof p.extra === "function" ? p.extra(pdf) : (p.extra ?? "")} >>`,
    );
  }
  pdf.set(pagesNum, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`);
  const infoNum = info !== null ? pdf.add(`<< ${info} >>`) : 0;
  const ctx = { pdf, root, pagesNum, pageNums, infoNum, f1 };
  const cat = typeof catalog === "function" ? catalog(ctx) : catalog;
  pdf.set(root, `<< /Type /Catalog /Pages ${pagesNum} 0 R ${cat} >>`);
  if (hook) hook(ctx);
  return {
    ...ctx,
    trailerInfo: infoNum ? `/Info ${infoNum} 0 R` : "",
    bytes(opts = {}) {
      return serialize(pdf, { root, ...opts, trailer: (infoNum ? `/Info ${infoNum} 0 R ` : "") + (opts.trailer ?? "") });
    },
  };
}

// ---- 画像 ----

/** 灰色 8bit の画像（Flate）。px：Uint8Array(w*h) */
export function grayImage(w, h, px, extra = "") {
  return stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 ${extra}`, Buffer.from(px), {
    flate: true,
  });
}

/** RGB 8bit の画像（Flate）。px：Uint8Array(w*h*3) */
export function rgbImage(w, h, px, extra = "") {
  return stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 ${extra}`, Buffer.from(px), {
    flate: true,
  });
}

/**
 * 「スキャン」のような灰色の画像。白い地に、字に見える黒い棒の並びを描く。
 * lines：[{ x, y, w, h }]（画像の画素の座標。左上が原点）に字のような模様を入れる。burn：黒で塗りつぶす箱
 */
export function scanPixels(w, h, lines, burn = []) {
  const px = new Uint8Array(w * h).fill(250);
  for (const L of lines) {
    for (let x = L.x; x < L.x + L.w; x++) {
      // 字のような縦の棒（4画素ごとに 2画素の黒）
      if ((x - L.x) % 6 >= 3) continue;
      for (let y = L.y; y < L.y + L.h; y++) {
        if ((y - L.y) % 5 === 4 && (x - L.x) % 12 < 6) continue;
        px[y * w + x] = 20;
      }
    }
  }
  for (const B of burn) for (let y = B.y; y < B.y + B.h; y++) for (let x = B.x; x < B.x + B.w; x++) px[y * w + x] = 0;
  return px;
}

// ---- 暗号化（標準のセキュリティハンドラ、RC4 128bit、R3） ----

const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");

function md5(...bufs) {
  const h = createHash("md5");
  for (const b of bufs) h.update(b);
  return h.digest();
}

export function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + S[i]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}

function padPw(pw) {
  return Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);
}

/**
 * RC4 128bit（V2・R3）の暗号化を作る。戻り値の encryptDict を Encrypt の体に、crypt を serialize に渡す。
 * 体の中の文字列は16進（<...>）で書いておくこと（ここで16進の文字列だけを暗号化する）。
 */
export function makeRc4Crypt({ userPw = "", ownerPw = "kasou-owner", P = -3904 }) {
  const id0 = Buffer.from("4B41534F55424C494E44303030303031", "hex");
  const n = 16;
  // O（Algorithm 3）
  let ok = md5(padPw(ownerPw));
  for (let i = 0; i < 50; i++) ok = md5(ok);
  ok = ok.subarray(0, n);
  let O = rc4(ok, padPw(userPw));
  for (let i = 1; i <= 19; i++) O = rc4(Buffer.from(ok.map((b) => b ^ i)), O);
  // 鍵（Algorithm 2）
  const pb = Buffer.alloc(4);
  pb.writeInt32LE(P, 0);
  let key = md5(padPw(userPw), O, pb, id0);
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
  key = key.subarray(0, n);
  // U（Algorithm 5）
  let U = rc4(key, md5(PAD, id0));
  for (let i = 1; i <= 19; i++) U = rc4(Buffer.from(key.map((b) => b ^ i)), U);
  U = Buffer.concat([U, Buffer.alloc(16, 0)]);
  const objKey = (num) => {
    const b = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]);
    return md5(key, b).subarray(0, Math.min(n + 5, 16));
  };
  const encryptDict = `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O ${hexStr(O)} /U ${hexStr(U)} >>`;
  return {
    encryptDict,
    crypt: {
      skip: [],
      data: (num, d) => rc4(objKey(num), d),
      strings: (num, s) =>
        s.replace(/(^|[^<])<([0-9A-Fa-f]*)>(?!>)/g, (m, pre, h) => pre + hexStr(rc4(objKey(num), Buffer.from(h, "hex")))),
    },
  };
}

// ---- EXIF（JPEG の APP1） ----

/**
 * TIFF（リトルエンディアン）の EXIF を作る。
 * ifd0：[{ tag, type: "ascii"|"short"|"long"|"rational", value }]、gps：同じ形、thumb：JPEG のバイト列（IFD1 に入れる）
 */
export function exifApp1({ ifd0 = [], gps = null, thumb = null }) {
  // 2段で組み立てる：まず大きさを決め、つぎに書く
  const ifds = [{ entries: [...ifd0] }];
  if (gps) ifds[0].entries.push({ tag: 0x8825, type: "long", value: 0, ptr: "gps" });
  ifds[0].entries.sort((a, b) => a.tag - b.tag);
  const typeInfo = { ascii: [2, 1], short: [3, 2], long: [4, 4], rational: [5, 8] };
  const valBytes = (e) => {
    if (e.type === "ascii") {
      const b = Buffer.from(e.value + "\0", "latin1");
      return b;
    }
    const vals = Array.isArray(e.value) ? e.value : [e.value];
    if (e.type === "short") {
      const b = Buffer.alloc(2 * vals.length);
      vals.forEach((v, i) => b.writeUInt16LE(v, 2 * i));
      return b;
    }
    if (e.type === "long") {
      const b = Buffer.alloc(4 * vals.length);
      vals.forEach((v, i) => b.writeUInt32LE(v, 4 * i));
      return b;
    }
    const b = Buffer.alloc(8 * vals.length);
    vals.forEach((v, i) => {
      b.writeUInt32LE(v[0], 8 * i);
      b.writeUInt32LE(v[1], 8 * i + 4);
    });
    return b;
  };
  const count = (e) => {
    if (e.type === "ascii") return Buffer.byteLength(e.value + "\0", "latin1");
    return Array.isArray(e.value) ? e.value.length : 1;
  };
  const blocks = []; // [{ entries, offset }]
  const list = [{ name: "ifd0", entries: ifds[0].entries }];
  if (gps) list.push({ name: "gps", entries: [...gps].sort((a, b) => a.tag - b.tag) });
  if (thumb) list.push({ name: "ifd1", entries: [{ tag: 0x0103, type: "short", value: 6 }, { tag: 0x0201, type: "long", value: 0, ptr: "thumb" }, { tag: 0x0202, type: "long", value: thumb.length }] });
  // 置き場所を決める
  let off = 8;
  const pos = {};
  for (const b of list) {
    pos[b.name] = off;
    let size = 2 + 12 * b.entries.length + 4;
    for (const e of b.entries) {
      const vb = valBytes(e);
      if (vb.length > 4) size += vb.length + (vb.length % 2);
    }
    b.size = size;
    off += size;
  }
  pos.thumb = off;
  const total = off + (thumb ? thumb.length : 0);
  const out = Buffer.alloc(total);
  out.write("II", 0, "latin1");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  for (const b of list) {
    let p = pos[b.name];
    out.writeUInt16LE(b.entries.length, p);
    p += 2;
    let extra = p + 12 * b.entries.length + 4;
    for (const e of b.entries) {
      const v = e.ptr ? { ...e, value: pos[e.ptr] } : e;
      const vb = valBytes(v);
      out.writeUInt16LE(e.tag, p);
      out.writeUInt16LE(typeInfo[e.type][0], p + 2);
      out.writeUInt32LE(count(v), p + 4);
      if (vb.length <= 4) vb.copy(out, p + 8);
      else {
        out.writeUInt32LE(extra, p + 8);
        vb.copy(out, extra);
        extra += vb.length + (vb.length % 2);
      }
      p += 12;
    }
    // 次の IFD：ifd0 の次は ifd1（あれば）
    const next = b.name === "ifd0" && thumb ? pos.ifd1 : 0;
    out.writeUInt32LE(next, p);
  }
  if (thumb) Buffer.from(thumb).copy(out, pos.thumb);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), out]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([seg, body]);
}

/** JPEG の SOI の直後に APP1 を入れる（もとの APP0・APP1 は外す） */
export function jpegWithExif(jpeg, app1) {
  const b = Buffer.from(jpeg);
  let p = 2;
  const keep = [];
  while (p < b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    if (marker === 0xda) break;
    const len = b.readUInt16BE(p + 2);
    if (!(marker === 0xe0 || marker === 0xe1)) keep.push(b.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  return Buffer.concat([b.subarray(0, 2), app1 ?? Buffer.alloc(0), ...keep, b.subarray(p)]);
}

export function jpegXObject(w, h, jpeg, extra = "") {
  return {
    dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ${extra}`,
    data: Buffer.from(jpeg),
  };
}

export function xmpPacket(inner) {
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" ' +
    'xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#" ' +
    'xmlns:stRef="http://ns.adobe.com/xap/1.0/sType/ResourceRef#" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">' +
    inner +
    "</rdf:Description></rdf:RDF></x:xmpmeta>\n" +
    '<?xpacket end="w"?>'
  );
}

/** XMP のストリームの体（UTF-8） */
export function xmpStream(inner, { flate = false } = {}) {
  return stream("/Type /Metadata /Subtype /XML", Buffer.from(xmpPacket(inner), "utf8"), { flate });
}

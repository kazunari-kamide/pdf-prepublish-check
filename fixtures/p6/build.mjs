// SPDX-License-Identifier: AGPL-3.0-only
//
// P6（見せかけの黒塗り）の合成 PDF と正解データを作る。
//   node fixtures/p6/build.mjs
// このファイルと同じフォルダに、<名前>.pdf・<名前>.expected.json・index.md を書く。
//
// - 名前・住所などは、すべて架空のもの（山田太郎、○○市 など）。
// - 日時・乱数を固定しているので、何度作っても同じバイト列になる（index.md に SHA-256 を載せる）。
// - スキャン画像は、字の形をまねた模様を、画素で直接作る（文字認識はしないので、本物の字である必要はない）。
// - 字のフォントは BIZ UDゴシック（SIL Open Font License 1.1。fonts/OFL.txt）。字に使う分だけを埋め込む。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument, PDFName, rgb, cmyk, degrees, BlendMode,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
  beginText, endText, setFontAndSize, moveText, showText, setTextRenderingMode, TextRenderingMode,
  setFillingColor,
} from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// フォントは fonts/ に置く。同じファイルを別の場所から読んで試すときだけ、環境変数 P6_FIXTURE_FONT で場所を渡す
const FONT_PATH = process.env.P6_FIXTURE_FONT ?? path.join(HERE, "fonts", "BIZUDGothic-Regular.ttf");
const FIXED_DATE = new Date("2026-11-03T00:00:00Z");
const PAGE = [595, 842]; // A4（ポイント）
const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);

// 字の箱の上下（BIZ UDゴシックの外枠。1em に対する割合）
const ASC = 0.879;
const DESC = -0.12;

// ---------- フォントの字のデータを偶数バイトにそろえる ----------
// @pdf-lib/fontkit 1.1.1 は、字を絞ったフォントが 64KB 以下のとき、位置の表（loca）を
// 「2で割った値」の形で書く。元のフォントに奇数バイトの字があると、そのあとの字の位置がずれて
// 形が読めなくなる（BIZ UDゴシックは 13,932 字のうち 6,966 字が奇数バイト）。
// ライブラリは直さず、埋め込む前に、字ごとのデータを 4 バイトの区切りまで 0 で埋めておく。
// 字の形は変わらない。電子署名（DSIG）は中身が変わると合わなくなるので外す。
function padGlyphs(src) {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const numTables = view.getUint16(4);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(...src.subarray(o, o + 4));
    tables.push({ tag, offset: view.getUint32(o + 8), length: view.getUint32(o + 12) });
  }
  const get = (tag) => tables.find((t) => t.tag === tag);
  const head = get("head"), loca = get("loca"), glyf = get("glyf"), maxp = get("maxp");
  const longLoca = view.getInt16(head.offset + 50) === 1;
  const numGlyphs = view.getUint16(maxp.offset + 4);
  const off = (i) => (longLoca ? view.getUint32(loca.offset + i * 4) : view.getUint16(loca.offset + i * 2) * 2);
  const pad4 = (n) => (n + 3) & ~3;
  // 新しい glyf と loca（長い形）
  let total = 0;
  for (let i = 0; i < numGlyphs; i++) total += pad4(off(i + 1) - off(i));
  const newGlyf = new Uint8Array(total);
  const newLoca = new Uint8Array((numGlyphs + 1) * 4);
  const lv = new DataView(newLoca.buffer);
  let pos = 0;
  for (let i = 0; i < numGlyphs; i++) {
    lv.setUint32(i * 4, pos);
    const a = off(i), b = off(i + 1);
    newGlyf.set(src.subarray(glyf.offset + a, glyf.offset + b), pos);
    pos += pad4(b - a);
  }
  lv.setUint32(numGlyphs * 4, pos);
  // 表を組み直す
  const out = tables
    .filter((t) => t.tag !== "DSIG")
    .map((t) => {
      let data = src.slice(t.offset, t.offset + t.length);
      if (t.tag === "glyf") data = newGlyf;
      if (t.tag === "loca") data = newLoca;
      if (t.tag === "head") {
        const hv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        hv.setUint32(8, 0); // checkSumAdjustment は最後に入れ直す
        hv.setInt16(50, 1); // loca は長い形
      }
      return { tag: t.tag, data };
    });
  const checksum = (bytes) => {
    const padded = new Uint8Array(pad4(bytes.length));
    padded.set(bytes);
    const dv = new DataView(padded.buffer);
    let s = 0;
    for (let i = 0; i < padded.length; i += 4) s = (s + dv.getUint32(i)) >>> 0;
    return s;
  };
  const n = out.length;
  const headerLen = 12 + n * 16;
  const size = headerLen + out.reduce((s, t) => s + pad4(t.data.length), 0);
  const font = new Uint8Array(size);
  const fv = new DataView(font.buffer);
  fv.setUint32(0, view.getUint32(0));
  fv.setUint16(4, n);
  const es = Math.floor(Math.log2(n));
  fv.setUint16(6, 2 ** es * 16);
  fv.setUint16(8, es);
  fv.setUint16(10, n * 16 - 2 ** es * 16);
  let at = headerLen;
  let headAt = 0;
  out.forEach((t, i) => {
    const o = 12 + i * 16;
    for (let k = 0; k < 4; k++) font[o + k] = t.tag.charCodeAt(k);
    fv.setUint32(o + 4, checksum(t.data));
    fv.setUint32(o + 8, at);
    fv.setUint32(o + 12, t.data.length);
    font.set(t.data, at);
    if (t.tag === "head") headAt = at;
    at += pad4(t.data.length);
  });
  fv.setUint32(headAt + 8, (0xb1b0afba - checksum(font)) >>> 0);
  return font;
}

const fontBytes = padGlyphs(new Uint8Array(readFileSync(FONT_PATH)));
const r2 = (b) => b.map((v) => Math.round(v * 100) / 100);
const countChars = (s) => [...s].filter((c) => c.trim() !== "").length;

// ---------- 決まった乱数 ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 1つの合成 PDF を作る道具 ----------
class Fixture {
  constructor(name, description) {
    this.name = name;
    this.description = description;
    this.leaks = [];
    this.negatives = [];
  }
  async init() {
    this.doc = await PDFDocument.create({ updateMetadata: false });
    this.doc.registerFontkit(fontkit);
    this.font = await this.doc.embedFont(fontBytes, { subset: true });
    // 文書情報は、合成であることだけを書く（P1 の漏れを混ぜない）
    this.doc.setTitle("合成テスト用 PDF（架空の内容）");
    this.doc.setProducer("omamori-pdf fixtures");
    this.doc.setCreator("omamori-pdf fixtures");
    this.doc.setCreationDate(FIXED_DATE);
    this.doc.setModificationDate(FIXED_DATE);
    return this;
  }
  addPage() {
    const p = this.doc.addPage(PAGE);
    this.pages = (this.pages ?? 0) + 1;
    p.__no = this.pages;
    return p;
  }
  width(s, size) {
    return this.font.widthOfTextAtSize(s, size);
  }
  // 字を書く。before は同じ行で先に書く字（覆う位置の計算に使う）
  text(page, s, x, y, size = 12, color = BLACK) {
    page.drawText(s, { x, y, size, font: this.font, color });
  }
  // 行 (x, y, size) の中の target（前に before がある）を覆う箱
  spanBox(x, y, size, before, target, pad = 1.5) {
    const x0 = x + this.width(before, size);
    const x1 = x0 + this.width(target, size);
    return [x0 - pad, y + DESC * size - pad, x1 + pad, y + ASC * size + pad];
  }
  rect(page, box, color = BLACK, opacity = 1, blendMode = undefined) {
    page.drawRectangle({ x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1], color, opacity, blendMode });
  }
  leak(page, layer, cover, rect, remaining) {
    this.leaks.push({ id: `${this.name}#L${this.leaks.length + 1}`, pattern: "P6", layer, cover, page: page.__no ?? page, rect: r2(rect), remaining });
  }
  negative(page, kind, rect, note) {
    this.negatives.push({ id: `${this.name}#N${this.negatives.length + 1}`, kind, page: page.__no ?? page, rect: r2(rect), note });
  }
  // 画像（灰色 8bit）を XObject として作る
  grayImage(w, h, pixels) {
    const stream = this.doc.context.flateStream(pixels, {
      Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 8,
    });
    return this.doc.context.register(stream);
  }
  placeImage(page, ref, box) {
    const name = page.node.newXObject("Im", ref);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(box[2] - box[0], 0, 0, box[3] - box[1], box[0], box[1]),
      drawObject(name),
      popGraphicsState(),
    );
  }
  // 注釈を足す。ap に描く命令（文字列）を渡すと、見た目（AP）も付ける
  annot(page, dict, ap) {
    const ctx = this.doc.context;
    const [x0, y0, x1, y1] = dict.Rect;
    if (ap) {
      const form = ctx.stream(ap, { Type: "XObject", Subtype: "Form", BBox: [0, 0, x1 - x0, y1 - y0] });
      dict.AP = { N: ctx.register(form) };
    }
    const ref = ctx.register(ctx.obj({ Type: "Annot", F: 4, ...dict }));
    const annots = page.node.Annots();
    if (annots) annots.push(ref);
    else page.node.set(PDFName.of("Annots"), ctx.obj([ref]));
  }
  // 字を直接の命令で書く（見えない字や、Form XObject の中に書くとき）
  textOps(fontKey, s, x, y, size, { mode = TextRenderingMode.Fill, color = BLACK } = {}) {
    return [
      beginText(),
      setFillingColor(color),
      setTextRenderingMode(mode),
      setFontAndSize(fontKey, size),
      moveText(x, y),
      showText(this.font.encodeText(s)),
      endText(),
    ];
  }
  async save() {
    const bytes = await this.doc.save({ useObjectStreams: false });
    const expected = {
      file: `${this.name}.pdf`,
      description: this.description,
      pages: this.pages,
      leaks: this.leaks,
      negatives: this.negatives,
    };
    writeFileSync(path.join(HERE, `${this.name}.pdf`), bytes);
    writeFileSync(path.join(HERE, `${this.name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
    return { ...expected, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
  }
}

// ---------- スキャン画像（字の形をまねた模様） ----------
const SCAN_SCALE = 1.25; // 1 ポイントあたりの画素
const SCAN_W = Math.round(PAGE[0] * SCAN_SCALE);
const SCAN_H = Math.round(PAGE[1] * SCAN_SCALE);
const PAPER = 238;
// 行の位置（ページのポイント。y は字の下端）。y=200〜330 は何も書かない余白
const SCAN_LINES = [
  ...Array.from({ length: 14 }, (_, i) => ({ y: 760 - i * 28, x0: 60, x1: i % 5 === 4 ? 330 : 535 })),
  ...Array.from({ length: 5 }, (_, i) => ({ y: 180 - i * 28, x0: 60, x1: 535 })),
];
const SCAN_BLANK = [60, 200, 535, 330];

function makeScan(seed) {
  const rand = rng(seed);
  const px = new Uint8Array(SCAN_W * SCAN_H).fill(PAPER);
  const dot = (X, Y, v) => {
    if (X >= 0 && X < SCAN_W && Y >= 0 && Y < SCAN_H) px[Y * SCAN_W + X] = v;
  };
  const cell = 14; // 1字の大きさ（ポイント）
  for (const ln of SCAN_LINES) {
    for (let x = ln.x0; x + cell <= ln.x1; x += cell) {
      if (rand() < 0.12) continue; // 字間の空き
      // 1字を、縦・横の線を数本組み合わせて描く
      const strokes = 2 + Math.floor(rand() * 4);
      for (let k = 0; k < strokes; k++) {
        const vertical = rand() < 0.5;
        const a = 2 + rand() * (cell - 4);
        const b0 = 1 + rand() * 4, b1 = cell - 1 - rand() * 4;
        for (let t = b0; t <= b1; t += 0.4) {
          const [X, Y] = vertical ? [x + a, ln.y + t] : [x + t, ln.y + a];
          const PX = Math.round(X * SCAN_SCALE), PY = Math.round((PAGE[1] - Y) * SCAN_SCALE);
          dot(PX, PY, 30); dot(PX + 1, PY, 30); dot(PX, PY + 1, 40);
        }
      }
    }
  }
  return px;
}
// スキャン画像の、ページ上の箱に当たる画素を黒くする（画素そのものを消す＝正しい墨消し）
function burnScan(px, box) {
  const X0 = Math.floor(box[0] * SCAN_SCALE), X1 = Math.ceil(box[2] * SCAN_SCALE);
  const Y0 = Math.floor((PAGE[1] - box[3]) * SCAN_SCALE), Y1 = Math.ceil((PAGE[1] - box[1]) * SCAN_SCALE);
  for (let y = Math.max(0, Y0); y < Math.min(SCAN_H, Y1); y++) {
    for (let x = Math.max(0, X0); x < Math.min(SCAN_W, X1); x++) px[y * SCAN_W + x] = 0;
  }
  return px;
}
// スキャンの行 i の、x0〜x1 の範囲を覆う箱
const scanLineBox = (i, x0, x1, n = 1) => [x0, SCAN_LINES[i + n - 1].y - 3, x1, SCAN_LINES[i].y + 17];

// ---------- 合成 PDF の一覧 ----------
const builders = [];
const def = (name, description, fn) => builders.push({ name, description, fn });

// ===== 漏れ：字の層 =====
def("p6-t01-rect-over-name", "黒い四角を、氏名の上に重ねただけ（下の字が残っている）", (f) => {
  const p = f.addPage();
  f.text(p, "申請書（控え）", 72, 760, 18);
  const pre = "氏名：", name = "山田太郎";
  f.text(p, pre + name, 72, 700);
  f.text(p, "住所：○○市△△町一丁目2番3号", 72, 676);
  const box = f.spanBox(72, 700, 12, pre, name);
  f.rect(p, box);
  f.leak(p, "text", "fill", box, { chars: countChars(name) });
});

def("p6-t02-partial-string", "1つの字の並びの一部（住所）だけを覆っている", (f) => {
  const p = f.addPage();
  const pre = "申請者：山田花子（", addr = "○○市△△町4丁目5番6号", post = "）";
  f.text(p, pre + addr + post, 60, 700, 11);
  const box = f.spanBox(60, 700, 11, pre, addr);
  f.rect(p, box);
  f.leak(p, "text", "fill", box, { chars: countChars(addr) });
});

def("p6-t03-near-black-and-cmyk", "真っ黒でない濃い色（#1a1a1a）と、CMYK の黒で覆っている", (f) => {
  const p = f.addPage();
  const preA = "電話：", tel = "000-1234-5678";
  const preB = "勤務先：", org = "株式会社○○商事";
  f.text(p, preA + tel, 72, 700);
  f.text(p, preB + org, 72, 660);
  const a = f.spanBox(72, 700, 12, preA, tel);
  const b = f.spanBox(72, 660, 12, preB, org);
  f.rect(p, a, rgb(0x1a / 255, 0x1a / 255, 0x1a / 255));
  f.rect(p, b, cmyk(0, 0, 0, 1));
  f.leak(p, "text", "fill", a, { chars: countChars(tel) });
  f.leak(p, "text", "fill", b, { chars: countChars(org) });
});

def("p6-t04-multi-line", "3行をまとめて1つの黒い四角で覆っている", (f) => {
  const p = f.addPage();
  const lines = ["相談の内容：山田太郎さんから、", "○○市△△町の土地について", "境界の確認を求める相談があった。"];
  lines.forEach((s, i) => f.text(p, s, 72, 700 - i * 20));
  f.text(p, "対応：担当課で確認する。", 72, 620);
  const w = Math.max(...lines.map((s) => f.width(s, 12)));
  const box = [70, 700 - 2 * 20 + DESC * 12 - 2, 72 + w + 2, 700 + ASC * 12 + 2];
  f.rect(p, box);
  f.leak(p, "text", "fill", box, { chars: lines.reduce((n, s) => n + countChars(s), 0) });
});

def("p6-t05-rotated-page", "90度回転したページの上で、黒い四角で覆っている", (f) => {
  const p = f.addPage();
  p.setRotation(degrees(90));
  const pre = "氏名：", name = "佐藤一郎";
  f.text(p, pre + name, 100, 500);
  const box = f.spanBox(100, 500, 12, pre, name);
  f.rect(p, box);
  f.leak(p, "text", "fill", box, { chars: countChars(name) });
});

def("p6-t06-scaled-matrix", "縮小と移動の行列（cm）の中で、字と黒い四角を描いている", (f) => {
  const p = f.addPage();
  const s = 0.5, tx = 100, ty = 400;
  const pre = "口座番号：", num = "1234567";
  p.pushOperators(pushGraphicsState(), concatTransformationMatrix(s, 0, 0, s, tx, ty));
  f.text(p, pre + num, 0, 0, 24);
  const local = f.spanBox(0, 0, 24, pre, num, 3);
  f.rect(p, local);
  p.pushOperators(popGraphicsState());
  const box = [local[0] * s + tx, local[1] * s + ty, local[2] * s + tx, local[3] * s + ty];
  f.leak(p, "text", "fill", box, { chars: countChars(num) });
});

def("p6-t07-form-xobject", "Form XObject（入れ子の部品）の中の字を覆う／部品の中の黒い四角でページの字を覆う", (f) => {
  const p = f.addPage();
  const ctx = f.doc.context;
  const fontKey = PDFName.of("F0");
  // 1つめ：部品の中に字。上からページで黒い四角
  const name1 = "鈴木次郎";
  const form1 = ctx.register(ctx.formXObject(f.textOps(fontKey, "担当：" + name1, 10, 10, 12), {
    BBox: [0, 0, 200, 40], Resources: { Font: { F0: f.font.ref } },
  }));
  const fx1 = p.node.newXObject("Fx", form1);
  p.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, 72, 680), drawObject(fx1), popGraphicsState());
  const b1 = f.spanBox(72 + 10, 680 + 10, 12, "担当：", name1);
  f.rect(p, b1);
  f.leak(p, "text", "fill", b1, { chars: countChars(name1) });
  // 2つめ：ページに字。上から部品の中の黒い四角
  const pre = "連絡先：", tel = "000-9876-5432";
  f.text(p, pre + tel, 72, 600);
  const b2 = f.spanBox(72, 600, 12, pre, tel);
  const w = b2[2] - b2[0], h = b2[3] - b2[1];
  const form2 = ctx.register(ctx.stream(`0 g 0 0 ${w.toFixed(3)} ${h.toFixed(3)} re f`, {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h],
  }));
  const fx2 = p.node.newXObject("Fx", form2);
  p.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, b2[0], b2[1]), drawObject(fx2), popGraphicsState());
  f.leak(p, "text", "fill", b2, { chars: countChars(tel) });
});

def("p6-t08-thick-stroke", "太い黒い線（マーカーで塗ったような線）で覆っている", (f) => {
  const p = f.addPage();
  const pre = "生年月日：", dob = "1980年1月1日";
  f.text(p, pre + dob, 72, 700);
  const b = f.spanBox(72, 700, 12, pre, dob, 0);
  const yMid = (b[1] + b[3]) / 2, thick = 16;
  p.drawLine({ start: { x: b[0] - 2, y: yMid }, end: { x: b[2] + 2, y: yMid }, thickness: thick, color: BLACK });
  f.leak(p, "text", "fill", [b[0] - 2, yMid - thick / 2, b[2] + 2, yMid + thick / 2], { chars: countChars(dob) });
});

def("p6-t09-square-annotation", "黒く塗った四角の注釈を、字の上に置いている", (f) => {
  const p = f.addPage();
  const pre = "氏名：", name = "高橋三郎";
  f.text(p, pre + name, 72, 700);
  const b = f.spanBox(72, 700, 12, pre, name);
  const w = b[2] - b[0], h = b[3] - b[1];
  f.annot(p, { Subtype: "Square", Rect: b, C: [0, 0, 0], IC: [0, 0, 0], T: "（架空）作業者" },
    `0 g 0 G 0 0 ${w.toFixed(3)} ${h.toFixed(3)} re B`);
  f.leak(p, "text", "annotation", b, { chars: countChars(name) });
});

def("p6-t10-redact-annotation", "墨消しの注釈を置いたが、まだ適用していない（下の字はそのまま）", (f) => {
  const p = f.addPage();
  const pre = "住所：", addr = "○○市□□町7番8号";
  f.text(p, pre + addr, 72, 700);
  const b = f.spanBox(72, 700, 12, pre, addr);
  f.annot(p, { Subtype: "Redact", Rect: b, IC: [0, 0, 0], OC: [1, 0, 0] });
  f.leak(p, "text", "annotation", b, { chars: countChars(addr) });
});

def("p6-t11-scan-with-hidden-text", "スキャン画像と、その上の見えない字（文字認識の層）を、黒い四角でまとめて覆っている", (f) => {
  const p = f.addPage();
  f.placeImage(p, f.grayImage(SCAN_W, SCAN_H, makeScan(11)), [0, 0, PAGE[0], PAGE[1]]);
  const key = p.node.newFontDictionary("F", f.font.ref);
  const hidden = "山田太郎　○○市△△町1番";
  p.pushOperators(...f.textOps(key, hidden, 60, SCAN_LINES[2].y, 14, { mode: TextRenderingMode.Invisible }));
  const box = scanLineBox(2, 56, 60 + f.width(hidden, 14) + 4);
  f.rect(p, box);
  f.leak(p, "text", "fill", box, { chars: countChars(hidden) });
  f.leak(p, "image", "fill", box, {});
});

def("p6-t12-black-image-over-text", "黒い画像を、字の上に貼っただけ", (f) => {
  const p = f.addPage();
  const pre = "マイナンバー：", num = "0000 1111 2222";
  f.text(p, pre + num, 72, 700);
  const box = f.spanBox(72, 700, 12, pre, num);
  f.placeImage(p, f.grayImage(8, 8, new Uint8Array(64).fill(0)), box);
  f.leak(p, "text", "image", box, { chars: countChars(num) });
});

// ===== 漏れ：画像の層 =====
def("p6-i01-scan-rect", "スキャン画像の上に、黒い四角を重ねただけ（下の画像はそのまま）", (f) => {
  const p = f.addPage();
  f.placeImage(p, f.grayImage(SCAN_W, SCAN_H, makeScan(101)), [0, 0, PAGE[0], PAGE[1]]);
  const box = scanLineBox(1, 130, 300);
  f.rect(p, box);
  f.leak(p, "image", "fill", box, {});
});

def("p6-i02-scan-black-image", "スキャン画像の上に、黒い画像を貼っただけ", (f) => {
  const p = f.addPage();
  f.placeImage(p, f.grayImage(SCAN_W, SCAN_H, makeScan(102)), [0, 0, PAGE[0], PAGE[1]]);
  const patch = f.grayImage(8, 8, new Uint8Array(64).fill(0));
  const box = scanLineBox(5, 200, 480, 2);
  f.placeImage(p, patch, box);
  f.leak(p, "image", "image", box, {});
});

def("p6-i03-scan-square-annotation", "スキャン画像の上に、黒く塗った四角の注釈を置いている", (f) => {
  const p = f.addPage();
  f.placeImage(p, f.grayImage(SCAN_W, SCAN_H, makeScan(103)), [0, 0, PAGE[0], PAGE[1]]);
  const b = scanLineBox(7, 90, 260);
  const w = b[2] - b[0], h = b[3] - b[1];
  f.annot(p, { Subtype: "Square", Rect: b, C: [0, 0, 0], IC: [0, 0, 0] }, `0 g 0 G 0 0 ${w.toFixed(3)} ${h.toFixed(3)} re B`);
  f.leak(p, "image", "annotation", b, {});
});

def("p6-i04-scan-redact-annotation", "スキャン画像の上に、適用していない墨消しの注釈を置いている", (f) => {
  const p = f.addPage();
  f.placeImage(p, f.grayImage(SCAN_W, SCAN_H, makeScan(104)), [0, 0, PAGE[0], PAGE[1]]);
  const b = scanLineBox(10, 300, 520);
  f.annot(p, { Subtype: "Redact", Rect: b, IC: [0, 0, 0] });
  f.leak(p, "image", "annotation", b, {});
});

def("p6-i05-scan-several", "スキャン画像の上に黒い四角を3つ（漏れ）と、余白の上に1つ（下に何もない）", (f) => {
  const p = f.addPage();
  f.placeImage(p, f.grayImage(SCAN_W, SCAN_H, makeScan(105)), [0, 0, PAGE[0], PAGE[1]]);
  const boxes = [scanLineBox(0, 60, 200), scanLineBox(3, 250, 520), scanLineBox(15, 100, 400, 2)];
  for (const b of boxes) {
    f.rect(p, b);
    f.leak(p, "image", "fill", b, {});
  }
  const blank = [150, 230, 450, 300];
  f.rect(p, blank);
  f.negative(p, "blank_area", blank, "スキャンの余白（何も書かれていない所）の上の黒い四角");
});

// ===== 正しく消したもの（漏れでない） =====
def("p6-n01-text-removed", "字を消してから黒い四角を置いた（正しい墨消し）", (f) => {
  const p = f.addPage();
  const pre1 = "氏名：", pre2 = "住所：";
  f.text(p, pre1, 72, 700);
  f.text(p, pre2, 72, 676);
  f.text(p, "上記のとおり申請します。", 72, 640);
  const b1 = f.spanBox(72, 700, 12, pre1, "山田太郎");
  const b2 = f.spanBox(72, 676, 12, pre2, "○○市△△町1番2号");
  f.rect(p, b1);
  f.rect(p, b2);
  f.negative(p, "redacted_correctly", b1, "下の字は消してある");
  f.negative(p, "redacted_correctly", b2, "下の字は消してある");
});

def("p6-n02-scan-burned", "スキャン画像の画素そのものを黒くしてから、黒い四角を置いた（正しい墨消し）", (f) => {
  const p = f.addPage();
  const b1 = scanLineBox(1, 130, 300);
  const b2 = scanLineBox(8, 60, 400, 2);
  const px = burnScan(burnScan(makeScan(201), b1), b2);
  f.placeImage(p, f.grayImage(SCAN_W, SCAN_H, px), [0, 0, PAGE[0], PAGE[1]]);
  f.rect(p, b1);
  f.rect(p, b2);
  f.negative(p, "redacted_correctly", b1, "下の画素は黒くしてある");
  f.negative(p, "redacted_correctly", b2, "下の画素は黒くしてある");
});

// ===== デザインの黒い帯など（漏れでない） =====
def("p6-d01-header-bands", "黒い帯の見出し・濃い色の表の見出し（字は帯のあとに白で書いてある）", (f) => {
  const p = f.addPage();
  const band = [0, 770, PAGE[0], 820];
  f.rect(p, band);
  f.text(p, "令和8年度 ○○市 事業計画（架空）", 40, 787, 18, WHITE);
  f.negative(p, "design_band", band, "字は帯の上に描かれている");
  const th = [60, 680, 535, 700];
  f.rect(p, th, rgb(0.2, 0.2, 0.2));
  ["項目", "金額", "備考"].forEach((s, i) => f.text(p, s, 70 + i * 160, 686, 11, WHITE));
  ["事業費", "1,000,000円", "架空"].forEach((s, i) => f.text(p, s, 70 + i * 160, 662, 11));
  f.negative(p, "table_header", th, "表の見出しの塗り。字は塗りのあと");
});

def("p6-d02-bars-and-underline", "字のない飾りの帯、字のすぐ横の黒い四角、字の下の黒い下線", (f) => {
  const p = f.addPage();
  const bar = [40, 740, 555, 748];
  f.rect(p, bar);
  f.negative(p, "decorative_bar", bar, "下に字がない飾り");
  const s = "■ 申請の方法";
  f.text(p, s, 90, 700);
  const side = [70, 699, 82, 711];
  f.rect(p, side);
  f.negative(p, "adjacent_box", side, "字のすぐ横の目印。字には重なっていない");
  const t = "提出期限：令和8年12月1日";
  f.text(p, t, 72, 660);
  const ul = [72, 657.5, 72 + f.width(t, 12), 659.5];
  f.rect(p, ul);
  f.negative(p, "underline", ul, "字の下端に少しかかる下線");
});

// 本物の蛍光ペンに合わせ、下の字が透ける描き方にする（PR #22 の返事の 2）。
// 灰色は不透明さ 0.4 の半透明、黄色は不透明のまま乗算（Multiply）で重ねる。どちらも下の字は見えている。
// 不透明な薄い色の四角の下の字は、P7 の漏れ（covered_light）として P7 の合成 PDF で扱う。
def("p6-d03-light-highlight", "薄い灰色（半透明）・黄色（乗算）のマーカーを字の上に重ねている（下の字が透けて見える）", (f) => {
  const p = f.addPage();
  const pre = "注意：", s = "提出は窓口でも受け付けます";
  f.text(p, pre + s, 72, 700);
  const b = f.spanBox(72, 700, 12, pre, s);
  f.rect(p, b, rgb(0.87, 0.87, 0.87), 0.4);
  f.negative(p, "light_highlight", b, "薄い灰色、不透明さ 0.4");
  const pre2 = "持ち物：", s2 = "本人確認書類";
  f.text(p, pre2 + s2, 72, 670);
  const b2 = f.spanBox(72, 670, 12, pre2, s2);
  f.rect(p, b2, rgb(1, 1, 0), 1, BlendMode.Multiply);
  f.negative(p, "light_highlight", b2, "黄色、乗算");
});

def("p6-d04-dark-photo", "暗い写真の上に、白い字の説明を載せている（字は写真のあと）", (f) => {
  const p = f.addPage();
  const rand = rng(404);
  const W = 300, H = 200;
  const px = new Uint8Array(W * H);
  for (let i = 0; i < px.length; i++) px[i] = 15 + Math.floor(rand() * 80);
  const box = [100, 450, 500, 717];
  f.placeImage(p, f.grayImage(W, H, px), box);
  f.text(p, "夜の○○市役所（架空）", 120, 470, 14, WHITE);
  f.negative(p, "dark_photo", box, "暗い写真。白い字は写真の上");
});

def("p6-d05-dark-cover-page", "黒い背景の表紙（字はすべて背景のあとに白で書いてある）", (f) => {
  const p = f.addPage();
  const bg = [0, 0, PAGE[0], PAGE[1]];
  f.rect(p, bg);
  f.text(p, "○○市 市民のしおり（架空）", 80, 500, 24, WHITE);
  f.text(p, "令和8年版", 80, 460, 16, WHITE);
  f.negative(p, "dark_background", bg, "黒い背景の表紙");
});

def("p6-d06-label-box", "黒い四角の上に、白い字で「非公開」と書いた（下には何もない）", (f) => {
  const p = f.addPage();
  const pre = "氏名：";
  f.text(p, pre, 72, 700);
  const b = f.spanBox(72, 700, 12, pre, "□□□□□□");
  f.rect(p, b);
  f.text(p, "非公開", b[0] + 4, 700, 12, WHITE);
  f.negative(p, "label_box", b, "下には字がなく、上に白い字");
});

// ===== 混ざったもの =====
def("p6-m01-two-pages", "1ページ目はデザインの帯だけ、2ページ目に見せかけの黒塗り", (f) => {
  const p1 = f.addPage();
  const band = [0, 790, PAGE[0], 842];
  f.rect(p1, band);
  f.text(p1, "お知らせ（架空）", 40, 808, 20, WHITE);
  f.text(p1, "このページには個人の情報はありません。", 72, 700);
  f.negative(p1, "design_band", band, "1ページ目の見出しの帯");
  const p2 = f.addPage();
  const pre = "受付番号 0012：", name = "田中四郎";
  f.text(p2, pre + name, 72, 700);
  const b = f.spanBox(72, 700, 12, pre, name);
  f.rect(p2, b);
  f.leak(p2, "text", "fill", b, { chars: countChars(name) });
});

// ---------- 作る ----------
const rows = [];
for (const b of builders) {
  const f = await new Fixture(b.name, b.description).init();
  b.fn(f);
  rows.push(await f.save());
}

// 出来上がりの一覧
const layerCover = (l) => `${l.layer}/${l.cover}`;
const totals = new Map();
for (const r of rows) for (const l of r.leaks) totals.set(layerCover(l), (totals.get(layerCover(l)) ?? 0) + 1);
const leakCount = rows.reduce((n, r) => n + r.leaks.length, 0);
const negCount = rows.reduce((n, r) => n + r.negatives.length, 0);
const md = [
  "# P6（見せかけの黒塗り）の合成 PDF の一覧",
  "",
  "`node fixtures/p6/build.mjs` で作り直せる。日時と乱数を固定しているので、作り直しても SHA-256 は変わらない。",
  "名前・住所などはすべて架空。字のフォントは BIZ UDゴシック（`fonts/OFL.txt`）。",
  "",
  `- 合成 PDF：${rows.length} 個`,
  `- 漏れ（検出率の分母）：${leakCount} 件`,
  `- 漏れでない黒い四角など（誤検知率の分母）：${negCount} 件`,
  "",
  "## 漏れの型ごとの件数",
  "",
  "| 層 / 覆っているもの | 件数 |",
  "|---|---|",
  ...[...totals.entries()].sort().map(([k, v]) => `| ${k} | ${v} |`),
  "",
  "## 一覧",
  "",
  "| ファイル | 何を再現しているか | ページ | 漏れ | 漏れでない | SHA-256（先頭16桁） |",
  "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.file} | ${r.description} | ${r.pages} | ${r.leaks.length} | ${r.negatives.length} | \`${r.sha256.slice(0, 16)}\` |`),
  "",
];
writeFileSync(path.join(HERE, "index.md"), md.join("\n"));
writeFileSync(path.join(HERE, "hashes.txt"), rows.map((r) => `${r.sha256}  ${r.file}`).join("\n") + "\n");
console.log(`合成 PDF ${rows.length} 個（漏れ ${leakCount} 件、漏れでない ${negCount} 件）を書きました`);

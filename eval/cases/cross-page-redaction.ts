// SPDX-License-Identifier: AGPL-3.0-only
//
// 同じ書式のページの塗り忘れ（cross-page-redaction）の合成 PDF。鍵は「open」（同じ書式の別のページで塗った位置が、塗られずに残る所 1 つ）。
// 中身はすべて架空。根拠の実物はスキャンの画像のページなので、様式の枠・見出し・欄の中身・黒い四角を、
// ページの全面の画像（灰色・Flate）の画素として描く。図形の命令では描かない。字の代わりに、幅のそろわない濃いかたまりを描く。

import { PDFDocument, PDFName } from "pdf-lib";
import type { CrossPageReport } from "../../rules/cross-page-redaction/index.ts";
import type { Case } from "./pdf.ts";

export const keysOf = (r: CrossPageReport) => r.findings.map(() => "open");

type Rect = { x: number; y: number; w: number; h: number };
/** 1 ページ分の描き方。form＝様式（a・b の 2 種）、seed＝欄の中身の違い、boxes＝黒く塗る所、empty＝中身を書かない欄の番号 */
type PageSpec = { form: "a" | "b"; seed: number; boxes: Rect[]; empty?: number[]; labels?: number; rule?: boolean };

const PW = 300;
const PH = 400;
const PX = 2; // 1pt あたりの点（144dpi）

/** 様式 a の欄（見出しの左端・欄の場所）。座標は pt・上が 0 */
const FORM_A = [
  { label: 30, field: { x: 100, y: 70, w: 160, h: 18 } },
  { label: 30, field: { x: 100, y: 110, w: 160, h: 18 } },
  { label: 30, field: { x: 100, y: 150, w: 160, h: 18 } },
  { label: 30, field: { x: 100, y: 190, w: 160, h: 18 } },
];
/** 名前の欄を塗る四角（様式 a の 1 番目の欄） */
const NAME_BOX: Rect = { x: 96, y: 66, w: 168, h: 26 };
/** 名前の欄を、大きめに塗った四角と、短く・少しずらして塗った四角（どちらも欄の中身は覆う。欄の中身は x 104〜250 まで） */
const WIDE_NAME_BOX: Rect = { x: 90, y: 60, w: 180, h: 36 };
const SHORT_NAME_BOX: Rect = { x: 101, y: 68, w: 154, h: 20 };

function drawPage(o: PageSpec): Uint8Array {
  const W = PW * PX;
  const H = PH * PX;
  const px = new Uint8Array(W * H).fill(240);
  let seed = 777 + o.seed * 9973;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const fill = (x: number, y: number, w: number, h: number) => {
    for (let yy = Math.max(0, Math.round(y * PX)); yy < Math.min(H, Math.round((y + h) * PX)); yy++)
      for (let xx = Math.max(0, Math.round(x * PX)); xx < Math.min(W, Math.round((x + w) * PX)); xx++) px[yy * W + xx] = 40;
  };
  /** 字の代わりのかたまり（同じ seed なら同じ形） */
  const text = (x: number, y: number, maxX: number, s: number) => {
    let t = 1000 + s * 31;
    const r = () => ((t = (t * 1103515245 + 12345) >>> 0) / 4294967296);
    let cx = x;
    while (cx < maxX) {
      const w = 5 + Math.floor(r() * 7);
      if (cx + w > maxX) break;
      fill(cx, y, w, 9);
      cx += w + 2 + Math.floor(r() * 4);
    }
  };
  if (o.form === "a") {
    // 様式 a：題・外の枠・欄ごとの見出しと下線
    text(90, 25, 210, 1);
    fill(20, 50, 260, 1);
    fill(20, 230, 260, 1);
    fill(20, 50, 1, 180);
    fill(279, 50, 1, 181);
    // 表の見出しと欄の間の縦の罫線（rule のとき）
    if (o.rule) fill(88, 50, 1, 180);
    FORM_A.forEach((f, i) => {
      // 見出しは、labels が同じなら、どのページでも同じ形（labels を変えると、罫線の位置は同じで見出しの字が違う別の表）
      text(f.label, f.field.y + 5, f.label + 50, 10 + i + (o.labels ?? 0) * 100);
      fill(f.field.x, f.field.y + f.field.h, f.field.w, 1);
      if (!o.empty?.includes(i)) text(f.field.x + 4, f.field.y + 5, f.field.x + f.field.w - 30 + Math.floor(rnd() * 20), 100 + o.seed * 10 + i);
    });
    for (let line = 0; line < 8; line++) text(30, 250 + line * 15, 270, 50 + o.seed * 20 + line);
  } else {
    // 様式 b：枠も見出しもない、右に寄せた本文だけの書類（字の行の並びも違う）
    text(150, 30, 270, 7);
    for (let line = 0; line < 20; line++) text(105 + (line % 3) * 6, 60 + line * 16, 285 - (line % 4) * 15, 300 + o.seed * 40 + line);
  }
  for (const b of o.boxes) fill(b.x, b.y, b.w, b.h);
  for (let i = 0; i < px.length; i++) px[i] = Math.max(0, Math.min(255, px[i]! + Math.round((rnd() - 0.5) * 16)));
  return px;
}

/** 架空の書類のスキャンを、ページごとに画素で描いて PDF にする */
async function scanPdf(pages: PageSpec[], rotate?: 90 | 180 | 270): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const p of pages) {
    const page = doc.addPage([PW, PH]);
    // 見せるときだけ回すページ（/Rotate）。画像と座標は回す前のまま
    if (rotate) page.node.set(PDFName.of("Rotate"), doc.context.obj(rotate));
    const img = doc.context.flateStream(drawPage(p), { Type: "XObject", Subtype: "Image", Width: PW * PX, Height: PH * PX, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
    page.node.setXObject(PDFName.of("Im0"), doc.context.register(img));
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(`q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`)));
  }
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

export const CASES: Case[] = [
  {
    id: "xp-l01",
    kind: "leak",
    description: "同じ様式の架空の申請書 2 ページ。1 ページ目は名前の欄を黒く塗り（下の画素は消えている）、2 ページ目の同じ欄は塗らずに残す",
    leaks: ["open"],
    build: () => scanPdf([
      { form: "a", seed: 1, boxes: [NAME_BOX] },
      { form: "a", seed: 2, boxes: [] },
    ]),
  },
  {
    id: "xp-l02",
    kind: "leak",
    description: "同じ様式の 3 ページ。1・3 ページ目は名前の欄を塗り、2 ページ目だけ塗り忘れる",
    leaks: ["open"],
    build: () => scanPdf([
      { form: "a", seed: 1, boxes: [NAME_BOX] },
      { form: "a", seed: 2, boxes: [] },
      { form: "a", seed: 3, boxes: [NAME_BOX] },
    ]),
  },
  {
    id: "xp-l03",
    kind: "leak",
    description: "同じ様式の 2 ページ。2 ページ目で 3 番目の欄を塗り、1 ページ目の同じ欄は残す（塗ったのが後ろのページ）",
    leaks: ["open"],
    build: () => scanPdf([
      { form: "a", seed: 4, boxes: [] },
      { form: "a", seed: 5, boxes: [{ x: 96, y: 146, w: 168, h: 26 }] },
    ]),
  },
  {
    id: "xp-l04",
    kind: "leak",
    description: "見出しと欄の間に縦の罫線がある同じ様式の 2 ページ。1 ページ目の名前の欄を塗り、2 ページ目の同じ欄は残す",
    leaks: ["open"],
    build: () => scanPdf([
      { form: "a", seed: 6, boxes: [NAME_BOX], rule: true },
      { form: "a", seed: 7, boxes: [], rule: true },
    ]),
  },
  {
    id: "xp-c05",
    kind: "control",
    description: "罫線と欄の位置は同じだが、見出しの字が違う 2 ページ（別の表）。片方の名前の欄の位置だけを塗ったもの",
    leaks: [],
    build: () => scanPdf([
      { form: "a", seed: 1, boxes: [NAME_BOX], rule: true },
      { form: "a", seed: 2, boxes: [], rule: true, labels: 1 },
    ]),
  },
  {
    id: "xp-c01",
    kind: "control",
    description: "同じ様式の 2 ページで、どちらも名前の欄を塗ったもの（正しい墨消し）",
    leaks: [],
    build: () => scanPdf([
      { form: "a", seed: 1, boxes: [NAME_BOX] },
      { form: "a", seed: 2, boxes: [NAME_BOX] },
    ]),
  },
  {
    id: "xp-c02",
    kind: "control",
    description: "様式の違う 2 ページで、片方の名前の欄だけを塗ったもの（もう片方の同じ位置は、関係のない本文）",
    leaks: [],
    build: () => scanPdf([
      { form: "a", seed: 1, boxes: [NAME_BOX] },
      { form: "b", seed: 2, boxes: [] },
    ]),
  },
  {
    id: "xp-c03",
    kind: "control",
    description: "同じ様式の 2 ページで、1 ページ目の名前の欄を塗り、2 ページ目の同じ欄は空のもの",
    leaks: [],
    build: () => scanPdf([
      { form: "a", seed: 1, boxes: [NAME_BOX] },
      { form: "a", seed: 2, boxes: [], empty: [0] },
    ]),
  },
  {
    id: "xp-c06",
    kind: "control",
    description: "同じ様式の 2 ページで、どちらも名前の欄を塗ったが、2 ページ目の黒い四角は短く、少しずれている（塗られずに見えている字はない）",
    leaks: [],
    build: () => scanPdf([
      { form: "a", seed: 1, boxes: [WIDE_NAME_BOX] },
      { form: "a", seed: 2, boxes: [SHORT_NAME_BOX] },
    ]),
  },
  {
    id: "xp-c07",
    kind: "control",
    description: "xp-c06 と同じ形を、見せるときに 270 度回すページ（/Rotate 270）で作ったもの",
    leaks: [],
    build: () => scanPdf([
      { form: "a", seed: 1, boxes: [WIDE_NAME_BOX] },
      { form: "a", seed: 2, boxes: [SHORT_NAME_BOX] },
    ], 270),
  },
  {
    id: "xp-c08",
    kind: "control",
    description: "同じ様式の 2 ページで、1 ページ目は名前の欄を 1 つの四角で塗り、2 ページ目は同じ欄の中身を、幅 30pt に届かない小さな四角に分けて塗ったもの",
    leaks: [],
    build: () => scanPdf([
      { form: "a", seed: 1, boxes: [NAME_BOX] },
      { form: "a", seed: 2, boxes: [0, 1, 2, 3, 4, 5].map((i) => ({ x: 102 + i * 26, y: 71, w: 22, h: 14 })) },
    ]),
  },
  {
    id: "xp-c09",
    kind: "control",
    description: "同じ様式の 2 ページで、1 ページ目は見出しの列（欄の名前）を塗り、2 ページ目は見出しを残して、となりの欄の中身を塗ったもの（見えているのは欄の名前だけ）",
    leaks: [],
    build: () => scanPdf([
      { form: "a", seed: 1, boxes: [{ x: 26, y: 68, w: 60, h: 62 }, { x: 96, y: 66, w: 168, h: 66 }] },
      { form: "a", seed: 2, boxes: [NAME_BOX, { x: 96, y: 106, w: 168, h: 26 }] },
    ]),
  },
  {
    id: "xp-c04",
    kind: "control",
    description: "1 ページだけの様式で、名前の欄を塗ったもの（比べる相手が無い）",
    leaks: [],
    build: () => scanPdf([{ form: "a", seed: 1, boxes: [NAME_BOX] }]),
  },
];

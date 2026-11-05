// SPDX-License-Identifier: AGPL-3.0-only
//
// 図形の層（P6 `p6-text` の layer: "vector"。1.13.0 から）の合成 PDF。
// 見つける段の3回目で見逃した型：パスで描いた字（曲線のない、直線だけの道。塗りと線の両方）の上に、白い不透明な四角の注釈（/Square）を重ねただけ。
// 鍵は "vector/<確からしさ>"。字の形は架空の多角形（どの字にも読めない、山形の形）。

import { PDFDocument, PDFName, type PDFContext, type PDFPage, type PDFRef } from "pdf-lib";
import { detectP6Text, type P6TextReport } from "../../rules/p6-text/index.ts";
import { save, type Case } from "./pdf.ts";

export const keysOf = (r: P6TextReport) => r.findings.filter((f) => f.layer === "vector").map((f) => `vector/${f.confidence}`);
export const detect = (b: Uint8Array) => detectP6Text(b);

/** 字1つ分の、直線だけの山形の道（幅 12・高さ 14、線分 7 本）。fill なら塗り、そうでなければ線 */
function glyph(x: number, y: number, fill: boolean): string {
  return `${x} ${y} m ${x + 3} ${y} l ${x + 6} ${y + 10} l ${x + 9} ${y} l ${x + 12} ${y} l ${x + 7} ${y + 14} l ${x + 5} ${y + 14} l h ${fill ? "f" : "S"}`;
}

/** 左下 (x, y) から横に n 字並べる */
function row(n: number, x: number, y: number, fill = true): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(glyph(x + (i % 14) * 14, y + Math.floor(i / 14) * 18, fill));
  return `q 0 g 0 G 0.6 w ${out.join(" ")} Q`;
}

type AnnotOpt = { rect?: [number, number, number, number]; ap?: boolean; ic?: number[]; f?: number; ca?: number };

function addSquare(ctx: PDFContext, page: PDFPage, o: AnnotOpt = {}): void {
  const rect = o.rect ?? [15, 75, 225, 130];
  const d: Record<string, unknown> = { Type: "Annot", Subtype: "Square", Rect: rect, F: o.f ?? 4, C: [1, 1, 1], IC: o.ic ?? [1, 1, 1] };
  if (o.ca !== undefined) d.CA = o.ca;
  if (o.ap !== false) {
    const w = rect[2] - rect[0];
    const h = rect[3] - rect[1];
    d.AP = { N: ctx.register(ctx.stream(`1 g 1 G 0 0 ${w} ${h} re B`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h] } as never)) };
  }
  const ref: PDFRef = ctx.register(ctx.obj(d as never));
  page.node.set(PDFName.of("Annots"), ctx.obj([ref]));
}

async function build(content: string, annot: AnnotOpt | null, opts: { inForm?: boolean; text?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  const res: Record<string, unknown> = {};
  if (opts.text) res.Font = { F1: ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" })) };
  let body = content;
  if (opts.inForm) {
    res.XObject = { Fm1: ctx.register(ctx.stream(content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 200] } as never)) };
    body = "q /Fm1 Do Q";
  }
  page.node.set(PDFName.of("Resources"), ctx.obj(res as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(body)));
  if (annot) addSquare(ctx, page, annot);
  return save(doc);
}

export const CASES: Case[] = [
  {
    id: "p6v-l01",
    kind: "leak",
    description: "塗り（f）で描いた字の形 28 個の上に、見た目のある白い四角の注釈",
    leaks: ["vector/check"],
    build: () => build(row(28, 20, 80), {}),
  },
  {
    id: "p6v-l02",
    kind: "leak",
    description: "線（S）で描いた字の形 20 個の上に、白い四角の注釈",
    leaks: ["vector/check"],
    build: () => build(row(20, 20, 80, false), {}),
  },
  {
    id: "p6v-l03",
    kind: "leak",
    description: "見た目のない白い四角の注釈（中の色 /IC だけ）の下に、字の形 16 個",
    leaks: ["vector/check"],
    build: () => build(row(16, 20, 80), { ap: false }),
  },
  {
    id: "p6v-l04",
    kind: "leak",
    description: "字の形を、フォーム XObject の中で描く",
    leaks: ["vector/check"],
    build: () => build(row(20, 20, 80), {}, { inForm: true }),
  },
  {
    id: "p6v-l05",
    kind: "leak",
    description: "道は 10 本だが、1本ごとに線分 60 本（合わせて 600。線分の数の線で出す）",
    leaks: ["vector/check"],
    build: () => {
      const paths: string[] = [];
      for (let p = 0; p < 10; p++) {
        const pts: string[] = [`${20 + p * 20} 80 m`];
        for (let k = 1; k <= 60; k++) pts.push(`${20 + p * 20 + (k % 2) * 6} ${80 + k * 0.6} l`);
        paths.push(`${pts.join(" ")} S`);
      }
      return build(`q 0 G 0.5 w ${paths.join(" ")} Q`, {});
    },
  },
  {
    id: "p6v-c01",
    kind: "control",
    description: "白い四角の注釈の下に、罫線1本だけ",
    leaks: [],
    build: () => build("q 0 G 1 w 20 100 m 220 100 l S Q", {}),
  },
  {
    id: "p6v-c02",
    kind: "control",
    description: "何も描いていない所の白い四角の注釈",
    leaks: [],
    build: () => build("", {}),
  },
  {
    id: "p6v-c03",
    kind: "control",
    description: "白い四角の注釈の下の字の形が 14 個（15 個の線の下。線分 98 本）",
    leaks: [],
    build: () => build(row(14, 20, 80), {}),
  },
  {
    id: "p6v-c04",
    kind: "control",
    description: "字の形 28 個の上に、注釈ではなく、ページの中身の白い塗り（図形の層では見ない）",
    leaks: [],
    build: () => build(`${row(28, 20, 80)} q 1 g 15 75 210 55 re f Q`, null),
  },
  {
    id: "p6v-c05",
    kind: "control",
    description: "字の形 28 個の上の白い四角の注釈が、隠した注釈（/F の Hidden）",
    leaks: [],
    build: () => build(row(28, 20, 80), { f: 2 }),
  },
  {
    id: "p6v-c06",
    kind: "control",
    description: "字の形 28 個の上の白い四角の注釈が、半透明（/CA 0.5）",
    leaks: [],
    build: () => build(row(28, 20, 80), { ca: 0.5 }),
  },
  {
    id: "p6v-c07",
    kind: "control",
    description: "字の形 28 個は、白い四角の注釈の外にある",
    leaks: [],
    build: () => build(row(28, 20, 10), { rect: [15, 140, 225, 190] }),
  },
  {
    id: "p6v-c08",
    kind: "control",
    description: "白い四角の注釈の下に、ふつうの字（文字の層で出すので、図形の層では2度出さない）と、字の形 20 個",
    leaks: [],
    build: () => build(`BT /F1 12 Tf 20 110 Td (Taro Yamada) Tj ET ${row(20, 20, 80)}`, {}, { text: true }),
  },
];

// SPDX-License-Identifier: AGPL-3.0-only
//
// 塗った下の字が、ほかの所に出ている（redacted-text-elsewhere）の合成 PDF。鍵は「塗った所のページ」（1 件ごと）。
// 中身はすべて架空（架空の地名 Sakuragaoka・架空の人名 Hanako Kumoi など）。字は欧文（Helvetica）で描く。
// 実物の根拠は、議事録で申請地の地名を黒い四角で塗ったが、同じ案件の別の段落に同じ地名が塗られずに出る形。
// 黒い四角の描き方は 2 つ：字のあとに四角を重ねた形（p6-text で拾う）と、四角のあとに黒い字を重ねた形（p7-hidden の same_color で拾う）。

import { PDFDocument, PDFName, StandardFonts, type PDFPage } from "pdf-lib";
import type { ElsewhereReport } from "../../rules/redacted-text-elsewhere/index.ts";
import { addAnnot, hex, save, setInfo, type Case } from "./pdf.ts";

export const keysOf = (r: ElsewhereReport) => r.findings.map((f) => `${f.page}`);

const esc = (s: string) => s.replace(/([()\\])/g, "\\$1");

type Line = { text: string; x?: number; y: number; color?: "black" | "white" };
type Box = { x: number; y: number; w: number; h: number; color?: "black" | "white"; order?: "after" | "before" };

/**
 * ページを 1 つ描く。lines は見える字（黒）。boxes の order が after（既定）なら、字のあとに四角を重ねる。
 * before なら、四角を先に描き、その上に under の字を同じ色で描く（見た目は黒塗り）
 */
async function page(doc: PDFDocument, p: PDFPage, lines: Line[], boxes: Array<Box & { under?: string }> = []) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  p.node.setFontDictionary(PDFName.of("F1"), font.ref);
  const rgb = (c?: "black" | "white") => (c === "white" ? "1 1 1" : "0 0 0");
  const text = (t: string, x: number, y: number, c?: "black" | "white") => `BT /F1 10 Tf ${rgb(c)} rg ${x} ${y} Td (${esc(t)}) Tj ET`;
  const ops: string[] = [];
  for (const l of lines) ops.push(text(l.text, l.x ?? 20, l.y, l.color));
  for (const b of boxes) {
    const fill = `${rgb(b.color)} rg ${b.x} ${b.y} ${b.w} ${b.h} re f`;
    const under = b.under ? text(b.under, b.x + 2, b.y + 3, b.color) : "";
    ops.push(b.order === "before" ? `${fill} ${under}` : `${under} ${fill}`);
  }
  p.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(ops.join("\n"))));
}

async function make(fn: (doc: PDFDocument, pages: PDFPage[]) => Promise<void>, n = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pages: PDFPage[] = [];
  for (let i = 0; i < n; i++) pages.push(doc.addPage([400, 300]));
  await fn(doc, pages);
  return save(doc);
}

const BOX = { x: 120, y: 245, w: 120, h: 16 };

export const CASES: Case[] = [
  {
    id: "rte-l01",
    kind: "leak",
    description: "1 ページ目で申請地の地名を黒い四角で塗った（字のあとに四角）が、2 ページ目の現地調査の報告に同じ地名が塗られずに出る",
    leaks: ["1"],
    build: () =>
      make(async (doc, [p1, p2]) => {
        await page(doc, p1!, [{ text: "Item 3  Location:", y: 250 }], [{ ...BOX, under: "Sakuragaoka 12-4" }]);
        await page(doc, p2!, [{ text: "Site visit: the field near Sakuragaoka hall was checked.", y: 250 }]);
      }),
  },
  {
    id: "rte-l02",
    kind: "leak",
    description: "黒い四角のあとに、同じ黒で地名を重ねた（見た目は黒塗り）。同じページの下の段落に同じ地名が出る",
    leaks: ["1"],
    build: () =>
      make(async (doc, [p1]) => {
        await page(doc, p1!, [{ text: "Item 5  Location:", y: 250 }, { text: "Report: the plot is next to Momijidai park.", y: 120 }], [{ ...BOX, y: 244, h: 13, under: "Momijidai 7", order: "before" }]);
      }, 1),
  },
  {
    id: "rte-l03",
    kind: "leak",
    description: "申請人の名前を塗ったが、文書情報のタイトルに同じ名前が残っている",
    leaks: ["1"],
    build: () =>
      make(async (doc, [p1]) => {
        await page(doc, p1!, [{ text: "Applicant:", y: 250 }], [{ ...BOX, under: "Hanako Kumoi" }]);
        setInfo(doc, { Title: hex("Minutes - application by Hanako Kumoi") });
      }, 1),
  },
  {
    id: "rte-l04",
    kind: "leak",
    description: "代理人の事務所名を塗ったが、注釈（コメント）の本文に同じ名前が残っている",
    leaks: ["1"],
    build: () =>
      make(async (doc, [p1]) => {
        await page(doc, p1!, [{ text: "Agent:", y: 250 }], [{ ...BOX, under: "Kumoi Office" }]);
        addAnnot(doc.context, p1!, { Subtype: "Text", Contents: hex("check Kumoi Office stamp") });
      }, 1),
  },
  {
    id: "rte-c01",
    kind: "control",
    description: "塗った下に字が残るが、同じ字はほかのどこにも出ない（p6-text だけが当たる形）",
    leaks: [],
    build: () =>
      make(async (doc, [p1, p2]) => {
        await page(doc, p1!, [{ text: "Item 3  Location:", y: 250 }], [{ ...BOX, under: "Sakuragaoka 12-4" }]);
        await page(doc, p2!, [{ text: "Site visit: the field was checked.", y: 250 }]);
      }),
  },
  {
    id: "rte-c02",
    kind: "control",
    description: "塗った下は番号だけ（数字と記号）。同じ番号が本文に出るが、数字だけの並びは数えない",
    leaks: [],
    build: () =>
      make(async (doc, [p1]) => {
        await page(doc, p1!, [{ text: "Receipt no.", y: 250 }, { text: "See 2024-0315 for details.", y: 120 }], [{ ...BOX, under: "2024-0315" }]);
      }, 1),
  },
  {
    id: "rte-c03",
    kind: "control",
    description: "正しい墨消し（下に字が無い）。地名は本文に出るが、塗った下の字が無いので、このルールでは比べられない",
    leaks: [],
    build: () =>
      make(async (doc, [p1]) => {
        await page(doc, p1!, [{ text: "Item 3  Location:", y: 250 }, { text: "near Sakuragaoka hall", y: 120 }], [{ ...BOX }]);
      }, 1),
  },
  {
    id: "rte-c04",
    kind: "control",
    description: "白い地の上の白い字（見えない字。黒塗りではない）が、本文と同じ字",
    leaks: [],
    build: () =>
      make(async (doc, [p1]) => {
        await page(doc, p1!, [{ text: "Sakuragaoka hall", y: 120 }], [{ ...BOX, color: "white", under: "Sakuragaoka hall", order: "before" }]);
      }, 1),
  },
  {
    id: "rte-c06",
    kind: "control",
    description: "字より背の高い黒い帯（見出しの帯）の上に、黒い字を置いた。同じ字が本文にも出るが、帯は字を囲む黒塗りの形ではない",
    leaks: [],
    build: () =>
      make(async (doc, [p1]) => {
        await page(doc, p1!, [{ text: "Chapter 2: Sakuragaoka hall plan", y: 120 }], [{ x: 0, y: 230, w: 400, h: 50, under: "Sakuragaoka hall plan", order: "before" }]);
      }, 1),
  },
  {
    id: "rte-c05",
    kind: "control",
    description: "同じ地名を 2 か所とも塗った（両方の下に字が残るが、塗られずに出る所は無い）",
    leaks: [],
    build: () =>
      make(async (doc, [p1, p2]) => {
        await page(doc, p1!, [{ text: "Item 3  Location:", y: 250 }], [{ ...BOX, under: "Sakuragaoka 12-4" }]);
        await page(doc, p2!, [{ text: "Site visit:", y: 250 }], [{ ...BOX, under: "Sakuragaoka 12-4" }]);
      }),
  },
];

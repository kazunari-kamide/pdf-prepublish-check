// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6（見せかけの黒塗り）の文字の層の判定の値を、合成 PDF の上で測る。
//   node eval/measure-p6-text.ts
//
// 判定をゆるめて（どんな色・形の塗りも拾う）、「先に描いた字に重なる塗り」を全部集め、
// それぞれの明るさと、字が隠れる割合のいちばん大きい値を出す。
// 正解データと照らし合わせ、「漏れ」「漏れでないもの」「どちらでもない」に分けて並べる。
// 画像（1.1.0 から）は、明るさの上限はそのままで、すべての画像の「濃い画素の割合」を測って並べる。
// 注釈も、ページのあとに重ねて読む（1.1.0 から）。
// 判定の値は、漏れと漏れでないものの間の開きの中に置く（推測で決めない）。

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PDFDocument } from "pdf-lib";
import { loadPdf } from "../rules/shared/load.ts";
import { area, intersectionArea } from "../rules/p6-text/geometry.ts";
import { scanAnnotations } from "../rules/p6-text/annotations.ts";
import { IDENTITY } from "../rules/p6-text/geometry.ts";
import { contentBytes, coverageOf, createPageScanner, type PageScan } from "../rules/p6-text/page.ts";
import type { P6TextSettings } from "../rules/p6-text/settings.ts";
import { DEFAULT_SETTINGS } from "../rules/p6-text/settings.ts";
import { overlap, type Expected } from "./match.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "fixtures", "p6");
const loose = { ...DEFAULT_SETTINGS, darkLuminanceMax: 1, opacityMin: 0, minStrokeWidth: 0 };
// 画像は、画素の明るさの上限はそのまま、覆いとみなす割合だけを 0 にする（すべての画像を並べる）
const looseImages = { ...DEFAULT_SETTINGS, opacityMin: 0, darkImageFractionMin: 0 };

function scanWith(doc: PDFDocument, page: ReturnType<PDFDocument["getPages"]>[number], settings: P6TextSettings): PageScan {
  const scanner = createPageScanner(doc.context, settings);
  scanner.run(contentBytes(doc.context, page.node.Contents()), page.node.Resources(), IDENTITY, "fill");
  scanAnnotations(doc.context, page.node.Annots(), scanner, settings);
  return scanner.result();
}

type ImageRow = { file: string; group: string; dark: number; covered: number };
const imageRows: ImageRow[] = [];

type Row = { file: string; group: string; how: string; luminance: number; covered: number };
const rows: Row[] = [];

for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".expected.json")).sort()) {
  const exp = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Expected;
  // 読み込みは検出ルールと同じ入口（暗号化した合成 PDF も、復号して測る）
  const loaded = await loadPdf(new Uint8Array(readFileSync(path.join(FIXTURES, exp.file))));
  if (loaded.status !== "ok") continue;
  const doc = loaded.doc;
  doc.getPages().forEach((page, i) => {
    const pageNo = i + 1;
    const scan = scanWith(doc, page, loose);
    const imgScan = scanWith(doc, page, looseImages);
    for (const c of imgScan.covers.filter((x) => x.how === "image")) {
      let best = 0;
      for (const g of imgScan.glyphs) {
        if (g.seq >= c.seq || g.isSpace) continue;
        const a = area(g.rect);
        if (a > 0) best = Math.max(best, coverageOf(c, g.rect) / a);
      }
      // ページ全体のスキャン画像は、どの正解の箱にも「小さいほうで割る重なり」で重なってしまうので、
      // 先に描いた字に重ならない画像は、正解と結ばずに「字に重ならない」とする
      const leak = best > 0 ? exp.leaks.find((l) => l.layer === "text" && l.page === pageNo && overlap(l.rect, c.rect) >= 0.5) : undefined;
      const neg = exp.negatives.find((n) => n.page === pageNo && overlap(n.rect, c.rect) >= 0.5 && n.kind === "dark_photo");
      const group = leak ? `漏れ(${leak.layer}/${leak.cover})` : neg ? `漏れでない(${neg.kind})` : best > 0 ? "どちらでもない" : "先に描いた字に重ならない";
      imageRows.push({ file: exp.file, group, dark: 1 - c.luminance, covered: best });
    }
    for (const c of scan.covers.filter((x) => x.how !== "image")) {
      let best = 0;
      for (const g of scan.glyphs) {
        if (g.seq >= c.seq || g.isSpace) continue;
        const a = area(g.rect);
        if (a > 0) best = Math.max(best, coverageOf(c, g.rect) / a);
      }
      if (best === 0) continue; // 先に描いた字に重ならない塗りは、判定に関係しない
      const leak = exp.leaks.find((l) => l.layer === "text" && l.page === pageNo && overlap(l.rect, c.rect) >= 0.5);
      const neg = exp.negatives.find((n) => n.page === pageNo && overlap(n.rect, c.rect) >= 0.5);
      const group = leak ? `漏れ(${leak.layer}/${leak.cover})` : neg ? `漏れでない(${neg.kind})` : "どちらでもない";
      rows.push({ file: exp.file, group, how: c.how, luminance: c.luminance, covered: best });
    }
  });
}

const fmt = (v: number) => v.toFixed(3);
console.log("先に描いた字に重なる塗り（判定をゆるめて集めたもの）");
console.log("ファイル | 分類 | 塗り方 | 明るさ | 字が隠れる割合の最大");
for (const r of rows) console.log(`${r.file} | ${r.group} | ${r.how} | ${fmt(r.luminance)} | ${fmt(r.covered)}`);

const groups = (pred: (r: Row) => boolean) => rows.filter(pred);
const range = (xs: number[]) => (xs.length ? `${fmt(Math.min(...xs))}〜${fmt(Math.max(...xs))}（${xs.length} 件）` : "なし");
const leaks = groups((r) => r.group.startsWith("漏れ("));
const others = groups((r) => !r.group.startsWith("漏れ("));
console.log();
console.log(`漏れの明るさ：${range(leaks.map((r) => r.luminance))}`);
console.log(`漏れでない・どちらでもないものの明るさ：${range(others.map((r) => r.luminance))}`);
console.log(`漏れの「字が隠れる割合」：${range(leaks.map((r) => r.covered))}`);
console.log(`漏れでない・どちらでもないもので、濃い（明るさ ${DEFAULT_SETTINGS.darkLuminanceMax} 以下）ものの「字が隠れる割合」：${range(others.filter((r) => r.luminance <= DEFAULT_SETTINGS.darkLuminanceMax).map((r) => r.covered))}`);

console.log();
console.log(`すべての画像の「濃い画素（明るさ ${DEFAULT_SETTINGS.darkLuminanceMax} 以下）の割合」`);
console.log("ファイル | 分類 | 濃い画素の割合 | 先に描いた字が隠れる割合の最大");
for (const r of imageRows) console.log(`${r.file} | ${r.group} | ${fmt(r.dark)} | ${fmt(r.covered)}`);
const imgLeaks = imageRows.filter((r) => r.group.startsWith("漏れ(text/"));
const imgOthers = imageRows.filter((r) => !r.group.startsWith("漏れ(text/"));
console.log(`字の層の漏れの覆いの画像：${range(imgLeaks.map((r) => r.dark))}`);
console.log(`それ以外の画像（暗い写真・スキャン画像など）：${range(imgOthers.map((r) => r.dark))}`);

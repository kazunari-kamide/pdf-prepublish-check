// SPDX-License-Identifier: AGPL-3.0-only
//
// 書体に残った字形（font-glyphs）の合成 PDF。鍵は「leftover」（余った字形のある書体1つにつき1つ）。
// 書体は、リポジトリにある BIZ UDゴシック（SIL Open Font License。P6 の合成 PDF と同じもの）を部分埋め込みで使う。
// 描かずに書体にだけ入れる字は、pdf-lib の encodeText（字の形を部分埋め込みの書体に入れるが、ページには描かない）で作る。字はすべて架空。

import { readFileSync } from "node:fs";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDict, PDFDocument, PDFName, rgb } from "pdf-lib";
import type { FontGlyphReport } from "../../rules/font-glyphs/index.ts";
import { save, type Case } from "./pdf.ts";

export const keysOf = (r: FontGlyphReport) => r.findings.map(() => "leftover");

const FONT = path.resolve(import.meta.dirname, "..", "..", "fixtures", "p6", "fonts", "BIZUDGothic-Regular.ttf");

/**
 * drawn をページに描き、extra は描かずに書体にだけ入れる。
 * pdf-lib は部分埋め込みの書体の名前に「ABCDEF+」の印を付けないので、Word や Acrobat などと同じ形（KAKUUA+…）に書き換える。
 * tag: false なら書き換えない（部分埋め込みの印の無い書体の対照）
 */
async function build(drawn: string, extra: string, opts: { tag?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(readFileSync(FONT), { subset: true });
  const page = doc.addPage([300, 200]);
  if (drawn) page.drawText(drawn, { x: 20, y: 100, size: 14, font, color: rgb(0, 0, 0) });
  if (extra) font.encodeText(extra);
  const first = await save(doc);
  if (opts.tag === false) return first;
  const again = await PDFDocument.load(first, { updateMetadata: false });
  for (const [, o] of again.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict)) continue;
    for (const key of ["BaseFont", "FontName"]) {
      const v = o.get(PDFName.of(key));
      if (v instanceof PDFName && v.decodeText().startsWith("BIZUDGothic")) o.set(PDFName.of(key), PDFName.of(`KAKUUA+${v.decodeText()}`));
    }
  }
  return save(again);
}

export const CASES: Case[] = [
  {
    id: "fg-l01",
    kind: "leak",
    description: "ページには「お知らせ」だけ。書体には、描かれていない「山田太郎様」の字形も残っている（消した字の手がかり）",
    leaks: ["leftover"],
    build: () => build("お知らせ", "山田太郎様"),
  },
  {
    id: "fg-l02",
    kind: "leak",
    description: "ページに字が1つも無い（全部消した）のに、書体に字形が残っている",
    leaks: ["leftover"],
    build: () => build("", "架空の申請者の住所"),
  },
  {
    id: "fg-c01",
    kind: "control",
    description: "描いた字だけの書体（余りなし）",
    leaks: [],
    build: () => build("山田太郎様へのお知らせ", ""),
  },
  {
    id: "fg-c02",
    kind: "control",
    description: "記号・空白が少し余るだけ（「、」と「・」と全角の空白。上限より少ない）",
    leaks: [],
    build: () => build("お知らせ", "、・　"),
  },
  {
    id: "fg-c03",
    kind: "control",
    description: "部分埋め込みの印（ABCDEF+）の無い書体は、全部を埋め込んだものとみなして見ない（余りがあっても出さない）",
    leaks: [],
    build: () => build("お知らせ", "山田太郎様", { tag: false }),
  },
];

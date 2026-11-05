// SPDX-License-Identifier: AGPL-3.0-only
//
// 書体に残った字形（font-glyphs）の合成 PDF。鍵は「leftover」（余った字形のある書体1つにつき1つ）。
// 書体は、リポジトリにある BIZ UDゴシック（SIL Open Font License。P6 の合成 PDF と同じもの）を部分埋め込みで使う。
// 描かずに書体にだけ入れる字は、pdf-lib の encodeText（字の形を部分埋め込みの書体に入れるが、ページには描かない）で作る。字はすべて架空。

import { readFileSync } from "node:fs";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDict, PDFDocument, PDFName, rgb, type PDFRef } from "pdf-lib";
import type { FontGlyphReport } from "../../rules/font-glyphs/index.ts";
import { save, type Case } from "./pdf.ts";

export const keysOf = (r: FontGlyphReport) => r.findings.map(() => "leftover");

const FONT = path.resolve(import.meta.dirname, "..", "..", "fixtures", "p6", "fonts", "BIZUDGothic-Regular.ttf");

/**
 * drawn をページに描き、extra は描かずに書体にだけ入れる。
 * pdf-lib は部分埋め込みの書体の名前に「ABCDEF+」の印を付けないので、Word や Acrobat などと同じ形（KAKUUA+…）に書き換える。
 * tag: false なら書き換えない（pdf-lib のままの、印の無い部分埋め込み）。full: true なら、書体を全部埋め込む（印も付けない）
 */
async function build(drawn: string, extra: string, opts: { tag?: boolean; full?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(readFileSync(FONT), { subset: !opts.full });
  const page = doc.addPage([300, 200]);
  if (drawn) page.drawText(drawn, { x: 20, y: 100, size: 14, font, color: rgb(0, 0, 0) });
  if (extra) font.encodeText(extra);
  const first = await save(doc);
  if (opts.tag === false || opts.full) return first;
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
    id: "fg-l04",
    kind: "leak",
    description: "部分埋め込みの印（ABCDEF+）の無い書体（pdf-lib のまま）でも、中身が部分埋め込みの形なら見る（1.2.0）。描かれていない「山田太郎様」の字形が残る",
    leaks: ["leftover"],
    build: () => build("お知らせ", "山田太郎様", { tag: false }),
  },
  {
    id: "fg-c05",
    kind: "control",
    description: "印の無い部分埋め込みで、ページで使う字形だけの書体（1.2.0）",
    leaks: [],
    build: () => build("お知らせします", "", { tag: false }),
  },
  {
    id: "fg-c06",
    kind: "control",
    description: "印が無く、書体を全部埋め込んだもの（字の対応表 cmap・名前の表 name がある）は、全部の字形が余りになるので見ない（1.2.0）",
    leaks: [],
    build: () => build("お知らせ", "", { full: true }),
  },
  {
    id: "fg-l03",
    kind: "leak",
    description: "Type3 の書体（1.1.0）：ページに描くのは A・B だけで、書体には描かれていない C〜F の字形も残っている",
    leaks: ["leftover"],
    build: () => buildType3("AB", "ABCDEF"),
  },
  {
    id: "fg-c04",
    kind: "control",
    description: "Type3 の書体：字形の A・B・C を、全部ページに描いている。形の無い字形（空白）は余っても数えない",
    leaks: [],
    build: () => buildType3("ABC", "ABC", true),
  },
];

/** Type3 の書体を作る。glyphs の字ごとに四角を描く字形を入れ、shown をページに描く。space なら、形の無い字形 space も入れる */
async function buildType3(shown: string, glyphs: string, space = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  const procs: Record<string, PDFRef> = {};
  const diffs: Array<number | PDFName> = [65];
  for (const ch of glyphs) {
    procs[ch] = ctx.register(ctx.stream(`600 0 0 0 600 700 d1 0 0 ${100 + ch.charCodeAt(0)} 700 re f`));
    diffs.push(PDFName.of(ch));
  }
  if (space) {
    procs["space"] = ctx.register(ctx.stream("300 0 d0"));
    diffs.push(32, PDFName.of("space"));
  }
  const font = ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "Type3",
      FontBBox: [0, 0, 700, 700],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: ctx.obj(procs as never),
      Encoding: ctx.obj({ Type: "Encoding", Differences: diffs } as never),
      FirstChar: 32,
      LastChar: 90,
      Widths: Array.from({ length: 59 }, () => 600),
      Resources: ctx.obj({}),
    } as never),
  );
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: ctx.obj({ T3: font } as never) } as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(`BT /T3 12 Tf 20 100 Td (${shown}${space ? " " : ""}) Tj ET`)));
  return save(doc);
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// しおりの題と代わりの文字（alt-text）の合成 PDF。鍵は「種類:場所」。字はすべて架空。

import { PDFName, StandardFonts, type PDFDocument, type PDFPage } from "pdf-lib";
import type { AltReport } from "../../rules/alt-text/index.ts";
import { hex, newDoc, placeJpeg, save, tinyJpeg, type Case } from "./pdf.ts";

export const keysOf = (r: AltReport) => r.findings.map((f) => `${f.kind}:${f.where}`);

/** 標準の書体 F1 で、描く命令をそのまま書く */
async function withContent(doc: PDFDocument, page: PDFPage, body: string, properties?: Record<string, unknown>) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  page.node.set(PDFName.of("Resources"), ctx.obj({ Font: { F1: font.ref }, ...(properties ? { Properties: properties } : {}) } as never));
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(body)));
}

export const CASES: Case[] = [
  {
    id: "alt-l01",
    kind: "leak",
    description: "描いた字（Draft）と違う /ActualText（コピーすると別の字が出る）",
    leaks: ["actual_text_diff:page"],
    async build() {
      const { doc, pages } = await newDoc();
      await withContent(doc, pages[0]!, "/Span <</ActualText (Taro Yamada 0120)>> BDC BT /F1 12 Tf 20 100 Td (Draft) Tj ET EMC");
      return save(doc);
    },
  },
  {
    id: "alt-l02",
    kind: "leak",
    description: "名前つきの属性（/Properties）の /ActualText が、描いた字と違う",
    leaks: ["actual_text_diff:page"],
    async build() {
      const { doc, pages } = await newDoc();
      await withContent(doc, pages[0]!, "/Span /MC0 BDC BT /F1 12 Tf 20 100 Td (OK) Tj ET EMC", { MC0: { ActualText: hex("架空の別の文") } });
      return save(doc);
    },
  },
  {
    id: "alt-l03",
    kind: "leak",
    description: "しおりの題（2つ。入れ子）",
    leaks: ["outline:outlines"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const root = ctx.nextRef();
      const a = ctx.nextRef();
      const b = ctx.nextRef();
      ctx.assign(b, ctx.obj({ Title: hex("内部用メモ"), Parent: a, Dest: [pages[0]!.ref, PDFName.of("Fit")] } as never));
      ctx.assign(a, ctx.obj({ Title: hex("第1章"), Parent: root, First: b, Last: b, Count: 1, Dest: [pages[0]!.ref, PDFName.of("Fit")] } as never));
      ctx.assign(root, ctx.obj({ Type: "Outlines", First: a, Last: a, Count: 2 } as never));
      doc.catalog.set(PDFName.of("Outlines"), root);
      return save(doc);
    },
  },
  {
    id: "alt-l04",
    kind: "leak",
    description: "構造の図の読み上げ用の説明（/Alt）",
    leaks: ["alt:structure"],
    async build() {
      const { doc, ctx } = await newDoc();
      const fig = ctx.obj({ S: "Figure", Alt: hex("架空の地図") });
      doc.catalog.set(PDFName.of("StructTreeRoot"), ctx.obj({ Type: "StructTreeRoot", K: [ctx.obj({ S: "Document", K: [fig] })] } as never));
      return save(doc);
    },
  },
  {
    id: "alt-l05",
    kind: "leak",
    description: "字を描いていない所（画像）の /ActualText",
    leaks: ["alt:page"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      placeJpeg(ctx, pages[0]!, tinyJpeg());
      pages[0]!.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("/Figure <</ActualText (photo)>> BDC q 100 0 0 100 10 10 cm /Im1 Do Q EMC")));
      return save(doc);
    },
  },
  {
    id: "alt-c01",
    kind: "control",
    description: "描いた字と同じ /ActualText（空白の違いだけ）と、全角・半角の違いだけ（合字・異体字を直す使い方）",
    leaks: [],
    async build() {
      const { doc, pages } = await newDoc();
      await withContent(
        doc,
        pages[0]!,
        "/Span <</ActualText (office hours)>> BDC BT /F1 12 Tf 20 100 Td (officehours) Tj ET EMC " +
          `/Span <</ActualText <${Buffer.from("﻿ＡＢＣ", "utf16le").swap16().toString("hex")}>>> BDC BT /F1 12 Tf 20 80 Td (ABC) Tj ET EMC`,
      );
      return save(doc);
    },
  },
  {
    id: "alt-c02",
    kind: "control",
    description: "しおりも構造も /ActualText も無い（ふつうの字だけ）",
    leaks: [],
    async build() {
      const { doc, pages } = await newDoc();
      await withContent(doc, pages[0]!, "BT /F1 12 Tf 20 100 Td (Hello) Tj ET");
      return save(doc);
    },
  },
];

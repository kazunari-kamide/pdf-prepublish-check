// SPDX-License-Identifier: AGPL-3.0-only
//
// P8（注釈）の合成 PDF。鍵は「欄:hidden」か「欄:shown」（隠しの印のある注釈か）。名前はすべて架空。

import { PDFName } from "pdf-lib";
import type { P8Report } from "../../rules/p8-annot/index.ts";
import { addAnnot, hex, lit, newDoc, save, shapeAppearance, textAppearance, type Case } from "./pdf.ts";

export const keysOf = (r: P8Report) => r.findings.map((f) => `${f.field}:${f.hidden ? "hidden" : "shown"}`);

const HIDDEN = 2;
const PRINT = 4;
const NO_VIEW = 32;
const READ_ONLY = 64;
const LOCKED = 128;

export const CASES: Case[] = [
  {
    id: "p8-l01",
    kind: "leak",
    description: "作成者欄（/T）にローマ字の姓",
    leaks: ["T:shown"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      addAnnot(ctx, pages[0]!, { Subtype: "Square", T: lit("yamada"), F: PRINT });
      return save(doc);
    },
  },
  {
    id: "p8-l02",
    kind: "leak",
    description: "隠しの印（Hidden）の付箋の注釈に、内容（/Contents）",
    leaks: ["Contents:hidden"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      addAnnot(ctx, pages[0]!, { Subtype: "Text", Contents: hex("この欄は架空の申請者の連絡先を確認"), F: HIDDEN });
      return save(doc);
    },
  },
  {
    id: "p8-l03",
    kind: "leak",
    description: "NoView の印の四角の注釈に、作成者と内容",
    leaks: ["T:hidden", "Contents:hidden"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      addAnnot(ctx, pages[0]!, { Subtype: "Square", T: hex("山田太郎"), Contents: hex("要確認"), F: NO_VIEW | PRINT });
      return save(doc);
    },
  },
  {
    id: "p8-l04",
    kind: "leak",
    description: "隠しの印のスタンプ注釈で、字が見た目のストリーム（/AP）の中だけにある",
    leaks: ["AP:hidden"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const ap = await textAppearance(doc, "DRAFT Yamada 0123");
      addAnnot(ctx, pages[0]!, { Subtype: "Stamp", Name: "Draft", F: HIDDEN | PRINT, AP: { N: ap } });
      return save(doc);
    },
  },
  {
    id: "p8-l05",
    kind: "leak",
    description: "隠しの印のスタンプ注釈で、字が見た目の中の部品（入れ子のフォーム XObject）の中にある",
    leaks: ["AP:hidden"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const inner = await textAppearance(doc, "Suzuki Hanako");
      const outer = ctx.register(
        ctx.stream("q /X1 Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 70, 30], Resources: { XObject: { X1: inner } } }),
      );
      addAnnot(ctx, pages[0]!, { Subtype: "Stamp", F: HIDDEN, AP: { N: outer } });
      return save(doc);
    },
  },
  {
    id: "p8-l06",
    kind: "leak",
    description: "リッチテキストの内容（/RC）と、2ページにまたがる同じ作成者（1件にまとまる）",
    leaks: ["T:shown", "RC:shown"],
    async build() {
      const { doc, ctx, pages } = await newDoc(2);
      addAnnot(ctx, pages[0]!, {
        Subtype: "FreeText",
        T: hex("佐藤"),
        RC: lit('<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p>確認済み</p></body>'),
      });
      addAnnot(ctx, pages[1]!, { Subtype: "Text", T: hex("佐藤") });
      return save(doc);
    },
  },
  {
    id: "p8-c01",
    kind: "control",
    description: "読み取り専用・ロック・印刷の印の注釈（隠しではない）。見た目に字があるが、見えている",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const ap = await textAppearance(doc, "APPROVED");
      addAnnot(ctx, pages[0]!, { Subtype: "Stamp", F: PRINT | READ_ONLY | LOCKED, AP: { N: ap } });
      return save(doc);
    },
  },
  {
    id: "p8-c02",
    kind: "control",
    description: "隠しの印の注釈だが、見た目は図形だけ（字なし）",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      addAnnot(ctx, pages[0]!, { Subtype: "Square", F: HIDDEN, AP: { N: shapeAppearance(ctx) } });
      return save(doc);
    },
  },
  {
    id: "p8-c03",
    kind: "control",
    description: "決まり文句の作成者（Author・ユーザー）と、数字だけの作成者",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      addAnnot(ctx, pages[0]!, { Subtype: "Text", T: lit("Author") });
      addAnnot(ctx, pages[0]!, { Subtype: "Text", T: hex("ユーザー"), F: HIDDEN });
      addAnnot(ctx, pages[0]!, { Subtype: "Text", T: lit("00123") });
      return save(doc);
    },
  },
  {
    id: "p8-c04",
    kind: "control",
    description: "フォームの欄（Widget）と吹き出し（Popup）。リンクの注釈（字なし）",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      addAnnot(ctx, pages[0]!, { Subtype: "Widget", T: lit("name"), F: HIDDEN });
      addAnnot(ctx, pages[0]!, { Subtype: "Popup", T: lit("yamada"), F: HIDDEN });
      addAnnot(ctx, pages[0]!, { Subtype: "Link", Border: [0, 0, 0], A: { S: "GoTo", D: [pages[0]!.ref, PDFName.of("Fit")] } });
      return save(doc);
    },
  },
];

// SPDX-License-Identifier: AGPL-3.0-only
//
// P11（フォームの値）の合成 PDF。鍵は「見え方:欄の種類」。値はすべて架空。

import { PDFName, type PDFContext, type PDFDocument, type PDFRef } from "pdf-lib";
import type { P11Report } from "../../rules/p11-forms/index.ts";
import { addAnnot, hex, lit, newDoc, save, type Case } from "./pdf.ts";

export const keysOf = (r: P11Report) => r.findings.map((f) => `${f.visibility}:${f.fieldType}`);

const HIDDEN = 2;
const NO_VIEW = 32;

function setFields(doc: PDFDocument, ctx: PDFContext, fields: PDFRef[]) {
  doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: fields } as never));
}

export const CASES: Case[] = [
  {
    id: "p11-l01",
    kind: "leak",
    description: "見えるテキストの欄に、入力した氏名",
    leaks: ["visible:text"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const w = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Tx", T: lit("name"), V: hex("山田太郎") });
      setFields(doc, ctx, [w]);
      return save(doc);
    },
  },
  {
    id: "p11-l02",
    kind: "leak",
    description: "ウィジェットの無い欄に、値だけが残っている",
    leaks: ["no_widget:text"],
    async build() {
      const { doc, ctx } = await newDoc();
      const f = ctx.register(ctx.obj({ FT: "Tx", T: lit("memo"), V: hex("架空の連絡先 090-0000-0000") } as never));
      setFields(doc, ctx, [f]);
      return save(doc);
    },
  },
  {
    id: "p11-l03",
    kind: "leak",
    description: "隠しの印（Hidden）のウィジェットの欄と、NoView のウィジェットのチェックボックス（オン）",
    leaks: ["hidden:text", "hidden:button"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const w1 = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Tx", T: lit("note"), V: hex("内部の確認用"), F: HIDDEN });
      const w2 = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Btn", T: lit("agree"), V: PDFName.of("Yes"), AS: PDFName.of("Yes"), F: NO_VIEW });
      setFields(doc, ctx, [w1, w2]);
      return save(doc);
    },
  },
  {
    id: "p11-l04",
    kind: "leak",
    description: "大きさ 0 のウィジェットの欄",
    leaks: ["hidden:text"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const w = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Tx", T: lit("x"), V: lit("Suzuki"), Rect: [50, 50, 50, 50] });
      setFields(doc, ctx, [w]);
      return save(doc);
    },
  },
  {
    id: "p11-l05",
    kind: "leak",
    description: "親子の欄（親に種類、子に値とウィジェット）と、複数選べる選択の欄（値が配列）",
    leaks: ["visible:text", "visible:choice"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const parent = ctx.register(ctx.obj({ FT: "Tx", T: lit("applicant") } as never));
      const child = ctx.register(ctx.obj({ T: lit("address"), Parent: parent, V: hex("架空県架空市1-2-3") } as never));
      const widget = addAnnot(ctx, pages[0]!, { Subtype: "Widget", Parent: child });
      (ctx.lookup(child) as import("pdf-lib").PDFDict).set(PDFName.of("Kids"), ctx.obj([widget]));
      (ctx.lookup(parent) as import("pdf-lib").PDFDict).set(PDFName.of("Kids"), ctx.obj([child]));
      const ch = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Ch", Ff: 2097152, T: lit("items"), V: [lit("A"), lit("C")], Opt: [lit("A"), lit("B"), lit("C")] });
      setFields(doc, ctx, [parent, ch]);
      return save(doc);
    },
  },
  {
    id: "p11-l06",
    kind: "leak",
    description: "ウィジェットはあるが、どのページにも置かれていない",
    leaks: ["no_widget:text"],
    async build() {
      const { doc, ctx } = await newDoc();
      const w = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [10, 10, 80, 30], FT: "Tx", T: lit("old"), V: hex("前の担当者") } as never));
      setFields(doc, ctx, [w]);
      return save(doc);
    },
  },
  {
    id: "p11-c01",
    kind: "control",
    description: "空・空白だけの値と、オフのチェックボックス",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const w1 = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Tx", T: lit("a"), V: lit("") });
      const w2 = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Tx", T: lit("b"), V: hex("  "), F: HIDDEN });
      const w3 = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Btn", T: lit("c"), V: PDFName.of("Off"), AS: PDFName.of("Off") });
      setFields(doc, ctx, [w1, w2, w3]);
      return save(doc);
    },
  },
  {
    id: "p11-c02",
    kind: "control",
    description: "値（/V）の無い欄（既定の値 /DV だけ）と、署名の欄",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const w1 = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Tx", T: lit("d"), DV: lit("default") });
      const sig = ctx.register(ctx.obj({ Type: "Sig", Filter: "Adobe.PPKLite", Contents: hex("00") } as never));
      const w2 = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Sig", T: lit("sig"), V: sig });
      setFields(doc, ctx, [w1, w2]);
      return save(doc);
    },
  },
  {
    id: "p11-c03",
    kind: "control",
    description: "フォームの無い PDF",
    leaks: [],
    async build() {
      const { doc } = await newDoc();
      return save(doc);
    },
  },
];

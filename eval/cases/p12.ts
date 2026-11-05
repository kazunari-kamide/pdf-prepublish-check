// SPDX-License-Identifier: AGPL-3.0-only
//
// P12（JavaScript・開いたときの動作）の合成 PDF。鍵は「種類:場所」。スクリプトは何もしない架空のもの。

import { PDFName } from "pdf-lib";
import type { P12Report } from "../../rules/p12-actions/index.ts";
import { addAnnot, lit, newDoc, save, type Case } from "./pdf.ts";

export const keysOf = (r: P12Report) => r.findings.flatMap((f) => Array.from({ length: f.count }, () => `${f.kind}:${f.where}`));

const JS = (code: string) => ({ S: "JavaScript", JS: lit(code) });

export const CASES: Case[] = [
  {
    id: "p12-l01",
    kind: "leak",
    description: "文書の JavaScript の一覧（/Names /JavaScript）",
    leaks: ["javascript:names"],
    async build() {
      const { doc, ctx } = await newDoc();
      const action = ctx.register(ctx.obj(JS("var x = 1;") as never));
      doc.catalog.set(PDFName.of("Names"), ctx.obj({ JavaScript: { Names: [lit("init"), action] } } as never));
      return save(doc);
    },
  },
  {
    id: "p12-l02",
    kind: "leak",
    description: "開いたときの動作（/OpenAction）が JavaScript。中身はストリーム",
    leaks: ["javascript:open_action"],
    async build() {
      const { doc, ctx } = await newDoc();
      const js = ctx.register(ctx.stream("app.alert('test');"));
      doc.catalog.set(PDFName.of("OpenAction"), ctx.obj({ S: "JavaScript", JS: js } as never));
      return save(doc);
    },
  },
  {
    id: "p12-l03",
    kind: "leak",
    description: "印刷の前の JavaScript（カタログの /AA /WP）と、開いたときにほかのファイルを開く動作（Launch）",
    leaks: ["javascript:document_aa", "launch:open_action"],
    async build() {
      const { doc, ctx } = await newDoc();
      doc.catalog.set(PDFName.of("AA"), ctx.obj({ WP: JS("var y = 2;") } as never));
      doc.catalog.set(PDFName.of("OpenAction"), ctx.obj({ S: "Launch", F: lit("example.txt") } as never));
      return save(doc);
    },
  },
  {
    id: "p12-l04",
    kind: "leak",
    description: "ページを開いたときに URL を開く（ページの /AA /O）",
    leaks: ["uri:page_aa"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      pages[0]!.node.set(PDFName.of("AA"), ctx.obj({ O: { S: "URI", URI: lit("https://example.invalid/") } } as never));
      return save(doc);
    },
  },
  {
    id: "p12-l05",
    kind: "leak",
    description: "リンクの注釈を押すと JavaScript",
    leaks: ["javascript:annotation"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      addAnnot(ctx, pages[0]!, { Subtype: "Link", A: JS("var z = 3;") });
      return save(doc);
    },
  },
  {
    id: "p12-l06",
    kind: "leak",
    description: "フォームの欄の、入力の形を整える JavaScript（ウィジェットの /AA /F）と、入力を送るボタン（SubmitForm）",
    leaks: ["javascript:field", "submit_form:field"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const w1 = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Tx", T: lit("amount"), AA: { F: JS("AFNumber_Format(0);") } });
      const w2 = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Btn", Ff: 65536, T: lit("send"), A: { S: "SubmitForm", F: { FS: "URL", F: lit("https://example.invalid/") } } });
      doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [w1, w2] } as never));
      return save(doc);
    },
  },
  {
    id: "p12-l07",
    kind: "leak",
    description: "開いたときの動作は同じ文書の中へ移るだけだが、続きの動作（/Next）が JavaScript",
    leaks: ["javascript:open_action"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      doc.catalog.set(PDFName.of("OpenAction"), ctx.obj({ S: "GoTo", D: [pages[0]!.ref, PDFName.of("Fit")], Next: JS("var n = 0;") } as never));
      return save(doc);
    },
  },
  {
    id: "p12-l08",
    kind: "leak",
    description: "どこからも指されていない JavaScript の動作（ファイルに残っている）",
    leaks: ["javascript:other"],
    async build() {
      const { doc, ctx } = await newDoc();
      ctx.register(ctx.obj(JS("var left = true;") as never));
      return save(doc);
    },
  },
  {
    id: "p12-c01",
    kind: "control",
    description: "開いたときに1ページ目を全体表示（行き先の配列）",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      doc.catalog.set(PDFName.of("OpenAction"), ctx.obj([pages[0]!.ref, PDFName.of("Fit")]));
      return save(doc);
    },
  },
  {
    id: "p12-l09",
    kind: "leak",
    description: "押したときに外のウェブのページを開くリンクと、フォームのボタンの URL（1.1.0 から、行き先を確かめてもらう低い件として数える）",
    leaks: ["uri:annotation", "uri:field"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      addAnnot(ctx, pages[0]!, { Subtype: "Link", A: { S: "URI", URI: lit("https://example.invalid/") } });
      const w = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Btn", Ff: 65536, T: lit("web"), A: { S: "URI", URI: lit("https://example.invalid/") } });
      doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [w] } as never));
      return save(doc);
    },
  },
  {
    id: "p12-c02",
    kind: "control",
    description: "同じ文書の中のページへ移るリンクと、名前つきの動作「次のページ」",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc(2);
      addAnnot(ctx, pages[0]!, { Subtype: "Link", A: { S: "GoTo", D: [pages[1]!.ref, PDFName.of("Fit")] } });
      addAnnot(ctx, pages[0]!, { Subtype: "Link", A: { S: "Named", N: "NextPage" } });
      return save(doc);
    },
  },
  {
    id: "p12-c04",
    kind: "control",
    description: "押したときだけ動く、別のファイルへのリンク（GoToR）とファイルを開くリンク（Launch）",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      addAnnot(ctx, pages[0]!, { Subtype: "Link", A: { S: "GoToR", F: lit("appendix.pdf"), D: [0, PDFName.of("Fit")] } });
      addAnnot(ctx, pages[0]!, { Subtype: "Link", A: { S: "Launch", F: lit("appendix.xlsx") } });
      return save(doc);
    },
  },
  {
    id: "p12-c03",
    kind: "control",
    description: "動作のない PDF",
    leaks: [],
    async build() {
      const { doc } = await newDoc();
      return save(doc);
    },
  },
];

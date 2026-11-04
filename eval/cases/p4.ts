// SPDX-License-Identifier: AGPL-3.0-only
//
// P4（ファイルパス・内部ホスト名）の合成 PDF。鍵は「種類:場所」。パス・サーバー名はすべて架空。

import { PDFName } from "pdf-lib";
import type { P4Report } from "../../rules/p4-paths/index.ts";
import { addAnnot, hex, lit, newDoc, save, setCatalogXmp, setInfo, xmpPacket, type Case } from "./pdf.ts";

export const keysOf = (r: P4Report) => r.findings.map((f) => `${f.kind}:${f.where}`);

export const CASES: Case[] = [
  {
    id: "p4-l01",
    kind: "leak",
    description: "文書情報のタイトルに、ユーザーのフォルダのパス",
    leaks: ["user_path:info"],
    async build() {
      const { doc } = await newDoc();
      setInfo(doc, { Title: hex("C:\\Users\\yamada\\Desktop\\案.docx") });
      return save(doc);
    },
  },
  {
    id: "p4-l02",
    kind: "leak",
    description: "注釈の内容に、共有フォルダ（\\\\サーバー\\共有）",
    leaks: ["server:annotation"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      addAnnot(ctx, pages[0]!, { Subtype: "Text", Contents: hex("原本は \\\\kakuu-fs01\\共有\\資料 にあります") });
      return save(doc);
    },
  },
  {
    id: "p4-l03",
    kind: "leak",
    description: "リンクの行き先が file:// の URL と、点の無いホスト名の URL（内向きのサーバー）",
    leaks: ["user_path:link", "server:link"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      addAnnot(ctx, pages[0]!, { Subtype: "Link", A: { S: "URI", URI: lit("file:///C:/Users/suzuki/Documents/a.xlsx") } });
      addAnnot(ctx, pages[0]!, { Subtype: "Link", A: { S: "URI", URI: lit("http://intranet/portal/") } });
      return save(doc);
    },
  },
  {
    id: "p4-l04",
    kind: "leak",
    description: "XMP の中の、ドライブ名から始まるパス（ユーザーのフォルダなし）と、内向きの IP アドレス",
    leaks: ["drive_path:xmp", "server:xmp"],
    async build() {
      const { doc } = await newDoc();
      setCatalogXmp(doc, xmpPacket("", '<xmpMM:DerivedFrom stRef:filePath="D:\\広報\\2026\\号外.indd"/><dc:source>http://192.168.0.10/share/</dc:source>'), true);
      return save(doc);
    },
  },
  {
    id: "p4-l05",
    kind: "leak",
    description: "別のファイルへ移るリンクの、ファイル指定の中のパス（二重に数えない）",
    leaks: ["user_path:link"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const fs = ctx.register(ctx.obj({ Type: "Filespec", F: hex("C:\\Users\\tanaka\\別紙.pdf") } as never));
      addAnnot(ctx, pages[0]!, { Subtype: "Link", A: { S: "GoToR", F: fs, D: [0, PDFName.of("Fit")] } });
      return save(doc);
    },
  },
  {
    id: "p4-c01",
    kind: "control",
    description: "ふつうの URL・相対パス・ドライブ名の無いファイル名・「C言語」「Q:A」のような字",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      setInfo(doc, { Title: hex("C言語の入門 Q:A 集"), Subject: hex("別紙.pdf を参照") });
      addAnnot(ctx, pages[0]!, { Subtype: "Link", A: { S: "URI", URI: lit("https://www.example.jp/a/b.html") } });
      addAnnot(ctx, pages[0]!, { Subtype: "Link", A: { S: "GoToR", F: lit("../appendix.pdf"), D: [0, PDFName.of("Fit")] } });
      addAnnot(ctx, pages[0]!, { Subtype: "Text", Contents: hex("時刻 10:30 / 比 3:2 / mailto:info@example.jp") });
      return save(doc);
    },
  },
  {
    id: "p4-c02",
    kind: "control",
    description: "XMP の名前空間の URL（http://ns.adobe.com/…）と、点のあるホスト名だけ",
    leaks: [],
    async build() {
      const { doc } = await newDoc();
      setCatalogXmp(doc, xmpPacket('xmp:CreatorTool="Microsoft Word"', "<dc:source>https://example.jp/</dc:source>"), false);
      return save(doc);
    },
  },
];

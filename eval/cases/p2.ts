// SPDX-License-Identifier: AGPL-3.0-only
//
// P2（文書全体の XMP）の合成 PDF。鍵は「種類:欄」。名前・パスはすべて架空。

import type { P2XmpReport } from "../../rules/p2-xmp/index.ts";
import { hex, newDoc, save, setCatalogXmp, setInfo, xmpPacket, type Case } from "./pdf.ts";

export const keysOf = (r: P2XmpReport) => r.findings.map((f) => `${f.kind}:${f.field}`);

const SOFTWARE_ONLY = [
  'xmp:CreatorTool="Microsoft Word" pdf:Producer="架空の PDF 書き出し 2.0"',
  'xmpMM:DocumentID="uuid:0f1e2d3c-0000-4000-8000-000000000001" xmpMM:InstanceID="uuid:0f1e2d3c-0000-4000-8000-000000000002"',
  'xmp:CreateDate="2026-10-01T09:00:00+09:00" xmp:ModifyDate="2026-10-02T09:00:00+09:00"',
].join(" ");

const one = (attrs: string, body: string, compressed: boolean) => async () => {
  const { doc } = await newDoc();
  setCatalogXmp(doc, xmpPacket(attrs, body), compressed);
  return save(doc);
};

export const CASES: Case[] = [
  {
    id: "p2-l01",
    kind: "leak",
    description: "圧縮なしの XMP の dc:creator に、人名",
    leaks: ["person:dc:creator"],
    build: one(SOFTWARE_ONLY, "<dc:creator><rdf:Seq><rdf:li>山田太郎</rdf:li></rdf:Seq></dc:creator>", false),
  },
  {
    id: "p2-l02",
    kind: "leak",
    description: "圧縮あり（Flate）の XMP の pdf:Author（属性）と dc:creator",
    leaks: ["person:pdf:Author", "person:dc:creator"],
    build: one(`${SOFTWARE_ONLY} pdf:Author="Taro Yamada"`, "<dc:creator><rdf:Seq><rdf:li>Taro Yamada</rdf:li></rdf:Seq></dc:creator>", true),
  },
  {
    id: "p2-l03",
    kind: "leak",
    description: "編集の履歴（3件）と、元のファイルのパス（ユーザーのフォルダ）",
    leaks: ["history:xmpMM:History", "path:stRef:filePath"],
    build: one(
      SOFTWARE_ONLY,
      [
        '<xmpMM:DerivedFrom stRef:filePath="C:\\Users\\yamada\\Documents\\案.docx"/>',
        "<xmpMM:History><rdf:Seq>",
        '<rdf:li stEvt:action="created" stEvt:when="2026-10-01T09:00:00+09:00"/>',
        '<rdf:li stEvt:action="saved" stEvt:when="2026-10-01T10:00:00+09:00"/>',
        '<rdf:li stEvt:action="converted" stEvt:parameters="from application/msword to application/pdf"/>',
        "</rdf:Seq></xmpMM:History>",
      ].join("\n"),
      true,
    ),
  },
  {
    id: "p2-l04",
    kind: "leak",
    description: "独自の欄（pdfx:Company）と題（dc:title）",
    leaks: ["text:pdfx:Company", "text:dc:title"],
    build: one(SOFTWARE_ONLY, '<pdfx:Company>架空株式会社</pdfx:Company><dc:title><rdf:Alt><rdf:li xml:lang="x-default">内部資料（案）</rdf:li></rdf:Alt></dc:title>', false),
  },
  {
    id: "p2-l05",
    kind: "leak",
    description: "履歴の説明（stEvt:parameters）の中の、ユーザーのフォルダのパス",
    leaks: ["path:stEvt:parameters", "history:xmpMM:History"],
    build: one(
      SOFTWARE_ONLY,
      '<xmpMM:History><rdf:Seq><rdf:li stEvt:action="converted" stEvt:parameters="from C:\\Users\\suzuki\\Desktop\\memo.docx"/></rdf:Seq></xmpMM:History>',
      false,
    ),
  },
  {
    id: "p2-c01",
    kind: "control",
    description: "ソフト名・文書 ID・日付・形式だけの XMP",
    leaks: [],
    build: one(SOFTWARE_ONLY, "<dc:format>application/pdf</dc:format>", true),
  },
  {
    id: "p2-c02",
    kind: "control",
    description: "決まり文句の作成者（Administrator）と、数字の入ったアカウント（user01）",
    leaks: [],
    build: one(`${SOFTWARE_ONLY} pdf:Author="user01"`, "<dc:creator><rdf:Seq><rdf:li>Administrator</rdf:li></rdf:Seq></dc:creator>", false),
  },
  {
    id: "p2-c03",
    kind: "control",
    description: "XMP のない PDF",
    leaks: [],
    async build() {
      const { doc } = await newDoc();
      return save(doc);
    },
  },
  {
    id: "p2-c04",
    kind: "control",
    description: "ユーザーのフォルダを含まないパス（Links/photo.jpg）",
    leaks: [],
    build: one(SOFTWARE_ONLY, '<xmpMM:DerivedFrom stRef:filePath="Links/photo.jpg"/>', true),
  },
  {
    id: "p2-l06",
    kind: "leak",
    description: "作成者が、名前と社員番号のような数字の組み（Taro KAKUU-0123）。数字があっても、名前の語があれば数える（p2-parts 1.1.0）",
    leaks: ["person:dc:creator"],
    build: one(SOFTWARE_ONLY, "<dc:creator><rdf:Seq><rdf:li>Taro KAKUU-0123</rdf:li></rdf:Seq></dc:creator>", true),
  },
  {
    id: "p2-c05",
    kind: "control",
    description: "数字の入った1語のアカウントと端末の名前（user01・PC-1234）は数えない",
    leaks: [],
    build: one(`${SOFTWARE_ONLY} pdf:Author="PC-1234"`, "<dc:creator><rdf:Seq><rdf:li>user01</rdf:li></rdf:Seq></dc:creator>", false),
  },
  {
    id: "p2-l07",
    kind: "leak",
    description: "XMP の題が、文書情報の題と違う（古い題が XMP に残った）。同じなら数えない（1.1.0）",
    leaks: ["text:dc:title"],
    async build() {
      const { doc } = await newDoc();
      setInfo(doc, { Title: hex("新しい題") });
      setCatalogXmp(doc, xmpPacket(SOFTWARE_ONLY, '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">古い題（架空 太郎 案）</rdf:li></rdf:Alt></dc:title>'), false);
      return save(doc);
    },
  },
  {
    id: "p2-c06",
    kind: "control",
    description: "XMP の題と説明が、文書情報の題・件名と同じ（P1 と二重に出さない）",
    leaks: [],
    async build() {
      const { doc } = await newDoc();
      setInfo(doc, { Title: hex("会議の資料"), Subject: hex("定例") });
      setCatalogXmp(
        doc,
        xmpPacket(SOFTWARE_ONLY, '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">会議の資料</rdf:li></rdf:Alt></dc:title><dc:description><rdf:Alt><rdf:li xml:lang="x-default">定例</rdf:li></rdf:Alt></dc:description>'),
        false,
      );
      return save(doc);
    },
  },
];

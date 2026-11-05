// SPDX-License-Identifier: AGPL-3.0-only
//
// P3（他組織名の混入）の合成 PDF。鍵は「欄の場所:欄」。団体名はすべて架空（架空市・架空町・Hoshizora City など）。

import type { P3Report } from "../../rules/p3-orgs/index.ts";
import { drawAscii, hex, lit, newDoc, save, setCatalogXmp, setInfo, xmpPacket, type Case } from "./pdf.ts";

export const keysOf = (r: P3Report) => r.findings.map((f) => `${f.source}:${f.field}`);

export const CASES: Case[] = [
  {
    id: "p3-l01",
    kind: "leak",
    description: "文書情報のタイトルは「Hoshizora City」、本文は「Kumoi Town」（ほかの団体の様式を流用した型）",
    leaks: ["info:Title"],
    async build() {
      const { doc, pages } = await newDoc();
      await drawAscii(doc, pages[0]!, ["Application form", "Issued by Kumoi Town"]);
      setInfo(doc, { Title: lit("Hoshizora City application form") });
      return save(doc);
    },
  },
  {
    id: "p3-l02",
    kind: "leak",
    description: "XMP の題に「架空市」、本文は「Kumoi Town」。作成者欄に会社の名前（架空商事株式会社）",
    leaks: ["xmp:dc:title", "info:Author"],
    async build() {
      const { doc, pages } = await newDoc();
      await drawAscii(doc, pages[0]!, ["Notice from Kumoi Town"]);
      setCatalogXmp(doc, xmpPacket("", '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">架空市 申請書</rdf:li></rdf:Alt></dc:title>'), false);
      setInfo(doc, { Author: hex("架空商事株式会社") });
      return save(doc);
    },
  },
  {
    id: "p3-c01",
    kind: "control",
    description: "タイトルと本文が同じ団体名（Kumoi Town）",
    leaks: [],
    async build() {
      const { doc, pages } = await newDoc();
      await drawAscii(doc, pages[0]!, ["Issued by Kumoi Town office"]);
      setInfo(doc, { Title: lit("Kumoi Town application form") });
      return save(doc);
    },
  },
  {
    id: "p3-c02",
    kind: "control",
    description: "本文に団体名が無い（比べられないので出さない）。タイトルの部署名（〇〇課）は比べない",
    leaks: [],
    async build() {
      const { doc, pages } = await newDoc();
      await drawAscii(doc, pages[0]!, ["Meeting notes"]);
      setInfo(doc, { Title: lit("Hoshizora City meeting notes"), Subject: hex("企画課") });
      return save(doc);
    },
  },
];

// SPDX-License-Identifier: AGPL-3.0-only
//
// プロパティの一覧（rules/props の listProperties）と、団体名らしい語の印（orgMarks）、文書情報と XMP の食い違い。
// 団体名・地名はすべて架空（架空市・架空町など）。

import { describe, expect, it } from "vitest";
import { detectInfoXmpDiff, listProperties, orgMarks } from "../rules/props/index.ts";
import { hex, lit, newDoc, save, setCatalogXmp, setInfo, xmpPacket } from "../eval/cases/pdf.ts";

const marked = (s: string) => orgMarks(s).map((m) => [...s].slice(m.start, m.end).join(""));

describe("団体名らしい語の印（字の並びの形だけ）", () => {
  it("〇〇市・〇〇町・〇〇村・〇〇県・〇〇課・〇〇室・北海道", () => {
    expect(marked("架空市 総務課")).toEqual(["架空市", "総務課"]);
    expect(marked("架空県架空町の資料")).toEqual(["架空県架空町"]);
    expect(marked("架空村役場")).toEqual(["架空村"]);
    expect(marked("北海道の架空区")).toEqual(["北海道", "架空区"]);
    expect(marked("広報室")).toEqual(["広報室"]);
  });
  it("株式会社などと、その前後の字", () => {
    expect(marked("作成：株式会社カクウ")).toEqual(["株式会社カクウ"]);
    expect(marked("カクウ商事有限会社 御中")).toEqual(["カクウ商事有限会社"]);
  });
  it("対照：市場・町内・都合・地区・全部・水道・都道府県・市町村・教室などには付けない", () => {
    for (const s of ["魚の市場", "町内会のお知らせ", "都合により", "この地区では", "全部で", "水道料金", "都道府県別", "市町村", "教室の予定", "部分的に", "課題の整理", "係数", "道路の工事", "都市計画"]) {
      expect(marked(s), s).toEqual([]);
    }
  });
  it("英字・数字だけの値には付けない", () => {
    expect(orgMarks("Microsoft Word 2021")).toEqual([]);
  });
});

describe("プロパティの一覧（中身ごと）", () => {
  it("文書情報と XMP のすべての欄を、名前・値・どこにあったかで返す", async () => {
    const { doc } = await newDoc();
    setInfo(doc, { Title: hex("架空市 総務課 資料"), Author: hex("山田太郎"), Producer: lit("KakuuPDF 1.0"), CustomKey: hex("x") });
    setCatalogXmp(doc, xmpPacket('xmp:CreatorTool="Word"', "<dc:creator><rdf:Seq><rdf:li>山田太郎</rdf:li></rdf:Seq></dc:creator>"), true);
    const r = await listProperties(await save(doc));
    if (r.status !== "ok") throw new Error("読めなかった");
    const byName = Object.fromEntries(r.properties.map((p) => [`${p.source}:${p.name}`, p.value]));
    expect(byName).toMatchObject({
      "info:Title": "架空市 総務課 資料",
      "info:Author": "山田太郎",
      "info:Producer": "KakuuPDF 1.0",
      "info:CustomKey": "x",
      "xmp:xmp:CreatorTool": "Word",
      "xmp:dc:creator": "山田太郎",
    });
    expect(r.properties.find((p) => p.name === "Title")?.marks).toEqual([
      { start: 0, end: 3, kind: "org" },
      { start: 4, end: 7, kind: "org" },
    ]);
  });
});

describe("文書情報と XMP の食い違い", () => {
  it("作成者が Info と XMP で違えば出す（値は返さない）", async () => {
    const { doc } = await newDoc();
    setInfo(doc, { Author: hex("総務課") });
    setCatalogXmp(doc, xmpPacket("", "<dc:creator><rdf:Seq><rdf:li>山田太郎</rdf:li></rdf:Seq></dc:creator>"), false);
    const r = await detectInfoXmpDiff(await save(doc));
    expect(r.findings).toEqual([{ pattern: "P1", field: "Author", xmpField: "dc:creator", infoChars: 3, xmpChars: 4 }]);
  });
  it("対照：同じ値（空白・全角半角の違いだけ、複数の作成者を「; 」でつないだもの）は出さない。片方だけにある欄も出さない", async () => {
    const { doc } = await newDoc();
    setInfo(doc, { Author: hex("山田太郎; 鈴木花子"), Title: hex("ABC 資料"), Subject: hex("説明") });
    setCatalogXmp(
      doc,
      xmpPacket(
        "",
        '<dc:creator><rdf:Seq><rdf:li>山田太郎</rdf:li><rdf:li>鈴木花子</rdf:li></rdf:Seq></dc:creator><dc:title><rdf:Alt><rdf:li xml:lang="x-default">ＡＢＣ  資料</rdf:li></rdf:Alt></dc:title>',
      ),
      true,
    );
    expect((await detectInfoXmpDiff(await save(doc))).findings).toEqual([]);
  });
});

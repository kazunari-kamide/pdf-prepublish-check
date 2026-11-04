// SPDX-License-Identifier: AGPL-3.0-only
//
// プロパティの一覧（src/inspect/properties.ts）と、団体名らしい語の目印（src/ui/org-words.ts）。名前はすべて架空。

import { PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { MAX_VALUE_CHARS, readProperties, xmpProperties } from "../src/inspect/properties";
import { orgSegments } from "../src/ui/org-words";

const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="架空ワープロ &amp; 変換">
<dc:creator><rdf:Seq><rdf:li>架空 太郎</rdf:li><rdf:li>見本 花子</rdf:li></rdf:Seq></dc:creator>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">見本の題</rdf:li></rdf:Alt></dc:title>
<!-- 注釈 --></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

describe("XMP の欄を取り出す", () => {
  it("属性の形と要素の形の両方。並びの中の値は、それぞれ欄の名前をつけて出す", () => {
    expect(xmpProperties(XMP).list).toEqual([
      { key: "xmp:CreatorTool", value: "架空ワープロ & 変換" },
      { key: "dc:creator", value: "架空 太郎" },
      { key: "dc:creator", value: "見本 花子" },
      { key: "dc:title", value: "見本の題" },
    ]);
  });
  it("欄が多すぎるときは、上限で止めて、そう知らせる", () => {
    const r = xmpProperties(XMP, 2);
    expect(r.list).toHaveLength(2);
    expect(r.limited).toBe(true);
  });
});

describe("文書情報と XMP を、値ごと読む", () => {
  it("UTF-16 の値も読み、長すぎる値は切る", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage();
    doc.setAuthor("架空市 総務課 見本 太郎");
    doc.setTitle("あ".repeat(MAX_VALUE_CHARS + 10));
    // 独自の欄（pdf-lib の getInfoDict は private なので、トレーラーの /Info から引く）
    (doc.context.lookup(doc.context.trailerInfo.Info) as PDFDict).set(PDFName.of("Custom"), PDFHexString.fromText("独自の欄"));
    const xmp = doc.context.stream(XMP, { Type: "Metadata", Subtype: "XML" });
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(xmp));
    const p = (await readProperties(await doc.save()))!;
    expect(p.info.find((x) => x.key === "Author")!.value).toBe("架空市 総務課 見本 太郎");
    expect(p.info.find((x) => x.key === "Title")).toMatchObject({ truncated: true });
    expect([...p.info.find((x) => x.key === "Title")!.value]).toHaveLength(MAX_VALUE_CHARS);
    expect(p.info.find((x) => x.key === "Custom")!.value).toBe("独自の欄");
    expect(p.xmp.map((x) => x.key)).toContain("dc:creator");
  });
  it("PDF でなければ null", async () => {
    expect(await readProperties(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("団体名らしい語の目印", () => {
  it("漢字・カタカナの並びに、団体の名前の終わりの語が続く所に付ける", () => {
    expect(orgSegments("架空市 総務課 見本 太郎").filter((s) => s.org).map((s) => s.text)).toEqual(["架空市", "総務課"]);
    expect(orgSegments("サンプル株式会社の資料").filter((s) => s.org).map((s) => s.text)).toEqual(["サンプル株式会社"]);
  });
  it("つなげると元の値に戻る。団体名らしい語がなければ1つのまま", () => {
    const t = "Microsoft Word で作成";
    expect(orgSegments(t)).toEqual([{ text: t, org: false }]);
    expect(orgSegments("見本県見本市の会議").map((s) => s.text).join("")).toBe("見本県見本市の会議");
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P8（注釈・コメント）1.1.0 のテスト。
// 採点用の合成 PDF（proposals/ に作られる予定）がまだないので、テストの中で小さな PDF を作って確かめる。
// 名前は架空のもの（山田太郎など）だけを使う。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFHexString, PDFName, PDFString, type PDFPage } from "pdf-lib";
import { detectP8Annot } from "../rules/p8-annot/index.ts";

type Annot = Record<string, unknown>;

async function makePdf(pages: Annot[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const annots of pages) {
    const page: PDFPage = doc.addPage([300, 200]);
    if (!annots.length) continue;
    const refs = annots.map((a) => doc.context.register(doc.context.obj({ Type: "Annot", Rect: [10, 10, 50, 50], ...a } as never)));
    page.node.set(PDFName.of("Annots"), doc.context.obj(refs));
  }
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

const text = (s: string) => PDFHexString.fromText(s); // UTF-16BE で入れる

describe("P8 注釈の作成者欄と内容", () => {
  it("作成者欄（/T）を見つけ、値は返さずに字数だけを返す", async () => {
    const r = await detectP8Annot(await makePdf([[{ Subtype: "Square", T: PDFString.of("yamada") }]]));
    expect(r.status).toBe("ok");
    expect(r.findings).toEqual([{ pattern: "P8", field: "T", hidden: false, chars: 6, annotations: 1, pages: [1] }]);
  });

  it("全注釈で同じ作成者なら、1件にまとめる（注釈の数とページを添える）", async () => {
    const r = await detectP8Annot(
      await makePdf([
        [{ Subtype: "Square", T: text("山田太郎") }, { Subtype: "Text", T: text("山田太郎") }],
        [],
        [{ Subtype: "Highlight", T: text("山田太郎") }],
      ]),
    );
    expect(r.findings).toEqual([{ pattern: "P8", field: "T", hidden: false, chars: 4, annotations: 3, pages: [1, 3] }]);
    expect(r.annotations).toBe(3);
  });

  it("作成者が違えば、別の件にする", async () => {
    const r = await detectP8Annot(await makePdf([[{ Subtype: "Text", T: text("yamada") }, { Subtype: "Text", T: text("suzuki") }]]));
    expect(r.findings.map((f) => f.field)).toEqual(["T", "T"]);
  });

  it("内容（/Contents）・件名（/Subj）・リッチテキスト（/RC）も数える。RC はタグを外した字数", async () => {
    const r = await detectP8Annot(
      await makePdf([
        [
          {
            Subtype: "Text",
            Contents: text("ここは要確認"),
            Subj: text("確認"),
            RC: PDFString.of('<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p>abc &amp; d</p></body>'),
          },
        ],
      ]),
    );
    const by = Object.fromEntries(r.findings.map((f) => [f.field, f.chars]));
    expect(by).toEqual({ Contents: 6, Subj: 2, RC: 7 });
  });

  it("includeValues のときだけ、値そのものを返す", async () => {
    const pdf = await makePdf([[{ Subtype: "Square", T: text("山田太郎") }]]);
    expect((await detectP8Annot(pdf)).findings[0]!.value).toBeUndefined();
    expect((await detectP8Annot(pdf, { includeValues: true })).findings[0]!.value).toBe("山田太郎");
  });

  it("決まり文句（Author・ユーザー・Administrator・user）と、数字だけの値は数えずに notCounted に回す", async () => {
    const r = await detectP8Annot(
      await makePdf([
        [
          { Subtype: "Text", T: PDFString.of("Author") },
          { Subtype: "Text", T: text("ユーザー") },
          { Subtype: "Text", T: PDFString.of("ADMINISTRATOR") },
          { Subtype: "Text", T: PDFString.of("user") },
          { Subtype: "Text", T: PDFString.of("0012345") },
        ],
      ]),
    );
    expect(r.findings).toEqual([]);
    expect(r.notCounted).toEqual([
      { field: "T", reason: "generic_author", annotations: 4 },
      { field: "T", reason: "digits_only", annotations: 1 },
    ]);
  });

  it("部署名のような値は、ルールでは見分けずに数える", async () => {
    const r = await detectP8Annot(await makePdf([[{ Subtype: "Text", T: text("総務課") }]]));
    expect(r.findings).toHaveLength(1);
  });

  it("フォームの欄（Widget）の /T と、吹き出し（Popup）は見ない", async () => {
    const r = await detectP8Annot(
      await makePdf([[{ Subtype: "Widget", T: PDFString.of("field1") }, { Subtype: "Popup", T: PDFString.of("yamada") }]]),
    );
    expect(r.findings).toEqual([]);
    expect(r.annotations).toBe(0);
  });

  it("空・空白だけの値は数えない", async () => {
    const r = await detectP8Annot(await makePdf([[{ Subtype: "Text", T: PDFString.of("  "), Contents: PDFString.of("") }]]));
    expect(r.findings).toEqual([]);
    expect(r.notCounted).toEqual([]);
  });

  it("注釈のない PDF・空のファイル・PDF でないもの", async () => {
    expect((await detectP8Annot(await makePdf([[]]))).findings).toEqual([]);
    expect((await detectP8Annot(new Uint8Array())).error?.code).toBe("empty");
    expect((await detectP8Annot(new TextEncoder().encode("PDF ではない"))).error?.code).toBe("unreadable");
  });
});

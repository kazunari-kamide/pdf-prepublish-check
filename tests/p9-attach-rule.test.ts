// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P9（添付ファイル）のテスト。
// 採点に使う合成 PDF（fixtures/p9）は使わず、テストの中で小さな PDF を作って確かめる。ファイル名はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFArray, PDFContext, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from "pdf-lib";
import { detectP9Attach, extensionOf } from "../rules/p9-attach/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** 中身のストリームを作る */
function content(ctx: PDFContext, data: string, withType = true): PDFRef {
  const dict: Record<string, unknown> = { Params: { Size: enc(data).length } };
  if (withType) dict.Type = "EmbeddedFile";
  return ctx.register(ctx.stream(enc(data), dict as never));
}

/** ファイル指定。stream がなければ、外のファイルを指すだけのもの */
function spec(ctx: PDFContext, name: string, stream?: PDFRef): PDFRef {
  const d = ctx.obj({ Type: "Filespec" }) as PDFDict;
  d.set(PDFName.of("F"), PDFString.of("file.bin"));
  d.set(PDFName.of("UF"), PDFHexString.fromText(name));
  if (stream) d.set(PDFName.of("EF"), ctx.obj({ F: stream }));
  return ctx.register(d);
}

function namesTree(doc: PDFDocument, root: PDFDict | PDFRef) {
  doc.catalog.set(PDFName.of("Names"), doc.context.obj({ EmbeddedFiles: root }));
}

function leaf(ctx: PDFContext, entries: Array<[string, PDFRef]>): PDFDict {
  const arr = PDFArray.withContext(ctx);
  for (const [k, v] of entries) {
    arr.push(PDFHexString.fromText(k));
    arr.push(v);
  }
  return ctx.obj({ Names: arr }) as PDFDict;
}

function fileAnnot(doc: PDFDocument, pageIndex: number, fs: PDFRef) {
  const ctx = doc.context;
  const annot = ctx.register(ctx.obj({ Type: "Annot", Subtype: "FileAttachment", Rect: [10, 10, 30, 30], FS: fs }));
  doc.getPage(pageIndex).node.set(PDFName.of("Annots"), ctx.obj([annot]));
}

async function makePdf(pages: number, fill: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  fill(doc);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe("拡張子", () => {
  it("最後の . のあとを小文字で返す。なければ null", () => {
    expect(extensionOf("名簿.XLSX")).toBe("xlsx");
    expect(extensionOf("a.tar.gz")).toBe("gz");
    expect(extensionOf("README")).toBeNull();
    expect(extensionOf("")).toBeNull();
  });
});

describe("場所ごとに見つける", () => {
  it("名前の木（/Kids の入れ子）の添付を names として返す。既定ではファイル名を出さない", async () => {
    const bytes = await makePdf(1, (doc) => {
      const ctx = doc.context;
      const a = leaf(ctx, [["k1", spec(ctx, "名簿.xlsx", content(ctx, "PK.."))]]);
      const b = leaf(ctx, [["k2", spec(ctx, "原本.docx", content(ctx, "PK...."))]]);
      namesTree(doc, ctx.obj({ Kids: [ctx.register(a), ctx.register(b)] }) as PDFDict);
    });
    const r = await detectP9Attach(bytes);
    expect(r.status).toBe("ok");
    expect(r.findings.map((f) => [f.where, f.ext, f.nameChars, f.size])).toEqual([
      ["names", "xlsx", 7, 4],
      ["names", "docx", 7, 6],
    ]);
    expect(r.findings.every((f) => f.name === undefined)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("名簿");
  });

  it("includeNames のときだけファイル名を返す", async () => {
    const bytes = await makePdf(1, (doc) => {
      const ctx = doc.context;
      namesTree(doc, leaf(ctx, [["k", spec(ctx, "名簿.xlsx", content(ctx, "x"))]]));
    });
    const r = await detectP9Attach(bytes, { includeNames: true });
    expect(r.findings[0]!.name).toBe("名簿.xlsx");
  });

  it("2ページ目の添付ファイルの注釈を annotation として、ページ番号つきで返す", async () => {
    const bytes = await makePdf(2, (doc) => fileAnnot(doc, 1, spec(doc.context, "memo.txt", content(doc.context, "memo"))));
    const r = await detectP9Attach(bytes);
    expect(r.findings.map((f) => [f.where, f.page, f.ext])).toEqual([["annotation", 2, "txt"]]);
  });

  it("文書の /AF だけから指されたものを af として返す", async () => {
    const bytes = await makePdf(1, (doc) => {
      const ctx = doc.context;
      doc.catalog.set(PDFName.of("AF"), ctx.obj([spec(ctx, "data.csv", content(ctx, "a,b"))]));
    });
    const r = await detectP9Attach(bytes);
    expect(r.findings.map((f) => f.where)).toEqual(["af"]);
  });

  it("同じ中身を名前の木と注釈の両方が指していれば1件。場所は names、ほかを also に入れる", async () => {
    const bytes = await makePdf(1, (doc) => {
      const ctx = doc.context;
      const fs = spec(ctx, "same.pdf", content(ctx, "%PDF"));
      namesTree(doc, leaf(ctx, [["k", fs]]));
      fileAnnot(doc, 0, fs);
    });
    const r = await detectP9Attach(bytes);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ where: "names", also: ["annotation"] });
  });

  it("どこからも指されていない中身を unreferenced として返す（ファイル指定が残っていれば名前の字数も）", async () => {
    const bytes = await makePdf(1, (doc) => {
      const ctx = doc.context;
      spec(ctx, "removed.xlsx", content(ctx, "PK", false)); // ファイル指定は残っている。中身に /Type はない
      content(ctx, "orphan"); // 中身だけが残っている
    });
    const r = await detectP9Attach(bytes);
    expect(r.findings.map((f) => [f.where, f.ext, f.nameChars]).sort()).toEqual([
      ["unreferenced", null, 0],
      ["unreferenced", "xlsx", 12],
    ]);
  });

  it("オブジェクトストリームで保存した PDF でも見つける", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([200, 200]);
    const ctx = doc.context;
    namesTree(doc, leaf(ctx, [["k", spec(ctx, "a.txt", content(ctx, "a"))]]));
    const bytes = new Uint8Array(await doc.save({ useObjectStreams: true }));
    const r = await detectP9Attach(bytes);
    expect(r.findings.map((f) => f.where)).toEqual(["names"]);
  });
});

describe("漏れでないもの", () => {
  it("外のファイルを指すだけのファイル指定・リンク・空の名前の木・字の中の「/Type /EmbeddedFile」は返さない", async () => {
    const bytes = await makePdf(1, (doc) => {
      const ctx = doc.context;
      fileAnnot(doc, 0, spec(ctx, "external.docx"));
      namesTree(doc, ctx.obj({ Names: [] }) as PDFDict);
      const page = doc.getPage(0);
      page.node.set(
        PDFName.of("Annots"),
        ctx.obj([
          ...(page.node.lookup(PDFName.of("Annots"), PDFArray).asArray() as PDFRef[]),
          ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 5, 5], A: { S: "URI", URI: PDFString.of("https://example.com/") } })),
          ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 5, 5], A: { S: "Launch", F: PDFString.of("other.exe") } })),
        ]),
      );
      page.drawText("/Type /EmbeddedFile", { x: 10, y: 100, size: 10 });
    });
    const r = await detectP9Attach(bytes);
    expect(r.status).toBe("ok");
    expect(r.findings).toEqual([]);
    expect(r.externalRefs).toBe(1);
  });
});

describe("壊れた・読めない入力で止まらない", () => {
  it("輪になった名前の木", async () => {
    const bytes = await makePdf(1, (doc) => {
      const ctx = doc.context;
      const node = ctx.obj({}) as PDFDict;
      const ref = ctx.register(node);
      node.set(PDFName.of("Kids"), ctx.obj([ref]));
      namesTree(doc, ref);
    });
    const r = await detectP9Attach(bytes);
    expect(r.status).toBe("ok");
    expect(r.findings).toEqual([]);
  });

  it("空のファイル・PDF でないもの", async () => {
    expect((await detectP9Attach(new Uint8Array())).error!.code).toBe("empty");
    const r = await detectP9Attach(enc("hello"));
    expect(r.findings).toEqual([]);
    if (r.status === "error") expect(r.error!.code).toBe("unreadable");
  });
});

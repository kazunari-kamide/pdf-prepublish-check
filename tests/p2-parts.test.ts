// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：部品に残った情報（p2-parts）1.0.0 のテスト。
// 採点用の合成 PDF（proposals/ に作られる予定）がまだないので、テストの中で小さな PDF を作って確かめる。
// 名前・パスは架空のもの（yamada、山田太郎など）だけを使う。

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, type PDFRef } from "pdf-lib";
import { detectP2Parts, illustratorFields, userFolderOf, xmpValues } from "../rules/p2-parts/index.ts";

const enc = new TextEncoder();

function xmp(body: string): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
 xmlns:stRef="http://ns.adobe.com/xap/1.0/sType/ResourceRef#" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/">
${body}
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

/** 画像（1×1）と部品（フォーム XObject）に、それぞれ XMP を付けた PDF。文書全体の XMP も付ける */
async function makePdf(opts: { image?: string; form?: string; catalog?: string; orphan?: string; pieceInfo?: (doc: PDFDocument) => PDFRef }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const meta = (x: string) => doc.context.register(doc.context.stream(enc.encode(x), { Type: "Metadata", Subtype: "XML" }));
  if (opts.image) {
    const img = doc.context.stream(new Uint8Array([128]), { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8, Metadata: meta(opts.image) });
    page.node.newXObject("Im", doc.context.register(img));
  }
  if (opts.form) {
    const form = doc.context.stream(enc.encode("0 0 m"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Metadata: meta(opts.form) });
    page.node.newXObject("Fm", doc.context.register(form));
  }
  if (opts.catalog) doc.catalog.set(PDFName.of("Metadata"), meta(opts.catalog));
  if (opts.orphan) meta(opts.orphan);
  if (opts.pieceInfo) page.node.set(PDFName.of("PieceInfo"), opts.pieceInfo(doc));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe("部品の XMP（p2-parts）", () => {
  it("画像の XMP の作成者（dc:creator）を P2 として見つけ、値は返さない", async () => {
    const r = await detectP2Parts(await makePdf({ image: xmp(`<dc:creator><rdf:Seq><rdf:li>山田太郎</rdf:li></rdf:Seq></dc:creator>`) }));
    expect(r.status).toBe("ok");
    expect(r.findings).toEqual([{ pattern: "P2", kind: "person", source: "xmp", field: "dc:creator", owner: "image", parts: 1, chars: 4 }]);
  });

  it("文書全体の XMP（カタログ）は見ない", async () => {
    const r = await detectP2Parts(await makePdf({ catalog: xmp(`<dc:creator><rdf:Seq><rdf:li>山田太郎</rdf:li></rdf:Seq></dc:creator>`) }));
    expect(r.findings).toEqual([]);
    expect(r.xmpParts).toBe(0);
  });

  it("同じ作成者が何個の部品にあっても1件にまとめる。どこからも指されていない XMP も見る", async () => {
    const x = xmp(`<dc:creator><rdf:Seq><rdf:li>yamada</rdf:li></rdf:Seq></dc:creator>`);
    const r = await detectP2Parts(await makePdf({ image: x, form: x, orphan: x }));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ field: "dc:creator", parts: 3, chars: 6 });
    expect(r.xmpParts).toBe(3);
  });

  it("ユーザーのフォルダを含むパス（stRef:filePath・DerivedFrom・Ingredients・DocumentAncestors）を P4 として見つける", async () => {
    const r = await detectP2Parts(
      await makePdf({
        image: xmp(`<xmpMM:DerivedFrom stRef:filePath="C:\\Users\\yamada\\Desktop\\a.ai"/>
<xmpMM:Ingredients><rdf:Bag><rdf:li rdf:parseType="Resource"><stRef:filePath>/Users/suzuki/Documents/Links/b.psd</stRef:filePath></rdf:li></rdf:Bag></xmpMM:Ingredients>
<photoshop:DocumentAncestors><rdf:Bag><rdf:li>file:///C:/Users/sato/c.psd</rdf:li><rdf:li>xmp.did:0123456789</rdf:li></rdf:Bag></photoshop:DocumentAncestors>`),
      }),
    );
    const paths = r.findings.filter((f) => f.pattern === "P4");
    expect(paths.map((f) => [f.field, f.chars])).toEqual([
      ["photoshop:DocumentAncestors", 4],
      ["stRef:filePath", 6],
      ["stRef:filePath", 6],
    ]);
  });

  it("中立なフォルダ・ソフト名・文書 ID・数字の入ったアカウント・決まり文句は数えない", async () => {
    const r = await detectP2Parts(
      await makePdf({
        image: xmp(`<dc:creator><rdf:Seq><rdf:li>Adobe Illustrator 28.0</rdf:li><rdf:li>user01</rdf:li><rdf:li>Administrator</rdf:li></rdf:Seq></dc:creator>
<xmpMM:Ingredients><rdf:Bag><rdf:li stRef:filePath="D:\\広報\\Links\\画像\\d.jpg"/><rdf:li stRef:filePath="C:\\Users\\Public\\e.jpg"/><rdf:li stRef:filePath="C:\\Users\\pc0123\\f.jpg"/></rdf:Bag></xmpMM:Ingredients>`),
      }),
    );
    expect(r.findings).toEqual([]);
    const reasons = Object.fromEntries(r.notCounted.map((n) => [`${n.field}/${n.reason}`, n.count]));
    expect(reasons).toEqual({
      "dc:creator/software": 1,
      "dc:creator/account": 1,
      "dc:creator/generic": 1,
      "stRef:filePath/no_user_folder": 1,
      "stRef:filePath/generic": 1,
      "stRef:filePath/account": 1,
    });
  });

  it("写真の GPS を P10 として見つける", async () => {
    const r = await detectP2Parts(await makePdf({ image: xmp(`<exif:GPSLatitude>35,40.0N</exif:GPSLatitude><exif:GPSLongitude>139,45.0E</exif:GPSLongitude>`) }));
    expect(r.findings).toEqual([{ pattern: "P10", kind: "gps", source: "xmp", field: "exif:GPSLatitude/exif:GPSLongitude", owner: "image", parts: 1, chars: 0 }]);
  });

  it("includeValues のときだけ、値を返す", async () => {
    const pdf = await makePdf({ image: xmp(`<dc:creator><rdf:Seq><rdf:li>山田太郎</rdf:li></rdf:Seq></dc:creator>`) });
    expect((await detectP2Parts(pdf)).findings[0]!.value).toBeUndefined();
    expect((await detectP2Parts(pdf, { includeValues: true })).findings[0]!.value).toBe("山田太郎");
  });
});

describe("Illustrator の編集用データ（PieceInfo）", () => {
  const psHeader = "%!PS-Adobe-3.0\r\n%%Creator: Adobe Illustrator(R) 24.0\r\n%%For: (yamada) ()\r\n%%DocumentFiles:C:\\Users\\yamada\\Links\\a.psd\r\n%%+D:\\共有\\Links\\b.jpg\r\n";

  function piece(data: Uint8Array) {
    return (doc: PDFDocument) => {
      const block = doc.context.register(doc.context.flateStream(data));
      const priv = doc.context.obj({ AIPrivateData1: block, NumBlock: 1 });
      return doc.context.register(doc.context.obj({ Illustrator: doc.context.obj({ Private: priv }) }));
    };
  }

  it("zlib の形（%AI12_CompressedData）を展開し、%%For と %%DocumentFiles を見つける", async () => {
    const z = deflateSync(enc.encode(psHeader));
    const data = new Uint8Array([...enc.encode("%AI12_CompressedData"), ...z]);
    const r = await detectP2Parts(await makePdf({ pieceInfo: piece(data) }));
    expect(r.findings).toEqual([
      { pattern: "P2", kind: "person", source: "illustrator", field: "%%For", owner: "page", parts: 1, chars: 6 },
      { pattern: "P2", kind: "private_data", source: "illustrator", field: "PieceInfo/Illustrator/Private", owner: "page", parts: 1, chars: 0, checked: true },
      { pattern: "P4", kind: "path", source: "illustrator", field: "%%DocumentFiles", owner: "page", parts: 1, chars: 6 },
    ]);
    expect(r.notCounted).toEqual([{ field: "%%DocumentFiles", reason: "no_user_folder", count: 1 }]);
  });

  it("zstd の形（%AI24_ZStandard_Data）は展開せず、「残っているが中身は調べていない」として返す", async () => {
    const data = new Uint8Array([...enc.encode("%AI24_ZStandard_Data"), 0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]);
    const r = await detectP2Parts(await makePdf({ pieceInfo: piece(data) }));
    expect(r.findings).toEqual([
      { pattern: "P2", kind: "private_data", source: "illustrator", field: "PieceInfo/Illustrator/Private", owner: "page", parts: 1, chars: 0, checked: false },
    ]);
  });

  it("壊れた zlib は、展開できなかったと返す（固まらない）", async () => {
    const data = new Uint8Array([...enc.encode("%AI12_CompressedData"), 1, 2, 3, 4, 5]);
    const r = await detectP2Parts(await makePdf({ pieceInfo: piece(data) }));
    expect(r.findings[0]).toMatchObject({ kind: "private_data", checked: false });
    expect(r.limits).toContainEqual({ reason: "inflate_failed" });
  });
});

describe("部品の読み方", () => {
  it("xmpValues：属性・要素・rdf:li・文字参照", () => {
    expect(xmpValues(`<a dc:creator="A &amp; B"/>`, "dc:creator")).toEqual(["A & B"]);
    expect(xmpValues(`<dc:creator><rdf:Seq><rdf:li>x</rdf:li><rdf:li>y</rdf:li></rdf:Seq></dc:creator>`, "dc:creator")).toEqual(["x", "y"]);
  });
  it("userFolderOf：Windows・mac・URL の形", () => {
    expect(userFolderOf("C:\\Users\\yamada\\a")).toBe("yamada");
    expect(userFolderOf("/Users/yamada/a")).toBe("yamada");
    expect(userFolderOf("file:///C:/Users/%E5%B1%B1%E7%94%B0/a")).toBe("山田");
    expect(userFolderOf("D:\\Links\\a")).toBeNull();
  });
  it("illustratorFields：括弧の中の逃がしを戻す", () => {
    expect(illustratorFields("%%For: (a\\)b) ()\n").forNames).toEqual(["a)b"]);
  });
  it("空のファイル・PDF でないもの", async () => {
    expect((await detectP2Parts(new Uint8Array())).error?.code).toBe("empty");
    expect((await detectP2Parts(enc.encode("PDF ではない"))).error?.code).toBe("unreadable");
  });
});

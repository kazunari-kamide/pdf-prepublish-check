// SPDX-License-Identifier: AGPL-3.0-only
//
// XMP の元の文書・素材の一覧（xmp-derived）の合成 PDF。鍵は「種類:欄」。ファイルの名前はすべて架空。
// 隠しありは、ドライブ名やフォルダの無いファイルの名前（と相対のパス）だけを入れる（パスの形は p2-xmp・p4-paths の範囲）。

import type { XmpDerivedReport } from "../../rules/xmp-derived/index.ts";
import { newDoc, save, setCatalogXmp, xmpPacket, type Case } from "./pdf.ts";

export const keysOf = (r: XmpDerivedReport) => r.findings.map((f) => `${f.kind}:${f.field}`);

/** 文書 ID だけ（漏れではない）。素材の一覧の名前空間もここで宣言する */
const IDS = [
  'xmlns:stMfs="http://ns.adobe.com/xap/1.0/sType/ManifestItem#"',
  'xmpMM:DocumentID="xmp.did:00000000-0000-4000-8000-0000000000a1"',
  'xmpMM:InstanceID="xmp.iid:00000000-0000-4000-8000-0000000000a2"',
].join(" ");

const one = (body: string, compressed: boolean) => async () => {
  const { doc } = await newDoc();
  setCatalogXmp(doc, xmpPacket(IDS, body), compressed);
  return save(doc);
};

const ingredients = (names: string[]) =>
  [
    "<xmpMM:Ingredients><rdf:Bag>",
    ...names.map((n, i) => `<rdf:li stRef:filePath="${n}" stRef:documentID="xmp.did:00000000-0000-4000-8000-00000000010${i}"/>`),
    "</rdf:Bag></xmpMM:Ingredients>",
  ].join("\n");

export const CASES: Case[] = [
  {
    id: "xd-l01",
    kind: "leak",
    description: "元の文書（xmpMM:DerivedFrom）に、架空の元ファイルの名前（属性の形）と元の文書 ID",
    leaks: ["derived:xmpMM:DerivedFrom"],
    build: one('<xmpMM:DerivedFrom stRef:documentID="xmp.did:00000000-0000-4000-8000-0000000000b1" stRef:filePath="架空の原稿_第2版.docx"/>', false),
  },
  {
    id: "xd-l02",
    kind: "leak",
    description: "素材の一覧（xmpMM:Ingredients）に、架空の素材ファイル 3 件（圧縮あり）",
    leaks: ["ingredients:xmpMM:Ingredients"],
    build: one(ingredients(["架空の地図.ai", "見本写真_01.jpg", "kakuu-logo.psd"]), true),
  },
  {
    id: "xd-l03",
    kind: "leak",
    description: "リンクした資源の一覧（xmpMM:Manifest。要素の形）と、素材の一覧の両方",
    leaks: ["manifest:xmpMM:Manifest", "ingredients:xmpMM:Ingredients"],
    build: one(
      [
        "<xmpMM:Manifest><rdf:Seq>",
        '<rdf:li rdf:parseType="Resource"><stMfs:linkForm>ReferenceStream</stMfs:linkForm><stMfs:reference rdf:parseType="Resource"><stRef:filePath>架空の表紙.png</stRef:filePath></stMfs:reference></rdf:li>',
        '<rdf:li rdf:parseType="Resource"><stMfs:linkForm>ReferenceStream</stMfs:linkForm><stMfs:reference rdf:parseType="Resource"><stRef:filePath>見本の図_v3.eps</stRef:filePath></stMfs:reference></rdf:li>',
        "</rdf:Seq></xmpMM:Manifest>",
        ingredients(["架空の表紙.png"]),
      ].join("\n"),
      false,
    ),
  },
  {
    id: "xd-l04",
    kind: "leak",
    description: "元の文書（要素の形）と、相対のパスの素材（フォルダ名つき）",
    leaks: ["derived:xmpMM:DerivedFrom","ingredients:xmpMM:Ingredients"],
    build: one(
      [
        '<xmpMM:DerivedFrom rdf:parseType="Resource"><stRef:instanceID>xmp.iid:00000000-0000-4000-8000-0000000000c1</stRef:instanceID><stRef:filePath>架空の案内_下書き.indd</stRef:filePath></xmpMM:DerivedFrom>',
        ingredients(["Links/架空の写真.jpg"]),
      ].join("\n"),
      true,
    ),
  },
  {
    id: "xd-c01",
    kind: "control",
    description: "文書 ID とインスタンス ID だけの XMP",
    leaks: [],
    build: one("<dc:format>application/pdf</dc:format>", false),
  },
  {
    id: "xd-c02",
    kind: "control",
    description: "元の文書の欄に、文書 ID・インスタンス ID だけ（ファイルの名前なし）",
    leaks: [],
    build: one('<xmpMM:DerivedFrom stRef:documentID="xmp.did:00000000-0000-4000-8000-0000000000d1" stRef:instanceID="xmp.iid:00000000-0000-4000-8000-0000000000d2"/>', true),
  },
  {
    id: "xd-c03",
    kind: "control",
    description: "パスの形の場所だけ（ユーザーのフォルダ・ドライブ名）。p2-xmp・p4-paths の範囲なので、ここでは数えない",
    leaks: [],
    build: one(
      [
        '<xmpMM:DerivedFrom stRef:filePath="C:\\Users\\kakuu\\Documents\\案.docx"/>',
        ingredients(["D:\\架空\\素材\\図.ai"]),
      ].join("\n"),
      false,
    ),
  },
  {
    id: "xd-c04",
    kind: "control",
    description: "XMP のない PDF",
    leaks: [],
    async build() {
      const { doc } = await newDoc();
      return save(doc);
    },
  },
];

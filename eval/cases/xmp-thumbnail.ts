// SPDX-License-Identifier: AGPL-3.0-only
//
// 文書全体の XMP に埋め込まれた縮小画像（xmp-thumbnail）の合成 PDF。鍵は「thumbnail:形」（jpeg・png）。中身はすべて架空。
// 隠しありは、縮小画像だけを XMP に入れ、ほかの欄はソフト名・文書 ID・日付だけにする（縮小画像そのものの漏れを見るため）。

import { PDFName } from "pdf-lib";
import type { XmpThumbnailReport } from "../../rules/xmp-thumbnail/index.ts";
import { drawAscii, newDoc, save, setCatalogXmp, tinyJpeg, xmpPacket, type Case } from "./pdf.ts";

export const keysOf = (r: XmpThumbnailReport) => r.findings.map((f) => `${f.kind}:${f.format}`);

const GIMG = 'xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/"';
const SOFTWARE_ONLY = [
  GIMG,
  'xmp:CreatorTool="架空の文書作成ソフト 3.1"',
  'xmpMM:DocumentID="uuid:7a6b5c4d-0000-4000-8000-000000000011"',
  'xmp:CreateDate="2026-10-05T09:00:00+09:00"',
].join(" ");

function base64(b: Uint8Array, lineBreak = false): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  const out = btoa(s);
  // 書き出すソフトの多くは、76 字ごとに &#xA; で折り返す
  return lineBreak ? out.replace(/(.{76})/g, "$1&#xA;") : out;
}

/** 架空の氏名の帯を描いた版の 1 ページ目を縮めた、という想定の JPEG（画素の中身はルールでは見ない） */
const OLD_PAGE_JPEG = () => tinyJpeg();

/** 要素の形の縮小画像（rdf:Alt の中の rdf:li 1つ） */
const elementThumb = (image: string, w = 256, h = 171) =>
  [
    '<rdf:li rdf:parseType="Resource">',
    `<xmpGImg:width>${w}</xmpGImg:width>`,
    `<xmpGImg:height>${h}</xmpGImg:height>`,
    "<xmpGImg:format>JPEG</xmpGImg:format>",
    `<xmpGImg:image>${image}</xmpGImg:image>`,
    "</rdf:li>",
  ].join("\n");

const thumbnails = (items: string[]) => ["<xmp:Thumbnails>", "<rdf:Alt>", ...items, "</rdf:Alt>", "</xmp:Thumbnails>"].join("\n");

export const CASES: Case[] = [
  {
    id: "xt-l01",
    kind: "leak",
    description: "XMP の xmp:Thumbnails に、直す前の 1 ページ目の縮小画像（JPEG・要素の形・&#xA; で折り返し）。ページ本体は字だけ",
    leaks: ["thumbnail:jpeg"],
    async build() {
      const { doc, pages } = await newDoc();
      await drawAscii(doc, pages[0]!, ["Notice No. 12", "Section 3"]);
      setCatalogXmp(doc, xmpPacket(SOFTWARE_ONLY, thumbnails([elementThumb(base64(OLD_PAGE_JPEG(), true))])), false);
      return save(doc);
    },
  },
  {
    id: "xt-l02",
    kind: "leak",
    description: "圧縮あり（Flate）の XMP で、縮小画像を属性の形（xmpGImg:image=\"…\"）で入れたもの",
    leaks: ["thumbnail:jpeg"],
    async build() {
      const { doc } = await newDoc();
      const li = `<rdf:li xmpGImg:width="128" xmpGImg:height="85" xmpGImg:format="JPEG" xmpGImg:image="${base64(OLD_PAGE_JPEG())}"/>`;
      setCatalogXmp(doc, xmpPacket(SOFTWARE_ONLY, thumbnails([li])), true);
      return save(doc);
    },
  },
  {
    id: "xt-l03",
    kind: "leak",
    description: "大きさ違いの縮小画像を 2 つ（どちらも JPEG）。名前空間の接頭辞を別の名前にしたもの",
    leaks: ["thumbnail:jpeg", "thumbnail:jpeg"],
    async build() {
      const { doc } = await newDoc();
      const attrs = SOFTWARE_ONLY.replace(GIMG, 'xmlns:gi="http://ns.adobe.com/xap/1.0/g/img/"');
      const li = (w: number) => `<rdf:li rdf:parseType="Resource"><gi:width>${w}</gi:width><gi:height>${w}</gi:height><gi:image>${base64(OLD_PAGE_JPEG())}</gi:image></rdf:li>`;
      setCatalogXmp(doc, xmpPacket(attrs, thumbnails([li(64), li(256)])), false);
      return save(doc);
    },
  },
  {
    id: "xt-c01",
    kind: "control",
    description: "XMP はあるが、縮小画像の無いもの（ソフト名・文書 ID・日付だけ）",
    leaks: [],
    async build() {
      const { doc, pages } = await newDoc();
      await drawAscii(doc, pages[0]!, ["Notice No. 12"]);
      setCatalogXmp(doc, xmpPacket(SOFTWARE_ONLY, ""), false);
      return save(doc);
    },
  },
  {
    id: "xt-c02",
    kind: "control",
    description: "xmp:Thumbnails の欄はあるが、画像の中身が空のもの",
    leaks: [],
    async build() {
      const { doc } = await newDoc();
      setCatalogXmp(doc, xmpPacket(SOFTWARE_ONLY, thumbnails([elementThumb("")])), false);
      return save(doc);
    },
  },
  {
    id: "xt-c03",
    kind: "control",
    description: "画像の欄に、画像でない字（base64 を解いても画像の頭でない）が入っているもの",
    leaks: [],
    async build() {
      const { doc } = await newDoc();
      setCatalogXmp(doc, xmpPacket(SOFTWARE_ONLY, thumbnails([elementThumb(base64(new TextEncoder().encode("placeholder only")))])), false);
      return save(doc);
    },
  },
  {
    id: "xt-c04",
    kind: "control",
    description: "ページの /Thumb だけ（extras の範囲）。文書全体の XMP は無い",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const jpeg = OLD_PAGE_JPEG();
      const thumb = ctx.register(ctx.stream(jpeg, { Width: 8, Height: 8, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "DCTDecode" }));
      pages[0]!.node.set(PDFName.of("Thumb"), thumb);
      return save(doc);
    },
  },
];

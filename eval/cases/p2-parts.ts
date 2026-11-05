// SPDX-License-Identifier: AGPL-3.0-only
//
// 部品の XMP とアプリの私的データ（p2-parts）の合成 PDF。鍵は「種類:持ち主」。名前はすべて架空。

import { deflateSync } from "node:zlib";
import { PDFName } from "pdf-lib";
import type { P2PartsReport } from "../../rules/p2-parts/index.ts";
import { hex, lit, newDoc, save, xmpPacket, type Case } from "./pdf.ts";

export const keysOf = (r: P2PartsReport) => r.findings.map((f) => `${f.kind}:${f.owner}`);

export const CASES: Case[] = [
  {
    id: "pp-l01",
    kind: "leak",
    description: "部品（フォーム XObject）に付いた XMP の作成者に、名前（ページから使っている部品）",
    leaks: ["person:form"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const meta = ctx.register(ctx.stream(xmpPacket("", "<dc:creator><rdf:Seq><rdf:li>Kumiko KAKUU</rdf:li></rdf:Seq></dc:creator>"), { Type: "Metadata", Subtype: "XML" }));
      const form = ctx.register(ctx.stream("0 0 10 10 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Metadata: meta }));
      pages[0]!.node.set(PDFName.of("Resources"), ctx.obj({ XObject: ctx.obj({ Fm1: form } as never) } as never));
      pages[0]!.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("/Fm1 Do")));
      return save(doc);
    },
  },
  {
    id: "pp-l02",
    kind: "leak",
    description: "ページと文書（カタログ）の /PieceInfo に、Illustrator 以外のアプリの私的データ（1.1.0。中身は読まない）",
    leaks: ["private_data:page", "private_data:document"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      // アプリの名前が同じなら1件にまとめる（同じ値は1件）ので、ここでは別のアプリにする
      const app = (name: string, user: string) => ctx.obj({ [name]: ctx.obj({ LastModified: lit("D:20261101090000"), Private: ctx.obj({ User: hex(user) } as never) } as never) } as never);
      pages[0]!.node.set(PDFName.of("PieceInfo"), app("KakuuApp", "架空 一郎"));
      doc.catalog.set(PDFName.of("PieceInfo"), app("KakuuSuite", "架空 二郎"));
      return save(doc);
    },
  },
  {
    id: "pp-l03",
    kind: "leak",
    description: "画像に付いた XMP に、製造番号と機種（1.2.0。P10）と、作った人の名前（tiff:Artist）",
    leaks: ["serial:image", "camera:image", "camera:image", "person:image"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const meta = ctx.register(
        ctx.stream(xmpPacket('aux:SerialNumber="KK0012345" tiff:Make="Kakuu Camera" tiff:Model="KX-1"', "<tiff:Artist>Hanako KAKUU</tiff:Artist>"), { Type: "Metadata", Subtype: "XML" }),
      );
      const im = ctx.register(ctx.flateStream(new Uint8Array(16).fill(128), { Type: "XObject", Subtype: "Image", Width: 4, Height: 4, ColorSpace: "DeviceGray", BitsPerComponent: 8, Metadata: meta }));
      pages[0]!.node.set(PDFName.of("Resources"), ctx.obj({ XObject: ctx.obj({ Im1: im } as never) } as never));
      pages[0]!.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("q 40 0 0 40 10 10 cm /Im1 Do Q")));
      return save(doc);
    },
  },
  {
    id: "pp-l04",
    kind: "leak",
    description: "ページの /PieceInfo /Illustrator /Private に、圧縮した編集用データ（%AI12_CompressedData）。中に作った人のユーザー名（%%For）",
    leaks: ["private_data:page", "person:page"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const body = deflateSync(Buffer.from("%!PS-Adobe-3.0\n%%Creator: Kakuu Draw\n%%For: (kakuu.ichiro)\n%%Title: (flyer.ai)\n"));
      const head = new TextEncoder().encode("%AI12_CompressedData");
      const data = new Uint8Array(head.length + body.length);
      data.set(head, 0);
      data.set(body, head.length);
      const s = ctx.register(ctx.stream(data));
      pages[0]!.node.set(PDFName.of("PieceInfo"), ctx.obj({ Illustrator: ctx.obj({ LastModified: lit("D:20261101090000"), Private: ctx.obj({ AIPrivateData1: s } as never) } as never) } as never));
      return save(doc);
    },
  },
  {
    id: "pp-c03",
    kind: "control",
    description: "Illustrator の編集用データが無く、/PieceInfo /Illustrator に日付だけ",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      pages[0]!.node.set(PDFName.of("PieceInfo"), ctx.obj({ Illustrator: ctx.obj({ LastModified: lit("D:20261101090000") } as never) } as never));
      return save(doc);
    },
  },
  {
    id: "pp-c01",
    kind: "control",
    description: "/PieceInfo の私的データが空（日付だけ）",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      pages[0]!.node.set(PDFName.of("PieceInfo"), ctx.obj({ KakuuApp: ctx.obj({ LastModified: lit("D:20261101090000"), Private: ctx.obj({}) } as never) } as never));
      doc.catalog.set(PDFName.of("PieceInfo"), ctx.obj({ KakuuApp: ctx.obj({ LastModified: lit("D:20261101090000") } as never) } as never));
      return save(doc);
    },
  },
  {
    id: "pp-c02",
    kind: "control",
    description: "画像に付いた XMP に、形式と大きさだけ",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const meta = ctx.register(ctx.stream(xmpPacket('dc:format="image/png" tiff:ImageWidth="8"', ""), { Type: "Metadata", Subtype: "XML" }));
      const form = ctx.register(ctx.stream("0 0 10 10 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Metadata: meta }));
      pages[0]!.node.set(PDFName.of("Resources"), ctx.obj({ XObject: ctx.obj({ Fm1: form } as never) } as never));
      pages[0]!.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("/Fm1 Do")));
      return save(doc);
    },
  },
];

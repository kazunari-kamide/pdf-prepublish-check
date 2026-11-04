// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの縮小画像（/Thumb）と、XFA・C2PA のお知らせの合成 PDF。鍵は thumb・xfa・c2pa。

import { PDFName } from "pdf-lib";
import type { ExtrasReport } from "../../rules/extras/index.ts";
import { lit, newDoc, placeJpeg, save, tinyJpeg, type Case } from "./pdf.ts";

export const keysOf = (r: ExtrasReport) => [...r.thumbnails.map(() => "thumb"), ...r.notices.map((n) => n.kind)];

/** APP11 の JUMBF の箱の形だけをまねたバイト列（中身は架空） */
const app11 = (label: string) => new Uint8Array([0x4a, 0x50, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0x20, ...new TextEncoder().encode("jumbjumd" + label)]);

/** tinyJpeg の APP1 の位置に、APP11 を差し込む */
function jpegWithApp11(label: string): Uint8Array {
  const base = tinyJpeg();
  const body = app11(label);
  const seg = new Uint8Array([0xff, 0xeb, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]);
  return new Uint8Array([...base.subarray(0, 2), ...seg, ...base.subarray(2)]);
}

export const CASES: Case[] = [
  {
    id: "ext-l01",
    kind: "leak",
    description: "ページの縮小画像（/Thumb）",
    leaks: ["thumb"],
    async build() {
      const { doc, ctx, pages } = await newDoc(2);
      const thumb = ctx.register(ctx.stream(new Uint8Array(30 * 20).fill(200), { Width: 30, Height: 20, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
      pages[1]!.node.set(PDFName.of("Thumb"), thumb);
      return save(doc);
    },
  },
  {
    id: "ext-l02",
    kind: "leak",
    description: "XFA のフォーム（中に入力した値）",
    leaks: ["xfa"],
    async build() {
      const { doc, ctx } = await newDoc();
      const ds = ctx.register(ctx.stream('<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><name>架空花子</name></form></xfa:data></xfa:datasets>'));
      doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [], XFA: [lit("datasets"), ds] } as never));
      return save(doc);
    },
  },
  {
    id: "ext-l03",
    kind: "leak",
    description: "C2PA（画像の来歴）の付いた JPEG（APP11）",
    leaks: ["c2pa"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      placeJpeg(ctx, pages[0]!, jpegWithApp11("c2pa"));
      return save(doc);
    },
  },
  {
    id: "ext-l04",
    kind: "leak",
    description: "文書の来歴の添付（/AFRelationship /C2PA_Manifest）",
    leaks: ["c2pa"],
    async build() {
      const { doc, ctx } = await newDoc();
      const ef = ctx.register(ctx.stream(new Uint8Array([1, 2, 3]), { Type: "EmbeddedFile" }));
      const fs = ctx.register(ctx.obj({ Type: "Filespec", F: lit("manifest.c2pa"), AFRelationship: "C2PA_Manifest", EF: { F: ef } } as never));
      doc.catalog.set(PDFName.of("AF"), ctx.obj([fs]));
      return save(doc);
    },
  },
  {
    id: "ext-c01",
    kind: "control",
    description: "縮小画像も XFA も C2PA も無い PDF（ふつうの JPEG とふつうのフォーム）",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      placeJpeg(ctx, pages[0]!, tinyJpeg());
      doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [] } as never));
      return save(doc);
    },
  },
  {
    id: "ext-c02",
    kind: "control",
    description: "C2PA でない APP11（JUMBF の別の中身）の JPEG",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      placeJpeg(ctx, pages[0]!, jpegWithApp11("othr"));
      return save(doc);
    },
  },
];

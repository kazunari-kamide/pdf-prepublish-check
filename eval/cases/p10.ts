// SPDX-License-Identifier: AGPL-3.0-only
//
// P10（画像の Exif）の合成 PDF。鍵は種類（gps・camera など）。値はすべて架空。

import { PDFName } from "pdf-lib";
import type { P10Report } from "../../rules/p10-exif/index.ts";
import { buildExifTiff, newDoc, placeJpeg, save, tinyJpeg, type Case, type IfdEntry } from "./pdf.ts";

export const keysOf = (r: P10Report) => r.findings.map((f) => f.kind);

const GPS: IfdEntry[] = [
  { tag: 0x0001, type: 2, value: "N" },
  { tag: 0x0002, type: 5, value: [35, 1, 0, 1, 0, 1] },
  { tag: 0x0003, type: 2, value: "E" },
  { tag: 0x0004, type: 5, value: [139, 1, 0, 1, 0, 1] },
];

const utf16le = (s: string) => {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out.push(c & 0xff, c >> 8);
  }
  return [...out, 0, 0];
};

const page = (tiff?: Uint8Array) => async () => {
  const { doc, ctx, pages } = await newDoc();
  placeJpeg(ctx, pages[0]!, tinyJpeg(tiff));
  return save(doc);
};

export const CASES: Case[] = [
  {
    id: "p10-l01",
    kind: "leak",
    description: "GPS の緯度・経度と、機種・ソフト",
    leaks: ["gps", "camera", "software"],
    build: page(
      buildExifTiff({
        ifd0: [
          { tag: 0x010f, type: 2, value: "KAKUU" },
          { tag: 0x0110, type: 2, value: "K-100" },
          { tag: 0x0131, type: 2, value: "KakuuEdit 1.0" },
        ],
        gps: GPS,
      }),
    ),
  },
  {
    id: "p10-l02",
    kind: "leak",
    description: "撮った人（Artist）と、Windows の作成者欄（XPAuthor。UTF-16LE）",
    leaks: ["person", "person"],
    build: page(
      buildExifTiff({
        ifd0: [
          { tag: 0x013b, type: 2, value: "Taro Yamada" },
          { tag: 0x9c9d, type: 1, value: utf16le("山田太郎") },
        ],
      }),
    ),
  },
  {
    id: "p10-l03",
    kind: "leak",
    description: "Exif の中の縮小画像（トリミングする前の写真の残り）",
    leaks: ["thumbnail"],
    build: page(buildExifTiff({ ifd0: [{ tag: 0x0112, type: 3, value: 1 }], thumbnail: tinyJpeg() })),
  },
  {
    id: "p10-l04",
    kind: "leak",
    description: "カメラの持ち主の名前と製造番号（Exif の IFD）",
    leaks: ["person", "serial"],
    build: page(
      buildExifTiff({
        exif: [
          { tag: 0xa430, type: 2, value: "Hanako Suzuki" },
          { tag: 0xa431, type: 2, value: "SN0000001" },
        ],
      }),
    ),
  },
  {
    id: "p10-l05",
    kind: "leak",
    description: "Flate と DCT の2段の画像（[/FlateDecode /DCTDecode]）の GPS",
    leaks: ["gps"],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const jpeg = tinyJpeg(buildExifTiff({ gps: GPS }));
      const ref = placeJpeg(ctx, pages[0]!, jpeg);
      const flate = ctx.flateStream(jpeg, {
        Type: "XObject",
        Subtype: "Image",
        Width: 8,
        Height: 8,
        ColorSpace: "DeviceGray",
        BitsPerComponent: 8,
      });
      flate.dict.set(PDFName.of("Filter"), ctx.obj([PDFName.of("FlateDecode"), PDFName.of("DCTDecode")]));
      ctx.assign(ref, flate);
      return save(doc);
    },
  },
  {
    id: "p10-c01",
    kind: "control",
    description: "Exif の無い JPEG",
    leaks: [],
    build: page(),
  },
  {
    id: "p10-c02",
    kind: "control",
    description: "向き・解像度・撮影の日時だけの Exif",
    leaks: [],
    build: page(
      buildExifTiff({
        ifd0: [
          { tag: 0x0112, type: 3, value: 1 },
          { tag: 0x011a, type: 5, value: [72, 1] },
          { tag: 0x0132, type: 2, value: "2026:10:01 09:00:00" },
        ],
        exif: [{ tag: 0x9003, type: 2, value: "2026:10:01 09:00:00" }],
      }),
    ),
  },
  {
    id: "p10-c03",
    kind: "control",
    description: "JPEG でない画像（Flate の灰色の画像）",
    leaks: [],
    async build() {
      const { doc, ctx, pages } = await newDoc();
      const ref = placeJpeg(ctx, pages[0]!, tinyJpeg());
      ctx.assign(ref, ctx.flateStream(new Uint8Array(64).fill(128), { Type: "XObject", Subtype: "Image", Width: 8, Height: 8, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
      return save(doc);
    },
  },
];

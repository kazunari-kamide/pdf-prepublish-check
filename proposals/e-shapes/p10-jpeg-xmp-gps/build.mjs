// SPDX-License-Identifier: AGPL-3.0-only
//
// P10（画像の位置情報など）の案：JPEG の中の XMP（APP1 の "http://ns.adobe.com/xap/1.0/\0" の包み）に、
// 撮った場所（GPS）と撮った人が残っている形。Exif の APP1 は入れない。画像 XObject に /Metadata も付けない。
//   node build.mjs [出力先]     出力先を省くと、このスクリプトの横の out/
// 名前は架空（山田太郎）。座標は海の上の架空の値。日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));
const enc = (s) => new TextEncoder().encode(s);


/**
 * 小さな JPEG（16×16、灰色の地に濃い四角）。@napi-rs/canvas で符号化し、app1 を渡すと APP0 のすぐあとに APP1 を1つ足す。
 * 本物の符号なので、画像を読む検査（P6 の画像の層など）も「読めない画像」とせずに読める。
 */
function smallJpeg(app1) {
  const c = createCanvas(16, 16);
  const g = c.getContext("2d");
  g.fillStyle = "#808080";
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = "#202020";
  g.fillRect(4, 4, 8, 8);
  const jpeg = new Uint8Array(c.toBuffer("image/jpeg", 90));
  if (!app1) return jpeg;
  if (jpeg[2] !== 0xff || jpeg[3] !== 0xe0) throw new Error("APP0 が先頭にない");
  const at = 4 + ((jpeg[4] << 8) | jpeg[5]); // APP0 のあと
  const len = app1.length + 2;
  if (len > 0xffff) throw new Error("segment too long");
  return new Uint8Array([...jpeg.subarray(0, at), 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...app1, ...jpeg.subarray(at)]);
}

/** JPEG の色の数（SOF の成分の数） */
function componentsOf(jpeg) {
  for (let i = 2; i + 9 < jpeg.length; ) {
    const m = jpeg[i + 1];
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (m >= 0xc0 && m <= 0xc2) return jpeg[i + 9];
    i += 2 + len;
  }
  throw new Error("SOF が無い");
}

/** JPEG の APP1 に入れる XMP の包み（名前空間の印 + NUL + XML） */
function xmpApp1(descriptionAttrs, inner = "") {
  const xml =
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" ${descriptionAttrs}>` +
    inner +
    `</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
  return new Uint8Array([...enc("http://ns.adobe.com/xap/1.0/"), 0, ...enc(xml)]);
}

async function pdfWithJpeg(label, jpeg) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([420, 300]);
  page.drawText(`P10 test: ${label}`, { x: 40, y: 250, size: 14, font });
  const ctx = doc.context;
  // DCTDecode のまま入れる（pdf-lib の embedJpg は使わない：中身をそのまま残すため）
  const img = ctx.register(ctx.stream(jpeg, { Type: "XObject", Subtype: "Image", Width: 16, Height: 16, ColorSpace: componentsOf(jpeg) === 1 ? "DeviceGray" : "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" }));
  page.node.setXObject(PDFName.of("Im1"), img);
  const content = ctx.register(ctx.stream("q 100 0 0 100 40 80 cm /Im1 Do Q"));
  page.node.addContentStream(content);
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

const CASES = [
  {
    name: "p10-x01-jpeg-xmp-gps-creator",
    description: "JPEG の中の XMP（APP1）に、撮った場所（exif:GPSLatitude・exif:GPSLongitude）と撮った人（dc:creator）。Exif の APP1 は無い",
    make: () =>
      pdfWithJpeg(
        "jpeg xmp gps",
        smallJpeg(
          xmpApp1(
            `exif:GPSLatitude="30,0.000N" exif:GPSLongitude="140,0.000E" exif:GPSVersionID="2.3.0.0"`,
            `<dc:creator><rdf:Seq><rdf:li>山田太郎</rdf:li></rdf:Seq></dc:creator>`,
          ),
        ),
      ),
    leaks: [
      { pattern: "P10", kind: "gps", field: "exif:GPSLatitude/exif:GPSLongitude", where: "jpeg_xmp", page: 1, chars: 0 },
      { pattern: "P10", kind: "person", field: "dc:creator", where: "jpeg_xmp", page: 1, chars: 4 },
    ],
    negatives: [],
  },
  {
    name: "p10-xc01-jpeg-xmp-orientation-only",
    description: "対照：JPEG の中の XMP（APP1）に、向き（tiff:Orientation）と大きさ（exif:PixelXDimension・exif:PixelYDimension）だけ。人や場所をたどれない",
    make: () => pdfWithJpeg("jpeg xmp orientation only", smallJpeg(xmpApp1(`tiff:Orientation="1" exif:PixelXDimension="8" exif:PixelYDimension="8"`))),
    leaks: [],
    negatives: [
      { kind: "orientation", field: "tiff:Orientation" },
      { kind: "dimensions", field: "exif:PixelXDimension/exif:PixelYDimension" },
    ],
  },
];

mkdirSync(OUT, { recursive: true });
for (const c of CASES) {
  const bytes = await c.make();
  const file = `${c.name}.pdf`;
  writeFileSync(path.join(OUT, file), bytes);
  const expected = {
    file,
    description: c.description,
    leaks: c.leaks.map((l, i) => ({ id: `${c.name}#L${i + 1}`, ...l })),
    negatives: c.negatives.map((n, i) => ({ id: `${c.name}#N${i + 1}`, ...n })),
  };
  writeFileSync(path.join(OUT, `${c.name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
  console.log(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// P4（ファイルパス・内部ホスト名）の案：画像 XObject の OPI 辞書（印刷所向けの、元の高解像度の画像の場所）の /F に、
// 作ったパソコンのパスや庁内のサーバーの場所が残っている形。
//   node build.mjs [出力先]     出力先を省くと、このスクリプトの横の out/
// 利用者名・サーバー名はすべて架空（yamada、fileserver）。日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));

/** 8×8 の灰色の画像（圧縮なし。画素は決まった模様） */
const PIXELS = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 37) % 256));

async function base(label) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([420, 300]);
  page.drawText(`P4 test: ${label}`, { x: 40, y: 250, size: 14, font });
  return { doc, ctx: doc.context, page };
}

/** 画像の辞書の中に、直接 /OPI を入れて置く。/F は字の並び（ファイル指定の辞書にはしない） */
function placeImageWithOpi(ctx, page, name, opi, x) {
  const img = ctx.register(ctx.stream(PIXELS, { Type: "XObject", Subtype: "Image", Width: 8, Height: 8, ColorSpace: "DeviceGray", BitsPerComponent: 8, OPI: opi }));
  page.node.setXObject(PDFName.of(name), img);
  return `q 120 0 0 90 ${x} 80 cm /${name} Do Q\n`;
}

const opi13 = (ctx, f) => ctx.obj({ "1.3": { Type: "OPI", Version: 1.3, F: PDFString.of(f), Size: [2400, 1800], CropRect: [0, 0, 2400, 1800], Position: [0, 0, 0, 1800, 2400, 1800, 2400, 0] } });
const opi20 = (ctx, f) => ctx.obj({ "2.0": { Type: "OPI", Version: 2.0, F: PDFString.of(f), Size: [2400, 1800] } });

const save = (doc) => doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });

// 字の並びの中の \ は、PDFString.of がそのまま書く（\\ にはしない）ので、ここで \\ にしておく
const esc = (s) => s.replace(/\\/g, "\\\\");
const USER_PATH = "C:\\Users\\yamada\\Desktop\\kouhou\\photo_hires.tif";
const SERVER_PATH = "\\\\fileserver\\share\\kouhou\\photo2_hires.tif";

const CASES = [
  {
    name: "p4-o01-opi-original-image-path",
    description: "画像2つの OPI 辞書の /F に、元の高解像度の画像の場所。1.3 版はユーザーのフォルダ（C:\\Users\\yamada\\…）、2.0 版は庁内のサーバー（\\\\fileserver\\…）",
    async make() {
      const { doc, ctx, page } = await base("OPI original image path");
      const ops = placeImageWithOpi(ctx, page, "Im1", opi13(ctx, esc(USER_PATH)), 40) + placeImageWithOpi(ctx, page, "Im2", opi20(ctx, esc(SERVER_PATH)), 220);
      page.node.addContentStream(ctx.register(ctx.stream(ops)));
      return save(doc);
    },
    leaks: [
      { pattern: "P4", kind: "user_path", where: "opi", opiVersion: "1.3", chars: USER_PATH.length },
      { pattern: "P4", kind: "server", where: "opi", opiVersion: "2.0", chars: SERVER_PATH.length },
    ],
    negatives: [],
  },
  {
    name: "p4-oc01-opi-file-name-only",
    description: "対照：画像の OPI 辞書の /F が、ドライブ名もフォルダも無いファイル名だけ（photo_hires.tif）。人や場所をたどれない",
    async make() {
      const { doc, ctx, page } = await base("OPI file name only");
      page.node.addContentStream(ctx.register(ctx.stream(placeImageWithOpi(ctx, page, "Im1", opi13(ctx, "photo_hires.tif"), 40))));
      return save(doc);
    },
    leaks: [],
    negatives: [{ kind: "file_name_only", where: "opi", name: "photo_hires.tif" }],
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

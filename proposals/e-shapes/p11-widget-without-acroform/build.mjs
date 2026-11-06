// SPDX-License-Identifier: AGPL-3.0-only
//
// P11（フォームの値）の案：カタログに /AcroForm が無い PDF の、ページのウィジェットに値（/V）が残っている形。
//   node build.mjs [出力先]     出力先を省くと、このスクリプトの横の out/
// 記入済みの申請書から一部のページだけを抜き出したときにできる形（注釈は写るが、AcroForm は写らない）。
// 名前・電話番号はすべて架空（山田太郎、090-0000-0000）。日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFHexString, PDFString, StandardFonts } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));
const HIDDEN = 2; // 注釈の /F の Hidden の印

async function base(label) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([420, 300]);
  page.drawText(`P11 test: ${label}`, { x: 40, y: 250, size: 14, font });
  return { doc, ctx: doc.context, page };
}

/** 欄とウィジェットが一体の辞書を、ページの /Annots に直接置く（/AcroForm には載せない。/AP も付けない） */
function orphanWidget(ctx, page, dict) {
  const ref = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Tx", Rect: [120, 150, 320, 170], P: page.ref, ...dict }));
  page.node.addAnnot(ref);
  return ref;
}

const save = (doc) => doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });

const VALUE = "山田太郎　090-0000-0000";

const CASES = [
  {
    name: "p11-o01-orphan-widget-hidden",
    description: "カタログに /AcroForm が無い。ページの隠しのウィジェット（/F 2、見た目なし）に、氏名と電話番号の値が残っている",
    async make() {
      const { doc, ctx, page } = await base("orphan widget");
      orphanWidget(ctx, page, { T: PDFHexString.fromText("氏名"), V: PDFHexString.fromText(VALUE), F: HIDDEN });
      return save(doc);
    },
    leaks: [{ pattern: "P11", visibility: "orphan_widget", fieldType: "text", page: 1, chars: [...VALUE].length, hiddenFlag: true }],
    negatives: [],
  },
  {
    name: "p11-oc01-orphan-widget-empty",
    description: "対照：/AcroForm が無いページのウィジェットで、/V が空の字（()）のものと、/V が無いもの。値は残っていない",
    async make() {
      const { doc, ctx, page } = await base("orphan widget, empty");
      orphanWidget(ctx, page, { T: PDFHexString.fromText("氏名"), V: PDFString.of(""), F: HIDDEN });
      orphanWidget(ctx, page, { T: PDFHexString.fromText("電話番号"), Rect: [120, 110, 320, 130], F: HIDDEN });
      return save(doc);
    },
    leaks: [],
    negatives: [
      { kind: "orphan_widget_empty_value", field: "氏名" },
      { kind: "orphan_widget_no_value", field: "電話番号" },
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

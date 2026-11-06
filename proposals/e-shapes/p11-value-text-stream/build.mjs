// SPDX-License-Identifier: AGPL-3.0-only
//
// P11（フォームの値）の案：テキストの欄の値（/V）が、字の並びでなく、圧縮したストリーム（text stream）で入っている形。
//   node build.mjs [出力先]     出力先を省くと、このスクリプトの横の out/
// ISO 32000 の 12.7.4.3 で、テキストの欄の /V は text string か text stream（PDF 1.5 から）と決まっている。
// 名前・住所はすべて架空（山田太郎、○○町1-2-3）。日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));
const HIDDEN = 2; // 注釈の /F の Hidden の印
const MULTILINE = 4096; // 欄の /Ff の Multiline の印

async function base(label) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([420, 300]);
  page.drawText(`P11 test: ${label}`, { x: 40, y: 250, size: 14, font });
  return { doc, ctx: doc.context, page };
}

/** UTF-16BE（BOM つき）のバイト列 */
function utf16be(s) {
  const out = [0xfe, 0xff];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c >> 8, c & 0xff);
  }
  return new Uint8Array(out);
}

/** 値をストリームで持つテキストの欄（ウィジェットと一体）。/AcroForm /Fields に載せる */
function streamField(ctx, page, name, valueBytes, rect) {
  const v = ctx.register(ctx.flateStream(valueBytes));
  const ref = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Tx", Ff: MULTILINE, T: PDFHexString.fromText(name), V: v, Rect: rect, F: HIDDEN, P: page.ref }),
  );
  page.node.addAnnot(ref);
  return ref;
}

const setFields = (doc, fields) => doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: fields }));
const save = (doc) => doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });

const VALUE = "山田太郎　○○町1-2-3";

const CASES = [
  {
    name: "p11-s01-value-text-stream",
    description: "隠しのウィジェット（/F 2）の複数行のテキストの欄。値（/V）が Flate で圧縮したストリームで、中身は UTF-16BE の氏名と住所",
    async make() {
      const { doc, ctx, page } = await base("value as text stream");
      setFields(doc, [streamField(ctx, page, "備考", utf16be(VALUE), [120, 120, 360, 180])]);
      return save(doc);
    },
    leaks: [{ pattern: "P11", visibility: "hidden", fieldType: "text", page: 1, chars: [...VALUE].length, valueForm: "stream" }],
    negatives: [],
  },
  {
    name: "p11-sc01-empty-text-streams",
    description: "対照：値（/V）がストリームだが、中身が 0 バイトの欄と、空白だけ（UTF-16BE の空白と改行）の欄。値は残っていない",
    async make() {
      const { doc, ctx, page } = await base("empty text streams");
      setFields(doc, [
        streamField(ctx, page, "備考", new Uint8Array(0), [120, 160, 360, 200]),
        streamField(ctx, page, "メモ", utf16be(" 　\n "), [120, 100, 360, 140]),
      ]);
      return save(doc);
    },
    leaks: [],
    negatives: [
      { kind: "empty_value_stream", field: "備考", bytes: 0 },
      { kind: "blank_value_stream", field: "メモ" },
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

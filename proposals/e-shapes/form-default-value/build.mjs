// SPDX-License-Identifier: AGPL-3.0-only
//
// P11 の案：様式の字の欄の値（/V）は消したが、既定の値（/DV）に前の記入（名前・電話番号）が残る形。
// 「入力内容をクリア」のボタン（ResetForm の動作）を押すと、既定の値が欄に入って画面に出る。
//   node build.mjs [出力先のフォルダ]
// 出力先を省くと、このファイルの横の out/ に書く。
// - 名前・電話番号はすべて架空。
// - 日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));
const PAGE = [400, 300];
const PUSH = 1 << 16; // 65536（押すボタン）
const chars = (s) => [...s.replace(/\s/g, "")].length;

async function base() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage(PAGE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const fields = [];
  page.drawText("Application form (sample)", { x: 40, y: 260, size: 14, font, color: rgb(0, 0, 0) });
  const add = (dict) => {
    const ref = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", F: 4, P: page.ref, ...dict }));
    const annots = page.node.Annots();
    if (annots) annots.push(ref);
    else page.node.set(PDFName.of("Annots"), ctx.obj([ref]));
    fields.push(ref);
  };
  const emptyAp = (w, h) => ctx.register(ctx.stream("/Tx BMC EMC", { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h] }));
  /** /V の無い字の欄。/DV に既定の値 */
  const textField = (name, label, y, dv) => {
    page.drawText(label, { x: 40, y: y + 6, size: 11, font, color: rgb(0, 0, 0) });
    const rect = [160, y, 340, y + 20];
    add({ Rect: rect, FT: "Tx", T: PDFString.of(name), DV: PDFHexString.fromText(dv), DA: PDFString.of("/Helv 10 Tf 0 g"), AP: { N: emptyAp(180, 20) }, MK: { BC: [0.5, 0.5, 0.5] } });
    return rect;
  };
  const resetButton = () => {
    const ap = ctx.register(ctx.stream("q 0.85 g 0 0 80 20 re f BT /Helv 10 Tf 0 g 22 6 Td (Clear) Tj ET Q", {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, 80, 20], Resources: { Font: { Helv: font.ref } },
    }));
    add({ Rect: [160, 60, 240, 80], FT: "Btn", Ff: PUSH, T: PDFString.of("clear"), MK: { CA: PDFString.of("Clear") }, A: { S: "ResetForm" }, AP: { N: ap } });
  };
  const finish = () => {
    doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: fields, DA: PDFString.of("/Helv 0 Tf 0 g"), DR: { Font: { Helv: font.ref } } }));
  };
  return { doc, textField, resetButton, finish };
}

async function save(doc, name, description, leaks, negatives) {
  const bytes = await doc.save({ useObjectStreams: false });
  const expected = {
    file: `${name}.pdf`, description, pages: 1,
    leaks: leaks.map((l, i) => ({ id: `${name}#L${i + 1}`, ...l })),
    negatives: negatives.map((n, i) => ({ id: `${name}#N${i + 1}`, ...n })),
  };
  writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
  writeFileSync(path.join(OUT, `${name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
  return { name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

mkdirSync(OUT, { recursive: true });
const rows = [];

// 漏れ：値は無いが、既定の値に前の記入の名前と電話番号
{
  const { doc, textField, resetButton, finish } = await base();
  const name = "北川花子", phone = "090-0000-0000";
  const r1 = textField("applicant", "Name", 200, name);
  const r2 = textField("phone", "Phone", 160, phone);
  resetButton();
  finish();
  rows.push(await save(doc, "e-dv-01-default-value-left",
    "字の欄の値（/V）は無く見た目も空だが、既定の値（/DV）に前の記入の名前と電話番号が残る。「Clear」のボタン（ResetForm）を押すと欄に出る",
    [
      { pattern: "P11", kind: "default_value", page: 1, field: "applicant", rect: r1, remaining: { chars: chars(name) } },
      { pattern: "P11", kind: "default_value", page: 1, field: "phone", rect: r2, remaining: { chars: chars(phone) } },
    ], []));
}

// 対照：既定の値が決まった案内の言葉だけの欄
{
  const { doc, textField, resetButton, finish } = await base();
  const r1 = textField("applicant", "Name", 200, "記入してください");
  const r2 = textField("note", "Note", 160, "（例）");
  resetButton();
  finish();
  rows.push(await save(doc, "e-dv-02-guide-words-only",
    "対照：既定の値（/DV）が「記入してください」「（例）」のような決まった案内の言葉だけの欄。「Clear」のボタン（ResetForm）もある",
    [], [
      { kind: "guide_words", page: 1, field: "applicant", rect: r1, note: "既定の値は案内の言葉だけ" },
      { kind: "guide_words", page: 1, field: "note", rect: r2, note: "既定の値は案内の言葉だけ" },
    ]));
}

for (const r of rows) console.log(`${r.sha256}  ${r.name}.pdf  ${r.bytes} バイト`);

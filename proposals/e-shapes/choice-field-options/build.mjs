// SPDX-License-Identifier: AGPL-3.0-only
//
// P11 の案：様式の選ぶ欄（開く一覧。/FT /Ch、/Ff に Combo の 131072）の選択肢（/Opt）に、
// 担当者の名前や書き出し用のメールアドレスが残る形。
//   node build.mjs [出力先のフォルダ]
// 出力先を省くと、このファイルの横の out/ に書く。
// - 名前・メールアドレス（example.jp）・内線の番号はすべて架空。
// - 日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));
const PAGE = [400, 300];
const COMBO = 1 << 17; // 131072
const t = (s) => PDFHexString.fromText(s); // UTF-16BE の字の列

async function base() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage(PAGE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const fields = [];
  page.drawText("Application form (sample)", { x: 40, y: 260, size: 14, font, color: rgb(0, 0, 0) });
  /** 選ぶ欄を1つ足す。ap は見た目に描く命令（省くと空の見た目） */
  const choice = (name, label, y, flags, opt, ap = "") => {
    page.drawText(label, { x: 40, y: y + 6, size: 11, font, color: rgb(0, 0, 0) });
    const h = ap ? 40 : 20;
    const rect = [160, y, 340, y + h];
    const apStream = ctx.register(ctx.stream(ap, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 180, h], Resources: { Font: { Helv: font.ref } } }));
    const ref = ctx.register(ctx.obj({
      Type: "Annot", Subtype: "Widget", F: 4, Rect: rect, P: page.ref, FT: "Ch", Ff: flags, T: PDFString.of(name),
      Opt: opt.map((o) => (Array.isArray(o) ? o.map(t) : t(o))), DA: PDFString.of("/Helv 10 Tf 0 g"), AP: { N: apStream },
      MK: { BC: [0.5, 0.5, 0.5] },
    }));
    const annots = page.node.Annots();
    if (annots) annots.push(ref);
    else page.node.set(PDFName.of("Annots"), ctx.obj([ref]));
    fields.push(ref);
    return rect;
  };
  const finish = () => {
    doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: fields, DA: PDFString.of("/Helv 0 Tf 0 g"), DR: { Font: { Helv: font.ref } } }));
  };
  return { doc, choice, finish };
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

// 漏れ：開く一覧の選択肢に、書き出し用のメールアドレスと表示する名前の組、内線・電話番号つきの担当者
{
  const { doc, choice, finish } = await base();
  const staff = [["k.kitagawa@example.jp", "北川花子"], ["j.kawamoto@example.jp", "川本次郎"], ["m.oshima@example.jp", "大島美咲"]];
  const contact = ["窓口 A（内線 1234）", "担当 北川（090-0000-1111）"];
  const r1 = choice("staff", "Person in charge", 200, COMBO, staff);
  const r2 = choice("contact", "Contact", 160, COMBO, contact);
  finish();
  rows.push(await save(doc, "e-choice-01-combo-options-personal",
    "開く一覧（Combo）の選ぶ欄の選択肢（/Opt）に、書き出し用の個人のメールアドレスと名前の組、内線・電話番号つきの担当者。値（/V）は無く、見た目は空",
    [
      { pattern: "P11", kind: "choice_option", page: 1, field: "staff", rect: r1, options: staff.length, note: "書き出し用の値と表示する名前の組（2要素の配列）" },
      { pattern: "P11", kind: "choice_option", page: 1, field: "contact", rect: r2, options: contact.length, note: "ただの字の選択肢" },
    ], []));
}

// 対照：決まった言葉だけの開く一覧と、選択肢が画面に並んで見える一覧の箱（Combo なし）
{
  const { doc, choice, finish } = await base();
  const r1 = choice("answer", "Answer", 200, COMBO, [["yes", "はい"], ["no", "いいえ"]]);
  const r2 = choice("time", "Time", 160, COMBO, ["午前", "午後"]);
  const desks = ["desk-a@example.jp", "desk-b@example.jp"];
  const ap = `/Tx BMC q BT /Helv 10 Tf 0 g 4 26 Td (${desks[0]}) Tj 0 -14 Td (${desks[1]}) Tj ET Q EMC`;
  const r3 = choice("desk", "Desk", 100, 0, desks, ap);
  finish();
  rows.push(await save(doc, "e-choice-02-fixed-words-and-listbox",
    "対照：選択肢が「はい」「いいえ」「午前」「午後」だけの開く一覧と、選択肢（窓口のアドレス）が画面に並んで見える一覧の箱（Combo なし）",
    [], [
      { kind: "fixed_words", page: 1, field: "answer", rect: r1, note: "決まった言葉だけ（書き出し用の値も決まった言葉）" },
      { kind: "fixed_words", page: 1, field: "time", rect: r2, note: "決まった言葉だけ" },
      { kind: "listbox_visible", page: 1, field: "desk", rect: r3, note: "一覧の箱。選択肢は見た目に描いてあり、画面で見えている" },
    ]));
}

for (const r of rows) console.log(`${r.sha256}  ${r.name}.pdf  ${r.bytes} バイト`);

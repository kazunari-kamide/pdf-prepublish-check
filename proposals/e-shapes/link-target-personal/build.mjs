// SPDX-License-Identifier: AGPL-3.0-only
//
// P4 の案：見える字は課の名前・「別紙はこちら」だけなのに、リンクの行き先（/URI）に
// 個人のメールアドレスや、個人の保存場所（/personal/<名前>/…）とファイル名が残る形。
//   node build.mjs [出力先のフォルダ]
// 出力先を省くと、このファイルの横の out/ に書く。
// - 名前・アドレス・ホスト名はすべて架空（ホスト名は example.jp の下）。実在の製品のドメインは使わない。
// - 日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));
const PAGE = [400, 300];
const ASC = 0.718, DESC = -0.207, SIZE = 12;
const r2 = (v) => Math.round(v * 100) / 100;

async function base() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage(PAGE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Notice from the section in charge (sample)", { x: 40, y: 260, size: 12, font, color: rgb(0, 0, 0) });
  /** 字を書き、その字の箱にリンクを付ける。target を渡すと、行の中のその部分だけにリンク */
  const link = (line, y, uri, target = line) => {
    page.drawText(line, { x: 40, y, size: SIZE, font, color: rgb(0, 0, 0.6) });
    const x0 = 40 + font.widthOfTextAtSize(line.slice(0, line.indexOf(target)), SIZE);
    const rect = [r2(x0), r2(y + DESC * SIZE), r2(x0 + font.widthOfTextAtSize(target, SIZE)), r2(y + ASC * SIZE)];
    const ref = doc.context.register(doc.context.obj({
      Type: "Annot", Subtype: "Link", F: 4, Rect: rect, Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of(uri) },
    }));
    const annots = page.node.Annots();
    if (annots) annots.push(ref);
    else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
    return rect;
  };
  return { doc, link };
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

// 漏れ：個人の保存場所の URL と、ページの字に無い個人のメールアドレス
{
  const { doc, link } = await base();
  const store = "https://share.example.jp/personal/jiro_kawamoto_example_jp/Documents/annex-member-list.xlsx";
  const mail = "mailto:jiro.kawamoto@example.jp";
  const r1 = link("See the annex here", 200, store);
  const r2 = link("Contact the section in charge", 170, mail);
  rows.push(await save(doc, "e-link-01-personal-targets",
    "見える字は「See the annex here」「Contact the section in charge」だけ。リンクの行き先に、個人の保存場所（/personal/<名前>/Documents/<ファイル名>）と、ページの字に無い個人のメールアドレス",
    [
      { pattern: "P4", kind: "personal_storage_url", level: "high", page: 1, rect: r1, note: "ホスト名に点のある https。パスに /personal/<名前>/ とファイル名" },
      { pattern: "P4", kind: "mailto_not_in_text", level: "check", page: 1, rect: r2, note: "行き先のアドレスがページの字に無い。個人か課の共用かはルールで見分けにくいので「確認」【仮】" },
    ], []));
}

// 対照：ページの字と同じアドレスへの mailto、公開のページへの https、窓口らしい局所部（info）の mailto
{
  const { doc, link } = await base();
  const r1 = link("Mail: soudan@example.jp", 200, "mailto:soudan@example.jp", "soudan@example.jp");
  const r2 = link("Notice page", 170, "https://www.example.jp/notice/annex.html");
  const r3 = link("Inquiries", 140, "mailto:info@example.jp");
  rows.push(await save(doc, "e-link-02-visible-or-public-targets",
    "対照：行き先のアドレスがページの字にも書いてある mailto、公開のページへの https、窓口らしい局所部（info）の mailto",
    [], [
      { kind: "mailto_in_text", page: 1, rect: r1, note: "同じアドレスがページの字にある" },
      { kind: "public_web_link", page: 1, rect: r2, note: "公開のページ" },
      { kind: "office_mailbox", page: 1, rect: r3, note: "info のような窓口の局所部。ページの字には無いが、個人のアドレスではない（扱いはルールの段で決める【仮】）" },
    ]));
}

for (const r of rows) console.log(`${r.sha256}  ${r.name}.pdf  ${r.bytes} バイト`);

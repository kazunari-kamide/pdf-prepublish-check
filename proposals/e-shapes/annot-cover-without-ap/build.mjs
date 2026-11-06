// SPDX-License-Identifier: AGPL-3.0-only
//
// P6 の案：見た目（/AP）の無い、黒い楕円（/Circle）・手書き（/Ink）の注釈で字を覆った形。
//   node build.mjs [出力先のフォルダ]
// 出力先を省くと、このファイルの横の out/ に書く。
// - 名前・電話番号はすべて架空。注釈に作成者欄（/T）は付けない（P8 と混ざらないように）。
// - 日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));
const PAGE = [400, 300];
const ASC = 0.718; // Helvetica の Ascent・Descent
const DESC = -0.207;
const SIZE = 12;
const r2 = (v) => Math.round(v * 100) / 100;
const chars = (s) => [...s.replace(/\s/g, "")].length;

async function base() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage(PAGE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const text = (s, x, y) => page.drawText(s, { x, y, size: SIZE, font, color: rgb(0, 0, 0) });
  /** 行 (x, y) の中の target（前に before がある）の箱 */
  const span = (x, y, before, target) => {
    const x0 = x + font.widthOfTextAtSize(before, SIZE);
    return [r2(x0), r2(y + DESC * SIZE), r2(x0 + font.widthOfTextAtSize(target, SIZE)), r2(y + ASC * SIZE)];
  };
  const annot = (dict) => {
    const ref = doc.context.register(doc.context.obj({ Type: "Annot", F: 4, ...dict }));
    const annots = page.node.Annots();
    if (annots) annots.push(ref);
    else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
  };
  /**
   * 行 (x, y) の字のうち、形（inside(px, py) が真の所）に箱の半分以上が隠れる字（空白は数えない）。
   * 字の箱の中に 8×8 の点を置いて割合を測る（検証器の README の測り方と同じ考え方）
   */
  const covered = (line, x, y, inside) => {
    let cx = x, n = 0, box = null;
    for (const ch of line) {
      const w = font.widthOfTextAtSize(ch, SIZE);
      const b = [cx, y + DESC * SIZE, cx + w, y + ASC * SIZE];
      cx += w;
      if (ch.trim() === "") continue;
      let hit = 0;
      for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
        if (inside(b[0] + ((i + 0.5) / 8) * (b[2] - b[0]), b[1] + ((j + 0.5) / 8) * (b[3] - b[1]))) hit++;
      }
      if (hit / 64 < 0.5) continue;
      n++;
      box = box ? [Math.min(box[0], b[0]), box[1], Math.max(box[2], b[2]), box[3]] : b;
    }
    return { chars: n, rect: box ? box.map(r2) : null };
  };
  text("Application form (sample)", 40, 260);
  return { doc, page, text, span, annot, covered };
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

// 漏れ：氏名の上に黒い楕円、電話番号の上に黒い太い手書きの線。どちらも /AP なし
{
  const { doc, text, span, annot, covered } = await base();
  const pre1 = "Applicant: ", name = "Jiro Kawamoto";
  text(pre1 + name, 40, 220);
  const t1 = span(40, 220, pre1, name);
  // 楕円が字の箱をすっぽり含むように、箱の幅・高さの √2 倍に、線の幅の分を足す
  const cx = (t1[0] + t1[2]) / 2, cy = (t1[1] + t1[3]) / 2;
  const rx = ((t1[2] - t1[0]) / 2) * Math.SQRT2 + 2, ry = ((t1[3] - t1[1]) / 2) * Math.SQRT2 + 2;
  annot({ Subtype: "Circle", Rect: [r2(cx - rx), r2(cy - ry), r2(cx + rx), r2(cy + ry)], C: [0, 0, 0], IC: [0, 0, 0], BS: { W: 1 } });

  const pre2 = "Phone: ", phone = "000-1111-2222";
  text(pre2 + phone, 40, 170);
  const t2 = span(40, 170, pre2, phone);
  // 字の高さ（約 11.1）より太い 14 の線で、字の中ほどを 2 往復する。両端は字の箱より 4 外へ出す
  const y = r2((t2[1] + t2[3]) / 2), xa = r2(t2[0] - 4), xb = r2(t2[2] + 4);
  annot({ Subtype: "Ink", Rect: [r2(xa - 8), r2(y - 8), r2(xb + 8), r2(y + 8)], InkList: [[xa, y, xb, y, xa, y, xb, y]], C: [0, 0, 0], BS: { W: 14 } });

  // 正解の箱と字数は、実際に覆った字（楕円は字の箱より広いので、前の「t: 」の一部も隠れる）
  const c1 = covered(pre1 + name, 40, 220, (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1);
  const c2 = covered(pre2 + phone, 40, 170, (px, py) => px >= xa && px <= xb && Math.abs(py - y) <= 7);
  rows.push(await save(doc, "e-annot-01-circle-and-ink-without-ap",
    "氏名の上に黒い楕円の注釈（/Circle、/IC 黒）、電話番号の上に太い黒い手書きの注釈（/Ink、/W 14）。どちらも見た目（/AP）が無く、下の字はページの中身に残る",
    [
      { pattern: "P6", layer: "text", cover: "annotation", page: 1, rect: c1.rect, remaining: { chars: c1.chars } },
      { pattern: "P6", layer: "text", cover: "annotation", page: 1, rect: c2.rect, remaining: { chars: c2.chars } },
    ], []));
  console.log(`覆った字：楕円 ${c1.chars} 字（氏名は ${chars(name)} 字）、手書きの線 ${c2.chars} 字（電話番号は ${chars(phone)} 字）`);
}

// 対照：字の下に細い手書きの下線（/W 1）、字の無い余白の黒い楕円。どちらも /AP なし
{
  const { doc, text, span, annot } = await base();
  const pre = "Submission deadline: ", date = "2026-12-01";
  text(pre + date, 40, 220);
  const t = span(40, 220, pre, date);
  const uy = r2(t[1] - 1.5);
  annot({ Subtype: "Ink", Rect: [r2(t[0] - 2), r2(uy - 2), r2(t[2] + 2), r2(uy + 2)], InkList: [[t[0], uy, t[2], uy]], C: [0, 0, 0], BS: { W: 1 } });
  const blank = [300, 40, 360, 80];
  annot({ Subtype: "Circle", Rect: blank, C: [0, 0, 0], IC: [0, 0, 0], BS: { W: 1 } });
  rows.push(await save(doc, "e-annot-02-underline-and-margin-circle",
    "対照：字の下の細い手書きの下線（/Ink、/W 1）と、字の無い余白の黒い楕円（/Circle）。どちらも見た目（/AP）が無い",
    [], [
      { kind: "underline", page: 1, rect: [r2(t[0]), r2(uy - 0.5), r2(t[2]), r2(uy + 0.5)], note: "字の下端より下の細い線" },
      { kind: "shapes_no_text", page: 1, rect: blank, note: "下に字の無い黒い楕円" },
    ]));
}

for (const r of rows) console.log(`${r.sha256}  ${r.name}.pdf  ${r.bytes} バイト`);

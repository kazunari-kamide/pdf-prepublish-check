// SPDX-License-Identifier: AGPL-3.0-only
//
// P4（ファイルパス・内部ホスト名）の案：カタログの URI の基準（/URI /Base。ISO 32000 の 12.6.4.7）に、
// 作った場所の file:// のパスが残っている形。ページには、この基準につないで解かれる相対のリンクを1つ置く。
//   node build.mjs [出力先]     出力先を省くと、このスクリプトの横の out/
// 利用者名はすべて架空（yamada）。日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));

async function withBase(label, base) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([420, 300]);
  page.drawText(`P4 test: ${label}`, { x: 40, y: 250, size: 14, font });
  page.drawText("bessi.html", { x: 40, y: 150, size: 12, font });
  const ctx = doc.context;
  // カタログの中に直接置く（間接オブジェクトにしない）
  doc.catalog.set(PDFName.of("URI"), ctx.obj({ Base: PDFString.of(base) }));
  page.node.addAnnot(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [40, 145, 120, 165], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("bessi.html") } })));
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

const USER_BASE = "file:///C:/Users/yamada/Documents/sagyou/";
const WEB_BASE = "https://www.example.jp/kouhou/";

const CASES = [
  {
    name: "p4-u01-catalog-uri-base-file",
    description: "カタログの /URI /Base が file:///C:/Users/yamada/…（作った場所のユーザーのフォルダ）。ページに相対のリンク（bessi.html）が1つ",
    make: () => withBase("catalog URI base (file)", USER_BASE),
    leaks: [{ pattern: "P4", kind: "user_path", where: "uri_base", chars: USER_BASE.length }],
    negatives: [{ kind: "relative_link", where: "link", name: "bessi.html" }],
  },
  {
    name: "p4-uc01-catalog-uri-base-web",
    description: "対照：カタログの /URI /Base が公開のウェブの場所（https://www.example.jp/kouhou/）。ページに相対のリンク（bessi.html）が1つ",
    make: () => withBase("catalog URI base (web)", WEB_BASE),
    leaks: [],
    negatives: [
      { kind: "web_base", where: "uri_base", name: WEB_BASE },
      { kind: "relative_link", where: "link", name: "bessi.html" },
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

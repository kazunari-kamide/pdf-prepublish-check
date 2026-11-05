// SPDX-License-Identifier: AGPL-3.0-only
//
// 埋め込み画像・模様の覆いの型の、合成 PDF と正解データを作る（採点する側に足す案）。
//   node proposals/a-p6-inline-pattern/build.mjs [出力先のフォルダ]
// 出力先を省くと、このフォルダの out/ に書く。人が中身を見て、fixtures/p6・p7 に移す（README.md）。
// 字はすべて架空。日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));
const PAGE = [400, 300];
const ASC = 0.718; // Helvetica の Ascent・Descent
const DESC = -0.207;
const r2 = (v) => Math.round(v * 100) / 100;

/** Helvetica で s を大きさ size で x・y に描いたときの箱 */
function box(font, s, x, y, size = 12) {
  const w = font.widthOfTextAtSize(s, size);
  return [r2(x), r2(y + DESC * size), r2(x + w), r2(y + ASC * size)];
}
const chars = (s) => [...s.replace(/\s/g, "")].length;

async function base() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage(PAGE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, page, font };
}

function setContent(doc, page, font, content, extra = {}) {
  const res = { Font: { F1: font.ref } };
  if (extra.pattern) res.Pattern = extra.pattern;
  if (extra.shading) res.Shading = extra.shading;
  page.node.set(PDFName.of("Resources"), doc.context.obj(res));
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(content)));
}

/** 4×4 の灰色の埋め込み画像（v は 0〜255）を、行列 m で置く命令 */
const inline = (v, m) => `q ${m} cm BI /W 4 /H 4 /CS /G /BPC 8 /F /AHx ID ${v.toString(16).padStart(2, "0").repeat(16)}> EI Q`;

/** すき間なく塗るタイルの模様（g は塗りの灰色）。body を渡すと、その中身 */
function tiling(doc, font, { g = 0, body, step = 10 } = {}) {
  return doc.context.register(
    doc.context.stream(body ?? `${g} g 0 0 ${step} ${step} re f`, {
      Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, step, step], XStep: step, YStep: step, Resources: { Font: { F1: font.ref } },
    }),
  );
}

const NAME = "Taro Yamada";

const CASES = [
  {
    dir: "p6",
    name: "p6-t11-inline-image-over-name",
    description: "氏名の上に、黒い埋め込み画像（ページの中身に直接書いた画像）を重ねただけ（下の字が残っている）",
    async make() {
      const { doc, page, font } = await base();
      const t = box(font, NAME, 40, 200);
      setContent(doc, page, font, `0 g BT /F1 12 Tf 40 200 Td (${NAME}) Tj ET\n${inline(0, `${r2(t[2] - t[0] + 10)} 0 0 18 35 195`)}`);
      return { doc, leaks: [{ pattern: "P6", layer: "text", cover: "image", page: 1, rect: t, remaining: { chars: chars(NAME) } }], negatives: [] };
    },
  },
  {
    dir: "p6",
    name: "p6-t12-pattern-over-name",
    description: "氏名の上に、黒い模様（すき間なく塗るタイルの模様）で塗った四角を重ねただけ",
    async make() {
      const { doc, page, font } = await base();
      const t = box(font, NAME, 40, 200);
      setContent(doc, page, font, `0 g BT /F1 12 Tf 40 200 Td (${NAME}) Tj ET\nq /Pattern cs /P0 scn 35 195 ${r2(t[2] - t[0] + 10)} 18 re f Q`, { pattern: { P0: tiling(doc, font) } });
      return { doc, leaks: [{ pattern: "P6", layer: "text", cover: "fill", page: 1, rect: t, remaining: { chars: chars(NAME) } }], negatives: [] };
    },
  },
  {
    dir: "p6",
    name: "p6-t13-shading-over-name",
    description: "氏名の上の四角の切り抜きの中を、濃いシェーディング（sh）で塗っただけ",
    async make() {
      const { doc, page, font } = await base();
      const t = box(font, NAME, 40, 200);
      const sh = doc.context.obj({ ShadingType: 2, ColorSpace: "DeviceGray", Coords: [0, 0, 400, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [0], C1: [0.15], N: 1 }, Extend: [true, true] });
      setContent(doc, page, font, `0 g BT /F1 12 Tf 40 200 Td (${NAME}) Tj ET\nq 35 195 ${r2(t[2] - t[0] + 10)} 18 re W n /S0 sh Q`, { shading: { S0: sh } });
      return { doc, leaks: [{ pattern: "P6", layer: "text", cover: "fill", page: 1, rect: t, remaining: { chars: chars(NAME) } }], negatives: [] };
    },
  },
  {
    dir: "p6",
    name: "p6-d11-inline-image-and-pattern-controls",
    description: "隠していない形：字のない所の白い埋め込み画像、字の下に置いた黒い埋め込み画像（上に白い字）、字の上の細い斜線の模様、字のない所の模様",
    async make() {
      const { doc, page, font } = await base();
      const a = "Example office";
      const b = "Section notice";
      const ta = box(font, a, 40, 120);
      const tb = box(font, b, 40, 80);
      const hatch = tiling(doc, font, { body: "0 g 0 0 10 2 re f" });
      const c = [
        inline(255, "100 0 0 30 250 220"),
        inline(0, `${r2(ta[2] - ta[0] + 10)} 0 0 18 35 115`),
        `1 g BT /F1 12 Tf 40 120 Td (${a}) Tj ET`,
        `0 g BT /F1 12 Tf 40 80 Td (${b}) Tj ET`,
        `q /Pattern cs /P1 scn 35 75 ${r2(tb[2] - tb[0] + 10)} 18 re f Q`,
        "q /Pattern cs /P0 scn 250 40 100 30 re f Q",
      ].join("\n");
      setContent(doc, page, font, c, { pattern: { P0: tiling(doc, font), P1: hatch } });
      return {
        doc,
        leaks: [],
        negatives: [
          { kind: "visible_on_dark", page: 1, rect: ta, note: "黒い埋め込み画像のあとに白い字" },
          { kind: "translucent_highlight", page: 1, rect: tb, note: "細い斜線の模様（すき間が多い）" },
        ],
      };
    },
  },
  {
    dir: "p7",
    name: "p7-28-pattern-white-text",
    description: "白い地のタイルの模様の中に、白い字で氏名が書いてあり、その模様で四角を塗った",
    async make() {
      const { doc, page, font } = await base();
      const body = `1 g 0 0 150 30 re f 1 g BT /F1 12 Tf 5 10 Td (${NAME}) Tj ET`;
      const pat = doc.context.register(
        doc.context.stream(body, { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 150, 30], XStep: 150, YStep: 30, Resources: { Font: { F1: font.ref } } }),
      );
      setContent(doc, page, font, "q /Pattern cs /P0 scn 0 180 150 30 re f Q", { pattern: { P0: pat } });
      // タイル (0, 6) が 0〜150 × 180〜210 に来る。字の原点は (5, 190)
      return { doc, leaks: [{ pattern: "P7", reason: "same_color", page: 1, rect: box(font, NAME, 5, 190), chars: chars(NAME) }], negatives: [] };
    },
  },
];

mkdirSync(OUT, { recursive: true });
const lines = [];
for (const c of CASES) {
  const r = await c.make();
  const bytes = new Uint8Array(await r.doc.save({ useObjectStreams: false }));
  const dir = path.join(OUT, c.dir);
  mkdirSync(dir, { recursive: true });
  const file = `${c.name}.pdf`;
  writeFileSync(path.join(dir, file), bytes);
  const expected = { file, description: c.description, pages: 1 };
  expected.leaks = r.leaks.map((l, i) => ({ id: `${c.name}#L${i + 1}`, ...l }));
  expected.negatives = r.negatives.map((n, i) => ({ id: `${c.name}#N${i + 1}`, ...n }));
  writeFileSync(path.join(dir, `${c.name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  lines.push(`${c.dir}/${file}  ${sha.slice(0, 16)}  漏れ ${expected.leaks.length}・漏れでない ${expected.negatives.length}`);
}
console.log(lines.join("\n"));

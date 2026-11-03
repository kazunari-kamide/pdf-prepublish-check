// SPDX-License-Identifier: AGPL-3.0-only
//
// P6（見せかけの黒塗り）の合成 PDF を足す案。fixtures/p6/build.mjs とは別のスクリプトにした。
//   node proposals/p6/additions/build-additions.mjs      → proposals/p6/additions/fixtures/p6/ に書く
// 移したあとに fixtures/p6/build-additions.mjs として置けば、同じフォルダ（fixtures/p6/）に書く。
//
// 足す型（検出ルールの判定の値で、合成 PDF がなく測れていないもの。rules/p6-text/README.md）：
// - 半透明の黒（不透明さ 0.3・0.6・0.95）
// - 四角でない覆い（楕円、1度・3度回した四角、角の丸い四角）
// - 図形の多い重いページ（曲線 12 万本。CLAUDE.md §5）
// 名前はすべて架空（Taro Yamada など）。字は標準の Helvetica（ASCII だけ）なので、フォントは埋め込まない。
// 乱数は種を固定した自前のもの、日時は書かないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { readdirSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDFDocument,
  PDFName,
  StandardFonts,
  appendBezierCurve,
  closePath,
  degrees,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingGrayscaleColor,
} from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// proposals/p6/additions/ で動かしたら、その下の fixtures/p6/ に書く。fixtures/p6/ に移したら、同じフォルダに書く
const OUT = path.basename(HERE) === "p6" && path.basename(path.dirname(HERE)) === "fixtures" ? HERE : path.join(HERE, "fixtures", "p6");
const PAGE = [595, 842];
const SIZE = 14;
const ASC = 0.718; // Helvetica の Ascent（1000 分の 718）
const DESC = -0.207;

const r2 = (v) => Math.round(v * 100) / 100;
const box = (pts) => [r2(Math.min(...pts.map((p) => p[0]))), r2(Math.min(...pts.map((p) => p[1]))), r2(Math.max(...pts.map((p) => p[0]))), r2(Math.max(...pts.map((p) => p[1])))];

async function base(pages = 1) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage(PAGE);
  return { doc, font, pages: doc.getPages() };
}

/** 字を描き、字の並びの箱 [x0, y0, x1, y1] と、空白でない字の数を返す */
function text(page, font, s, x, y) {
  page.drawText(s, { x, y, size: SIZE, font, color: rgb(0, 0, 0) });
  const w = font.widthOfTextAtSize(s, SIZE);
  return { rect: [r2(x), r2(y + DESC * SIZE), r2(x + w), r2(y + ASC * SIZE)], chars: s.replace(/\s/g, "").length, w };
}

/** 字の箱を、まわり pad だけ広げた箱 */
const around = (r, pad) => [r2(r[0] - pad), r2(r[1] - pad), r2(r[2] + pad), r2(r[3] + pad)];

/** 回した四角を描き、外枠の箱を返す（左下の角を中心に deg 度回す。pdf-lib の drawRectangle と同じ） */
function rotatedRect(page, x, y, w, h, deg, opts = {}) {
  page.drawRectangle({ x, y, width: w, height: h, rotate: degrees(deg), color: rgb(0, 0, 0), ...opts });
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([px, py]) => [x + px * c - py * s, y + px * s + py * c]);
  return box(pts);
}

/** 角の丸い四角を、黒で塗る（曲線 4 本と直線 4 本） */
function roundedRect(page, x, y, w, h, r) {
  const k = 0.5523 * r; // 円を3次ベジエで近似する係数
  page.pushOperators(
    pushGraphicsState(),
    setFillingGrayscaleColor(0),
    moveTo(x + r, y),
    lineTo(x + w - r, y),
    appendBezierCurve(x + w - r + k, y, x + w, y + r - k, x + w, y + r),
    lineTo(x + w, y + h - r),
    appendBezierCurve(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h),
    lineTo(x + r, y + h),
    appendBezierCurve(x + r - k, y + h, x, y + h - r + k, x, y + h - r),
    lineTo(x, y + r),
    appendBezierCurve(x, y + r - k, x + r - k, y, x + r, y),
    closePath(),
    fill(),
    popGraphicsState(),
  );
  return [r2(x), r2(y), r2(x + w), r2(y + h)];
}

/** 種を固定した乱数（線形合同法） */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const leak = (id, page, rect, chars) => ({ id, pattern: "P6", layer: "text", cover: "fill", page, rect, remaining: { chars } });
const neg = (id, kind, page, rect, note) => ({ id, kind, page, rect, note });

const CASES = [
  {
    name: "p6-t13-opaque-095",
    description: "不透明さ 0.95 の黒い四角で、氏名を覆っている（下の字はほぼ見えない）",
    async make() {
      const { doc, font, pages } = await base();
      const t = text(pages[0], font, "Taro Yamada", 72, 700);
      const r = around(t.rect, 4);
      pages[0].drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color: rgb(0, 0, 0), opacity: 0.95 });
      return { doc, leaks: [leak("#L1", 1, r, t.chars)], negatives: [] };
    },
  },
  {
    name: "p6-d07-translucent-03",
    description: "不透明さ 0.3 の黒い四角を、字の上に重ねている（字は透けて読める）",
    async make() {
      const { doc, font, pages } = await base();
      const t = text(pages[0], font, "Hanako Sato", 72, 700);
      const r = around(t.rect, 4);
      pages[0].drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color: rgb(0, 0, 0), opacity: 0.3 });
      return { doc, leaks: [], negatives: [neg("#N1", "translucent_mark", 1, r, "不透明さ 0.3。字が透けて読めるので、隠していない")] };
    },
  },
  {
    name: "p6-d08-translucent-06",
    description: "不透明さ 0.6 の黒い四角を、字の上に重ねている（字は暗いが読める）",
    async make() {
      const { doc, font, pages } = await base();
      // 白い字を黒い 0.6 の上に描くのではなく、黒い字の上に 0.6 を重ねる。字と背景の明るさの比は約 1:0.4
      const t = text(pages[0], font, "Ichiro Suzuki", 72, 700);
      const r = around(t.rect, 4);
      pages[0].drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color: rgb(0, 0, 0), opacity: 0.6 });
      return { doc, leaks: [], negatives: [neg("#N1", "translucent_mark", 1, r, "不透明さ 0.6。漏れとするかは人が決める（README の決めてほしいこと 1）")] };
    },
  },
  {
    name: "p6-t14-ellipse",
    description: "黒い楕円で、氏名を覆っている",
    async make() {
      const { doc, font, pages } = await base();
      const t = text(pages[0], font, "Taro Yamada", 72, 700);
      const cx = (t.rect[0] + t.rect[2]) / 2;
      const cy = (t.rect[1] + t.rect[3]) / 2;
      const rx = t.w / 2 + 16;
      const ry = 18;
      pages[0].drawEllipse({ x: cx, y: cy, xScale: rx, yScale: ry, color: rgb(0, 0, 0) });
      return { doc, leaks: [leak("#L1", 1, [r2(cx - rx), r2(cy - ry), r2(cx + rx), r2(cy + ry)], t.chars)], negatives: [] };
    },
  },
  {
    name: "p6-t15-rotated-rects",
    description: "1度と3度だけ回した黒い四角で、2つの氏名を覆っている",
    async make() {
      const { doc, font, pages } = await base();
      const a = text(pages[0], font, "Taro Yamada", 72, 700);
      const b = text(pages[0], font, "Jiro Takahashi", 72, 640);
      const ra = rotatedRect(pages[0], a.rect[0] - 6, a.rect[1] - 7, a.w + 12, 24, 1);
      const rb = rotatedRect(pages[0], b.rect[0] - 6, b.rect[1] - 9, b.w + 12, 28, 3);
      return { doc, leaks: [leak("#L1", 1, ra, a.chars), leak("#L2", 1, rb, b.chars)], negatives: [] };
    },
  },
  {
    name: "p6-t16-rounded-rects",
    description: "角の丸い黒い四角（半径 3 と、高さの半分）で、2つの氏名を覆っている",
    async make() {
      const { doc, font, pages } = await base();
      const a = text(pages[0], font, "Taro Yamada", 72, 700);
      const b = text(pages[0], font, "Saburo Ito", 72, 640);
      const ra = roundedRect(pages[0], a.rect[0] - 4, a.rect[1] - 4, a.w + 8, a.rect[3] - a.rect[1] + 8, 3);
      const h = b.rect[3] - b.rect[1] + 8;
      const rb = roundedRect(pages[0], b.rect[0] - 4 - h / 2, b.rect[1] - 4, b.w + 8 + h, h, h / 2);
      return { doc, leaks: [leak("#L1", 1, ra, a.chars), leak("#L2", 1, rb, b.chars)], negatives: [] };
    },
  },
  {
    name: "p6-d09-shapes-no-text",
    description: "字のない所の黒い円と斜めの帯、黒い丸の上の白い字（どれも下に字がない）",
    async make() {
      const { doc, font, pages } = await base();
      const p = pages[0];
      p.drawEllipse({ x: 120, y: 500, xScale: 30, yScale: 30, color: rgb(0, 0, 0) });
      const band = rotatedRect(p, 250, 470, 200, 16, 20);
      p.drawEllipse({ x: 120, y: 380, xScale: 40, yScale: 20, color: rgb(0, 0, 0) });
      p.drawText("NEW", { x: 105, y: 375, size: 12, font, color: rgb(1, 1, 1) });
      return {
        doc,
        leaks: [],
        negatives: [
          neg("#N1", "decorative_shape", 1, [90, 470, 150, 530], "下に字のない黒い円"),
          neg("#N2", "decorative_shape", 1, band, "下に字のない斜めの帯"),
          neg("#N3", "label_box", 1, [80, 360, 160, 400], "黒い丸の上に白い字（字は丸のあと）"),
        ],
      };
    },
  },
  {
    name: "p6-h01-heavy-page",
    description: "1ページ目は曲線 12 万本の重いページ（字はない）。2ページ目に見せかけの黒塗り",
    async make() {
      const { doc, font, pages } = await base(2);
      const rand = lcg(20261103);
      const parts = ["0 G 0.3 w\n"];
      for (let i = 0; i < 120_000; i++) {
        const x = 40 + rand() * 515;
        const y = 40 + rand() * 760;
        const f = (v) => v.toFixed(1);
        parts.push(`${f(x)} ${f(y)} m ${f(x + 3)} ${f(y + 4)} ${f(x + 6)} ${f(y - 4)} ${f(x + 9)} ${f(y)} c S\n`);
      }
      const ctx = doc.context;
      const heavy = ctx.register(ctx.flateStream(new TextEncoder().encode(parts.join(""))));
      pages[0].node.set(PDFName.of("Contents"), ctx.obj([heavy]));
      const t = text(pages[1], font, "Taro Yamada", 72, 700);
      const r = around(t.rect, 4);
      pages[1].drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color: rgb(0, 0, 0) });
      return { doc, leaks: [leak("#L1", 2, r, t.chars)], negatives: [], expected_skipped_pages: [1] };
    },
  },
];

// ---------- 書き出し ----------

mkdirSync(OUT, { recursive: true });
for (const c of CASES) {
  for (const ext of [".pdf", ".expected.json"]) {
    try {
      unlinkSync(path.join(OUT, c.name + ext));
    } catch {
      // ない
    }
  }
}

const rows = [];
const hashes = [];
for (const c of CASES) {
  const made = await c.make();
  const bytes = await made.doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  const file = `${c.name}.pdf`;
  writeFileSync(path.join(OUT, file), bytes);
  const expected = {
    file,
    description: c.description,
    pages: made.doc.getPageCount(),
    leaks: made.leaks.map((l) => ({ ...l, id: c.name + l.id })),
    negatives: made.negatives.map((n) => ({ ...n, id: c.name + n.id })),
  };
  if (made.expected_skipped_pages) expected.expected_skipped_pages = made.expected_skipped_pages;
  writeFileSync(path.join(OUT, `${c.name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  hashes.push(`${sha}  ${file}`);
  rows.push(`| ${file} | ${c.description} | ${expected.pages} | ${expected.leaks.length} | ${expected.negatives.length} | \`${sha.slice(0, 16)}\` |`);
}
writeFileSync(path.join(OUT, "hashes-additions.txt"), hashes.join("\n") + "\n");
writeFileSync(
  path.join(OUT, "index-additions.md"),
  `# P6（見せかけの黒塗り）の合成 PDF：追加の案の一覧

\`build-additions.mjs\` で作り直せる。乱数の種を固定しているので、作り直しても SHA-256 は変わらない。名前はすべて架空。

| ファイル | 何を再現しているか | ページ | 漏れ | 漏れでない | SHA-256（先頭16桁） |
|---|---|---|---|---|---|
${rows.join("\n")}
`,
);
console.log(`追加の合成 PDF ${CASES.length} 個を ${path.relative(process.cwd(), OUT)} に書いた`);

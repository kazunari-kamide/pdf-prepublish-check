// SPDX-License-Identifier: AGPL-3.0-only
//
// P7（隠れたテキスト）の合成 PDF と正解データを作る。
//   node fixtures/p7/build.mjs
// 名前はすべて架空（Taro Yamada など）。字は標準の Helvetica（ASCII だけ）なので、フォントは埋め込まない。
// 日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames as N,
  StandardFonts,
  drawObject,
  grayscale,
  rgb,
} from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = [400, 300];
const ASC = 0.718; // Helvetica の Ascent・Descent（1000 分の 718・−207）
const DESC = -0.207;

const op = (name, ...args) => PDFOperator.of(name, args.map((a) => (typeof a === "number" ? PDFNumber.of(a) : a)));
const r2 = (v) => Math.round(v * 100) / 100;

async function base(pages = 1) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage(PAGE);
  return { doc, font, page: doc.getPages()[0], pages: doc.getPages() };
}

/** 字を描き、字の並びの箱と、空白でない字の数を返す */
function text(page, font, s, x, y, opts = {}) {
  const size = opts.size ?? 12;
  page.drawText(s, { x, y, size, font, color: opts.color ?? rgb(0, 0, 0), opacity: opts.opacity });
  const w = font.widthOfTextAtSize(s, size);
  return { rect: [r2(x), r2(y + DESC * size), r2(x + w), r2(y + ASC * size)], chars: s.replace(/\s/g, "").length };
}

/** 状態を変えて字を描く（q … Q で囲む） */
function withState(page, before, draw) {
  page.pushOperators(op(N.PushGraphicsState), ...before);
  const r = draw();
  page.pushOperators(op(N.PopGraphicsState));
  return r;
}

/** 表示する・しないレイヤー（OCG）を作り、ページの /Properties に名前で入れる */
function layer(doc, page, name, visible) {
  const ref = doc.context.register(doc.context.obj({ Type: "OCG", Name: name }));
  const res = page.node.Resources();
  let dict = res.get(PDFName.of("Properties"));
  if (!dict) {
    dict = doc.context.obj({});
    res.set(PDFName.of("Properties"), dict);
  }
  dict.set(PDFName.of(name), ref);
  return { ref, name, visible };
}

function setLayers(doc, layers) {
  doc.catalog.set(
    PDFName.of("OCProperties"),
    doc.context.obj({ OCGs: layers.map((l) => l.ref), D: { OFF: layers.filter((l) => !l.visible).map((l) => l.ref), Order: layers.map((l) => l.ref) } }),
  );
}

const grayImage = (doc, v) =>
  doc.context.register(doc.context.flateStream(new Uint8Array(16).fill(v), { Type: "XObject", Subtype: "Image", Width: 4, Height: 4, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));

function placeImage(page, ref, x, y, w, h) {
  const name = page.node.newXObject("Im", ref);
  page.pushOperators(op(N.PushGraphicsState), op(N.ConcatTransformationMatrix, w, 0, 0, h, x, y), drawObject(name), op(N.PopGraphicsState));
}

const L = (reason, page, t) => ({ reason, page, rect: t.rect, chars: t.chars });
const NEG = (kind, page, t, note) => ({ kind, page, rect: t.rect, note });

// ---------- 合成 PDF の一覧 ----------
// make は { doc, leaks: [L(...)], negatives: [NEG(...)] } を返す

const CASES = [
  {
    name: "p7-01-white-text",
    description: "白い地のページに、白い字で氏名が書いてある",
    async make() {
      const { doc, font, page } = await base();
      text(page, font, "Report of the committee", 40, 250);
      const t = text(page, font, "Taro Yamada", 40, 200, { color: rgb(1, 1, 1) });
      return { doc, leaks: [L("same_color", 1, t)], negatives: [] };
    },
  },
  {
    name: "p7-02-near-white",
    description: "ほとんど白（明るさ 0.97）の字と、薄い灰色（0.8）の字（読める）",
    async make() {
      const { doc, font, page } = await base();
      const t = text(page, font, "Hanako Sato", 40, 200, { color: grayscale(0.97) });
      const n = text(page, font, "Draft version", 40, 150, { color: grayscale(0.8) });
      return { doc, leaks: [L("same_color", 1, t)], negatives: [NEG("light_gray_text", 1, n, "明るさの差 0.2。読める")] };
    },
  },
  {
    name: "p7-03-black-on-black",
    description: "黒い帯の上に、黒い字（見えない）と白い字（見える）",
    async make() {
      const { doc, font, page } = await base();
      page.drawRectangle({ x: 30, y: 180, width: 300, height: 60, color: rgb(0, 0, 0) });
      const t = text(page, font, "Ichiro Suzuki", 40, 215);
      const n = text(page, font, "Section 1", 40, 190, { color: rgb(1, 1, 1) });
      return { doc, leaks: [L("same_color", 1, t)], negatives: [NEG("visible_on_dark", 1, n, "黒い帯の上の白い字")] };
    },
  },
  {
    name: "p7-04-off-page-right",
    description: "ページの右の外に置いた字と、右端の内側ぎりぎりの字（見える）",
    async make() {
      const { doc, font, page } = await base();
      const t = text(page, font, "Jiro Takahashi", 450, 200);
      const n = text(page, font, "Page 1", 350, 20);
      return { doc, leaks: [L("off_page", 1, t)], negatives: [NEG("near_edge", 1, n, "ページの中")] };
    },
  },
  {
    name: "p7-05-off-page-below",
    description: "ページの下の外に置いた字",
    async make() {
      const { doc, font, page } = await base();
      const t = text(page, font, "Saburo Ito 000-1234-5678", 40, -40);
      return { doc, leaks: [L("off_page", 1, t)], negatives: [] };
    },
  },
  {
    name: "p7-06-tiny",
    description: "大きさ 0.5 の字（見えない）と、大きさ 6 の字（小さいが読める）",
    async make() {
      const { doc, font, page } = await base();
      const t = text(page, font, "Shiro Nakamura", 40, 200, { size: 0.5 });
      const n = text(page, font, "Note: see appendix", 40, 150, { size: 6 });
      return { doc, leaks: [L("tiny", 1, t)], negatives: [NEG("small_legible", 1, n, "大きさ 6")] };
    },
  },
  {
    name: "p7-07-invisible-mode",
    description: "描き方 3（見えない字）で、画像のない所に書いた字",
    async make() {
      const { doc, font, page } = await base();
      const t = withState(page, [op(N.SetTextRenderingMode, 3)], () => text(page, font, "Goro Kobayashi", 40, 200));
      return { doc, leaks: [L("invisible", 1, t)], negatives: [] };
    },
  },
  {
    name: "p7-08-ocr-layer",
    description: "スキャン画像の上に、描き方 3 の字（文字認識の層。漏れでない）",
    async make() {
      const { doc, font, page } = await base();
      placeImage(page, grayImage(doc, 220), 20, 100, 360, 150);
      const n = withState(page, [op(N.SetTextRenderingMode, 3)], () => text(page, font, "Scanned page text", 40, 200));
      return { doc, leaks: [], negatives: [NEG("ocr_layer", 1, n, "画像の上の見えない字（文字認識の層）")] };
    },
  },
  {
    name: "p7-09-hidden-layer",
    description: "表示しないレイヤーの中の字と、表示するレイヤーの中の字",
    async make() {
      const { doc, font, page } = await base();
      const off = layer(doc, page, "OC1", false);
      const on = layer(doc, page, "OC2", true);
      setLayers(doc, [off, on]);
      page.pushOperators(op(N.BeginMarkedContentSequence, PDFName.of("OC"), PDFName.of("OC1")));
      const t = text(page, font, "Rokuro Watanabe", 40, 200);
      page.pushOperators(op(N.EndMarkedContent), op(N.BeginMarkedContentSequence, PDFName.of("OC"), PDFName.of("OC2")));
      const n = text(page, font, "Visible layer", 40, 150);
      page.pushOperators(op(N.EndMarkedContent));
      return { doc, leaks: [L("hidden_layer", 1, t)], negatives: [NEG("visible_layer", 1, n, "表示するレイヤー")] };
    },
  },
  {
    name: "p7-10-clipped",
    description: "切り抜き（クリップ）の外にある字と、切り抜きの中の字",
    async make() {
      const { doc, font, page } = await base();
      const [t, n] = withState(page, [op(N.AppendRectangle, 20, 140, 360, 40), op(N.ClipNonZero), op(N.EndPath)], () => [
        text(page, font, "Shichiro Yamamoto", 40, 220),
        text(page, font, "Inside the clip", 40, 155),
      ]);
      return { doc, leaks: [L("clipped", 1, t)], negatives: [NEG("inside_clip", 1, n, "切り抜きの中")] };
    },
  },
  {
    name: "p7-11-white-cover",
    description: "字のあとに、白い四角を重ねて隠した",
    async make() {
      const { doc, font, page } = await base();
      const t = text(page, font, "Hachiro Kato", 40, 200);
      page.drawRectangle({ x: 35, y: 193, width: 100, height: 20, color: rgb(1, 1, 1) });
      return { doc, leaks: [L("covered_light", 1, t)], negatives: [] };
    },
  },
  {
    name: "p7-12-light-covers",
    description: "不透明な薄い黄色の四角で隠した字（漏れ）と、半透明・乗算の黄色のマーカー（漏れでない）",
    async make() {
      const { doc, font, page } = await base();
      const t = text(page, font, "Kuro Yoshida", 40, 220);
      page.drawRectangle({ x: 35, y: 213, width: 100, height: 20, color: rgb(1, 1, 0.6) });
      const n1 = text(page, font, "Highlighted A", 40, 160);
      page.drawRectangle({ x: 35, y: 153, width: 100, height: 20, color: rgb(1, 1, 0.6), opacity: 0.3 });
      const n2 = text(page, font, "Highlighted B", 40, 110);
      const gs = doc.context.register(doc.context.obj({ Type: "ExtGState", BM: "Multiply" }));
      const gsName = page.node.newExtGState("GS", gs);
      page.pushOperators(
        op(N.PushGraphicsState),
        op(N.SetGraphicsStateParams, gsName),
        op(N.NonStrokingColorRgb, 1, 1, 0.6),
        op(N.AppendRectangle, 35, 103, 100, 20),
        op(N.FillNonZero),
        op(N.PopGraphicsState),
      );
      return {
        doc,
        leaks: [L("covered_light", 1, t)],
        negatives: [NEG("translucent_highlight", 1, n1, "不透明さ 0.3"), NEG("translucent_highlight", 1, n2, "乗算（Multiply）")],
      };
    },
  },
  {
    name: "p7-13-dark-cover-is-p6",
    description: "字のあとに黒い四角を重ねた（見せかけの黒塗り。P6 で数えるので、P7 では出さない）",
    async make() {
      const { doc, font, page } = await base();
      const n = text(page, font, "Taro Yamada", 40, 200);
      page.drawRectangle({ x: 35, y: 193, width: 100, height: 20, color: rgb(0, 0, 0) });
      return { doc, leaks: [], negatives: [NEG("p6_dark_cover", 1, n, "P6 で数える")] };
    },
  },
  {
    name: "p7-14-transparent-text",
    description: "不透明さ 0 の字",
    async make() {
      const { doc, font, page } = await base();
      const t = text(page, font, "Hanako Sato 1-2-3", 40, 200, { opacity: 0 });
      return { doc, leaks: [L("invisible", 1, t)], negatives: [] };
    },
  },
  {
    name: "p7-15-several",
    description: "1ページに、白い字・とても小さい字・ページの外の字",
    async make() {
      const { doc, font, page } = await base();
      text(page, font, "Visible heading", 40, 260);
      const a = text(page, font, "Ichiro Suzuki", 40, 200, { color: rgb(1, 1, 1) });
      const b = text(page, font, "000-1234-5678", 40, 150, { size: 0.4 });
      const c = text(page, font, "Taro Yamada", 40, 400);
      return { doc, leaks: [L("same_color", 1, a), L("tiny", 1, b), L("off_page", 1, c)], negatives: [] };
    },
  },
  {
    name: "p7-16-form-xobject",
    description: "部品（Form XObject）の中の白い字",
    async make() {
      const { doc, font, page } = await base();
      const s = "Jiro Takahashi";
      const form = doc.context.register(
        doc.context.flateStream(new TextEncoder().encode(`BT /F1 12 Tf 1 1 1 rg 40 200 Td (${s}) Tj ET`), {
          Type: "XObject",
          Subtype: "Form",
          BBox: [0, 0, 400, 300],
          Resources: { Font: { F1: font.ref } },
        }),
      );
      const name = page.node.newXObject("Fm", form);
      page.pushOperators(drawObject(name));
      const w = font.widthOfTextAtSize(s, 12);
      return { doc, leaks: [L("same_color", 1, { rect: [40, r2(200 + DESC * 12), r2(40 + w), r2(200 + ASC * 12)], chars: s.replace(/\s/g, "").length })], negatives: [] };
    },
  },
  {
    name: "p7-17-second-page",
    description: "1ページ目はふつうの字だけ、2ページ目に白い字",
    async make() {
      const { doc, font, pages } = await base(2);
      text(pages[0], font, "Page one", 40, 200);
      const t = text(pages[1], font, "Saburo Ito", 40, 200, { color: rgb(1, 1, 1) });
      return { doc, leaks: [L("same_color", 2, t)], negatives: [] };
    },
  },
  {
    name: "p7-18-clip-only-mode",
    description: "描き方 7（切り抜きだけに使い、描かない字）",
    async make() {
      const { doc, font, page } = await base();
      const t = withState(page, [op(N.SetTextRenderingMode, 7)], () => text(page, font, "Shiro Nakamura", 40, 200));
      return { doc, leaks: [L("invisible", 1, t)], negatives: [] };
    },
  },
  {
    name: "p7-19-gray-on-gray",
    description: "灰色（0.5）の地に、ほぼ同じ灰色（0.52）の字と、黒い字（見える）",
    async make() {
      const { doc, font, page } = await base();
      page.drawRectangle({ x: 30, y: 140, width: 300, height: 100, color: grayscale(0.5) });
      const t = text(page, font, "Goro Kobayashi", 40, 210, { color: grayscale(0.52) });
      const n = text(page, font, "Readable text", 40, 160);
      return { doc, leaks: [L("same_color", 1, t)], negatives: [NEG("visible_on_gray", 1, n, "灰色の地の黒い字")] };
    },
  },
  {
    name: "p7-20-outside-cropbox",
    description: "見える範囲（CropBox）を下半分にした。上半分（MediaBox の中、CropBox の外）に字が残っている",
    async make() {
      const { doc, font, page } = await base();
      page.setCropBox(0, 0, 400, 150);
      text(page, font, "Visible part", 40, 100);
      const t = text(page, font, "Rokuro Watanabe", 40, 250);
      return { doc, leaks: [L("off_page", 1, t)], negatives: [] };
    },
  },
  {
    name: "p7-21-plain-document",
    description: "ふつうの黒い字だけ（隠れた字はない）",
    async make() {
      const { doc, font, page } = await base();
      const n = text(page, font, "Meeting minutes", 40, 250);
      text(page, font, "Attendees: (omitted)", 40, 220);
      return { doc, leaks: [], negatives: [NEG("plain_text", 1, n, "ふつうの字")] };
    },
  },
  {
    name: "p7-22-white-on-dark-photo",
    description: "暗い写真の上の白い字（見える）",
    async make() {
      const { doc, font, page } = await base();
      placeImage(page, grayImage(doc, 30), 20, 150, 300, 100);
      const n = text(page, font, "Photo caption", 40, 200, { color: rgb(1, 1, 1) });
      return { doc, leaks: [], negatives: [NEG("visible_on_dark_image", 1, n, "暗い写真の上の白い字")] };
    },
  },
  {
    name: "p7-23-small-and-light",
    description: "大きさ 3 の字と、明るさ 0.85 の字（どちらも見える）",
    async make() {
      const { doc, font, page } = await base();
      const n1 = text(page, font, "Fine print", 40, 200, { size: 3 });
      const n2 = text(page, font, "Watermark-like text", 40, 150, { color: grayscale(0.85) });
      return { doc, leaks: [], negatives: [NEG("small_legible", 1, n1, "大きさ 3"), NEG("light_gray_text", 1, n2, "明るさの差 0.15")] };
    },
  },
  {
    name: "p7-24-white-on-dark-circle",
    description: "黒い円（曲線の形）の上の白い字（見える）",
    async make() {
      const { doc, font, page } = await base();
      page.drawEllipse({ x: 80, y: 200, xScale: 50, yScale: 25, color: rgb(0, 0, 0) });
      const n = text(page, font, "NEW", 68, 196, { color: rgb(1, 1, 1) });
      return { doc, leaks: [], negatives: [NEG("visible_on_dark", 1, n, "黒い円の上の白い字。円は四角でない形")] };
    },
  },
  {
    name: "p7-25-ocr-layer-before-image",
    description: "描き方 3 の字（文字認識の層）を先に書き、あとからスキャン画像を重ねた（描く順番が逆の道具。漏れでない）",
    async make() {
      const { doc, font, page } = await base();
      const n = withState(page, [op(N.SetTextRenderingMode, 3)], () => text(page, font, "Scanned page text", 40, 200));
      placeImage(page, grayImage(doc, 220), 20, 100, 360, 150);
      return { doc, leaks: [], negatives: [NEG("ocr_layer", 1, n, "画像の前に書いた見えない字（文字認識の層。描く順番は問わない）")] };
    },
  },
];

// ---------- 書き出し ----------

for (const f of readdirSync(HERE)) {
  if (/^p7-.*\.(pdf|expected\.json)$/.test(f)) unlinkSync(path.join(HERE, f));
}
const rows = [];
const hashes = [];
let totalLeaks = 0;
let totalNeg = 0;
for (const c of CASES) {
  const made = await c.make();
  const bytes = await made.doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  const file = `${c.name}.pdf`;
  writeFileSync(path.join(HERE, file), bytes);
  const expected = {
    file,
    description: c.description,
    pages: made.doc.getPageCount(),
    leaks: made.leaks.map((l, i) => ({ id: `${c.name}#L${i + 1}`, pattern: "P7", ...l })),
    negatives: made.negatives.map((n, i) => ({ id: `${c.name}#N${i + 1}`, ...n })),
  };
  writeFileSync(path.join(HERE, `${c.name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  hashes.push(`${sha}  ${file}`);
  rows.push(`| ${file} | ${c.description} | ${expected.leaks.length} | ${expected.negatives.length} | \`${sha.slice(0, 16)}\` |`);
  totalLeaks += expected.leaks.length;
  totalNeg += expected.negatives.length;
}
writeFileSync(path.join(HERE, "hashes.txt"), hashes.join("\n") + "\n");
writeFileSync(
  path.join(HERE, "index.md"),
  `# P7（隠れたテキスト）の合成 PDF の一覧

\`node fixtures/p7/build.mjs\` で作り直せる。日時も乱数も使わないので、作り直しても SHA-256 は変わらない。名前はすべて架空。

- 合成 PDF：${CASES.length} 個
- 漏れ（検出率の分母）：${totalLeaks} 件
- 漏れでないもの（誤検知率の分母）：${totalNeg} 件

| ファイル | 何を再現しているか | 漏れ | 漏れでない | SHA-256（先頭16桁） |
|---|---|---|---|---|
${rows.join("\n")}
`,
);
console.log(`合成 PDF ${CASES.length} 個、漏れ ${totalLeaks} 件、漏れでないもの ${totalNeg} 件`);

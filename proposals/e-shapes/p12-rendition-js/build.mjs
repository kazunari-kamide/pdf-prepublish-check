// SPDX-License-Identifier: AGPL-3.0-only
//
// P12（スクリプト・外部動作）の案：画面の注釈（Screen）の、押したときの動作が「再生」（/S /Rendition）で、
// その中に JavaScript（/JS）が入っている形。ISO 32000 の 12.6.4.13 で、/JS は再生の代わりに動く JavaScript。
//   node build.mjs [出力先]     出力先を省くと、このスクリプトの横の out/
// JavaScript の中身は app.alert('test') だけ（送信先の URL は入れない）。日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, "out"));

async function base(label) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([420, 300]);
  page.drawText(`P12 test: ${label}`, { x: 40, y: 250, size: 14, font });
  return { doc, ctx: doc.context, page };
}

/** Screen の注釈を置き、その /A に Rendition の動作を付ける（/AN はこの注釈自身） */
function screenWithRendition(ctx, page, rect, action) {
  const annot = ctx.obj({ Type: "Annot", Subtype: "Screen", Rect: rect, F: 4, P: page.ref });
  const ref = ctx.register(annot);
  annot.set(PDFName.of("A"), ctx.obj({ S: "Rendition", OP: 0, AN: ref, ...action }));
  page.node.addAnnot(ref);
  return ref;
}

const save = (doc) => doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });

const JS_STRING = "app.alert('test');";
const JS_STREAM = "app.alert('test stream');";

const CASES = [
  {
    name: "p12-r01-rendition-js",
    description: "Screen の注釈2つの、押したときの動作が Rendition で、/JS に JavaScript。1つは字の並び、1つは Flate で圧縮したストリーム",
    async make() {
      const { doc, ctx, page } = await base("Rendition action with JS");
      screenWithRendition(ctx, page, [40, 120, 180, 200], { JS: PDFString.of(JS_STRING.replace(/[()\\]/g, "\\$&")) });
      screenWithRendition(ctx, page, [220, 120, 360, 200], { JS: ctx.register(ctx.flateStream(JS_STREAM)) });
      return save(doc);
    },
    leaks: [
      { pattern: "P12", kind: "javascript", where: "annotation", trigger: null, page: 1, chars: JS_STRING.length, jsForm: "string" },
      { pattern: "P12", kind: "javascript", where: "annotation", trigger: null, page: 1, chars: JS_STREAM.length, jsForm: "stream" },
    ],
    negatives: [],
  },
  {
    name: "p12-rc01-rendition-media-only",
    description: "対照：Screen の注釈の Rendition の動作で、/JS が無く /R（再生する動画の指定）だけ。押したときに動画を再生するだけで、JavaScript は無い",
    async make() {
      const { doc, ctx, page } = await base("Rendition action, media only");
      const clip = ctx.obj({ Type: "MediaClip", S: "MCD", CT: PDFString.of("video/mp4"), D: { Type: "Filespec", F: PDFString.of("movie.mp4") } });
      const rendition = ctx.register(ctx.obj({ Type: "Rendition", S: "MR", C: clip }));
      screenWithRendition(ctx, page, [40, 120, 180, 200], { R: rendition });
      return save(doc);
    },
    leaks: [],
    negatives: [{ kind: "rendition_media_only", where: "annotation", page: 1 }],
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

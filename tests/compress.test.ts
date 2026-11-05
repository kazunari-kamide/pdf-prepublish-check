// SPDX-License-Identifier: AGPL-3.0-only
//
// ファイルを小さくする（sanitize/compress.ts）のテスト。合成 PDF（tests/helpers/compress-pdfs.ts。中身はすべて架空）を使う。

import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import { compress, redact, type CompressResult, type RedactCheck } from "../sanitize/index.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";
import { checkAreas } from "../sanitize/redact-check.ts";
import { allChecks } from "./helpers/redact-checks.ts";
import { A4, SCENES, a4px, scanGray } from "./helpers/compress-pdfs.ts";
import { buildPdf, imageFlate } from "./helpers/redact-pdfs.ts";
import { HEAVY_TIMEOUT } from "./helpers/timeout.ts";

const codec = createNodeImageCodec();
const scene = (name: string) => SCENES.find((s) => s.name.startsWith(name))!.make();

/** 1 ページめの /Im1 の画像の辞書 */
async function image1(bytes: Uint8Array): Promise<{ w: number; h: number; filter: string; smask: PDFStream | null }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const res = doc.getPage(0).node.Resources()!;
  const xo = ctx.lookup(res.get(PDFName.of("XObject"))) as PDFDict;
  const s = ctx.lookup(xo.get(PDFName.of("Im1"))) as PDFStream;
  const n = (k: string) => (ctx.lookup(s.dict.get(PDFName.of(k))) as PDFNumber).asNumber();
  const sm = ctx.lookup(s.dict.get(PDFName.of("SMask")));
  return { w: n("Width"), h: n("Height"), filter: String(ctx.lookup(s.dict.get(PDFName.of("Filter")))), smask: sm instanceof PDFStream ? sm : null };
}

async function textOf(bytes: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  const s = tc.items.map((it) => ("str" in it ? it.str : "")).join("");
  await task.destroy();
  return s;
}

const ok = (r: CompressResult) => {
  expect(r.status).toBe("ok");
  if (r.status !== "ok") throw new Error(r.status);
  return r;
};

describe("小さくする", () => {
  it("300dpi のスキャンを 150dpi に縮めて JPEG に書き直す。ページの数・読み直しの残りは変わらない", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await scene("スキャン（灰色");
    const r = ok(await compress(bytes, { codec, checks: allChecks }));
    expect(r.changed).toBe(true);
    expect(r.sizeAfter).toBeLessThan(r.sizeBefore / 10);
    expect(r.images.changed).toBe(1);
    expect(r.checked).toEqual(["rules", "verifier"]);
    const im = await image1(r.bytes);
    // A4（595 × 842 ポイント）を 150dpi で：1240 × 1755 画素
    expect([im.w, im.h]).toEqual([Math.ceil((595 / 72) * 150), Math.ceil((842 / 72) * 150)]);
    expect(im.filter).toBe("/DCTDecode");
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(1);
  });

  it("字はそのまま残る（取り出せる字が同じ）", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await scene("写真");
    const r = ok(await compress(bytes, { codec, checks: allChecks }));
    expect(r.changed).toBe(true);
    expect(await textOf(r.bytes)).toBe(await textOf(bytes));
  });

  it("同じ画像を2か所に描くときは、大きく描いた方の細かさで縮める", { timeout: HEAVY_TIMEOUT }, async () => {
    const r = ok(await compress(await scene("同じ画像"), { codec }));
    const im = await image1(r.bytes);
    // 大きい方は 480 × 360 ポイント：150dpi で 1000 × 750 画素
    expect([im.w, im.h]).toEqual([1000, 750]);
  });

  it("細かさと JPEG の質を選べる（細かさを下げるほど小さい）", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await scene("スキャン（RGB");
    const a = ok(await compress(bytes, { codec, maxDpi: 200, jpegQuality: 0.85 }));
    const b = ok(await compress(bytes, { codec, maxDpi: 100, jpegQuality: 0.6 }));
    expect(b.sizeAfter).toBeLessThan(a.sizeAfter);
    const [w] = a4px(100);
    expect((await image1(b.bytes)).w).toBe(Math.ceil((595 / 72) * 100));
    expect(w).toBeGreaterThan(0);
  });

  it("透明の型（/SMask）は、そのまま残す", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await scene("透明の型");
    const before = await image1(bytes);
    const r = ok(await compress(bytes, { codec }));
    const after = await image1(r.bytes);
    expect(after.w).toBeLessThan(before.w);
    expect(after.smask).not.toBeNull();
    const n = (s: PDFStream, k: string) => (s.dict.get(PDFName.of(k)) as PDFNumber).asNumber();
    expect([n(after.smask!, "Width"), n(after.smask!, "Height")]).toEqual([n(before.smask!, "Width"), n(before.smask!, "Height")]);
    expect((after.smask as PDFRawStream).contents).toEqual((before.smask as PDFRawStream).contents);
  });
});

describe("手を付けない画像（入れたバイト列のまま返す）", () => {
  for (const [name, reason] of [
    ["白黒", "bitonal"],
    ["もう粗い画像", "within_dpi"],
    ["注釈の見た目", "used_elsewhere"],
  ] as const) {
    it(`${name}：${reason}`, { timeout: HEAVY_TIMEOUT }, async () => {
      const bytes = await scene(name);
      const r = ok(await compress(bytes, { codec, checks: allChecks }));
      expect(r.changed).toBe(false);
      expect(r.bytes).toBe(bytes);
      expect(r.images.skipped.map((s) => s.reason)).toEqual([reason]);
    });
  }

  it("対照：画像のない PDF は、そのまま返す", async () => {
    const bytes = await scene("対照");
    const r = ok(await compress(bytes, { codec }));
    expect(r.changed).toBe(false);
    expect(r.bytes).toBe(bytes);
    expect(r.images).toEqual({ changed: 0, savedBytes: 0, skipped: [] });
  });
});

describe("読み直し：残りが増えたら保存させない", () => {
  /** 入れたバイト列のときは 0 件、ほかのバイト列では 1 件の残りを返す、試しの確かめ */
  const grows = (input: Uint8Array): RedactCheck => ({
    name: "rules",
    run: async (b) => (b === input ? [] : [{ check: "rules", kind: "rule_item", pattern: "P6", count: 1, label: "試しの残り" }]),
  });

  it("小さくしたあとに残りが増えたら blocked。バイト列は返さない", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await scene("写真");
    const r = await compress(bytes, { codec, checks: [grows(bytes)] });
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect("bytes" in r).toBe(false);
    expect(r.increased).toEqual([{ check: "rules", kind: "rule_item", pattern: "P6", label: "試しの残り", before: 0, after: 1 }]);
  });

  it("前からある残りは、増えなければ止めない", { timeout: HEAVY_TIMEOUT }, async () => {
    const same: RedactCheck = { name: "rules", run: async () => [{ check: "rules", kind: "rule_item", pattern: "P1", count: 2, label: "前からの残り" }] };
    const r = await compress(await scene("写真"), { codec, checks: [same] });
    expect(r.status).toBe("ok");
  });

  it("小さくしたあとの確かめが失敗したら、確かめられないので保存させない", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await scene("写真");
    const throws: RedactCheck = { name: "verifier", run: async (b) => { if (b !== bytes) throw new Error("x"); return []; } };
    const r = await compress(bytes, { codec, checks: [throws] });
    expect(r.status).toBe("blocked");
    if (r.status === "blocked") expect(r.increased[0]?.kind).toBe("verifier_error");
  });
});

describe("黒塗りしたあとに小さくする", () => {
  it("黒く塗った所は、縁の 1 画素を除いて塗られたまま。字の確かめ・作品の検査・検証器の残りも増えない", { timeout: HEAVY_TIMEOUT }, async () => {
    const [w, h] = a4px(300);
    const rect: [number, number, number, number] = [100, 500, 400, 560];
    const scan = await buildPdf((doc) => ({ pages: [{ size: A4, content: `q ${A4[0]} 0 0 ${A4[1]} 0 0 cm /Im1 Do Q\n`, images: [imageFlate(doc.context, w, h, 1, scanGray(w, h, 21))] }] }));
    const red = await redact(scan, [{ page: 1, rect }], { codec, checks: allChecks });
    expect(red.status).toBe("ok");
    if (red.status !== "ok") return;
    const r = ok(await compress(red.bytes, { codec, checks: allChecks }));
    expect(r.changed).toBe(true);
    const m = 72 / 150;
    expect(await checkAreas(r.bytes, [{ page: 1, rect: [rect[0] + m, rect[1] + m, rect[2] - m, rect[3] - m] }], { codec })).toEqual([]);
  });
});

describe("入力の確かめ", () => {
  it("細かさ・質が範囲の外、道具なし、空、壊れた PDF はエラー", async () => {
    const bytes = await scene("対照");
    const code = async (p: Promise<CompressResult>) => { const r = await p; return r.status === "error" ? r.code : r.status; };
    expect(await code(compress(bytes, { codec, maxDpi: 10 }))).toBe("bad_options");
    expect(await code(compress(bytes, { codec, maxDpi: Number.NaN }))).toBe("bad_options");
    expect(await code(compress(bytes, { codec, jpegQuality: 1.5 }))).toBe("bad_options");
    expect(await code(compress(bytes, { codec: undefined as never }))).toBe("no_codec");
    expect(await code(compress(new Uint8Array(), { codec }))).toBe("empty");
    expect(await code(compress(new TextEncoder().encode("%PDF-1.7\nこわれた"), { codec }))).toBe("unreadable");
  });

  it("参照の形（PDFRef）を使う画像の辞書だけを置き換える（ほかの部品の参照は変わらない）", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await scene("スキャン（灰色");
    const r = ok(await compress(bytes, { codec }));
    const before = await PDFDocument.load(bytes);
    const after = await PDFDocument.load(r.bytes);
    const refOf = (d: PDFDocument) => (d.context.lookup(d.getPage(0).node.Resources()!.get(PDFName.of("XObject"))) as PDFDict).get(PDFName.of("Im1")) as PDFRef;
    expect(refOf(after).objectNumber).toBe(refOf(before).objectNumber);
  });
});

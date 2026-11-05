// SPDX-License-Identifier: AGPL-3.0-only
//
// 動画の素材の合成の PDF（demo/scan-minutes/。作り方は build.mjs）が、決めた形のままかを確かめる。
// - ページ全体が 1 枚の画像で、字の層がない。文書情報も書いていない
// - 黒く塗った四角の注釈（Square）が 3 つ、boxes.json の場所にある（fixtures/p6/p6-i03 と同じ型）
// - 今の検出ルールで、P6 の画像の層の「高」が 3 件出て、ほかの型は出ない
// fixtures/ ではないので、採点（npm run eval）には入らない。

import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { IMAGE, OUT, PAGE, REDACTED, toPdfRect } from "../demo/scan-minutes/build.mjs";
import { sanitizePdf } from "../sanitize/index.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";
import { createNodeImageDecoder } from "../eval/image-decoder.ts";
import { inspectAll } from "../src/inspect/inspect";
import { RULES } from "../src/inspect/rules";
import { buildCleanView } from "../src/ui/clean-model";
import { buildView } from "../src/ui/model";

const DIR = path.resolve(import.meta.dirname, "..", "demo", "scan-minutes");
const read = (f: string) => new Uint8Array(readFileSync(path.join(DIR, f)));
const boxes = JSON.parse(readFileSync(path.join(DIR, OUT.boxes), "utf8")) as {
  boxes: Array<{ key: string; x: number; y: number; width: number; height: number; pdfRect: number[] }>;
};

describe.each([OUT.pdf, OUT.pdfMarked])("demo/scan-minutes/%s", (file) => {
  it("ページ全体が 1 枚の画像（JPEG）で、字の層・書体がない。文書情報も書いていない", async () => {
    const doc = await PDFDocument.load(read(file), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    const page = doc.getPage(0);
    expect(page.getSize()).toEqual({ width: PAGE.width, height: PAGE.height });
    const res = page.node.Resources()!;
    // 書体の辞書は、ないか空（pdf-lib が空の辞書を置くことがある）
    const fonts = res.lookupMaybe(PDFName.of("Font"), PDFDict);
    expect(fonts?.keys() ?? []).toEqual([]);
    const xobjects = res.lookup(PDFName.of("XObject"), PDFDict);
    const images = xobjects.keys().map((k) => xobjects.lookup(k) as PDFRawStream);
    expect(images).toHaveLength(1);
    expect(images[0]!.dict.get(PDFName.of("Filter"))).toEqual(PDFName.of("DCTDecode"));
    expect((images[0]!.dict.get(PDFName.of("Width")) as PDFNumber).asNumber()).toBe(IMAGE.width);
    // ページの中身の命令に、字を書く命令（BT・Tj・TJ）がない
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
    const content = streams.map((st) => new TextDecoder().decode(st instanceof PDFRawStream ? decodePDFRawStream(st).decode() : (st as unknown as { getContents(): Uint8Array }).getContents())).join("\n");
    expect(content).toContain("Do");
    expect(content).not.toMatch(/\bBT\b|\bTj\b|\bTJ\b/);
    // 文書情報は、ないか空（作成者・作成した道具・日時を書かない）
    const info = doc.context.trailerInfo.Info ? doc.context.lookup(doc.context.trailerInfo.Info, PDFDict) : undefined;
    expect(info?.keys() ?? []).toEqual([]);
    expect(doc.catalog.get(PDFName.of("Metadata"))).toBeUndefined();
  });

  it("黒く塗った四角の注釈（Square）が 3 つ、boxes.json の場所にある", async () => {
    const doc = await PDFDocument.load(read(file), { updateMetadata: false });
    const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    const list = annots.asArray().map((r) => doc.context.lookup(r, PDFDict));
    expect(list).toHaveLength(Object.keys(REDACTED).length);
    expect(boxes.boxes.map((b) => b.key)).toEqual(Object.keys(REDACTED));
    list.forEach((a, i) => {
      expect(a.get(PDFName.of("Subtype"))).toEqual(PDFName.of("Square"));
      const nums = (k: string) => (a.lookup(PDFName.of(k), PDFArray).asArray() as PDFNumber[]).map((n) => n.asNumber());
      expect(nums("IC")).toEqual([0, 0, 0]);
      expect(nums("Rect")).toEqual(boxes.boxes[i]!.pdfRect);
      expect(boxes.boxes[i]!.pdfRect).toEqual(toPdfRect(boxes.boxes[i]!));
    });
  });

  it("今の検出ルールで、P6 の画像の層の「高」が 3 件だけ出る", async () => {
    const s = await inspectAll(read(file));
    const found = s.rules.flatMap((r) => r.items.map((it) => ({ ...it, rule: r.ruleId, pattern: r.pattern })));
    const p6 = found.filter((f) => f.pattern === "P6");
    expect(p6).toHaveLength(3);
    for (const f of p6) {
      expect(f.severity).toBe("high");
      expect(f.page).toBe(1);
    }
    expect(found.filter((f) => f.pattern !== "P6")).toEqual([]);
  }, 60_000);

  it("整えると、黒い四角の下の画像を 3 か所だけ塗り（四角の外は塗らない）、読み直すと何も残らない", async () => {
    const bytes = read(file);
    // 画面の Worker と同じく、JPEG を解く道具を渡す（渡さないと、塗ったあとの画素を確かめられず「残っている」と数える）
    const ctx = { imageDecoder: createNodeImageDecoder() };
    const before = buildView(await inspectAll(bytes, () => {}, RULES, ctx));
    const r = await sanitizePdf(bytes, { codec: createNodeImageCodec() });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    // 塗った所は 3 か所で、それぞれ黒い四角と同じ場所（四角の外にはみ出した帯を、別に塗っていない）
    const painted = r.removed.filter((x) => x.kind === "covered_pixels");
    expect(painted.map((x) => x.rect)).toEqual(boxes.boxes.map((b) => b.pdfRect.map((v) => Math.round(v * 100) / 100)));
    // 画面の「4 読み直す」と同じ流れ（tests/sanitize-reinspect.test.ts）：最初から検査し直して、残りは 0、緑（clean）
    const after = buildView(await inspectAll(r.bytes, () => {}, RULES, ctx));
    const c = buildCleanView({ before, after, removed: r.removed, notDone: r.notDone, decrypted: r.decrypted });
    expect({ left: c.left, notDone: c.notDone.length, verdict: c.verdict }).toEqual({ left: 0, notDone: 0, verdict: "clean" });
  }, 60_000);
});

describe("黒い四角を外した版（下が見える版）の画像", () => {
  it("PDF の中の画像と同じもの", async () => {
    for (const [pdf, jpg] of [
      [OUT.pdf, OUT.image],
      [OUT.pdfMarked, OUT.imageMarked],
    ] as const) {
      const doc = await PDFDocument.load(read(pdf), { updateMetadata: false });
      const xobjects = doc.getPage(0).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
      const img = xobjects.lookup(xobjects.keys()[0]!) as PDFRawStream;
      expect(Buffer.from(img.getContents()).equals(Buffer.from(read(jpg)))).toBe(true);
    }
  });

  it("隅の一言のあるなしで、黒く塗る所は同じ場所", () => {
    expect(boxes.boxes.every((b) => b.x > 0 && b.y > 0 && b.x + b.width < IMAGE.width && b.y + b.height < IMAGE.height)).toBe(true);
  });
});

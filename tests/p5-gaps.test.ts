// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P5（旧版の残存）1.2.0 のテスト。
// - 使われていない構造の部品（フォント・文字の対応表・色の設定）だけが残っている PDF を「漏れ」にせず、
//   「片付けで消せる残り」（cleanupOnly）として数えること。字の中身を持つ残りは、従来どおり漏れとして数えること。
// - オブジェクトストリームの中の、どこからも指されていない辞書で字の値を持つものを、字数で数えること（dict_text）。
// 採点に使う合成 PDF（fixtures/p5）は使わず、テストの中で小さな PDF を作る。名前・字はすべて架空。
// フォントの本体だけは、合成 PDF の作り方と同じ BIZ UDゴシック（fixtures/p6/fonts。SIL OFL 1.1）を読む（書き込みはしない）。

import { readFileSync } from "node:fs";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { detectP5Revisions, partBySignature } from "../rules/p5-revisions/index.ts";
import { RULES } from "../src/inspect/rules.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FONT = new Uint8Array(readFileSync(path.join(ROOT, "fixtures", "p6", "fonts", "BIZUDGothic-Regular.ttf")));
const p5Rule = RULES.find((r) => r.id === "p5-revisions")!;
const enc = (s: string) => new TextEncoder().encode(s);

type Report = Awaited<ReturnType<typeof detectP5Revisions>>;
const pick = (r: Report) => r.findings.map((f) => `${f.object}:${f.kind}:${f.where}`).sort();

/** 1ページの PDF。page に何か描き、extra で使わない部品を足して保存する */
async function make(opts: { draw?: boolean; extra?: (doc: PDFDocument) => Promise<void> | void; useObjectStreams?: boolean } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const page = doc.addPage([200, 200]);
  if (opts.draw !== false) page.drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
  await opts.extra?.(doc);
  return new Uint8Array(await doc.save({ useObjectStreams: opts.useObjectStreams ?? false }));
}

/** 使わないストリームを1つ登録する（どこからも指さない） */
function strayStream(doc: PDFDocument, bytes: Uint8Array, dict: Record<string, unknown> = {}) {
  const ctx = doc.context;
  return ctx.register(ctx.flateStream(bytes, dict as never));
}

describe("頭の印で部品を見分ける", () => {
  it("TrueType・OpenType・CFF・Type 1・ICC・CMap を見分け、ページの中身は見分けない", () => {
    expect(partBySignature(new Uint8Array([0, 1, 0, 0, 0, 12]))).toBe("font_file");
    expect(partBySignature(enc("OTTO\u0000\u0001"))).toBe("font_file");
    expect(partBySignature(new Uint8Array([1, 0, 4, 2, 0]))).toBe("font_file");
    expect(partBySignature(enc("%!PS-AdobeFont-1.0: Dummy"))).toBe("font_file");
    const icc = new Uint8Array(128);
    icc.set(enc("acsp"), 36);
    expect(partBySignature(icc)).toBe("color_profile");
    expect(partBySignature(enc("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\nendcmap"))).toBe("cmap");
    expect(partBySignature(enc("BT /F1 12 Tf (abc) Tj ET"))).toBeNull();
  });
});

describe("項目19：版が1つで、使われていない構造の部品だけが残っている", () => {
  it("埋め込んだのに使わなかったフォント（フォントの本体・対応表を含む）は漏れにせず、片付けで消せる残りとして数える", async () => {
    // 合成 PDF の作り方で起きていた形：字を書かないページに、フォントだけを埋め込んで保存した
    const bytes = await make({ extra: async (doc) => void (await doc.embedFont(FONT, { subset: true })) });
    const r = await detectP5Revisions(bytes);
    expect(r.status).toBe("ok");
    expect(r.revisions).toBe(1);
    expect(r.findings).toEqual([]);
    expect(r.cleanupOnly.count).toBe(5);
    expect(r.cleanupOnly.parts).toEqual({ font: 3, font_file: 1, cmap: 1, color_profile: 0, other: 0 });
    expect(r.notCounted.every((n) => n.reason === "structure")).toBe(true);
  });

  it("フォントの本体の印がなくても、FontDescriptor から指されていて BT〜ET の字の命令がなければ部品とみなす", async () => {
    // バイト列の中に、たまたま「>"」「) Tj」に見える並びを入れておく（以前は中身と取り違えた形）
    const bytes = await make({
      extra: (doc) => {
        const ctx = doc.context;
        const file = strayStream(doc, enc('\u0007\u0002garbage>" (x) Tj \u0003\u0004 binary'));
        ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "Dummy", Flags: 4, FontFile2: file }));
      },
    });
    const r = await detectP5Revisions(bytes);
    expect(r.findings).toEqual([]);
    expect(r.cleanupOnly.parts.font_file).toBe(1);
    expect(r.cleanupOnly.parts.font).toBe(1);
  });

  it("使わない色の設定（ICC）・文字の対応表（CMap）・/Length1 のあるフォントの本体も、片付けで消せる残り", async () => {
    const icc = new Uint8Array(200);
    icc.set(enc("acsp"), 36);
    icc.set(enc(") Tj"), 100);
    const bytes = await make({
      extra: (doc) => {
        const ctx = doc.context;
        const prof = strayStream(doc, icc, { N: 3 });
        ctx.register(ctx.obj([PDFName.of("ICCBased"), prof]));
        strayStream(doc, enc("/CIDInit /ProcSet findresource begin\nbegincmap\n1 beginbfchar\n<0001> <0041>\nendbfchar\nendcmap"));
        strayStream(doc, enc('%x>" Tj binary'), { Length1: 14 });
      },
    });
    const r = await detectP5Revisions(bytes);
    expect(r.findings).toEqual([]);
    expect(r.cleanupOnly.parts).toMatchObject({ color_profile: 1, cmap: 1, font_file: 1 });
  });

  it("画面では「低」の1行（片付けで消せる残り）として出し、「高」は出さない", async () => {
    const bytes = await make({ extra: async (doc) => void (await doc.embedFont(FONT, { subset: true })) });
    const res = await p5Rule.run(bytes);
    expect(res.status).toBe("ok");
    expect(res.items.map((i) => i.severity)).toEqual(["low"]);
    expect(res.items[0]!.title).toContain("片付けで消せる残り");
    expect(res.items[0]!.why).toContain("片付ける");
    expect(res.items[0]!.detail).toBe("フォントの設定 3個／フォントの本体 1個／文字の対応表 1個");
    // 断定する言い方をしない
    expect(res.items[0]!.why).not.toMatch(/安全です|問題なし/);
  });

  it("対照：使う部品だけの PDF は、何も出さない", async () => {
    const bytes = await make({
      extra: async (doc) => {
        const f = await doc.embedFont(FONT, { subset: true });
        doc.getPage(0).drawText("あいう", { x: 20, y: 100, size: 12, font: f });
      },
    });
    const r = await detectP5Revisions(bytes);
    expect(r.findings).toEqual([]);
    expect(r.cleanupOnly.count).toBe(0);
    expect((await p5Rule.run(bytes)).items).toEqual([]);
  });

  it("対照（字の中身あり）：使っていないページの中身（BT〜ET の字）は、従来どおり漏れ（content・高）", async () => {
    let num = 0;
    const bytes = await make({
      extra: (doc) => {
        num = strayStream(doc, enc("BT /F1 12 Tf 10 100 Td (Kakuu Hanako) Tj ET")).objectNumber;
      },
    });
    const r = await detectP5Revisions(bytes);
    expect(pick(r)).toEqual([`${num}:content:unreferenced`]);
    const res = await p5Rule.run(bytes);
    expect(res.items.map((i) => i.severity)).toEqual(["high"]);
  });

  it("対照（字の中身あり）：フォントから指されていても、BT〜ET の字の命令があれば中身として数える", async () => {
    let num = 0;
    const bytes = await make({
      extra: (doc) => {
        const ctx = doc.context;
        const s = strayStream(doc, enc("BT /F1 12 Tf 10 100 Td (Kakuu Hanako) Tj ET"));
        num = s.objectNumber;
        ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "Dummy", Flags: 4, FontFile2: s }));
      },
    });
    const r = await detectP5Revisions(bytes);
    expect(pick(r)).toEqual([`${num}:content:unreferenced`]);
  });
});

describe("項目5：オブジェクトストリームの中の、どこからも指されていない辞書", () => {
  it("字の値を持つ辞書は、字数だけ数える（dict_text。字そのものは返さない）", async () => {
    let num = 0;
    const bytes = await make({
      useObjectStreams: true,
      extra: (doc) => {
        const ctx = doc.context;
        num = ctx.register(ctx.obj({ Note: PDFHexString.fromText("架空の担当 山田"), Ref: PDFString.of("No.12") })).objectNumber;
      },
    });
    const r = await detectP5Revisions(bytes);
    expect(pick(r)).toEqual([`${num}:dict_text:unreferenced`]);
    const f = r.findings[0]!;
    expect(f.chars).toBe([..."架空の担当 山田"].length + 5);
    expect(JSON.stringify(r)).not.toContain("No.12");
    const res = await p5Rule.run(bytes);
    expect(res.items.map((i) => i.severity)).toEqual(["high"]);
    expect(res.items[0]!.detail).toContain("字");
  });

  it("入れ子の辞書・配列の中の字も数える。日付と CIDSystemInfo の字は数えない", async () => {
    let num = 0;
    const bytes = await make({
      useObjectStreams: true,
      extra: (doc) => {
        const ctx = doc.context;
        num = ctx.register(
          ctx.obj({
            Items: [PDFString.of("abc"), { Memo: PDFString.of("de") }],
            M: PDFString.of("D:20261105000000"),
            When: PDFString.of("D:20261105"),
            Info: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
          }),
        ).objectNumber;
      },
    });
    const r = await detectP5Revisions(bytes);
    expect(r.findings.map((f) => [f.object, f.kind, f.chars])).toEqual([[num, "dict_text", 5]]);
  });

  it("対照：フォントなどの構造の部品は、字の値があっても数えない", async () => {
    const bytes = await make({
      useObjectStreams: true,
      extra: (doc) => {
        const ctx = doc.context;
        ctx.register(ctx.obj({ Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Japan1"), Supplement: 6 })); // CIDSystemInfo
        ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Dummy", Comment: PDFString.of("abc") }));
        ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "Dummy", Style: { Panose: PDFHexString.of("0102") } }));
        ctx.register(ctx.obj({ Type: "ExtGState", Name: PDFString.of("gs") }));
        ctx.register(ctx.obj({ Type: "Page", Label: PDFString.of("p") }));
      },
    });
    const r = await detectP5Revisions(bytes);
    expect(r.findings).toEqual([]);
    expect(r.cleanupOnly.parts.font).toBe(2);
  });

  it("対照：字の値のない辞書、いまの版で使っている辞書は数えない", async () => {
    const bytes = await make({
      useObjectStreams: true,
      extra: (doc) => {
        const ctx = doc.context;
        ctx.register(ctx.obj({ A: 1, B: PDFName.of("X"), C: [1, 2, 3] }));
        const used = ctx.register(ctx.obj({ Note: PDFString.of("used") }));
        doc.catalog.set(PDFName.of("Extra"), used);
      },
    });
    const r = await detectP5Revisions(bytes);
    expect(r.findings).toEqual([]);
  });

  it("対照：オブジェクトストリームでない（xref の表の）辞書は、いままでどおり構造として扱う（項目5の範囲の外）", async () => {
    const bytes = await make({
      useObjectStreams: false,
      extra: (doc) => {
        const ctx = doc.context;
        ctx.register(ctx.obj({ Note: PDFString.of("top level") }));
      },
    });
    const r = await detectP5Revisions(bytes);
    expect(r.findings).toEqual([]);
    expect(r.cleanupOnly.count).toBe(1);
  });

  it("対照：pdf-lib で普通に保存した PDF（標準フォントで字を書いた）では、何も出さない", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([200, 200]).drawText("Hello", { x: 10, y: 100, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    doc.setTitle("Kakuu");
    const bytes = new Uint8Array(await doc.save({ useObjectStreams: true }));
    const r = await detectP5Revisions(bytes);
    expect(r.findings).toEqual([]);
    expect(r.cleanupOnly.count).toBe(0);
  });
});

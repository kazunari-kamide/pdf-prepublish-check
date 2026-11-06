// SPDX-License-Identifier: AGPL-3.0-only
//
// 決まった字の対応表（90ms-RKSJ-H・UniJIS-UCS2-H など）の書体で、ToUnicode も埋め込みもない日本語の PDF を読む（2026-11-06）。
// 合成の見本はテストの中で作る（fixtures/ は使わない）。書体名・人の名前はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString, type PDFRef } from "pdf-lib";
import { readFont } from "../rules/shared/fonts.ts";
import { predefinedCMap, SUPPORTED_PREDEFINED_CMAPS } from "../rules/shared/predefined-cmaps.ts";
import { detectPii } from "../rules/pii/index.ts";
import { detectP6Text } from "../rules/p6-text/index.ts";
import { inspectAll } from "../src/inspect/inspect.ts";
import { buildView } from "../src/ui/model.ts";
import { buildCleanView, saveGate } from "../src/ui/clean-model.ts";
import { sanitizePdf } from "../sanitize/index.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";

// ---------------------------------------------------------------- 字をバイト列にする道具

let sjisTable: Map<string, number[]> | null = null;
/** Shift-JIS（Windows の 932）のバイト列にする。1 バイトの字は ASCII だけ */
function sjis(text: string): number[] {
  if (!sjisTable) {
    sjisTable = new Map();
    const dec = new TextDecoder("shift_jis");
    for (let l = 0x81; l <= 0xfc; l++) {
      if (l > 0x9f && l < 0xe0) continue;
      for (let t = 0x40; t <= 0xfc; t++) {
        if (t === 0x7f) continue;
        const s = dec.decode(Uint8Array.of(l, t));
        if (s !== "�" && !sjisTable.has(s)) sjisTable.set(s, [l, t]);
      }
    }
  }
  return [...text].flatMap((c) => (c.charCodeAt(0) < 0x80 ? [c.charCodeAt(0)] : sjisTable!.get(c)!));
}
/** UTF-16BE のバイト列にする（BMP の外はサロゲートの 4 バイト） */
const utf16 = (text: string) => [...text].flatMap((c) => {
  const cp = c.codePointAt(0)!;
  if (cp < 0x10000) return [cp >> 8, cp & 255];
  const h = 0xd800 + ((cp - 0x10000) >> 10);
  const l = 0xdc00 + ((cp - 0x10000) & 1023);
  return [h >> 8, h & 255, l >> 8, l & 255];
});
const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

/** 埋め込まない CID の書体（ToUnicode なし）。W は半角の CID（231〜389）を 500、ほかは DW 1000 */
function cmapFont(doc: PDFDocument, encoding: string, w: unknown[] = [231, 389, 500]): PDFRef {
  const ctx = doc.context;
  const cid = ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "CIDFontType2",
      BaseFont: "KasouMincho",
      CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Japan1"), Supplement: 2 },
      FontDescriptor: ctx.obj({ Type: "FontDescriptor", FontName: "KasouMincho", Flags: 6, FontBBox: [0, -141, 1000, 859], ItalicAngle: 0, Ascent: 859, Descent: -141, CapHeight: 700, StemV: 80 }),
      DW: 1000,
      W: w as never,
    }),
  );
  return ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "KasouMincho", Encoding: encoding, DescendantFonts: [cid] }));
}

/** 1 ページの PDF。content はページの命令（/F1 が cmapFont） */
async function pdfWith(encoding: string, content: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  page.node.set(PDFName.of("Resources"), doc.context.obj({ Font: { F1: cmapFont(doc, encoding) } }));
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(content)));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

const decodeWith = async (encoding: string, bytes: number[], w?: unknown[]) => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  return readFont(doc.context, cmapFont(doc, encoding, w)).decode(Uint8Array.from(bytes));
};

// 「氏名 朝霧澄香」の行（12pt）。名前の 4 字は x = 72 + 24（氏名）+ 6（1 バイトの空白、半角 500）= 102 から 48pt
const LINE = "氏名 朝霧澄香";
const COVER = "0 g 100 694 52 20 re f";

describe("決まった字の対応表を読む", () => {
  it("対応表の一覧（例外の表を同梱したもの）", () => {
    expect([...SUPPORTED_PREDEFINED_CMAPS].sort()).toEqual(
      ["90ms-RKSJ-H", "90ms-RKSJ-V", "90msp-RKSJ-H", "90msp-RKSJ-V", "RKSJ-H", "RKSJ-V", "UniJIS-UCS2-H", "UniJIS-UCS2-HW-H", "UniJIS-UCS2-HW-V", "UniJIS-UCS2-V", "UniJIS-UTF16-H", "UniJIS-UTF16-V"].sort(),
    );
    expect(predefinedCMap("Identity-H")).toBeNull();
    expect(predefinedCMap("83pv-RKSJ-H")).toBeNull(); // 入れていない表は、これまでどおり 2 バイトずつ
  });

  it("90ms-RKSJ-H：1 バイト（ASCII）と 2 バイトの混ざった並びを区切り、字と幅（CID で引く）を返す", async () => {
    const g = await decodeWith("90ms-RKSJ-H", sjis("AB 氏名"));
    expect(g.map((x) => x.text).join("")).toBe("AB 氏名");
    expect(g.map((x) => x.bytes)).toEqual([1, 1, 1, 2, 2]);
    // 1 バイトの字は半角の CID（231〜389。W で 500）、2 バイトの字は全角（DW 1000）。前は 2 バイトずつ区切り、字は空・幅はコードで引いていた
    expect(g.map((x) => x.width)).toEqual([0.5, 0.5, 0.5, 1, 1]);
    expect(g[2]).toMatchObject({ isSpace: true, isWordSpace: true });
  });

  it("90ms-RKSJ-H：半角カナ（1 バイト）も読む", async () => {
    const g = await decodeWith("90ms-RKSJ-H", [0xb1, 0xdd]);
    expect(g.map((x) => [x.text, x.width, x.bytes])).toEqual([["ｱ", 0.5, 1], ["ﾝ", 0.5, 1]]);
  });

  it("90ms-RKSJ-V：縦書き用の CID になる字（ー）は、例外の表で縦書きの CID の幅を引く", async () => {
    // CID 660 は横書きの「ー」、7891 は縦書きの「ー」（Adobe-Japan1）
    const g = await decodeWith("90ms-RKSJ-V", sjis("ー"), [660, [900], 7891, [700]]);
    expect(g.map((x) => [x.text, x.width])).toEqual([["ー", 0.7]]);
    const h = await decodeWith("90ms-RKSJ-H", sjis("ー"), [660, [900], 7891, [700]]);
    expect(h.map((x) => [x.text, x.width])).toEqual([["ー", 0.9]]);
  });

  it("UniJIS-UCS2-H：2 バイトの Unicode として読む。ASCII は比例の CID（1〜95）、HW は半角の CID", async () => {
    const w = [1, 95, 600, 231, 389, 500];
    const g = await decodeWith("UniJIS-UCS2-H", utf16("A朝霧"), w);
    expect(g.map((x) => [x.text, x.width])).toEqual([["A", 0.6], ["朝", 1], ["霧", 1]]);
    const hw = await decodeWith("UniJIS-UCS2-HW-H", utf16("A朝霧"), w);
    expect(hw.map((x) => [x.text, x.width])).toEqual([["A", 0.5], ["朝", 1], ["霧", 1]]);
  });

  it("UniJIS-UTF16-H：BMP の外の字（サロゲートの 4 バイト）を 1 字として読む", async () => {
    const g = await decodeWith("UniJIS-UTF16-H", utf16("𠮟る"));
    expect(g.map((x) => [x.text, x.bytes])).toEqual([["𠮟", 4], ["る", 2]]);
  });
});

describe("書体を埋め込まない日本語の PDF（90ms-RKSJ-H、ToUnicode なし）", () => {
  const draw = (text: string) => `BT /F1 12 Tf 72 700 Td <${hex(sjis(text))}> Tj ET`;

  it("P13：「中身を読み取れない字」が出ず、氏名を見つける", async () => {
    const r = await detectPii(await pdfWith("90ms-RKSJ-H", draw(LINE)), { includeText: true });
    expect(r.unreadable).toEqual({ pages: [], glyphs: 0 });
    expect(r.findings.map((f) => [f.type, f.confidence, f.text])).toEqual([["name", "high", "朝霧澄香"]]);
    // 箱の位置も、幅を CID で引いた結果で合う（名前は x = 102 から 48pt）
    expect(r.findings[0]!.rect[0]).toBeCloseTo(102, 0);
    expect(r.findings[0]!.rect[2]).toBeCloseTo(150, 0);
  });

  it("P6：黒い四角の下の字を、中身つきで読む", async () => {
    const r = await detectP6Text(await pdfWith("90ms-RKSJ-H", `${draw(LINE)}\n${COVER}`), { includeText: true });
    expect(r.status).toBe("ok");
    expect(r.findings.map((f) => (f as { text?: string }).text)).toEqual(["朝霧澄香"]);
  });

  it("整える：下の字を消し、読み直しが「言い切れない」にならない（1 バイトと 2 バイトの混ざった並びを、字ごとのバイト数で切る）", async () => {
    const bytes = await pdfWith("90ms-RKSJ-H", `${draw(LINE)}\n${COVER}`);
    const before = await inspectAll(bytes);
    const codec = createNodeImageCodec();
    const r = await sanitizePdf(bytes, codec ? { codec } : {});
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const after = await inspectAll(r.bytes);
    const c = buildCleanView({ before: buildView(before), after: buildView(after), removed: r.removed, notDone: r.notDone, decrypted: r.decrypted });
    expect(c.verdict).toBe("clean");
    expect(saveGate(c)).toBe("ok");
    // 覆いの外の字（氏名と空白）は残り、名前だけが消える
    const pii = await detectPii(r.bytes, { includeText: true });
    expect(pii.unreadable.glyphs).toBe(0);
    expect(pii.noTextPages).toEqual([]); // 字の命令をまるごと消していない（前は区切りが合わず、覆いの外の「氏名」まで消していた）
    expect(pii.findings).toEqual([]);
    const p6 = await detectP6Text(r.bytes, { includeText: true });
    expect(p6.findings).toEqual([]);
  }, 60_000);
});

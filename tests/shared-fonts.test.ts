// SPDX-License-Identifier: AGPL-3.0-only
//
// 共通の書体の寸法（rules/shared/fonts.ts）のテスト。P6 と P7 の検出ルールが同じものを使う（PR #25 の返事の 1）。
// テストの中で書体の辞書を作って確かめる（fixtures/ は使わない）。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { readFont } from "../rules/shared/fonts.ts";

const ascii = (s: string) => new TextEncoder().encode(s);

describe("共通の書体の寸法", () => {
  it("/FontDescriptor のない標準の書体は、pdf-lib の寸法で幅と高さを引く", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    await font.embed(); // 書体の辞書は、書き出すまで作られないので、先に作らせる
    const f = readFont(doc.context, font.ref);
    expect(f.twoByte).toBe(false);
    expect(f.ascent).toBeCloseTo(0.718, 3);
    expect(f.descent).toBeCloseTo(-0.207, 3);
    const [a, sp] = f.decode(ascii("A "));
    expect(a!.width).toBeCloseTo(0.667, 3);
    expect(sp!.isSpace).toBe(true);
    expect(sp!.isWordSpace).toBe(true);
  });

  it("/Widths → /MissingWidth → 0.5em の順に引き、Ascent が 0 なら /FontBBox を使う", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const desc = ctx.obj({ Type: "FontDescriptor", Ascent: 0, Descent: -150, FontBBox: [0, -200, 1000, 900], MissingWidth: 250 });
    const font = ctx.obj({ Type: "Font", Subtype: "TrueType", BaseFont: "Foo", FirstChar: 65, Widths: [600], FontDescriptor: ctx.register(desc) });
    const f = readFont(ctx, ctx.register(font));
    expect(f.decode(ascii("AB")).map((g) => g.width)).toEqual([0.6, 0.25]);
    expect(f.ascent).toBeCloseTo(0.9, 6);
    expect(f.descent).toBeCloseTo(-0.15, 6);
    const noMissing = readFont(ctx, ctx.register(ctx.obj({ Type: "Font", Subtype: "TrueType", BaseFont: "Foo", FirstChar: 65, Widths: [600] })));
    expect(noMissing.decode(ascii("B"))[0]!.width).toBe(0.5);
    expect([noMissing.ascent, noMissing.descent]).toEqual([0.8, -0.2]);
  });

  it("Type3 は FontMatrix の倍率（正の値）で幅と高さを直す", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const font = ctx.obj({ Type: "Font", Subtype: "Type3", FontMatrix: [-0.01, 0, 0, 0.01, 0, 0], FontBBox: [0, -10, 100, 70], FirstChar: 65, Widths: [50] });
    const f = readFont(ctx, ctx.register(font));
    expect(f.decode(ascii("A"))[0]!.width).toBeCloseTo(0.5, 6);
    expect(f.ascent).toBeCloseTo(0.7, 6);
    expect(f.descent).toBeCloseTo(-0.1, 6);
  });

  it("Type0 は2バイトで区切り、/W で幅を引き、ToUnicode で空白になる字（全角の空白）を空白とする", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const cmap = ctx.stream("1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <5C71> <0002> <3000> endbfchar");
    const cid = ctx.obj({ Type: "Font", Subtype: "CIDFontType2", BaseFont: "ABCDEF+Mincho", DW: 1000, W: [1, [800]] });
    const font = ctx.obj({ Type: "Font", Subtype: "Type0", Encoding: "Identity-H", DescendantFonts: [ctx.register(cid)], ToUnicode: ctx.register(cmap) });
    const f = readFont(ctx, ctx.register(font));
    const gs = f.decode(Uint8Array.from([0, 1, 0, 2, 0, 3]));
    expect(f.twoByte).toBe(true);
    expect(gs.map((g) => [g.width, g.isSpace, g.isWordSpace, g.text])).toEqual([
      [0.8, false, false, "山"],
      [1, true, false, "　"],
      [1, false, false, ""],
    ]);
  });

  it("書体の辞書でないものは、幅 0.5em・既定の高さにする", async () => {
    const doc = await PDFDocument.create();
    const f = readFont(doc.context, PDFName.of("NotAFont"));
    expect(f.decode(ascii("a"))[0]!.width).toBe(0.5);
    expect([f.ascent, f.descent]).toEqual([0.8, -0.2]);
  });
});

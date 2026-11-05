// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6（見せかけの黒塗り）の文字の層のテスト。
// fixtures/ の合成 PDF は採点に使うので、ここではテストの中で小さな PDF を作って確かめる。

import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb, grayscale } from "pdf-lib";
import { detectP6Text, type P6TextFinding } from "../rules/p6-text/index.ts";
import { bytesArg, operations } from "../rules/shared/content-lexer.ts";
import { luminanceOf } from "../rules/p6-text/page.ts";

const enc = (s: string) => new TextEncoder().encode(s);

async function makePdf(draw: (page: import("pdf-lib").PDFPage, font: import("pdf-lib").PDFFont) => void) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  draw(page, font);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe("命令の読み取り", () => {
  it("文字列のエスケープ・16進の文字列・配列・名前を読む", () => {
    const ops = [...operations(enc("/F1 12 Tf (a\\(b\\)\\101) Tj <4142> Tj [(x) -250 (y)] TJ"))];
    expect(ops.map((o) => o.op)).toEqual(["Tf", "Tj", "Tj", "TJ"]);
    const s = bytesArg(ops[1]!.args[0])!;
    expect(new TextDecoder().decode(s)).toBe("a(b)A");
    const h = bytesArg(ops[2]!.args[0])!;
    expect(new TextDecoder().decode(h)).toBe("AB");
  });

  it("埋め込みの画像（BI … ID … EI）の中身を命令として読まない", () => {
    const ops = [...operations(enc("q BI /W 1 /H 1 /CS /G /BPC 8 ID \x00re f EI Q 0 0 1 1 re f"))];
    expect(ops.map((o) => o.op)).toEqual(["q", "BI", "Q", "re", "f"]);
  });

  it("深すぎる入れ子では止まる（固まらない）", () => {
    expect(() => [...operations(enc("[".repeat(100) + "] Tj"))]).toThrow();
  });
});

describe("明るさ", () => {
  it("灰色・RGB・CMYK の黒は 0 に近い", () => {
    expect(luminanceOf([0], 1)).toBe(0);
    expect(luminanceOf([0, 0, 0], 3)).toBe(0);
    expect(luminanceOf([0, 0, 0, 1], 4)).toBe(0);
  });
  it("分からない色空間は null（濃いとはみなさない）", () => {
    expect(luminanceOf([0.5], 0)).toBeNull();
  });
});

describe("黒い四角の下の字", () => {
  it("字のあとに黒い四角を描いたら、見つける", async () => {
    const pdf = await makePdf((page, font) => {
      page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
      page.drawRectangle({ x: 15, y: 95, width: 120, height: 20, color: rgb(0, 0, 0) });
    });
    const r = await detectP6Text(pdf);
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(1);
    expect((r.findings[0] as P6TextFinding).chars).toBe(10); // 空白は数えない
    expect((r.findings[0] as P6TextFinding).text).toBeUndefined(); // 既定では字の中身を返さない
  });

  it("黒い四角のあとに字を描いたら（黒地に白い字）、見つけない", async () => {
    const pdf = await makePdf((page, font) => {
      page.drawRectangle({ x: 15, y: 95, width: 120, height: 20, color: rgb(0, 0, 0) });
      page.drawText("Heading", { x: 20, y: 100, size: 12, font, color: rgb(1, 1, 1) });
    });
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });

  it("不透明な薄い色の四角も、下の字を隠すので見つける（1.11.0 から。濃くない覆いとして）", async () => {
    const pdf = await makePdf((page, font) => {
      page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
      page.drawRectangle({ x: 15, y: 95, width: 120, height: 20, color: grayscale(0.9) });
    });
    expect((await detectP6Text(pdf)).findings).toMatchObject([{ layer: "text", cover: "fill", coverTone: "opaque", chars: 10 }]);
  });

  it("半透明の黒は、隠していないので見つけない", async () => {
    const pdf = await makePdf((page, font) => {
      page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
      page.drawRectangle({ x: 15, y: 95, width: 120, height: 20, color: rgb(0, 0, 0), opacity: 0.3 });
    });
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });

  it("字の下端に少しかかる下線は、見つけない", async () => {
    const pdf = await makePdf((page, font) => {
      page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
      page.drawRectangle({ x: 20, y: 98, width: 70, height: 1, color: rgb(0, 0, 0) });
    });
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });

  it("円で覆ったものも、見つける（1.3.0 から。形そのものの面積で測る）", async () => {
    const pdf = await makePdf((page, font) => {
      page.drawText("Taro", { x: 20, y: 100, size: 12, font });
      page.drawEllipse({ x: 32, y: 104, xScale: 20, yScale: 20, color: rgb(0, 0, 0) });
    });
    const r = await detectP6Text(pdf);
    expect(r.findings).toHaveLength(1);
    expect((r.findings[0] as P6TextFinding).chars).toBe(4);
  });

  it("includeText を付けたときだけ、覆われた字を返す", async () => {
    const pdf = await makePdf((page, font) => {
      page.drawText("Taro", { x: 20, y: 100, size: 12, font });
      page.drawRectangle({ x: 15, y: 95, width: 60, height: 20, color: rgb(0, 0, 0) });
    });
    const r = await detectP6Text(pdf, { includeText: true });
    expect((r.findings[0] as P6TextFinding).text).toBe("Taro");
  });
});

describe("壊れた入力", () => {
  it("空のファイル", async () => {
    expect((await detectP6Text(new Uint8Array(0))).error?.code).toBe("empty");
  });
  it("PDF でないもの", async () => {
    expect((await detectP6Text(enc("hello"))).status).toBe("error");
  });
  it("途中で切れた PDF でも止まらない", async () => {
    const pdf = await makePdf((page, font) => page.drawText("Taro", { x: 20, y: 100, size: 12, font }));
    const r = await detectP6Text(pdf.slice(0, Math.floor(pdf.length / 2)));
    expect(["ok", "error"]).toContain(r.status);
  });
  it("命令が多すぎるページは、調べずに「省いた」と返す", async () => {
    const pdf = await makePdf((page, font) => page.drawText("Taro", { x: 20, y: 100, size: 12, font }));
    const r = await detectP6Text(pdf, { settings: { maxOperationsPerPage: 2 } });
    expect(r.skippedPages).toEqual([{ page: 1, reason: "too_many_operations" }]);
    expect(r.findings).toHaveLength(0);
  });
});

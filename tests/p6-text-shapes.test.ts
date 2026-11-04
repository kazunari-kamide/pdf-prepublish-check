// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6（見せかけの黒塗り）の文字の層 1.3.0：四角でない覆い（楕円・回した四角・角の丸い四角・太い曲線・回した画像）と、
// 重いページのテスト（PR #12 の返事）。
// - テストの中で小さな PDF を作って確かめる（fixtures/ は使わない）
// - 楕円・回した四角・角の丸い四角の合成 PDF（t14〜t16）は、検証器を直すまで proposals/p6/additions/ にある。
//   そこにある間は、そこから読んで正解データと照らす（fixtures/p6/ に移ったら、そちらを読む）

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PDFDocument,
  PDFName,
  StandardFonts,
  appendBezierCurve,
  closePath,
  concatTransformationMatrix,
  degrees,
  drawObject,
  fill,
  PDFOperator,
  PDFOperatorNames,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingGrayscaleColor,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { detectP6Text, type P6TextFinding } from "../rules/p6-text/index.ts";
import { adaptP6Text } from "../eval/adapters/p6-text.ts";
import { matchFile, type Expected } from "../eval/match.ts";
import { HEAVY_TIMEOUT } from "./helpers/timeout.ts";

async function makePdf(draw: (page: PDFPage, font: PDFFont, doc: PDFDocument) => void) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
  draw(page, font, doc);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe("四角でない覆い", () => {
  it("楕円で覆った字を見つけ、覆いの箱は楕円の外枠", async () => {
    const r = await detectP6Text(await makePdf((p) => p.drawEllipse({ x: 52, y: 104, xScale: 50, yScale: 14, color: rgb(0, 0, 0) })));
    expect(r.findings).toHaveLength(1);
    expect((r.findings[0] as P6TextFinding).chars).toBe(10);
    const [x0, y0, x1, y1] = r.findings[0]!.rect;
    expect([x0, y0, x1, y1].map(Math.round)).toEqual([2, 90, 102, 118]);
  });

  it("3度・30度回した黒い四角で覆った字を見つける", async () => {
    for (const deg of [3, 30]) {
      const pdf = await makePdf((p) =>
        p.drawRectangle({ x: 14, y: deg === 3 ? 92 : 60, width: 90, height: deg === 3 ? 22 : 90, rotate: degrees(deg), color: rgb(0, 0, 0) }),
      );
      const r = await detectP6Text(pdf);
      expect(r.findings, `${deg} 度`).toHaveLength(1);
    }
  });

  it("角の丸い四角（半径が高さの半分）で覆った字を見つける", async () => {
    const pdf = await makePdf((p) => {
      const [x, y, w, h, rr] = [6, 94, 90, 20, 10];
      const k = 0.5523 * rr;
      p.pushOperators(
        pushGraphicsState(),
        setFillingGrayscaleColor(0),
        moveTo(x + rr, y),
        lineTo(x + w - rr, y),
        appendBezierCurve(x + w - rr + k, y, x + w, y + rr - k, x + w, y + rr),
        appendBezierCurve(x + w, y + h - rr + k, x + w - rr + k, y + h, x + w - rr, y + h),
        lineTo(x + rr, y + h),
        appendBezierCurve(x + rr - k, y + h, x, y + h - rr + k, x, y + rr),
        appendBezierCurve(x, y + rr - k, x + rr - k, y, x + rr, y),
        closePath(),
        fill(),
        popGraphicsState(),
      );
    });
    expect((await detectP6Text(pdf)).findings).toHaveLength(1);
  });

  it("字のない所の黒い円は、見つけない", async () => {
    const pdf = await makePdf((p) => p.drawEllipse({ x: 200, y: 50, xScale: 20, yScale: 20, color: rgb(0, 0, 0) }));
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });

  it("字を囲む黒い枠（偶奇の決まりで中を抜いた四角）は、字を隠していないので見つけない", async () => {
    const pdf = await makePdf((p) =>
      p.pushOperators(
        pushGraphicsState(),
        setFillingGrayscaleColor(0),
        // 外の四角と内の四角を f* で塗る（内側は塗られない）
        moveTo(5, 85), lineTo(115, 85), lineTo(115, 125), lineTo(5, 125), closePath(),
        moveTo(10, 90), lineTo(110, 90), lineTo(110, 120), lineTo(10, 120), closePath(),
        PDFOperator.of(PDFOperatorNames.FillEvenOdd),
        popGraphicsState(),
      ),
    );
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });

  it("字を囲む黒い枠（ゼロでない決まりで、内側を逆向きに描いた四角）も、見つけない", async () => {
    const pdf = await makePdf((p) =>
      p.pushOperators(
        pushGraphicsState(),
        setFillingGrayscaleColor(0),
        moveTo(5, 85), lineTo(115, 85), lineTo(115, 125), lineTo(5, 125), closePath(),
        moveTo(10, 90), lineTo(10, 120), lineTo(110, 120), lineTo(110, 90), closePath(), // 逆向き
        fill(),
        popGraphicsState(),
      ),
    );
    expect((await detectP6Text(pdf)).findings).toHaveLength(0);
  });

  it("斜めの太いマーカーの線で覆った字を見つけ、細い斜めの線は見つけない", async () => {
    const thick = await makePdf((p) => p.drawLine({ start: { x: 15, y: 100 }, end: { x: 100, y: 108 }, thickness: 18, color: rgb(0, 0, 0) }));
    expect((await detectP6Text(thick)).findings).toHaveLength(1);
    const thin = await makePdf((p) => p.drawLine({ start: { x: 15, y: 100 }, end: { x: 100, y: 108 }, thickness: 0.5, color: rgb(0, 0, 0) }));
    expect((await detectP6Text(thin)).findings).toHaveLength(0);
  });

  it("太い曲線（手書きのように引いた線）で覆った字を見つける", async () => {
    const pdf = await makePdf((p) => p.drawSvgPath("M 0 0 C 30 -6, 60 6, 90 0", { x: 15, y: 104, borderColor: rgb(0, 0, 0), borderWidth: 20 }));
    expect((await detectP6Text(pdf)).findings).toHaveLength(1);
  });

  it("回して置いた黒い画像で覆った字を見つける", async () => {
    const pdf = await makePdf((p, _f, doc) => {
      const img = doc.context.register(
        doc.context.flateStream(new Uint8Array(16), { Type: "XObject", Subtype: "Image", Width: 4, Height: 4, ColorSpace: "DeviceGray", BitsPerComponent: 8 }),
      );
      const name = p.node.newXObject("Im", img);
      const t = (5 * Math.PI) / 180;
      p.pushOperators(pushGraphicsState(), concatTransformationMatrix(100 * Math.cos(t), 100 * Math.sin(t), -24 * Math.sin(t), 24 * Math.cos(t), 14, 92), drawObject(name), popGraphicsState());
    });
    const r = await detectP6Text(pdf);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.cover).toBe("image");
  });
});

describe("合成 PDF t14〜t16（proposals/p6/additions/ か fixtures/p6/）", () => {
  const ROOT = path.resolve(import.meta.dirname, "..");
  const dirs = [path.join(ROOT, "fixtures", "p6"), path.join(ROOT, "proposals", "p6", "additions", "fixtures", "p6")];
  const rule = JSON.parse(readFileSync(path.join(ROOT, "rubric", "p6.json"), "utf8")).match;
  for (const name of ["p6-t14-ellipse", "p6-t15-rotated-rects", "p6-t16-rounded-rects"]) {
    it(`${name}：正解の漏れをすべて見つけ、正解にない報告をしない`, async () => {
      const dir = dirs.find((d) => existsSync(path.join(d, `${name}.expected.json`)));
      expect(dir, "合成 PDF が見つからない").toBeDefined();
      const exp = JSON.parse(readFileSync(path.join(dir!, `${name}.expected.json`), "utf8")) as Expected;
      const report = adaptP6Text(await detectP6Text(new Uint8Array(readFileSync(path.join(dir!, exp.file)))));
      const m = matchFile(exp, report, rule);
      expect(m.missed.map((x) => x.id)).toEqual([]);
      expect(m.falseNowhere).toHaveLength(0);
      expect(m.falseOnNegative).toHaveLength(0);
      for (const x of m.matched) expect(x.item.remaining?.chars).toBe(x.leak.remaining?.chars);
    });
  }
});

describe("重いページ", () => {
  /** 細い曲線を n 本並べたページ（字はない）と、2ページ目に見せかけの黒塗り */
  async function heavy(n: number, stroke: string) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([300, 200]);
    const parts = [stroke];
    for (let i = 0; i < n; i++) parts.push(`${(i % 280) + 5} ${(i % 190) + 5} m ${(i % 280) + 8} ${(i % 190) + 9} ${(i % 280) + 11} ${(i % 190) + 1} ${(i % 280) + 14} ${(i % 190) + 5} c S\n`);
    p1.node.set(PDFName.of("Contents"), doc.context.obj([doc.context.register(doc.context.flateStream(new TextEncoder().encode(parts.join(""))))]));
    const p2 = doc.addPage([300, 200]);
    p2.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
    p2.drawRectangle({ x: 15, y: 95, width: 120, height: 20, color: rgb(0, 0, 0) });
    return new Uint8Array(await doc.save({ useObjectStreams: false }));
  }

  it("曲線 10 万本（命令 30 万）のページも、省かずに調べる（1.2.0 の上限 20 万を超える）", { timeout: HEAVY_TIMEOUT }, async () => {
    const r = await detectP6Text(await heavy(100_000, "0 G 0.3 w\n"));
    expect(r.skippedPages).toEqual([]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.page).toBe(2);
  });

  it("先に描いた字に重なる濃い塗りが上限を超えたページは、省いたと返す（ほかのページは調べる）", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([300, 200]);
    p1.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
    for (let i = 0; i < 20; i++) p1.drawRectangle({ x: 15 + i, y: 95, width: 10, height: 20, color: rgb(0, 0, 0) });
    const p2 = doc.addPage([300, 200]);
    p2.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
    p2.drawRectangle({ x: 15, y: 95, width: 120, height: 20, color: rgb(0, 0, 0) });
    const r = await detectP6Text(new Uint8Array(await doc.save({ useObjectStreams: false })), { settings: { maxCoversPerPage: 5 } });
    expect(r.skippedPages).toEqual([{ page: 1, reason: "too_many_covers" }]);
    expect(r.findings.map((f) => f.page)).toEqual([2]);
  });

  it("字に重ならない濃い塗りは、覆いの数に数えない（字のないページの塗りで省かない）", async () => {
    const r = await detectP6Text(await heavy(2_000, "0 g\n").then((b) => b), { settings: { maxCoversPerPage: 5 } });
    expect(r.skippedPages).toEqual([]);
  });
});

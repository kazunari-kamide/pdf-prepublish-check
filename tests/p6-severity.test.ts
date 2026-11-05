// SPDX-License-Identifier: AGPL-3.0-only
//
// P6（見せかけの黒塗り）の画面の深刻度（2026-11-05）。
// 実物の公開 PDF で、注釈の四角や塗りの誤検知が「高」で多く出た。「高」にするのは、覆いの下に拾えるもの
// （字、または取り出せる画像の中身）があると言い切れるときと、読み解けない画像の上に濃い四角を重ねたもの（スキャン画像の黒塗りの型）だけ。
// 図形の層と、そのほかの「確かめてください」は「中」。PDF はテストの中で作る。字はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { P6Finding } from "../rules/p6-text/index.ts";
import { RULES, p6Item } from "../src/inspect/rules.ts";

const p6Rule = RULES.find((r) => r.id === "p6-text")!;
const R: [number, number, number, number] = [10, 10, 60, 30];

const text = (confidence: "high" | "check", extra: object = {}): P6Finding => ({ pattern: "P6", layer: "text", cover: "fill", page: 1, rect: R, chars: 5, confidence, ...extra });
const image = (confidence: "high" | "check", extra: object = {}): P6Finding => ({
  pattern: "P6",
  layer: "image",
  cover: "annotation",
  tone: "dark",
  page: 1,
  rect: R,
  spread: null,
  confidence,
  ...extra,
});

describe("報告の形ごとの深刻度", () => {
  it.each([
    ["黒い四角の下に字（言い切れる）", text("high"), "high"],
    ["白い四角の下に字（言い切れる）", text("high", { coverTone: "opaque" }), "high"],
    ["黒い四角の下に字かもしれない（見出しの帯のような形）", text("check"), "medium"],
    ["白い四角の下に字かもしれない（上に別の字）", text("check", { coverTone: "opaque" }), "medium"],
    ["黒い四角の下に画像の中身（言い切れる）", image("high"), "high"],
    ["写真のような画像の上の四角（確かめてください）", image("check"), "medium"],
    ["読み解けない画像の上の濃い四角（スキャン画像の黒塗りの型）", image("check", { reason: "under_unreadable" }), "high"],
    ["読み解けない画像の上の白い四角", image("check", { reason: "under_unreadable", tone: "light" }), "medium"],
    ["四角の上に線が重なって測れない画像", image("check", { reason: "under_later_paint" }), "medium"],
    ["白い四角の注釈の下の図形", { pattern: "P6", layer: "vector", cover: "annotation", page: 1, rect: R, paths: 40, segments: 300, confidence: "check" } as P6Finding, "medium"],
  ])("%s", (_name, f, want) => {
    expect(p6Item(f).severity).toBe(want);
  });
});

async function makePdf(draw: (page: ReturnType<PDFDocument["addPage"]>, font: Awaited<ReturnType<PDFDocument["embedFont"]>>) => void) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  draw(page, font);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe("合成した PDF で", () => {
  it("字の上に黒い四角を重ねただけ（下の字を拾える）は「高」", async () => {
    const bytes = await makePdf((page, font) => {
      page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
      page.drawRectangle({ x: 15, y: 95, width: 90, height: 20, color: rgb(0, 0, 0) });
    });
    const res = await p6Rule.run(bytes);
    expect(res.items.map((i) => i.severity)).toEqual(["high"]);
  });

  it("黒い帯の上に白い見出しの字がある（下の字と上の字が別）なら、言い切れないので「中」", async () => {
    const bytes = await makePdf((page, font) => {
      page.drawText("Kakushita namae", { x: 20, y: 100, size: 12, font });
      page.drawRectangle({ x: 15, y: 95, width: 110, height: 20, color: rgb(0, 0, 0) });
      page.drawText("Midashi", { x: 20, y: 100, size: 12, font, color: rgb(1, 1, 1) });
    });
    const res = await p6Rule.run(bytes);
    expect(res.items.length).toBeGreaterThan(0);
    for (const it of res.items) {
      expect(it.confidence).toBe("check");
      expect(it.severity).toBe("medium");
    }
  });

  it("下に字のない黒い塗りは、何も出さない", async () => {
    const bytes = await makePdf((page, font) => {
      page.drawText("Taro Yamada", { x: 20, y: 150, size: 12, font });
      page.drawRectangle({ x: 15, y: 50, width: 90, height: 20, color: rgb(0, 0, 0) });
    });
    const res = await p6Rule.run(bytes);
    expect(res.items).toEqual([]);
  });
});

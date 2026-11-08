// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の図（src/site/figures/*.svg。作り方は site-figures-draw.ts）を確かめる。
// - 全部の記事に図があり、代わりの文（alt）が、図の中の題（<title>）と同じ
// - リポジトリの SVG が、描く道具で作り直したものと同じ（手で直してずれないように）
// - 色は design/tokens.css・design/sheet.css にある値だけ。字は 24 以上（幅 390px の画面では図が幅 336px になり、字は約 12.6px。2026-11-05 に測った）
// - 中身の決まり（スクリプト・style・外へのリンク・別の画像がない）は site-figures.ts の確かめも通る

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { svgSize } from "../site-figures.ts";
import { C, FIGURES, figureSvg } from "../site-figures-draw.ts";
import { ARTICLES } from "../src/site/articles.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "src", "site", "figures");
const read = (f: string) => readFileSync(path.join(DIR, f), "utf8");

/** デザインの決まりにある色（tokens.css・sheet.css の #xxxxxx） */
const PALETTE = new Set(
  ["design/tokens.css", "design/sheet.css"].flatMap((f) => [...readFileSync(path.join(ROOT, f), "utf8").matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase())),
);

describe("記事の図", () => {
  it("全部の記事（35 本）に図があり、ファイルがある", () => {
    expect(ARTICLES.length).toBe(35);
    const files = new Set(readdirSync(DIR));
    for (const a of ARTICLES) {
      expect(a.figure, a.slug).toBeDefined();
      expect(files.has(a.figure!.file), a.figure!.file).toBe(true);
    }
  });

  it("代わりの文は空でなく、図の中の題（<title>）と同じ", () => {
    for (const a of ARTICLES) {
      const alt = a.figure!.alt;
      expect(alt.length, a.slug).toBeGreaterThan(10);
      const title = read(a.figure!.file).match(/<title>([^<]*)<\/title>/)?.[1];
      expect(title, a.slug).toBe(alt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
    }
  });

  it("リポジトリの SVG は、描く道具（npm run figures:draw）で作り直したものと同じ", () => {
    for (const slug of Object.keys(FIGURES)) expect(read(`${slug}.svg`).replace(/\r\n/g, "\n"), slug).toBe(figureSvg(slug));
  });

  it("色は、デザインの決まりにある値だけ", () => {
    for (const v of Object.values(C)) expect(PALETTE.has(v), v).toBe(true);
    for (const f of readdirSync(DIR).filter((x) => x.endsWith(".svg"))) {
      const used = [...read(f).matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1]!.toLowerCase());
      for (const c of used) expect(PALETTE.has(c), `${f}：${c}`).toBe(true);
    }
  });

  it("字は 24 以上（幅 390px の画面では、図の幅 336px・字は約 12.6px）", () => {
    for (const f of readdirSync(DIR).filter((x) => x.endsWith(".svg"))) {
      for (const m of read(f).matchAll(/font-size="([0-9.]+)"/g)) expect(Number(m[1]), f).toBeGreaterThanOrEqual(24);
    }
  });

  it("site-figures.ts の確かめ（大きさ・スクリプト・style・リンク・別の画像）を通り、640×360", () => {
    for (const f of readdirSync(DIR).filter((x) => x.endsWith(".svg"))) expect(svgSize(read(f)), f).toEqual({ width: 640, height: 360 });
  });

  it("図の中の名前は、架空のもの（「架空」の付いた名前だけ）", () => {
    // 人・団体の名前らしい所（「さん」「町」「市」「様」の前）には「架空」を付ける決まり
    for (const f of readdirSync(DIR).filter((x) => x.endsWith(".svg"))) {
      const texts = [...read(f).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
      for (const s of texts) if (/(さん|町|市|村|県|様|株式会社)/.test(s)) expect(s, f).toMatch(/架空/);
    }
  });
});

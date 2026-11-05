// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧のサムネ（案 C。site-thumbs-draw.ts・site-thumbs.ts）を確かめる。
// - すべての記事にサムネ（16:9 と正方形）が当たる
// - リポジトリの SVG は、描くコードから書いたものと 1 バイトも違わない（手で直していない）
// - 色は design/tokens.css・design/sheet.css にある値だけ。字（<text>）・外の画像・スクリプトを入れない
// - 記事の一覧の札に、サムネと題のリンクが 1 つずつあり、札の中に枠・面の部品（タグの並び）を置かない

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARTICLES } from "../src/site/articles.ts";
import { renderArticleIndex } from "../src/site/article-index.ts";
import { MOTIFS, THUMBS_DIR, thumbSvg } from "../site-thumbs-draw.ts";
import { buildThumbs, thumbName } from "../site-thumbs.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const tokenColors = () => {
  const css = ["design/tokens.css", "design/sheet.css"].map((f) => readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  return new Set([...css.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase()));
};

describe("記事の一覧のサムネ", () => {
  it("すべての記事に、16:9 と正方形のサムネが当たる", () => {
    const { assets, files } = buildThumbs();
    for (const a of ARTICLES) {
      const t = assets.get(a.slug);
      expect(t, a.slug).toBeDefined();
      expect(t!.wide.href).toMatch(/^\/assets\/thumbs\/[a-z0-9-]+-[0-9a-f]{10}\.svg$/);
      expect(t!.square.href).toMatch(/^\/assets\/thumbs\/[a-z0-9-]+-sq-[0-9a-f]{10}\.svg$/);
      expect([t!.wide.width, t!.wide.height]).toEqual([320, 180]);
      expect(t!.square.width).toBe(t!.square.height);
      expect(MOTIFS[thumbName(a)] !== undefined || readdirSync(THUMBS_DIR).includes(`${a.slug}.svg`), a.slug).toBe(true);
    }
    expect([...files.keys()].every((k) => k.startsWith("assets/thumbs/"))).toBe(true);
  });

  it("リポジトリの SVG は、描くコードから書いたものと同じ", () => {
    // 改行は LF にそろえて比べる（Windows で取り出すと CRLF になることがあるため）
    const read = (f: string) => readFileSync(path.join(THUMBS_DIR, f), "utf8").replace(/\r\n/g, "\n");
    for (const name of Object.keys(MOTIFS)) {
      expect(read(`${name}.svg`), name).toBe(thumbSvg(name));
      expect(read(`${name}-sq.svg`), `${name}-sq`).toBe(thumbSvg(name, true));
    }
  });

  it("色は決まりの値だけ。字・外の画像・スクリプトを入れない", () => {
    const allowed = tokenColors();
    for (const f of readdirSync(THUMBS_DIR).filter((n) => n.endsWith(".svg"))) {
      const svg = readFileSync(path.join(THUMBS_DIR, f), "utf8");
      const used = [...svg.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase());
      expect(used.filter((c) => !allowed.has(c)), f).toEqual([]);
      expect(svg, f).not.toMatch(/<text|<image|<script|\shref=|\sstyle=/);
    }
  });

  it("記事の一覧の札：サムネ 2 つ・題のリンク 1 つ。札の中にタグの並びを置かない", () => {
    const { assets } = buildThumbs();
    const html = renderArticleIndex({ origin: "https://example.invalid", csp: "", cssHref: "/a.css", thumbs: assets });
    const cards = [...html.matchAll(/<li class="card"[\s\S]*?<\/li>\n/g)].map((m) => m[0]);
    expect(cards.length).toBe(ARTICLES.length);
    for (const c of cards) {
      expect(c.match(/<img class="card-thumb /g)?.length).toBe(2);
      expect(c.match(/<a /g)?.length).toBe(1);
      expect(c).not.toContain("card-tags");
      expect(c).toMatch(/alt=""/);
    }
    // 3D の飾りは出さない（案 C でやめた）
    expect(html).not.toContain("site-hero-3d");
  });
});

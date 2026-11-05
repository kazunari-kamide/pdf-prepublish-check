// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧のサムネ（src/site/thumbs/。描き方は site-thumbs-draw.ts）を、ビルドの時に assets/thumbs/ に置く（site.ts が呼ぶ。ブラウザでは動かさない）。
// - 記事ごとの絵（<記事の名前>.svg）があればそれを、なければ型ごとの絵（p1〜p12。型のない手順の記事は guide）を使う
// - 16:9（広い画面）と正方形（狭い画面。<名前>-sq.svg）の 2 つ。名前に中身のハッシュを付ける（1 年キャッシュさせるため）
// - SVG の中身は、記事の図と同じ決まりで確かめる（site-figures.ts の svgSize：スクリプト・style・外を指すリンクを止める）
// - サムネは飾り（すぐ横に題がある）なので、alt は空にする（article-index.ts）

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ARTICLES } from "./src/site/articles.ts";
import { svgSize } from "./site-figures.ts";
import type { Article } from "./src/site/types.ts";

export const THUMBS_DIR = path.join(import.meta.dirname, "src", "site", "thumbs");

export interface ThumbAsset {
  href: string;
  width: number;
  height: number;
}

export interface Thumb {
  wide: ThumbAsset;
  square: ThumbAsset;
}

/** 記事に当てる絵の名前（記事ごとの絵がなければ、型ごとの絵） */
export function thumbName(a: Article, dir = THUMBS_DIR): string {
  if (existsSync(path.join(dir, `${a.slug}.svg`))) return a.slug;
  const p = a.pattern?.match(/P(\d+)/);
  return p ? `p${p[1]}` : "guide";
}

export function buildThumbs(articles: readonly Article[] = ARTICLES, dir = THUMBS_DIR): { assets: Map<string, Thumb>; files: Map<string, Uint8Array> } {
  const assets = new Map<string, Thumb>();
  const files = new Map<string, Uint8Array>();
  const put = (file: string, where: string): ThumbAsset => {
    const p = path.join(dir, file);
    if (!existsSync(p)) throw new Error(`${where}：src/site/thumbs/${file} がありません（npm run thumbs:draw）`);
    const buf = readFileSync(p);
    let size: { width: number; height: number };
    try {
      size = svgSize(buf.toString("utf8"));
    } catch (err) {
      throw new Error(`${where}：${err instanceof Error ? err.message : err}`);
    }
    const name = `assets/thumbs/${path.basename(file, ".svg")}-${createHash("sha256").update(buf).digest("hex").slice(0, 10)}.svg`;
    files.set(name, buf);
    return { href: `/${name}`, ...size };
  };
  for (const a of articles) {
    const n = thumbName(a, dir);
    const where = `記事 ${a.slug} のサムネ`;
    assets.set(a.slug, { wide: put(`${n}.svg`, where), square: put(`${n}-sq.svg`, where) });
  }
  return { assets, files };
}

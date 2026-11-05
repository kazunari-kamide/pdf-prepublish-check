// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の図（articles.ts の figure。ファイルは src/site/figures/）を、ビルドの時に assets/figures/ に置く（site.ts が呼ぶ。ブラウザでは動かさない）。
// - 名前に中身のハッシュを付ける（.htaccess で 1 年キャッシュさせるため。scripts/check-dist.mjs の決まり）
// - 使えるのは SVG と PNG だけ。大きさをファイルから読み、<img> の width・height に書く（読み込む前から場所を取る）
// - SVG は、スクリプト・style・外を指すリンク・イベントを含んでいたら止める（<img> で読むので動かないが、置くものから除く）
// - 図は、自分で描いた SVG か、合成 PDF（fixtures/ の架空のもの）を画面で撮った PNG だけ。実在の団体・PDF は使わない

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ARTICLES } from "./src/site/articles.ts";
import type { Article, FigureAsset } from "./src/site/types.ts";

export const FIGURES_DIR = path.join(import.meta.dirname, "src", "site", "figures");

/** PNG の大きさ（IHDR の幅と高さ） */
export function pngSize(buf: Uint8Array): { width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((b, i) => buf[i] === b)) throw new Error("PNG の形になっていません");
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** SVG の大きさ（width・height。なければ viewBox）。中身も確かめる */
export function svgSize(text: string): { width: number; height: number } {
  const svg = text.replace(/<!--[\s\S]*?-->/g, "");
  const open = svg.match(/<svg\b[^>]*>/);
  if (!open) throw new Error("SVG の形になっていません");
  if (/<script|<style|\sstyle=|\son[a-z]+=|<foreignObject|<image\b/i.test(svg)) throw new Error("SVG に、スクリプト・style・イベント・別の画像が入っています");
  if (/\s(?:xlink:)?href="(?!#)[^"]*"/i.test(svg)) throw new Error("SVG に、ファイルの中の場所（#…）以外を指すリンクがあります");
  const num = (name: string) => {
    const m = open[0].match(new RegExp(`\\s${name}="([0-9.]+)(px)?"`));
    return m ? Number(m[1]) : null;
  };
  const vb = open[0].match(/\sviewBox="\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*"/);
  const width = num("width") ?? (vb ? Number(vb[1]) : null);
  const height = num("height") ?? (vb ? Number(vb[2]) : null);
  if (!width || !height) throw new Error("SVG に、大きさ（width・height か viewBox）がありません");
  return { width: Math.round(width), height: Math.round(height) };
}

export interface BuiltFigures {
  /** 記事の slug ごとの、置いた図の場所と大きさ（RenderOptions.figures） */
  assets: Map<string, FigureAsset>;
  /** dist/ に置くファイル。鍵は dist/ の中の名前 */
  files: Map<string, Uint8Array>;
}

export function buildFigures(articles: readonly Article[] = ARTICLES, dir = FIGURES_DIR): BuiltFigures {
  const assets = new Map<string, FigureAsset>();
  const files = new Map<string, Uint8Array>();
  for (const a of articles) {
    const f = a.figure;
    if (!f) continue;
    const where = `記事 ${a.slug} の図（src/site/figures/${f.file}）`;
    if (!/^[a-z0-9-]+\.(svg|png)$/.test(f.file)) throw new Error(`${where}：名前は英小文字・数字・- と、.svg か .png だけにしてください`);
    if (!f.alt.trim()) throw new Error(`${where}：代わりの文（alt）が空です`);
    const p = path.join(dir, f.file);
    if (!existsSync(p)) throw new Error(`${where}：ファイルがありません`);
    const buf = readFileSync(p);
    const ext = path.extname(f.file);
    let size: { width: number; height: number };
    try {
      size = ext === ".svg" ? svgSize(buf.toString("utf8")) : pngSize(buf);
    } catch (err) {
      throw new Error(`${where}：${err instanceof Error ? err.message : err}`);
    }
    const name = `assets/figures/${path.basename(f.file, ext)}-${createHash("sha256").update(buf).digest("hex").slice(0, 10)}${ext}`;
    files.set(name, buf);
    assets.set(a.slug, { href: `/${name}`, alt: f.alt, ...(f.caption ? { caption: f.caption } : {}), ...size });
  }
  return { assets, files };
}

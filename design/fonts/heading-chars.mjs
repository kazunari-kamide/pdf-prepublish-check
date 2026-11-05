// SPDX-License-Identifier: AGPL-3.0-only
//
// 見出しの書体（Zen Maru Gothic）に入れる字の一覧（design/fonts/heading-chars.txt）を作る・確かめる。
//   npm run fonts:headings   … ビルドしたページ（dist/）の見出しから字を集め、一覧を書き直す（そのあと npm run fonts:build）
//   scripts/check-dist.mjs  … ビルドのたびに、見出しの字が一覧から漏れていないかを確かめる（missingHeadingChars）
//
// 2026-11-05 本人が決定：見出しの書体は、見出しで使う字だけに絞る（Shift_JIS の 7,488 字だと 2 つで約 3.0MB、見出しの字だけだと約 0.11MB）。
// - 集める所：すべての HTML の h1・h2・h3 の中の字
// - いつも入れる字（BASE）：半角の英数と記号・ひらがな・カタカナ・よく使う記号。画面のスクリプトが後から作る見出しでも、仮名と英数は崩れない
// - 一覧にない字は、本文の書体（Noto Sans JP）で出る（@font-face の字の範囲の外になるため。字が消えることはない）
// 通信はしない（ファイルを読んで書くだけ）。

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const HEADING_CHARS_FILE = path.join(ROOT, "design", "fonts", "heading-chars.txt");

/** いつも入れる字 */
export function baseChars() {
  const out = new Set();
  for (let c = 0x20; c <= 0x7e; c++) out.add(String.fromCharCode(c));
  for (let c = 0x3041; c <= 0x3096; c++) out.add(String.fromCodePoint(c)); // ひらがな
  for (let c = 0x30a1; c <= 0x30fa; c++) out.add(String.fromCodePoint(c)); // カタカナ
  for (const ch of "ー、。・「」『』（）！？：；〜…―－✓▲") out.add(ch);
  return out;
}

function listHtml(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listHtml(p));
    else if (p.endsWith(".html")) out.push(p);
  }
  return out.sort();
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** HTML の文から、h1・h2・h3 の中の字を集める */
export function headingCharsOf(html) {
  const out = new Set();
  for (const m of html.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = m[2]
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e]);
    for (const ch of text) if (!/\s/.test(ch)) out.add(ch);
  }
  return out;
}

/** dist/ のすべての HTML の見出しの字 */
export function distHeadingChars(distDir) {
  const out = new Set();
  for (const f of listHtml(distDir)) for (const ch of headingCharsOf(readFileSync(f, "utf8"))) out.add(ch);
  return out;
}

/** 一覧のファイルの字 */
export function listedChars(file = HEADING_CHARS_FILE) {
  return new Set(readFileSync(file, "utf8").replace(/\r?\n/g, ""));
}

/** dist/ の見出しにあって、一覧にない字（並べて返す） */
export function missingHeadingChars(distDir, file = HEADING_CHARS_FILE) {
  const listed = listedChars(file);
  return [...distHeadingChars(distDir)].filter((ch) => !listed.has(ch)).sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
}

/** 字を決まった順に並べ、40 字ずつの行にする */
export function formatChars(set) {
  const all = [...set].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  const lines = [];
  for (let i = 0; i < all.length; i += 40) lines.push(all.slice(i, i + 40).join(""));
  return lines.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}`) {
  const dist = path.join(ROOT, "dist");
  if (!existsSync(dist)) {
    console.error("dist/ がありません。先に npm run build をしてください。");
    process.exit(1);
  }
  const set = baseChars();
  for (const ch of distHeadingChars(dist)) set.add(ch);
  // 前の一覧にあった字は残す（ページを消しても、書体が急に変わらないように）
  if (existsSync(HEADING_CHARS_FILE)) for (const ch of listedChars()) set.add(ch);
  writeFileSync(HEADING_CHARS_FILE, formatChars(set));
  console.log(`書きました：${path.relative(ROOT, HEADING_CHARS_FILE)}（${set.size} 字）。続けて npm run fonts:build をしてください。`);
}

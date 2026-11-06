// SPDX-License-Identifier: AGPL-3.0-only
//
// 本文の書体（Noto Sans JP）の「画面の字の塊」に入れる字の一覧（design/fonts/ui-chars.txt）を作る・確かめる。
//   npm run fonts:ui        … ビルドしたページ（dist/）の HTML・JS・CSS から字を集め、一覧を書き直す（そのあと npm run fonts:build）
//   scripts/check-dist.mjs  … ビルドのたびに、画面の字が一覧から漏れていないかを確かめる（missingUiChars）
//
// 2026-11-06 本人が決定（案 A）：本文の書体を、画面の字の塊と、残りの字の塊（いくつか）に分け、
// CSS の unicode-range で、ページにある字の塊だけをブラウザに読ませる（全部で 7,489 字・約 2.08MB → 最初は画面の字の塊だけ）。
// - 集める所：dist/ の HTML・JS・CSS の字（\uXXXX・\u{XXXXX}・CSS の \XXXX の書き方も字に戻す）
// - Worker の束（*.worker-*.js）は、検出ルールの結果の文（画面に出る）を含むので集める。ただし、文字コードの表（ASCII 以外の字が
//   長く続く並び。64 字以上）は外す（漢字が 1 万字以上入っているが、画面には出さない）。2026-11-06 に、前は束ごと外していて、
//   結果の文の字（例：「組織」の「織」）で残りの塊を余分に読んでいたのを、Chrome で測って見つけて直した
// - 外す所：PDF.js の写し（/pdfjs/・pdf.min・pdf.worker.min）
// - 一覧から漏れた字も、表示は崩れない（残りの塊にあるので、その塊を読み足す）。ただ、最初の表示が重くなるので、ビルドで止める
// 通信はしない（ファイルを読んで書くだけ）。

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const UI_CHARS_FILE = path.join(ROOT, "design", "fonts", "ui-chars.txt");

/** 字を集めないファイル（画面に出さない字が入っているもの） */
export function isSkipped(rel) {
  const r = rel.replace(/\\/g, "/");
  return r.startsWith("pdfjs/") || /(^|\/)pdf(\.worker)?\.min-[^/]*\.m?js$/.test(r);
}

/** Worker の束か（文字コードの表を外してから集める） */
export const isWorkerBundle = (rel) => /(^|\/)[^/]*\.worker-[^/]*\.js$/.test(rel.replace(/\\/g, "/"));

/** 文字コードの表とみなす、ASCII 以外の字が続く長さ */
export const TABLE_RUN = 64;

/** 文字コードの表（ASCII 以外の字が TABLE_RUN 字以上続く並び）を外す */
export function withoutTables(text) {
  return text.replace(new RegExp(`[^\\x00-\\x7f]{${TABLE_RUN},}`, "g"), "");
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else if (/\.(html|m?js|css)$/.test(name) && !isSkipped(path.relative(base, p))) out.push(p);
  }
  return out.sort();
}

/** 文の中の字を集める。エスケープした書き方も字に戻す */
export function charsOf(text) {
  const out = new Set();
  const add = (cp) => {
    if (cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) out.add(String.fromCodePoint(cp));
  };
  for (const ch of text) add(ch.codePointAt(0));
  for (const m of text.matchAll(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g)) add(parseInt(m[1] ?? m[2], 16));
  for (const m of text.matchAll(/\\([0-9a-fA-F]{4,6})(?![0-9a-fA-F])/g)) add(parseInt(m[1], 16)); // CSS の content: "\25B6" など
  for (const m of text.matchAll(/&#x([0-9a-fA-F]+);|&#(\d+);/g)) add(m[1] ? parseInt(m[1], 16) : parseInt(m[2], 10));
  return out;
}

/** dist/ の画面の字（書体に入っているかは問わない） */
export function distUiChars(distDir) {
  const out = new Set();
  for (const f of listFiles(distDir)) {
    const text = readFileSync(f, "utf8");
    for (const ch of charsOf(isWorkerBundle(path.relative(distDir, f)) ? withoutTables(text) : text)) out.add(ch);
  }
  return out;
}

/** 一覧のファイルの字 */
export function listedUiChars(file = UI_CHARS_FILE) {
  return new Set(readFileSync(file, "utf8").replace(/\r?\n/g, ""));
}

/** dist/ の画面にあって、本文の書体にはあるのに、一覧にない字（並べて返す） */
export function missingUiChars(distDir, fontChars, file = UI_CHARS_FILE) {
  const listed = listedUiChars(file);
  return [...distUiChars(distDir)].filter((ch) => fontChars.has(ch) && !listed.has(ch)).sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
}

/** 字を決まった順に並べ、40 字ずつの行にする */
export function formatChars(set) {
  const all = [...set].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  const lines = [];
  for (let i = 0; i < all.length; i += 40) lines.push(all.slice(i, i + 40).join(""));
  return lines.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}`) {
  const { shiftJisChars } = await import("./chars.mjs");
  const dist = path.join(ROOT, "dist");
  if (!existsSync(dist)) {
    console.error("dist/ がありません。先に npm run build をしてください（一覧が古くて止まるときは、npx vite build だけをしてから）。");
    process.exit(1);
  }
  const font = new Set(shiftJisChars());
  const set = new Set([...distUiChars(dist)].filter((ch) => font.has(ch)));
  // 前の一覧にあった字は残す（画面の文を消しても、塊が急に変わらないように）
  if (existsSync(UI_CHARS_FILE)) for (const ch of listedUiChars()) if (font.has(ch)) set.add(ch);
  writeFileSync(UI_CHARS_FILE, formatChars(set));
  console.log(`書きました：${path.relative(ROOT, UI_CHARS_FILE)}（${set.size} 字）。続けて npm run fonts:build をしてください。`);
}

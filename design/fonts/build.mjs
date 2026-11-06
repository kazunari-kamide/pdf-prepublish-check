// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面の書体を、使う字だけに絞って作る（2026-11-05 本人が決定：元のファイルをリポジトリに入れ、ここから作る）。
//   本文：Noto Sans JP（400〜700）。見出し：Zen Maru Gothic の Bold（700）と Black（900）（2026-11-05 夜、案 C で本人が決定）
//   npm run fonts:build   … src/assets/fonts/ と design/fonts.css の本文の書体の @font-face を作り直す
//   npm run fonts:check   … 作り直したものが、リポジトリのものと1バイトも違わないかを確かめる（再現できるビルド。CLAUDE.md §11-4）
//
// - 元：design/fonts/source/NotoSansJP[wght].ttf と design/fonts/source/zen-maru-gothic/（google/fonts の固定したコミットのもの。出どころと SHA-256 は design/fonts/README.md）
// - 道具：subset-font（npm。版は package-lock.json で固定）。中で harfbuzz（harfbuzzjs）が字を絞り、WOFF2 に包む
// - 字：本文（Noto Sans JP）は、Shift_JIS で書ける字と画面で使う記号（design/fonts/chars.mjs）。
//   2026-11-06（案 A）から、画面の字の塊（design/fonts/ui-chars.txt）と、残りの字の塊（REST_CHUNKS 個）に分けて作り、
//   design/fonts.css に、塊ごとの @font-face（unicode-range つき）を書く。ブラウザは、ページにある字の塊だけを読む。
//   見出し（Zen Maru Gothic）は、見出しで使う字だけ（design/fonts/heading-chars.txt。npm run fonts:headings で作る）。
//   字の並びは決まった順に作るので、同じ元・同じ一覧と同じ道具からは、同じファイルができる
// - 太さ：Noto Sans JP は画面で使う 400〜700 だけを残す（可変のまま、範囲を狭める）。Zen Maru Gothic は太さごとのファイルなので、そのまま
// - ライセンスと著作権の欄（name の 0〜14）は残す（SIL OFL 1.1 の決まり。OFL.txt も一緒に配る）
// - 予約された名前（Reserved Font Name）は、Noto Sans JP は「Source」（書体の名前に入っていないので、名前は変えない）。Zen Maru Gothic はなし
// 通信はしない（ファイルを読んで書くだけ）。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import subsetFont from "subset-font";
import { chunkRanges, notoChunks } from "./chars.mjs";
import { listedUiChars, UI_CHARS_FILE } from "./ui-chars.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(ROOT, "design", "fonts", "source");
const OUT_DIR = path.join(ROOT, "src", "assets", "fonts");
const FONTS_CSS = path.join(ROOT, "design", "fonts.css");

/** 本文の書体の元（sha256 は元のファイルの SHA-256。design/fonts/README.md と同じ。違えば止める） */
const NOTO = {
  source: path.join(SRC, "NotoSansJP[wght].ttf"),
  sha256: "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f",
  license: { from: path.join(SRC, "OFL.txt"), to: "OFL.txt" },
  axes: { wght: { min: 400, max: 700, default: 400 } },
};

/** 本文の書体の塊のファイルの名前（src/assets/fonts/ の中） */
export const notoFile = (id) => `NotoSansJP-${id}.woff2`;

/** 作るもの */
export function jobs() {
  const chunks = notoChunks(listedUiChars(UI_CHARS_FILE));
  return [
    ...chunks.map((c) => ({ ...NOTO, out: notoFile(c.id), text: c.chars, chunk: c })),
    {
      source: path.join(SRC, "zen-maru-gothic", "ZenMaruGothic-Bold.ttf"),
      sha256: "fe24426b9c8b5523a0146a8235c8674eccf0493af354a53ec895c3596d9eb745",
      out: "zen-maru-gothic/ZenMaruGothic-Bold-subset.woff2",
      license: { from: path.join(SRC, "zen-maru-gothic", "OFL.txt"), to: "zen-maru-gothic/OFL.txt" },
      text: headingChars(),
    },
    {
      source: path.join(SRC, "zen-maru-gothic", "ZenMaruGothic-Black.ttf"),
      sha256: "6bd74fe76cd39ee0ec18775c3661d845343fb3f6f8fa09a3076638417baf741f",
      out: "zen-maru-gothic/ZenMaruGothic-Black-subset.woff2",
      license: { from: path.join(SRC, "zen-maru-gothic", "OFL.txt"), to: "zen-maru-gothic/OFL.txt" },
      text: headingChars(),
    },
  ];
}

/**
 * 見出しの書体（Zen Maru Gothic）に入れる字の一覧（2026-11-05 本人が決定：見出しで使う字だけに絞る）。
 * 中身は npm run fonts:headings が、ビルドしたページの見出しから集めて書く（design/fonts/heading-chars.mjs）。
 * 一覧はリポジトリに入れるので、同じ一覧と同じ元からは、同じファイルができる
 */
export const HEADING_CHARS = path.join(ROOT, "design", "fonts", "heading-chars.txt");

/** 元の書体の SHA-256（前からの名前。Noto Sans JP） */
export const SOURCE_SHA256 = NOTO.sha256;

const sha = (b) => createHash("sha256").update(b).digest("hex");

async function build(job) {
  const src = readFileSync(job.source);
  if (sha(src) !== job.sha256) throw new Error(`元の書体のファイルが、決めたものと違います（SHA-256 が合いません）：${path.relative(ROOT, job.source)}`);
  const opts = { targetFormat: "woff2", preserveNameIds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] };
  if (job.axes) opts.variationAxes = job.axes;
  return subsetFont(src, job.text, opts);
}

/** 見出しの字の一覧を読む（1 行目からの字をつなぐ。改行は字に入れない） */
export function headingChars() {
  const t = readFileSync(HEADING_CHARS, "utf8").replace(/\r?\n/g, "");
  return [...new Set(t)].sort((a, b) => a.codePointAt(0) - b.codePointAt(0)).join("");
}

// design/fonts.css の中で、このスクリプトが書く所（本文の書体の @font-face）
const BEGIN = "/* ここから：本文の書体の塊（npm run fonts:build が書く。手で直さない） */";
const END = "/* ここまで：本文の書体の塊 */";

/** 本文の書体の @font-face を、塊ごとに書く */
export function notoFaces(noto) {
  const ranges = chunkRanges(noto.map((j) => j.chunk));
  const faces = noto.map(
    (j) => `@font-face {
  font-family: "Noto Sans JP Omamori";
  src: url("../src/assets/fonts/${j.out}") format("woff2");
  font-weight: 400 700;
  font-style: normal;
  font-display: swap;
  unicode-range: ${ranges[j.chunk.id]};
}`,
  );
  return [BEGIN, ...faces, END].join("\n\n");
}

/** design/fonts.css の、書く所を差し替えた中身（改行は LF にそろえて返す） */
function withFaces(css, faces) {
  const t = css.replace(/\r\n/g, "\n");
  const a = t.indexOf(BEGIN);
  const b = t.indexOf(END);
  if (a < 0 || b < a) throw new Error("design/fonts.css に、本文の書体を書く所の印がありません");
  return t.slice(0, a) + faces + t.slice(b + END.length);
}

const check = process.argv.includes("--check");
let bad = false;
const all = jobs();
const noto = all.filter((j) => j.chunk);
const expectedFiles = new Set(noto.map((j) => j.out));
const staleNoto = () => readdirSync(OUT_DIR).filter((f) => /^NotoSansJP-.*\.woff2$/.test(f) && !expectedFiles.has(f));
let total = 0;
for (const job of all) {
  const out = await build(job);
  if (job.chunk) total += out.length;
  const outPath = path.join(OUT_DIR, job.out);
  const licPath = path.join(OUT_DIR, job.license.to);
  if (check) {
    let current;
    try {
      current = readFileSync(outPath);
    } catch {
      console.error(`${path.relative(ROOT, outPath)} がありません。npm run fonts:build で作ってください。`);
      bad = true;
      continue;
    }
    const same = sha(current) === sha(out);
    let lic = false;
    try {
      lic = sha(readFileSync(licPath)) === sha(readFileSync(job.license.from));
    } catch {}
    console.log(`${job.out}（${[...job.text].length} 字）`);
    console.log(`  作り直したもの：${out.length} バイト・SHA-256 ${sha(out)}`);
    console.log(`  リポジトリのもの：${current.length} バイト・SHA-256 ${sha(current)}`);
    if (!same || !lic) {
      console.error(!same ? "  違います。元か道具の版が変わったか、手で直したファイルです。" : `  ${job.license.to} が、元のものと違います。`);
      bad = true;
    } else console.log("  同じです（再現できました）。");
  } else {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, out);
    copyFileSync(job.license.from, licPath);
    console.log(`作りました：${path.relative(ROOT, outPath)}（字 ${[...job.text].length} 字・${out.length} バイト・SHA-256 ${sha(out)}）`);
  }
}

// design/fonts.css の本文の書体の @font-face と、使わなくなった塊のファイル
const css = readFileSync(FONTS_CSS, "utf8");
const next = withFaces(css, notoFaces(noto));
if (check) {
  if (css.replace(/\r\n/g, "\n") !== next) {
    console.error("design/fonts.css の本文の書体の @font-face が、作り直したものと違います。npm run fonts:build をしてください。");
    bad = true;
  } else console.log("design/fonts.css の本文の書体の @font-face：同じです。");
  for (const f of staleNoto()) {
    console.error(`src/assets/fonts/${f} は、今の分け方では使いません。npm run fonts:build で消してください。`);
    bad = true;
  }
} else {
  writeFileSync(FONTS_CSS, next);
  for (const f of staleNoto()) {
    rmSync(path.join(OUT_DIR, f));
    console.log(`消しました（今の分け方では使わないため）：src/assets/fonts/${f}`);
  }
  console.log(`書きました：design/fonts.css（本文の書体の塊 ${noto.length} 個・合わせて ${total} バイト）`);
}
if (bad) process.exit(1);

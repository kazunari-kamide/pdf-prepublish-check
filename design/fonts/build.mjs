// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面の書体を、使う字だけに絞って作る（2026-11-05 本人が決定：元のファイルをリポジトリに入れ、ここから作る）。
//   本文：Noto Sans JP（400〜700）。見出し：Zen Maru Gothic の Bold（700）と Black（900）（2026-11-05 夜、案 C で本人が決定）
//   npm run fonts:build   … src/assets/fonts/ に作り直す
//   npm run fonts:check   … 作り直したものが、リポジトリのものと1バイトも違わないかを確かめる（再現できるビルド。CLAUDE.md §11-4）
//
// - 元：design/fonts/source/NotoSansJP[wght].ttf と design/fonts/source/zen-maru-gothic/（google/fonts の固定したコミットのもの。出どころと SHA-256 は design/fonts/README.md）
// - 道具：subset-font（npm。版は package-lock.json で固定）。中で harfbuzz（harfbuzzjs）が字を絞り、WOFF2 に包む
// - 字：本文（Noto Sans JP）は、Shift_JIS で書ける字（JIS X 0208 の字・半角の英数と記号・半角カナ）と、画面で使う記号（下の EXTRA）。
//   見出し（Zen Maru Gothic）は、見出しで使う字だけ（design/fonts/heading-chars.txt。npm run fonts:headings で作る）。
//   字の並びは決まった順に作るので、同じ元・同じ一覧と同じ道具からは、同じファイルができる
// - 太さ：Noto Sans JP は画面で使う 400〜700 だけを残す（可変のまま、範囲を狭める）。Zen Maru Gothic は太さごとのファイルなので、そのまま
// - ライセンスと著作権の欄（name の 0〜14）は残す（SIL OFL 1.1 の決まり。OFL.txt も一緒に配る）
// - 予約された名前（Reserved Font Name）は、Noto Sans JP は「Source」（書体の名前に入っていないので、名前は変えない）。Zen Maru Gothic はなし
// 通信はしない（ファイルを読んで書くだけ）。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import subsetFont from "subset-font";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(ROOT, "design", "fonts", "source");
const OUT_DIR = path.join(ROOT, "src", "assets", "fonts");

/** 作るもの。sha256 は元のファイルの SHA-256（design/fonts/README.md と同じ）。違えば止める */
export const JOBS = [
  {
    source: path.join(SRC, "NotoSansJP[wght].ttf"),
    sha256: "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f",
    out: "NotoSansJP-subset.woff2",
    license: { from: path.join(SRC, "OFL.txt"), to: "OFL.txt" },
    axes: { wght: { min: 400, max: 700, default: 400 } },
  },
  {
    source: path.join(SRC, "zen-maru-gothic", "ZenMaruGothic-Bold.ttf"),
    sha256: "fe24426b9c8b5523a0146a8235c8674eccf0493af354a53ec895c3596d9eb745",
    out: "zen-maru-gothic/ZenMaruGothic-Bold-subset.woff2",
    license: { from: path.join(SRC, "zen-maru-gothic", "OFL.txt"), to: "zen-maru-gothic/OFL.txt" },
    chars: "heading",
  },
  {
    source: path.join(SRC, "zen-maru-gothic", "ZenMaruGothic-Black.ttf"),
    sha256: "6bd74fe76cd39ee0ec18775c3661d845343fb3f6f8fa09a3076638417baf741f",
    out: "zen-maru-gothic/ZenMaruGothic-Black-subset.woff2",
    license: { from: path.join(SRC, "zen-maru-gothic", "OFL.txt"), to: "zen-maru-gothic/OFL.txt" },
    chars: "heading",
  },
];

/**
 * 見出しの書体（Zen Maru Gothic）に入れる字の一覧（2026-11-05 本人が決定：見出しで使う字だけに絞る）。
 * 中身は npm run fonts:headings が、ビルドしたページの見出しから集めて書く（design/fonts/heading-chars.mjs）。
 * 一覧はリポジトリに入れるので、同じ一覧と同じ元からは、同じファイルができる
 */
export const HEADING_CHARS = path.join(ROOT, "design", "fonts", "heading-chars.txt");

/** 元の書体の SHA-256（前からの名前。Noto Sans JP） */
export const SOURCE_SHA256 = JOBS[0].sha256;

/**
 * Shift_JIS にない、画面で使う記号（状態の印・矢印など）。
 * ▶ は「見た所・見なかった所」の開け閉めの印（src/style.css の .coverage-summary .group-head::before）。見出しの書体（Zen Maru Gothic）にない字なので、
 * ここに入れないと OS の書体で出ていた（2026-11-06 に足した）
 */
const EXTRA = "✓▲▶■●◐○－⊘？→…・「」『』（）〜※";

/** Shift_JIS で書ける字を、決まった順に集める */
export function shiftJisChars() {
  const dec = new TextDecoder("shift_jis", { fatal: false });
  const out = new Set();
  for (let b = 0x20; b <= 0x7e; b++) out.add(String.fromCharCode(b));
  for (let b = 0xa1; b <= 0xdf; b++) out.add(dec.decode(new Uint8Array([b])));
  const leads = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xef; b++) leads.push(b);
  for (const lead of leads) {
    for (let t = 0x40; t <= 0xfc; t++) {
      if (t === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([lead, t]));
      if (ch.length === 1 && ch !== "�") out.add(ch);
    }
  }
  for (const ch of EXTRA) out.add(ch);
  return [...out].sort((a, b) => a.codePointAt(0) - b.codePointAt(0)).join("");
}

const sha = (b) => createHash("sha256").update(b).digest("hex");

async function build(job, text) {
  const src = readFileSync(job.source);
  if (sha(src) !== job.sha256) throw new Error(`元の書体のファイルが、決めたものと違います（SHA-256 が合いません）：${path.relative(ROOT, job.source)}`);
  const opts = { targetFormat: "woff2", preserveNameIds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] };
  if (job.axes) opts.variationAxes = job.axes;
  return subsetFont(src, text, opts);
}

/** 見出しの字の一覧を読む（1 行目からの字をつなぐ。改行は字に入れない） */
export function headingChars() {
  const t = readFileSync(HEADING_CHARS, "utf8").replace(/\r?\n/g, "");
  return [...new Set(t)].sort((a, b) => a.codePointAt(0) - b.codePointAt(0)).join("");
}

const check = process.argv.includes("--check");
let bad = false;
for (const job of JOBS) {
  const text = job.chars === "heading" ? headingChars() : shiftJisChars();
  const out = await build(job, text);
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
    console.log(`${job.out}`);
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
    console.log(`作りました：${path.relative(ROOT, outPath)}（字 ${[...text].length} 字・${out.length} バイト・SHA-256 ${sha(out)}）`);
  }
}
if (bad) process.exit(1);

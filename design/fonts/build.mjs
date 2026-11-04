// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面の書体（Noto Sans JP）を、使う字だけに絞って作る（2026-11-05 本人が決定：元のファイルをリポジトリに入れ、ここから作る）。
//   npm run fonts:build   … src/assets/fonts/ に作り直す
//   npm run fonts:check   … 作り直したものが、リポジトリのものと1バイトも違わないかを確かめる（再現できるビルド。CLAUDE.md §11-4）
//
// - 元：design/fonts/source/NotoSansJP[wght].ttf（google/fonts の固定したコミットのもの。出どころと SHA-256 は design/fonts/README.md）
// - 道具：subset-font（npm。版は package-lock.json で固定）。中で harfbuzz（harfbuzzjs）が字を絞り、WOFF2 に包む
// - 字：Shift_JIS で書ける字（JIS X 0208 の字・半角の英数と記号・半角カナ）と、画面で使う記号（下の EXTRA）。
//   字の並びは決まった順に作るので、同じ元と同じ道具からは、同じファイルができる
// - 太さ：画面で使う 400〜700 だけを残す（可変のまま、範囲を狭める）
// - ライセンスと著作権の欄（name の 0〜14）は残す（SIL OFL 1.1 の決まり。OFL.txt も一緒に配る）
// - 予約された名前（Reserved Font Name）は「Source」。書体の名前（Noto Sans JP）には入っていないので、名前は変えない
// 通信はしない（ファイルを読んで書くだけ）。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import subsetFont from "subset-font";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SOURCE = path.join(ROOT, "design", "fonts", "source", "NotoSansJP[wght].ttf");
const LICENSE = path.join(ROOT, "design", "fonts", "source", "OFL.txt");
const OUT_DIR = path.join(ROOT, "src", "assets", "fonts");
const OUT = path.join(OUT_DIR, "NotoSansJP-subset.woff2");
const OUT_LICENSE = path.join(OUT_DIR, "OFL.txt");

/** 元のファイルの SHA-256（design/fonts/README.md と同じ）。違えば止める */
export const SOURCE_SHA256 = "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f";

/** Shift_JIS にない、画面で使う記号（状態の印・矢印など） */
const EXTRA = "✓▲■●◐○－⊘？→…・「」『』（）〜※";

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

async function build() {
  const src = readFileSync(SOURCE);
  if (sha(src) !== SOURCE_SHA256) throw new Error("元の書体のファイルが、決めたものと違います（SHA-256 が合いません）");
  const text = shiftJisChars();
  const out = await subsetFont(src, text, {
    targetFormat: "woff2",
    variationAxes: { wght: { min: 400, max: 700, default: 400 } },
    preserveNameIds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  });
  return { out, chars: [...text].length };
}

const check = process.argv.includes("--check");
const { out, chars } = await build();
if (check) {
  let current;
  try {
    current = readFileSync(OUT);
  } catch {
    console.error(`${path.relative(ROOT, OUT)} がありません。npm run fonts:build で作ってください。`);
    process.exit(1);
  }
  const same = sha(current) === sha(out);
  const lic = sha(readFileSync(OUT_LICENSE)) === sha(readFileSync(LICENSE));
  console.log(`作り直したもの：${out.length} バイト・SHA-256 ${sha(out)}`);
  console.log(`リポジトリのもの：${current.length} バイト・SHA-256 ${sha(current)}`);
  if (!same || !lic) {
    console.error(!same ? "違います。元か道具の版が変わったか、手で直したファイルです。" : "OFL.txt が、元のものと違います。");
    process.exit(1);
  }
  console.log("同じです（再現できました）。");
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, out);
  copyFileSync(LICENSE, OUT_LICENSE);
  console.log(`作りました：${path.relative(ROOT, OUT)}（字 ${chars} 字・${out.length} バイト・SHA-256 ${sha(out)}）`);
}

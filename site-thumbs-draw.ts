// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧のサムネ（案 C。design/sheet.md「案 C」の絵・動き）を、コードから SVG に書き出す（npm run thumbs:draw）。
// - 話題の色の地に、大きく単純な絵を 1 つ。字は入れない
// - 1 つの絵から、16:9（広い画面。320×180）と正方形（狭い画面）の 2 つの切り取りを書く（<名前>.svg と <名前>-sq.svg）
// - 色は design/tokens.css・design/sheet.css にある値だけ（tests/site-thumbs.test.ts で確かめる）
// - 2026-11-05 夜：型 P1〜P12 と「手順」の 13 種類。記事ごとの絵は、あとで足す（足すまでは型ごとの絵を使う。site-thumbs.ts）
// 外の画像は読み込まない。通信はしない（ファイルを書くだけ）。

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const THUMBS_DIR = path.join(import.meta.dirname, "src", "site", "thumbs");

/** 使う色（design/tokens.css・design/sheet.css の値と同じ） */
export const C = {
  ink: "#2b2a28", // 墨 900
  line: "#e2ded6", // 墨 200
  white: "#ffffff",
  beni: "#a3201b", // 紅 700
  beniPale: "#efcfcd", // 紅 200
  midori: "#2f6f5e", // 緑 700
  midoriPale: "#c9ded7", // 緑 200
  topicBeni: "#f2cdc7",
  topicMidori: "#cbe3d8",
  topicKi: "#f2dc98",
  topicAi: "#d2e0ee",
} as const;

/** 型ごとの話題の色（design/sheet.md「案 C」のサムネ） */
export const MOTIF_TOPIC: Record<string, string> = {
  p1: C.topicMidori, // 文書の情報
  p2: C.topicMidori,
  p3: C.topicMidori,
  p4: C.topicMidori,
  p10: C.topicMidori, // 写真の情報
  p5: C.topicKi, // 前の版
  p8: C.topicKi, // 注釈（残った書き込み）
  p9: C.topicKi, // 添付ファイル（入ったままのもの）
  p6: C.topicBeni, // 黒塗り
  p7: C.topicBeni, // 見えない字
  p11: C.topicAi, // フォームの値（仕組みの中の値）
  p12: C.topicAi, // スクリプト
  guide: C.topicAi, // 手順
};

const shadow = `<ellipse cx="160" cy="160" rx="92" ry="9" fill="${C.ink}" opacity="0.08"/>`;
const bar = (x: number, y: number, w: number, fill: string = C.line, h = 8) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`;
const paper = (x: number, y: number, w: number, h: number, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.white}"${extra}/>`;

/** 絵（320×180 の座標。正方形に切り取っても入るよう、x 60〜260 に収める） */
export const MOTIFS: Record<string, string> = {
  // P1 文書の情報：名札（人の形と、欄の線）
  p1: `${paper(92, 40, 136, 102)}<circle cx="130" cy="80" r="17" fill="${C.beni}"/><path d="M106 124c3-17 13-25 24-25s21 8 24 25z" fill="${C.beni}"/>${bar(166, 70, 44, C.midori, 9)}${bar(166, 90, 34, C.midoriPale)}${bar(166, 108, 40, C.midoriPale)}<rect x="148" y="30" width="24" height="16" rx="4" fill="${C.midori}"/>`,
  // P2 XMP：重なった紙と時計（編集の履歴）
  p2: `${paper(124, 54, 104, 96, ' opacity="0.55"')}${paper(110, 42, 104, 96, ' opacity="0.8"')}${paper(96, 30, 104, 96)}<circle cx="148" cy="78" r="28" fill="none" stroke="${C.midori}" stroke-width="8"/><path d="M148 62v17l11 8" fill="none" stroke="${C.beni}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`,
  // P3 ほかの団体の名前：紙と、別の建物の印
  p3: `${paper(82, 30, 104, 120)}${bar(98, 52, 70)}${bar(98, 70, 70)}${bar(98, 88, 46)}<path d="M176 92l40-24 40 24z" fill="${C.midori}"/><rect x="184" y="92" width="64" height="44" fill="${C.white}"/><rect x="194" y="102" width="12" height="34" fill="${C.midoriPale}"/><rect x="226" y="102" width="12" height="34" fill="${C.midoriPale}"/><rect x="178" y="136" width="76" height="8" rx="3" fill="${C.midori}"/>`,
  // P4 保存先の場所：フォルダと、つながる道
  p4: `<path d="M84 54h44l12 14h96a8 8 0 0 1 8 8v62a8 8 0 0 1-8 8H84a8 8 0 0 1-8-8V62a8 8 0 0 1 8-8z" fill="${C.white}"/><path d="M84 54h44l12 14H76v-6a8 8 0 0 1 8-8z" fill="${C.midori}"/><circle cx="116" cy="108" r="7" fill="${C.beni}"/><circle cx="160" cy="108" r="7" fill="${C.midoriPale}"/><circle cx="204" cy="108" r="7" fill="${C.midoriPale}"/><path d="M123 108h30M167 108h30" stroke="${C.midoriPale}" stroke-width="4" stroke-linecap="round"/>`,
  // P5 前の版：点線の前の版が、今の版の下に残る
  p5: `<rect x="132" y="40" width="104" height="120" rx="10" fill="${C.white}" opacity="0.6" stroke="${C.beni}" stroke-width="3" stroke-dasharray="9 7"/>${bar(146, 64, 64, C.beniPale)}${bar(146, 82, 48, C.beniPale)}${paper(88, 22, 104, 120)}${bar(104, 44, 70)}${bar(104, 62, 70)}${bar(104, 80, 50)}`,
  // P6 見せかけの黒塗り：黒い四角の両側から、下の紅の字がはみ出る
  p6: `<g transform="rotate(-6 160 90)">${paper(98, 22, 124, 134)}${bar(116, 44, 70, C.line, 9)}${bar(116, 104, 88)}${bar(116, 122, 60)}${bar(110, 72, 100, C.beni, 9)}<rect x="122" y="62" width="76" height="28" rx="3" fill="${C.ink}" transform="rotate(-5 160 76)"/></g>`,
  // P7 見えない字：紙と、斜めの線の入った目
  p7: `${paper(80, 28, 108, 124)}${bar(96, 50, 74)}${bar(96, 68, 74)}${bar(96, 86, 50)}<path d="M164 102c16-22 60-22 76 0-16 22-60 22-76 0z" fill="${C.white}"/><circle cx="202" cy="102" r="12" fill="${C.ink}"/><path d="M174 128l56-52" stroke="${C.beni}" stroke-width="8" stroke-linecap="round"/>`,
  // P8 注釈：吹き出しの書き込み
  p8: `${paper(70, 40, 100, 116)}${bar(86, 62, 66)}${bar(86, 80, 66)}${bar(86, 98, 40)}<path d="M150 34h96a12 12 0 0 1 12 12v44a12 12 0 0 1-12 12h-58l-20 18v-18h-18a12 12 0 0 1-12-12V46a12 12 0 0 1 12-12z" fill="${C.white}"/>${bar(160, 52, 76, C.beni)}${bar(160, 70, 52, C.beniPale)}`,
  // P9 添付ファイル：紙をとめたクリップと、中の別の紙
  p9: `${paper(92, 34, 120, 120)}${bar(110, 70, 84)}${bar(110, 88, 84)}${bar(110, 106, 54)}${paper(186, 92, 54, 64, ` stroke="${C.beni}" stroke-width="3"`)}${bar(196, 110, 34, C.beniPale, 6)}${bar(196, 124, 24, C.beniPale, 6)}<path d="M128 22v52a12 12 0 0 0 24 0V30a7 7 0 0 0-14 0v40" fill="none" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/>`,
  // P10 写真の情報：写真と、撮った場所の印
  p10: `${paper(80, 36, 150, 108)}<rect x="92" y="48" width="126" height="84" rx="6" fill="${C.midoriPale}"/><path d="M92 132l38-44 28 30 18-18 42 32z" fill="${C.midori}"/><circle cx="196" cy="68" r="10" fill="${C.white}"/><path d="M232 30c-14 0-24 10-24 23 0 17 24 41 24 41s24-24 24-41c0-13-10-23-24-23z" fill="${C.beni}"/><circle cx="232" cy="53" r="8" fill="${C.white}"/>`,
  // P11 フォームの値：入力の欄が並び、1 つに値が残る
  p11: `${paper(84, 28, 152, 128)}<rect x="102" y="48" width="116" height="22" rx="6" fill="${C.white}" stroke="${C.line}" stroke-width="3"/><rect x="102" y="82" width="116" height="22" rx="6" fill="${C.white}" stroke="${C.beni}" stroke-width="3"/>${bar(112, 89, 66, C.beni)}<rect x="102" y="116" width="116" height="22" rx="6" fill="${C.white}" stroke="${C.line}" stroke-width="3"/>`,
  // P12 スクリプト：紙の中で動く仕組み（いなずま）
  p12: `${paper(92, 26, 120, 130)}${bar(110, 48, 84)}${bar(110, 66, 60)}<path d="M168 72l-34 44h24l-10 34 38-48h-24l10-30z" fill="${C.beni}"/>`,
  // 手順：1 つ・2 つの点と、最後の ✓
  guide: `<path d="M86 92H234" stroke="${C.white}" stroke-width="8" stroke-linecap="round"/><circle cx="86" cy="92" r="26" fill="${C.white}"/><circle cx="86" cy="92" r="6" fill="${C.ink}"/><circle cx="160" cy="92" r="26" fill="${C.white}"/><circle cx="150" cy="92" r="6" fill="${C.ink}"/><circle cx="170" cy="92" r="6" fill="${C.ink}"/><circle cx="234" cy="92" r="30" fill="${C.midori}"/><path d="M222 92l9 9 16-18" fill="none" stroke="${C.white}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`,
};

/** 1 つの絵の SVG。sq なら正方形に切り取る */
export function thumbSvg(name: string, sq = false): string {
  const body = MOTIFS[name];
  const bg = MOTIF_TOPIC[name];
  if (!body || !bg) throw new Error(`サムネの絵「${name}」がありません`);
  const [vb, w, h] = sq ? ["48 -22 224 224", 224, 224] : ["0 0 320 180", 320, 180];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${w}" height="${h}" role="img">\n<rect x="-1000" y="-1000" width="2320" height="2180" fill="${bg}"/>\n${shadow}${body}\n</svg>\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  mkdirSync(THUMBS_DIR, { recursive: true });
  for (const name of Object.keys(MOTIFS)) {
    writeFileSync(path.join(THUMBS_DIR, `${name}.svg`), thumbSvg(name));
    writeFileSync(path.join(THUMBS_DIR, `${name}-sq.svg`), thumbSvg(name, true));
  }
  console.log(`書きました：${path.relative(process.cwd(), THUMBS_DIR)}（${Object.keys(MOTIFS).length} 種類 × 2）`);
}

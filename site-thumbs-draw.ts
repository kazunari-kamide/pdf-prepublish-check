// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧のサムネ（案 C。design/sheet.md「案 C」の絵・動き）を、コードから SVG に書き出す（npm run thumbs:draw）。
// - 話題の色の地に、大きく単純な絵を 1 つ。字は入れない
// - 1 つの絵から、16:9（広い画面。320×180）と正方形（狭い画面）の 2 つの切り取りを書く（<名前>.svg と <名前>-sq.svg）
// - 色は design/tokens.css・design/sheet.css にある値だけ（tests/site-thumbs.test.ts で確かめる）
// - 2026-11-05 夜：型 P1〜P12 と「手順」の 13 種類と、記事ごとの 20 種類（地の色は、名前の頭の型・手順の色）
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

/** 絵の地の色。記事ごとの絵（p2-parts-xmp・guide-word など）は、名前の頭（p2・guide）の色を使う */
export function topicOf(name: string): string | undefined {
  return MOTIF_TOPIC[name] ?? MOTIF_TOPIC[name.split("-")[0]!];
}

const shadow = `<ellipse cx="160" cy="160" rx="92" ry="9" fill="${C.ink}" opacity="0.08"/>`;
/** ✓ の丸（済・正しいやり方） */
const check = (cx: number, cy: number, r = 18) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.midori}"/><path d="M${cx - r * 0.42} ${cy}l${r * 0.3} ${r * 0.3} ${r * 0.55}-${r * 0.6}" fill="none" stroke="${C.white}" stroke-width="${r * 0.24}" stroke-linecap="round" stroke-linejoin="round"/>`;
/** × の丸（消したもの・古いもの） */
const cross = (cx: number, cy: number, r = 13) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.beni}"/><path d="M${cx - r * 0.4} ${cy - r * 0.4}l${r * 0.8} ${r * 0.8}M${cx + r * 0.4} ${cy - r * 0.4}l-${r * 0.8} ${r * 0.8}" stroke="${C.white}" stroke-width="${r * 0.26}" stroke-linecap="round"/>`;
/** 右向きの矢印（作り変える・書き出す） */
const arrow = (x1: number, x2: number, y: number) => `<path d="M${x1} ${y}H${x2 - 10}" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/><path d="M${x2} ${y}l-14-9v18z" fill="${C.ink}"/>`;
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
  // ==== 記事ごとの絵（2026-11-05 夜。地の色は、名前の頭の型・手順と同じ）
  // P2 貼り付けた部品の XMP：紙の中の画像に、時計の札が付いている
  "p2-parts-xmp": `${paper(82, 26, 136, 128)}${bar(98, 44, 60)}<rect x="98" y="62" width="104" height="66" rx="6" fill="${C.midoriPale}"/><path d="M98 128l30-34 22 22 14-12 38 24z" fill="${C.midori}"/><circle cx="210" cy="62" r="22" fill="${C.white}"/><circle cx="210" cy="62" r="16" fill="none" stroke="${C.midori}" stroke-width="5"/><path d="M210 53v10l6 5" fill="none" stroke="${C.beni}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  // P5 消したページ：ファイルの箱の中に、× の付いたページが残っている
  "p5-removed-page": `<rect x="70" y="30" width="180" height="120" rx="14" fill="none" stroke="${C.white}" stroke-width="6"/>${paper(88, 46, 64, 88)}${bar(100, 62, 40)}${bar(100, 78, 40)}${bar(100, 94, 26)}<rect x="168" y="46" width="64" height="88" rx="10" fill="${C.white}" opacity="0.6" stroke="${C.beni}" stroke-width="3" stroke-dasharray="8 6"/>${bar(180, 62, 40, C.beniPale)}${bar(180, 78, 30, C.beniPale)}${cross(232, 46)}`,
  // P5 縮小画像：今のページと、古い中身のままの小さな見本
  "p5-thumbnail": `${paper(72, 24, 106, 130)}${bar(88, 46, 72)}${bar(88, 64, 72)}${bar(88, 82, 48)}<path d="M182 92h18" stroke="${C.white}" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 8"/>${paper(204, 64, 50, 62)}${bar(212, 78, 34, C.beni, 6)}${bar(212, 90, 34, C.beni, 6)}${bar(212, 102, 22, C.beni, 6)}${cross(250, 64, 11)}`,
  // P6 白い四角：白い四角を重ねた下から、紅の字がはみ出る
  "p6-white-box": `<g transform="rotate(-5 160 90)">${paper(96, 22, 128, 134)}${bar(114, 44, 70)}${bar(110, 76, 104, C.beni, 9)}<rect x="122" y="64" width="80" height="32" rx="3" fill="${C.white}" stroke="${C.ink}" stroke-width="2.5" stroke-dasharray="6 5"/>${bar(114, 112, 88)}${bar(114, 130, 56)}</g>`,
  // P6 適用していない墨消し：紅の枠の印だけで、下の字がそのまま見える
  "p6-unapplied-redaction": `${paper(86, 22, 128, 134)}${bar(104, 44, 70)}<rect x="98" y="64" width="104" height="30" rx="4" fill="${C.beniPale}" opacity="0.6" stroke="${C.beni}" stroke-width="3.5"/>${bar(106, 75, 88, C.ink, 8)}${bar(104, 112, 86)}${bar(104, 130, 54)}<circle cx="226" cy="58" r="18" fill="${C.white}" stroke="${C.beni}" stroke-width="5"/>`,
  // P7 OCR の層：スキャンした紙の上に、透けた字の層が重なる
  "p7-ocr-layer": `<rect x="80" y="40" width="120" height="116" rx="8" fill="${C.line}"/><rect x="94" y="56" width="74" height="9" rx="2" fill="${C.ink}" opacity="0.45"/><rect x="94" y="76" width="88" height="9" rx="2" fill="${C.ink}" opacity="0.45"/><rect x="94" y="96" width="60" height="9" rx="2" fill="${C.ink}" opacity="0.45"/><rect x="118" y="22" width="122" height="116" rx="8" fill="${C.white}" opacity="0.55" stroke="${C.beni}" stroke-width="3" stroke-dasharray="8 6"/>${bar(134, 42, 74, C.beni)}${bar(134, 62, 88, C.beni)}${bar(134, 82, 60, C.beni)}`,
  // P7 しおり：左の目次（しおり）と、紅のリボン
  "p7-bookmark-title": `<rect x="64" y="28" width="70" height="124" rx="8" fill="${C.white}" opacity="0.7"/>${bar(74, 44, 50, C.beni)}${bar(80, 62, 44)}${bar(80, 80, 44)}${bar(74, 98, 50)}${paper(146, 28, 110, 124)}${bar(162, 50, 70)}${bar(162, 68, 70)}${bar(162, 86, 46)}<path d="M232 28v46l-12-10-12 10V28z" fill="${C.beni}"/>`,
  // P7 代わりの説明：画像と、その下に隠れた説明の吹き出し
  "p7-alt-text": `${paper(78, 22, 150, 96)}<rect x="90" y="34" width="126" height="72" rx="6" fill="${C.beniPale}"/><path d="M90 106l34-38 24 24 16-14 52 28z" fill="${C.beni}" opacity="0.7"/><path d="M100 128h142a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H112l-12 10v-10a8 8 0 0 1-8-8v-12a8 8 0 0 1 8-8z" fill="${C.white}"/>${bar(108, 138, 92, C.beni)}`,
  // P7 切り抜いた写真の外側：切り抜きの枠の外にも、写真が続いている
  "p7-hidden-image": `<rect x="64" y="26" width="192" height="128" rx="8" fill="${C.beniPale}" opacity="0.7"/><path d="M64 154l58-66 40 40 26-24 68 50z" fill="${C.beni}" opacity="0.35"/>${paper(110, 52, 100, 76)}<rect x="116" y="58" width="88" height="64" rx="4" fill="${C.beniPale}"/><path d="M116 122l30-30 20 18 12-10 26 22z" fill="${C.beni}"/><path d="M104 46h18M104 46v18M216 46h-18M216 46v18M104 134h18M104 134v-18M216 134h-18M216 134v-18" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/>`,
  // P8 注釈を付けた人：吹き出しと、付けた人の顔
  "p8-annotation-author": `${paper(64, 46, 100, 108)}${bar(80, 66, 66)}${bar(80, 84, 66)}${bar(80, 102, 40)}<path d="M150 30h88a12 12 0 0 1 12 12v40a12 12 0 0 1-12 12h-52l-18 16v-16h-18a12 12 0 0 1-12-12V42a12 12 0 0 1 12-12z" fill="${C.white}"/>${bar(160, 48, 66, C.beniPale)}${bar(160, 64, 44, C.beniPale)}<circle cx="226" cy="124" r="22" fill="${C.white}"/><circle cx="226" cy="118" r="7" fill="${C.beni}"/><path d="M212 136c2-8 8-11 14-11s12 3 14 11z" fill="${C.beni}"/>`,
  // P9 添付の中の添付：紙の中の紙の中に、さらに紙
  "p9-attachment-inside": `${paper(72, 24, 176, 132)}${bar(88, 40, 60)}<rect x="104" y="58" width="128" height="88" rx="8" fill="${C.white}" stroke="${C.line}" stroke-width="4"/>${bar(116, 70, 46)}<rect x="150" y="84" width="70" height="52" rx="6" fill="${C.white}" stroke="${C.beni}" stroke-width="3"/>${bar(160, 96, 40, C.beniPale, 6)}${bar(160, 108, 28, C.beniPale, 6)}<path d="M96 14v40a10 10 0 0 0 20 0V20a6 6 0 0 0-12 0v30" fill="none" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/>`,
  // P10 写真の中の小さな見本：塗った写真と、塗る前のままの小さな見本
  "p10-photo-thumbnail": `${paper(66, 28, 132, 100)}<rect x="76" y="38" width="112" height="80" rx="5" fill="${C.midoriPale}"/><path d="M76 118l32-38 24 26 14-12 42 24z" fill="${C.midori}"/><rect x="128" y="50" width="48" height="26" rx="3" fill="${C.ink}"/>${paper(196, 92, 62, 50)}<rect x="202" y="98" width="50" height="38" rx="3" fill="${C.midoriPale}"/><path d="M202 136l14-16 11 11 6-5 19 10z" fill="${C.midori}"/><circle cx="238" cy="108" r="6" fill="${C.beni}"/>${cross(254, 92, 11)}`,
  // P11 見えない欄：見えている欄の下に、点線の見えない欄があり、値が残る
  "p11-hidden-field": `${paper(84, 24, 152, 132)}<rect x="102" y="42" width="116" height="22" rx="6" fill="${C.white}" stroke="${C.line}" stroke-width="3"/><rect x="102" y="76" width="116" height="22" rx="6" fill="${C.white}" stroke="${C.line}" stroke-width="3"/><rect x="102" y="114" width="116" height="24" rx="6" fill="${C.beniPale}" opacity="0.5" stroke="${C.beni}" stroke-width="3" stroke-dasharray="7 5"/>${bar(112, 122, 60, C.beni)}`,
  // 手順：Word の書類 → PDF（✓）
  "guide-word": `${paper(66, 36, 84, 108)}<rect x="66" y="36" width="84" height="22" rx="10" fill="${C.midoriPale}"/>${bar(78, 72, 60)}${bar(78, 88, 60)}${bar(78, 104, 40)}${arrow(158, 186, 90)}${paper(192, 36, 66, 88)}${bar(202, 54, 46, C.ink)}${bar(202, 70, 46)}${bar(202, 86, 30)}${check(242, 124)}`,
  // 手順：Excel の表 → PDF（✓）
  // P6 黒塗りのそばの記号：塗った宛先の上に、紅の細い線の並びが残る（架空の並び）
  "p6-barcode-near-redaction": `${paper(86, 22, 148, 134)}${Array.from({ length: 22 }, (_, i) => {
    const [y, h] = ([[0, 16], [0, 11], [5, 11], [4, 7]] as const)[(i * 7 + (i >> 2)) % 4]!;
    return `<rect x="${102 + i * 5.4}" y="${40 + y}" width="2.6" height="${h}" fill="${C.beni}"/>`;
  }).join("")}<rect x="100" y="64" width="120" height="34" rx="3" fill="${C.ink}"/>${bar(104, 114, 96)}${bar(104, 132, 60)}`,
  // P6 同じ書式のページの塗り残し：同じ書式の 2 枚で、左は黒く塗り、右は紅の字が見えている
  "p6-cross-page-redaction": `${paper(70, 30, 86, 118)}${bar(82, 46, 50)}<rect x="80" y="64" width="66" height="18" rx="3" fill="${C.ink}"/>${bar(82, 98, 62)}${bar(82, 114, 40)}${paper(166, 30, 86, 118, ` stroke="${C.beni}" stroke-width="3"`)}${bar(178, 46, 50)}${bar(178, 69, 62, C.beni, 9)}${bar(178, 98, 62)}${bar(178, 114, 40)}`,
  // P6 塗った字がほかの所に出ている：上の行は黒く塗り、下の行に同じ紅の字が出ている
  "p6-redacted-text-elsewhere": `${paper(86, 22, 148, 134)}${bar(102, 42, 40)}<rect x="146" y="36" width="56" height="20" rx="3" fill="${C.ink}"/>${bar(102, 72, 112)}${bar(102, 92, 30)}${bar(136, 92, 56, C.beni, 9)}${bar(102, 112, 104)}${bar(102, 132, 70)}`,
  "guide-excel": `${paper(62, 36, 92, 108)}<path d="M62 64h92M62 88h92M62 112h92M92 36v108M122 36v108" stroke="${C.midoriPale}" stroke-width="4"/>${arrow(162, 188, 90)}${paper(194, 36, 64, 88)}<path d="M202 54h48M202 70h48M202 86h48M218 46v48M234 46v48" stroke="${C.line}" stroke-width="3"/>${check(242, 124)}`,
  // 手順：一太郎の書類（縦書き）→ PDF（✓）
  "guide-ichitaro": `${paper(62, 30, 92, 116)}${bar(130, 46, 70, C.midoriPale, 8).replace(/width="70" height="8"/, 'width="8" height="84"')}${bar(112, 46, 70, C.line, 8).replace(/width="70" height="8"/, 'width="8" height="84"')}${bar(94, 46, 70, C.line, 8).replace(/width="70" height="8"/, 'width="8" height="60"')}${bar(76, 46, 70, C.line, 8).replace(/width="70" height="8"/, 'width="8" height="72"')}${arrow(162, 188, 90)}${paper(194, 36, 64, 88)}${bar(202, 54, 46, C.ink)}${bar(202, 70, 46)}${bar(202, 86, 30)}${check(242, 124)}`,
  // 手順：Acrobat の墨消し：下の字まで消えた黒い帯と ✓
  "guide-acrobat-redaction": `${paper(86, 22, 128, 134)}${bar(104, 44, 70)}<rect x="104" y="64" width="92" height="26" rx="3" fill="${C.ink}"/>${bar(104, 108, 86)}${bar(104, 126, 54)}${check(214, 128, 22)}`,
  // 手順：スキャナーから出た紙に、正しく黒塗り
  "guide-scan": `<rect x="70" y="92" width="180" height="44" rx="10" fill="${C.ink}"/><rect x="84" y="102" width="152" height="8" rx="4" fill="${C.midoriPale}"/>${paper(100, 26, 120, 76)}${bar(116, 42, 60)}<rect x="116" y="58" width="76" height="16" rx="2" fill="${C.ink}"/>${bar(116, 82, 44)}${check(232, 128, 18)}`,
  // 手順：写真の情報を消してから貼る（場所の印に × → ✓）
  "guide-photo": `${paper(70, 34, 120, 92)}<rect x="80" y="44" width="100" height="72" rx="5" fill="${C.midoriPale}"/><path d="M80 116l28-34 22 22 12-10 38 22z" fill="${C.midori}"/><path d="M168 22c-11 0-19 8-19 18 0 13 19 32 19 32s19-19 19-32c0-10-8-18-19-18z" fill="${C.beni}" opacity="0.35"/>${cross(168, 40, 12)}${arrow(198, 222, 80)}${check(242, 80, 20)}`,
  // 手順：小さくする前に片付ける（大きな紙 → 小さな紙と ✓）
  "guide-shrink": `${paper(60, 28, 100, 124)}${bar(76, 50, 66)}${bar(76, 68, 66)}${bar(76, 86, 42)}${arrow(168, 194, 90)}${paper(202, 62, 52, 64)}${bar(210, 76, 36, C.line, 6)}${bar(210, 88, 36, C.line, 6)}${bar(210, 100, 22, C.line, 6)}${check(250, 124, 16)}`,
};

/** 1 つの絵の SVG。sq なら正方形に切り取る */
export function thumbSvg(name: string, sq = false): string {
  const body = MOTIFS[name];
  const bg = topicOf(name);
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

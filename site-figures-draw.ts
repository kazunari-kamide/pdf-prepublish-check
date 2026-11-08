// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の図（src/site/figures/*.svg）を描く。できた SVG をリポジトリに置き、ビルドは site-figures.ts がそれを写す。
//
//   npm run figures:draw   … 作り直す（node site-figures-draw.ts）
//
// 決まり（src/site/figures/README.md・tests/site-figures-draw.test.ts）：
// - 色は design/tokens.css・design/sheet.css にある値だけ（下の C）。
// - 字は少なく、大きく（24 以上。幅 390px の画面では図の幅が 336px になり、字は約 12.6px。同じ中身は記事の文と代わりの文にある）。
// - 図の中の名前・番号・場所は、すべて架空のもの。実在の団体・人・PDF は使わない。
// - スクリプト・style・別の画像・外へのリンクは入れない（属性だけで描く）。

import { writeFileSync } from "node:fs";
import path from "node:path";

const OUT = path.join(import.meta.dirname, "src", "site", "figures");

/** 使う色（design/tokens.css・design/sheet.css の値） */
export const C = {
  base: "#2b2a28", // --color-base（墨）
  accent: "#a3201b", // --color-accent（紅）
  accentTint: "#f7e9e8", // --color-accent-tint
  ok: "#2f6f5e", // --color-ok（緑）
  okTint: "#e7f0ed", // --color-ok-tint
  surface: "#ffffff", // --color-surface
  sunken: "#efece6", // --color-sunken
  line: "#d9d4ca", // --color-line
  control: "#8a857c", // --color-control-line
  muted: "#57534e", // --color-muted
  ink400: "#b5afa4", // --ink-400
  ink200: "#e2ded6", // --ink-200
  chip: "#f4f2ee", // --color-chip
  focus: "#ffd43d", // --color-focus（付箋の黄）
} as const;

const W = 640;
const H = 360;
const FONT = "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', Meiryo, sans-serif";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------- 部品

/** 字（大きさは 26 以上を基本にする） */
function t(x: number, y: number, s: string, o: { size?: number; color?: string; weight?: number; anchor?: "start" | "middle" | "end" } = {}): string {
  return `<text x="${x}" y="${y}" font-size="${o.size ?? 26}" fill="${o.color ?? C.base}" font-weight="${o.weight ?? 500}" text-anchor="${o.anchor ?? "start"}">${esc(s)}</text>`;
}
/** 紙（ページ） */
function page(x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; dash?: boolean } = {}): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${o.fill ?? C.surface}" stroke="${o.stroke ?? C.control}" stroke-width="2"${o.dash ? ' stroke-dasharray="8 6"' : ""}/>`;
}
/** 本文の字の代わりの線（字は描かない） */
function lines(x: number, y: number, w: number, n: number, o: { gap?: number; color?: string; h?: number } = {}): string {
  const gap = o.gap ?? 22;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`<rect x="${x}" y="${y + i * gap}" width="${i === n - 1 ? Math.round(w * 0.6) : w}" height="${o.h ?? 8}" rx="4" fill="${o.color ?? C.line}"/>`);
  return out.join("");
}
function box(x: number, y: number, w: number, h: number, fill: string, o: { rx?: number; stroke?: string; dash?: boolean; sw?: number } = {}): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 0}" fill="${fill}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 3}"` : ""}${o.dash ? ' stroke-dasharray="8 6"' : ""}/>`;
}
/** 札（紅＝危ない所、緑＝片付いた所、墨＝ふつう） */
function tag(x: number, y: number, s: string, kind: "danger" | "ok" | "plain" = "danger", size = 24): string {
  const fill = kind === "danger" ? C.accent : kind === "ok" ? C.ok : C.base;
  const w = Math.round([...s].reduce((n, ch) => n + (/[ -~]/.test(ch) ? 0.6 : 1), 0) * size + 28);
  return `<rect x="${x}" y="${y}" width="${w}" height="${size + 18}" rx="${(size + 18) / 2}" fill="${fill}"/>` + t(x + w / 2, y + size + 3, s, { size, color: C.surface, weight: 700, anchor: "middle" });
}
/** 矢印 */
function arrow(x1: number, y1: number, x2: number, y2: number, color: string = C.base): string {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const hx = (d: number, s: number) => (x2 - 16 * Math.cos(a) + s * 9 * Math.sin(a)).toFixed(1) + "," + (y2 - 16 * Math.sin(a) - s * 9 * Math.cos(a)).toFixed(1);
  return `<line x1="${x1}" y1="${y1}" x2="${(x2 - 12 * Math.cos(a)).toFixed(1)}" y2="${(y2 - 12 * Math.sin(a)).toFixed(1)}" stroke="${color}" stroke-width="4" stroke-linecap="round"/><polygon points="${x2},${y2} ${hx(16, 1)} ${hx(16, -1)}" fill="${color}"/>`;
}
/** 欄の表（左に欄の名前、右に値） */
function fields(x: number, y: number, w: number, rows: Array<[string, string, boolean?]>): string {
  const out = [box(x, y, w, rows.length * 48 + 16, C.chip, { rx: 8, stroke: C.line, sw: 2 })];
  rows.forEach(([k, v, bad], i) => {
    const yy = y + 42 + i * 48;
    out.push(t(x + 16, yy, k, { size: 24, color: C.muted }));
    if (bad) out.push(box(x + 100, yy - 30, w - 116, 40, C.accentTint, { rx: 6, stroke: C.accent, sw: 2 }));
    out.push(t(x + 112, yy, v, { size: 26, color: bad ? C.accent : C.base, weight: bad ? 700 : 500 }));
  });
  return out.join("");
}
/** 写真（山と太陽の絵） */
function photo(x: number, y: number, w: number, h: number): string {
  return (
    box(x, y, w, h, C.okTint, { stroke: C.control, sw: 2 }) +
    `<circle cx="${x + w * 0.75}" cy="${y + h * 0.3}" r="${Math.min(w, h) * 0.1}" fill="${C.ink400}"/>` +
    `<polygon points="${x},${y + h} ${x + w * 0.35},${y + h * 0.4} ${x + w * 0.6},${y + h * 0.75} ${x + w * 0.75},${y + h * 0.55} ${x + w},${y + h}" fill="${C.ok}"/>`
  );
}
/** 位置の印 */
function pin(cx: number, cy: number, color: string = C.accent): string {
  return `<path d="M${cx} ${cy + 30} C${cx - 4} ${cy + 18} ${cx - 18} ${cy + 8} ${cx - 18} ${cy - 6} A18 18 0 1 1 ${cx + 18} ${cy - 6} C${cx + 18} ${cy + 8} ${cx + 4} ${cy + 18} ${cx} ${cy + 30} Z" fill="${color}"/><circle cx="${cx}" cy="${cy - 6}" r="7" fill="${C.surface}"/>`;
}
/** ファイルの形（右上を折った紙）と、拡張子の札 */
function file(x: number, y: number, w: number, h: number, label: string, color: string = C.base): string {
  return (
    `<path d="M${x} ${y} H${x + w - 24} L${x + w} ${y + 24} V${y + h} H${x} Z" fill="${C.surface}" stroke="${color}" stroke-width="3"/>` +
    `<path d="M${x + w - 24} ${y} V${y + 24} H${x + w}" fill="none" stroke="${color}" stroke-width="3"/>` +
    box(x + 10, y + h - 44, w - 20, 32, color, { rx: 4 }) +
    t(x + w / 2, y + h - 19, label, { size: 24, color: C.surface, weight: 700, anchor: "middle" })
  );
}
/** 吹き出し（注釈） */
function bubble(x: number, y: number, w: number, h: number, fill: string = C.accentTint, stroke: string = C.accent): string {
  return `<path d="M${x} ${y + 8} Q${x} ${y} ${x + 8} ${y} H${x + w - 8} Q${x + w} ${y} ${x + w} ${y + 8} V${y + h - 8} Q${x + w} ${y + h} ${x + w - 8} ${y + h} H${x + 40} L${x + 18} ${y + h + 22} L${x + 22} ${y + h} H${x + 8} Q${x} ${y + h} ${x} ${y + h - 8} Z" fill="${fill}" stroke="${stroke}" stroke-width="3"/>`;
}
/** 虫めがね */
function lens(cx: number, cy: number, r = 34): string {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.base}" stroke-width="6"/><line x1="${cx + r * 0.7}" y1="${cy + r * 0.7}" x2="${cx + r * 1.5}" y2="${cy + r * 1.5}" stroke="${C.base}" stroke-width="10" stroke-linecap="round"/>`;
}
/** 手順の番号の丸 */
function step(cx: number, cy: number, n: number): string {
  return `<circle cx="${cx}" cy="${cy}" r="20" fill="${C.base}"/>` + t(cx, cy + 8, String(n), { size: 24, color: C.surface, weight: 700, anchor: "middle" });
}
const check = (x: number, y: number, color: string = C.ok) => `<path d="M${x} ${y} l12 12 l24 -26" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
const cross = (x: number, y: number, color: string = C.accent) => `<path d="M${x} ${y} l26 26 M${x + 26} ${y} l-26 26" stroke="${color}" stroke-width="7" stroke-linecap="round"/>`;

function svg(title: string, body: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${esc(FONT)}" role="img">`,
    `<title>${esc(title)}</title>`,
    // 外枠は描かない（枠は使う側の CSS だけが描く。札の縁・記事の図の枠と二重にならないように。site.css）
    `<rect width="${W}" height="${H}" fill="${C.surface}"/>`,
    body,
    `</svg>`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- 図（記事の slug ごと）

/** slug → [図の題（SVG の title）, 中身] */
export const FIGURES: Record<string, () => [string, string]> = {
  "p1-docinfo": () => [
    "見た目の本文とは別に、文書情報の作成者の欄に名前が残る",
    page(40, 40, 180, 280) + lines(64, 80, 132, 8) + arrow(236, 180, 284, 180, C.control) +
      fields(284, 72, 324, [["題", "会議資料"], ["作成者", "架空 花子", true], ["ソフト", "ワープロ"]]) +
      tag(284, 268, "ファイルの情報に残る"),
  ],
  "p2-xmp": () => [
    "XMP の中に、編集の履歴が何回分も残る",
    page(40, 40, 180, 280) + lines(64, 80, 132, 8) + arrow(236, 180, 284, 180, C.control) +
      t(300, 76, "XMP の中", { size: 26, weight: 700 }) +
      [0, 1, 2].map((i) => box(300, 96 + i * 62, 300, 48, i === 2 ? C.accentTint : C.chip, { rx: 8, stroke: i === 2 ? C.accent : C.line, sw: 2 }) + t(316, 128 + i * 62, `編集 ${i + 1} 回目`, { size: 24, color: i === 2 ? C.accent : C.muted })).join("") +
      tag(300, 288, "前の作業の記録"),
  ],
  "p2-parts-xmp": () => [
    "貼り付けた画像に、ページとは別の XMP が付いたまま残る",
    page(40, 40, 260, 280) + lines(64, 72, 212, 3) + photo(64, 150, 150, 110) +
      arrow(220, 176, 340, 120, C.accent) + box(340, 70, 260, 120, C.accentTint, { rx: 10, stroke: C.accent }) +
      t(360, 112, "画像の XMP", { size: 26, weight: 700, color: C.accent }) + t(360, 160, "作った人・機種", { size: 24, color: C.base }) +
      tag(340, 232, "部品ごとに残る"),
  ],
  "p3-foreign-org": () => [
    "流用した様式の題に、ほかの団体の名前が残る",
    page(40, 40, 180, 280) + box(60, 64, 140, 20, C.base) + lines(64, 110, 132, 7) + arrow(236, 180, 284, 180, C.control) +
      fields(284, 72, 324, [["題", "架空町の様式", true], ["作成者", "総務の係"]]) + tag(284, 220, "元の団体の名前"),
  ],
  "p4-internal-path": () => [
    "ファイルの中に、作ったパソコンの保存先のパスが残る",
    page(40, 40, 180, 280) + lines(64, 80, 132, 8) + arrow(236, 180, 284, 180, C.control) +
      box(296, 96, 304, 120, C.chip, { rx: 8, stroke: C.line, sw: 2 }) + t(312, 136, "保存先", { size: 24, color: C.muted }) +
      box(312, 152, 272, 44, C.accentTint, { rx: 6, stroke: C.accent, sw: 2 }) + t(324, 183, "C:\\…\\kasou\\資料", { size: 24, color: C.accent, weight: 700 }) +
      tag(296, 240, "利用者の名前が入る"),
  ],
  "p5-revisions": () => [
    "上書きしても、直す前の版がファイルの中に重なって残る",
    page(70, 64, 200, 230, { fill: C.accentTint, stroke: C.accent, dash: true }) + lines(94, 90, 150, 3, { color: C.accent }) +
      page(40, 34, 200, 230) + lines(64, 70, 150, 8) + t(140, 334, "今の版の下に前の版", { size: 24, anchor: "middle" }) +
      arrow(290, 150, 340, 150, C.accent) + t(356, 140, "前の版も", { size: 28, weight: 700, color: C.accent }) + t(356, 182, "ファイルに残る", { size: 28, weight: 700, color: C.accent }) +
      tag(356, 230, "末尾に足して保存"),
  ],
  "p5-removed-page": () => [
    "消したページが、どこからも使われない部品としてファイルに残る",
    box(28, 40, 584, 250, C.chip, { rx: 12, stroke: C.line, sw: 2 }) + t(48, 80, "ファイルの中", { size: 24, color: C.muted }) +
      page(60, 100, 130, 160) + lines(78, 126, 94, 5) + t(125, 320, "1", { size: 26, anchor: "middle" }) +
      page(220, 100, 130, 160) + lines(238, 126, 94, 5) + t(285, 320, "2", { size: 26, anchor: "middle" }) +
      page(400, 100, 130, 160, { fill: C.accentTint, stroke: C.accent, dash: true }) + lines(418, 126, 94, 5, { color: C.accent }) + t(465, 320, "消した 3", { size: 26, anchor: "middle", color: C.accent, weight: 700 }),
  ],
  "p5-thumbnail": () => [
    "ページの縮小画像だけが、直す前のページのまま残る",
    page(40, 50, 200, 260) + lines(64, 90, 150, 7) + box(64, 240, 120, 22, C.base) + t(140, 344, "今のページ", { size: 24, anchor: "middle" }) +
      arrow(260, 180, 330, 180, C.control) +
      page(350, 90, 140, 180, { stroke: C.accent }) + lines(368, 116, 104, 6, { color: C.accent, gap: 20 }) + t(420, 314, "縮小画像", { size: 24, anchor: "middle", color: C.accent, weight: 700 }) +
      tag(500, 120, "直す前", "danger"),
  ],
  "p6-fake-redaction": () => [
    "黒い四角は上に重なっているだけで、下の字の層が残っている断面の図",
    t(40, 64, "横から見ると", { size: 26, weight: 700 }) +
      box(80, 110, 300, 34, C.base) + t(400, 136, "黒い四角", { size: 26 }) +
      box(80, 190, 300, 34, C.accentTint, { stroke: C.accent, sw: 2 }) + lines(96, 203, 260, 1, { color: C.accent }) + t(400, 216, "下の字", { size: 26, color: C.accent, weight: 700 }) +
      box(60, 258, 340, 10, C.control) + t(416, 272, "ページ", { size: 24, color: C.muted }) +
      tag(80, 300, "選んでコピーできる"),
  ],
  "p6-white-box": () => [
    "白い四角で隠した下に、字が残っている図",
    page(40, 40, 260, 280) + lines(64, 76, 212, 2) + box(60, 120, 220, 60, C.surface, { stroke: C.accent, dash: true, sw: 3 }) + lines(76, 138, 188, 2, { color: C.accent, gap: 20 }) + lines(64, 210, 212, 4) +
      arrow(316, 150, 360, 150, C.accent) + t(376, 140, "白い四角の下に", { size: 26, weight: 700, color: C.accent }) + t(376, 180, "字が残る", { size: 26, weight: 700, color: C.accent }) +
      tag(376, 220, "見た目は空白", "plain"),
  ],
  "p6-unapplied-redaction": () => [
    "墨消しの印を付けただけで適用していないと、下の字が残る",
    page(40, 40, 230, 280) + lines(64, 76, 182, 2) + box(60, 120, 190, 44, "none", { stroke: C.accent, sw: 4, dash: true }) + lines(74, 134, 162, 1, { color: C.base }) + lines(64, 200, 182, 4) +
      t(300, 110, "印を付けただけ", { size: 26, weight: 700 }) + cross(300, 140) + t(340, 162, "まだ消えていない", { size: 24, color: C.accent }) +
      check(300, 222) + t(344, 236, "「適用」で消える", { size: 24, color: C.ok, weight: 700 }),
  ],
  "p6-barcode-near-redaction": () => [
    "宛先は黒く塗ったが、すぐ上の細い線が並んだ記号は塗られずに残っている図",
    page(40, 40, 260, 280) +
      Array.from({ length: 36 }, (_, i) => {
        // 架空の 4 種の高さの並び（意味のある値を表していない）
        const [y, h] = ([[0, 24], [0, 16], [8, 16], [6, 10]] as const)[(i * 7 + (i >> 2)) % 4]!;
        return box(64 + i * 6, 78 + y, 3, h, C.accent, { rx: 0 });
      }).join("") +
      box(60, 116, 220, 62, C.base) + lines(64, 210, 212, 4) +
      arrow(316, 92, 360, 92, C.accent) + t(376, 82, "宛先は塗ったが", { size: 26, weight: 700 }) + t(376, 122, "記号が残る", { size: 26, weight: 700, color: C.accent }) +
      tag(376, 160, "郵便のバーコード"),
  ],
  "p6-cross-page-redaction": () => [
    "同じ書式の 2 枚のうち、1 枚目は氏名の欄を塗り、もう 1 枚は同じ欄を塗り忘れている図",
    page(40, 40, 240, 250) + lines(64, 70, 190, 1) + box(60, 108, 200, 30, C.base) + lines(64, 168, 190, 4) + t(160, 330, "1 枚目", { size: 26, anchor: "middle" }) +
      page(360, 40, 240, 250, { stroke: C.accent }) + lines(384, 70, 190, 1) + box(380, 108, 200, 30, C.accentTint, { stroke: C.accent, sw: 3 }) + t(396, 132, "氏名が見える", { size: 24, color: C.accent, weight: 700 }) + lines(384, 168, 190, 4) +
      t(480, 330, "3 枚目：塗り忘れ", { size: 26, anchor: "middle", color: C.accent, weight: 700 }),
  ],
  "p6-redacted-text-elsewhere": () => [
    "ある段落で黒く塗った地名が、下の段落には塗られずに出ている図",
    page(40, 40, 300, 280) + lines(64, 72, 252, 1) + box(64, 100, 96, 28, C.base) + lines(176, 108, 140, 1) + lines(64, 150, 252, 2) +
      box(64, 220, 110, 34, C.accentTint, { rx: 6, stroke: C.accent, sw: 3 }) + t(76, 246, "空見台", { size: 24, color: C.accent, weight: 700 }) + lines(190, 232, 126, 1) + lines(64, 280, 200, 1) +
      t(364, 120, "ここは塗った", { size: 26, weight: 700 }) + arrow(356, 230, 300, 238, C.accent) + t(364, 222, "同じ字が", { size: 26, weight: 700, color: C.accent }) + t(364, 260, "ほかの所に出る", { size: 26, weight: 700, color: C.accent }),
  ],
  "p7-hidden-text": () => [
    "画面には見えない字が、検索やコピーで出てくる",
    page(40, 40, 260, 280) + lines(64, 76, 212, 3) + box(60, 150, 220, 40, C.surface, { stroke: C.ink400, dash: true, sw: 2 }) + lines(64, 230, 212, 3) +
      lens(250, 172) + box(330, 120, 270, 110, C.accentTint, { rx: 10, stroke: C.accent }) + t(350, 160, "検索で見つかる", { size: 26, color: C.accent, weight: 700 }) + t(350, 202, "白い字・小さい字", { size: 24 }),
  ],
  "p7-ocr-layer": () => [
    "スキャンした画像の上に、見えない文字の層が重なっている",
    t(40, 64, "重なっている層", { size: 26, weight: 700 }) +
      `<polygon points="80,110 340,110 410,160 150,160" fill="${C.accentTint}" stroke="${C.accent}" stroke-width="3" stroke-dasharray="8 6"/>` + t(430, 150, "見えない字", { size: 26, color: C.accent, weight: 700 }) +
      `<polygon points="80,200 340,200 410,250 150,250" fill="${C.sunken}" stroke="${C.control}" stroke-width="3"/>` + t(430, 240, "スキャンの画像", { size: 24, color: C.muted }) +
      tag(80, 290, "選ぶと文字が取れる"),
  ],
  "p7-bookmark-title": () => [
    "しおり（目次）の題に、本文にはない古い見出しが残る",
    box(40, 40, 230, 280, C.chip, { rx: 8, stroke: C.line, sw: 2 }) + t(60, 80, "しおり", { size: 24, color: C.muted, weight: 700 }) +
      t(60, 130, "1 はじめに", { size: 24 }) + box(52, 150, 208, 44, C.accentTint, { rx: 6, stroke: C.accent, sw: 2 }) + t(60, 181, "2 案（古い題）", { size: 24, color: C.accent, weight: 700 }) + t(60, 236, "3 まとめ", { size: 24 }) +
      page(300, 40, 300, 280) + lines(324, 76, 252, 9) + tag(320, 270, "本文とは別に保存"),
  ],
  "p7-alt-text": () => [
    "図に付けた代わりの説明に、画面には出ない情報が残る",
    page(40, 40, 250, 280) + photo(64, 70, 200, 140) + lines(64, 240, 200, 3) +
      bubble(320, 70, 280, 120) + t(340, 112, "代わりの説明", { size: 24, color: C.muted }) + t(340, 156, "架空 太郎さんの家", { size: 24, color: C.accent, weight: 700 }) +
      tag(320, 240, "読み上げで聞こえる"),
  ],
  "p7-hidden-image": () => [
    "切り抜いた写真の外側も、ファイルの中に残っている",
    box(60, 60, 360, 240, C.accentTint, { stroke: C.accent, dash: true, sw: 3 }) + t(76, 96, "元の写真ぜんぶ", { size: 24, color: C.accent, weight: 700 }) +
      photo(150, 120, 180, 130) + `<rect x="150" y="120" width="180" height="130" fill="none" stroke="${C.base}" stroke-width="5"/>` +
      t(440, 160, "見えるのは", { size: 24 }) + t(440, 196, "黒い枠の中だけ", { size: 24 }) + tag(440, 230, "外側も残る"),
  ],
  "p8-annotation": () => [
    "確認の途中のコメントが、ページに付いたまま公開される",
    page(40, 40, 260, 280) + lines(64, 76, 212, 10) + `<rect x="230" y="110" width="40" height="40" rx="4" fill="${C.focus}" stroke="${C.base}" stroke-width="2"/>` +
      bubble(320, 70, 280, 130) + t(340, 116, "コメント", { size: 24, color: C.muted }) + t(340, 160, "ここは要確認", { size: 26, color: C.accent, weight: 700 }) +
      tag(320, 250, "中身ごと公開される"),
  ],
  "p8-annotation-author": () => [
    "付箋やコメントに、付けた人の名前が残る",
    page(40, 40, 230, 280) + lines(64, 76, 182, 10) +
      bubble(300, 60, 300, 150, C.chip, C.control) + t(320, 104, "付けた人", { size: 24, color: C.muted }) +
      box(316, 120, 268, 44, C.accentTint, { rx: 6, stroke: C.accent, sw: 2 }) + t(328, 152, "架空 太郎", { size: 26, color: C.accent, weight: 700 }) + t(320, 196, "OK です", { size: 24 }) +
      tag(300, 262, "名前の欄が残る"),
  ],
  "p9-attachment": () => [
    "PDF の中に、元の表計算のファイルが入ったまま残る",
    page(40, 40, 260, 280) + lines(64, 76, 212, 9) + `<path d="M250 40 v-14 a14 14 0 0 1 28 0 v60 a22 22 0 0 1 -44 0 v-44" fill="none" stroke="${C.base}" stroke-width="5" stroke-linecap="round"/>` +
      arrow(316, 180, 370, 180, C.accent) + file(390, 90, 130, 170, "表計算", C.accent) + tag(380, 286, "中身ごと入っている"),
  ],
  "p9-attachment-inside": () => [
    "添付した PDF の中にも、見せかけの黒塗りなどが残る",
    page(40, 40, 260, 280) + lines(64, 76, 212, 9) + arrow(316, 180, 360, 180, C.control) +
      page(380, 60, 200, 230, { stroke: C.accent }) + t(396, 96, "添付の PDF", { size: 24, color: C.accent, weight: 700 }) + lines(400, 120, 160, 2) + box(400, 170, 140, 24, C.base) + lines(400, 220, 160, 2) +
      tag(380, 300, "中も同じに確かめる", "danger", 24),
  ],
  "p10-image-exif": () => [
    "貼った写真に、撮った場所と機種の情報が付いている",
    photo(40, 60, 260, 200) + pin(250, 120) +
      fields(330, 70, 290, [["場所", "北緯…", true], ["機種", "架空カメラ"], ["日時", "撮った日"]]) + tag(40, 288, "写真の中の EXIF"),
  ],
  "p10-photo-thumbnail": () => [
    "写真を塗っても、中の小さな見本に塗る前の絵が残る",
    photo(40, 60, 230, 180) + box(92, 150, 90, 56, C.base) + t(155, 280, "塗った写真", { size: 24, anchor: "middle" }) +
      arrow(290, 150, 340, 150, C.control) +
      box(360, 50, 240, 200, C.accentTint, { rx: 8, stroke: C.accent, dash: true }) + photo(390, 80, 180, 130) + t(480, 290, "中の見本は塗る前", { size: 24, anchor: "middle", color: C.accent, weight: 700 }),
  ],
  "p11-form-value": () => [
    "入力できる PDF の欄に、前に入れた名前や番号が残る",
    page(40, 40, 560, 280) + t(70, 90, "申請書", { size: 28, weight: 700 }) +
      t(70, 148, "名前", { size: 24, color: C.muted }) + box(170, 118, 300, 44, C.accentTint, { rx: 6, stroke: C.accent, sw: 3 }) + t(186, 150, "架空 花子", { size: 26, color: C.accent, weight: 700 }) +
      t(70, 216, "番号", { size: 24, color: C.muted }) + box(170, 186, 300, 44, C.accentTint, { rx: 6, stroke: C.accent, sw: 3 }) + t(186, 218, "0000-1234", { size: 26, color: C.accent, weight: 700 }) +
      tag(70, 252, "前の値が残ったまま"),
  ],
  "p11-hidden-field": () => [
    "表示しない欄や大きさのない欄に、値が残っている",
    page(40, 40, 300, 280) + t(64, 84, "申請書", { size: 26, weight: 700 }) + box(64, 104, 240, 40, C.surface, { rx: 6, stroke: C.control, sw: 2 }) +
      box(64, 170, 240, 40, "none", { rx: 6, stroke: C.accent, sw: 3, dash: true }) + t(76, 199, "見えない欄", { size: 24, color: C.accent }) + lines(64, 240, 240, 3) +
      arrow(356, 190, 400, 190, C.accent) + box(410, 140, 190, 100, C.accentTint, { rx: 8, stroke: C.accent }) + t(426, 180, "値", { size: 24, color: C.muted }) + t(426, 220, "架空 花子", { size: 24, color: C.accent, weight: 700 }),
  ],
  "p12-active-content": () => [
    "開いたときやボタンを押したときに、スクリプトが動いて外へつなぐ",
    page(40, 40, 240, 280) + lines(64, 76, 192, 4) + box(64, 200, 150, 50, C.base, { rx: 8 }) + t(139, 234, "ボタン", { size: 24, color: C.surface, anchor: "middle", weight: 700 }) +
      arrow(296, 180, 380, 180, C.accent) + box(396, 110, 210, 140, C.accentTint, { rx: 10, stroke: C.accent }) + t(416, 160, "スクリプト", { size: 26, color: C.accent, weight: 700 }) + t(416, 204, "外のサイトへ", { size: 24 }) +
      tag(396, 276, "開く前に確かめる"),
  ],
  "guide-word": () => flow("Word で作ってから PDF にするまでの 3 つの段", ["コメント", "PDF にする", "確かめる"], ["消して確定", "書き出す", "残りを見る"]),
  "guide-excel": () => flow("Excel の表を PDF にするまでの 3 つの段", ["隠した列", "PDF にする", "確かめる"], ["表に戻す", "書き出す", "残りを見る"]),
  "guide-ichitaro": () => flow("一太郎の書類を PDF にするまでの 3 つの段", ["文書の情報", "PDF にする", "確かめる"], ["名前を消す", "書き出す", "残りを見る"]),
  "guide-acrobat-redaction": () => [
    "墨消しは、印を付けてから適用し、下の字まで消す",
    [["印を付ける", false], ["適用する", true], ["字が消える", true]]
      .map(([s, done], i) => {
        const x = 30 + i * 204;
        return page(x, 60, 180, 200) + lines(x + 20, 88, 140, 2) +
          (i === 0 ? box(x + 18, 140, 144, 34, "none", { stroke: C.accent, sw: 4, dash: true }) + lines(x + 30, 153, 120, 1, { color: C.base }) : box(x + 18, 140, 144, 34, C.base)) +
          (i === 2 ? check(x + 70, 214) : lines(x + 20, 200, 140, 2)) + step(x + 26, 300, i + 1) + t(x + 56, 309, String(s), { size: 24, weight: 700, color: done && i === 2 ? C.ok : C.base });
      })
      .join(""),
  ],
  "guide-scan": () => [
    "スキャンした書類は、紙の段階で塗ってから読み取る",
    page(40, 50, 170, 220) + lines(60, 80, 130, 2) + box(58, 130, 134, 30, C.base) + lines(60, 190, 130, 3) + t(125, 310, "紙で塗る", { size: 24, anchor: "middle", weight: 700 }) +
      arrow(224, 160, 270, 160, C.control) + box(284, 120, 120, 80, C.sunken, { rx: 10, stroke: C.control, sw: 3 }) + box(296, 104, 96, 18, C.control, { rx: 4 }) + t(344, 310, "読み取る", { size: 24, anchor: "middle", weight: 700 }) +
      arrow(418, 160, 464, 160, C.control) + page(476, 50, 130, 220) + box(492, 70, 98, 180, C.sunken) + box(500, 130, 82, 24, C.base) + check(520, 276) + t(541, 330, "画像だけ", { size: 24, anchor: "middle", color: C.ok, weight: 700 }),
  ],
  "guide-photo": () => [
    "写真は、撮った時の情報を消してから貼る",
    photo(40, 70, 180, 150) + pin(180, 110) + t(130, 270, "撮った写真", { size: 24, anchor: "middle" }) +
      arrow(236, 150, 290, 150, C.control) + box(300, 90, 140, 110, C.okTint, { rx: 10, stroke: C.ok }) + cross(320, 112, C.accent) + t(356, 136, "場所", { size: 24 }) + cross(320, 156, C.accent) + t(356, 180, "機種", { size: 24 }) + t(370, 270, "情報を消す", { size: 24, anchor: "middle", weight: 700 }) +
      arrow(456, 150, 500, 150, C.control) + page(510, 70, 100, 150) + photo(522, 90, 76, 60) + check(534, 196) + t(560, 270, "貼る", { size: 24, anchor: "middle", weight: 700 }),
  ],
  "guide-shrink": () => [
    "ファイルを小さくしても、隠れた情報はそのまま残る",
    file(40, 60, 170, 220, "大きい PDF") + box(60, 100, 130, 30, C.accentTint, { rx: 6, stroke: C.accent, sw: 2 }) + t(72, 124, "作成者", { size: 24, color: C.accent }) +
      arrow(226, 170, 300, 170, C.control) + t(263, 150, "小さく", { size: 24, anchor: "middle", color: C.muted }) +
      file(316, 100, 150, 180, "小さい PDF") + box(330, 136, 102, 30, C.accentTint, { rx: 6, stroke: C.accent, sw: 2 }) + t(340, 160, "作成者", { size: 24, color: C.accent }) +
      tag(486, 150, "残る", "danger", 26) + t(486, 250, "先に消す", { size: 26, weight: 700, color: C.ok }),
  ],
};

/** 手順の記事の図：3 つの段（上に題、下に何をするか） */
function flow(title: string, heads: string[], notes: string[]): [string, string] {
  const body = heads
    .map((h, i) => {
      const x = 30 + i * 204;
      return (
        box(x, 70, 176, 200, i === 2 ? C.okTint : C.chip, { rx: 12, stroke: i === 2 ? C.ok : C.line, sw: 2 }) +
        step(x + 88, 110, i + 1) +
        t(x + 88, 176, h, { size: 26, anchor: "middle", weight: 700 }) +
        t(x + 88, 226, notes[i] ?? "", { size: 24, anchor: "middle", color: C.muted }) +
        (i < 2 ? arrow(x + 180, 170, x + 200, 170, C.control) : "")
      );
    })
    .join("");
  return [title, body];
}

/** 記事 1 本の図の SVG（ファイルの中身） */
export function figureSvg(slug: string): string {
  const draw = FIGURES[slug];
  if (!draw) throw new Error(`図がありません：${slug}`);
  const [title, body] = draw();
  return svg(title, body);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  for (const slug of Object.keys(FIGURES)) writeFileSync(path.join(OUT, `${slug}.svg`), figureSvg(slug));
  console.log(`描きました：src/site/figures/ に ${Object.keys(FIGURES).length} 枚`);
}

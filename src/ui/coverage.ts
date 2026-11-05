// SPDX-License-Identifier: AGPL-3.0-only
//
// 「見た所・見なかった所」：漏洩パターン P1〜P12 と、新しい型を1行ずつ並べ、どこまで調べたかを示す（CLAUDE.md §11-5b）。
// 画面の部品に頼らない計算だけを置き、テストで確かめる。
//
// 状態は4つ。「安全です」「問題なし」とは言わない。
// - checked：調べた（見つかった数を添える）
// - partial：調べたが、省いたページ・読み解けなかった画像・途中で止めた所がある（理由を添える）
// - failed：調べられなかった（暗号・読めないファイルなど。ルールの理由を添える）
// - not_in_version：この版では調べていない（調べるルールがない。理由を添える）

import type { InspectSummary, RuleResult } from "../inspect/report";

export type CoverageState = "checked" | "partial" | "failed" | "not_in_version";

export type CoverageRow = {
  /** P1〜P12、または新しい型の名前（pii・info） */
  key: string;
  /** 画面で見せる名前（用語集の言葉）。P の番号は key */
  name: string;
  state: CoverageState;
  /** 見つかった所の数（言い切れる所） */
  found: number;
  /** 確かめてほしい所の数（confidence: check） */
  check: number;
  /** 状態の理由。checked のときは空のことがある */
  reasons: string[];
};

type CatalogEntry = {
  key: string;
  name: string;
  /** このルールを、この行の型として数える */
  match(r: RuleResult): boolean;
  /** 数えるのが、見つけた所ではなく「お知らせ」のとき true */
  countsNotices?: boolean;
  /** 調べるルールがないときの理由 */
  missing: string;
};

const byPattern = (p: string) => (r: RuleResult) => r.pattern === p && r.ruleId !== "extras";
const NO_RULE = "この版には、調べるルールがまだありません。";

/** 並べる型の一覧。並びは用語集の P の番号の順。新しい型は後ろに足す */
export const CATALOG: readonly CatalogEntry[] = [
  { key: "P1", name: "文書情報", match: byPattern("P1"), missing: NO_RULE },
  { key: "P2", name: "XMP メタデータ", match: byPattern("P2"), missing: NO_RULE },
  {
    key: "P3",
    name: "他の団体の名前の混入",
    match: byPattern("P3"),
    missing: "その文書を出した団体の名前と比べる必要があるため、この版では調べていません。",
  },
  { key: "P4", name: "ファイルパス・内部ホスト名", match: byPattern("P4"), missing: NO_RULE },
  {
    key: "P5",
    name: "旧版の残存",
    match: (r) => r.pattern === "P5",
    missing: NO_RULE,
  },
  { key: "P6", name: "見せかけの黒塗り", match: byPattern("P6"), missing: NO_RULE },
  { key: "P7", name: "隠れたテキスト", match: byPattern("P7"), missing: NO_RULE },
  { key: "P8", name: "注釈・コメント", match: byPattern("P8"), missing: NO_RULE },
  { key: "P9", name: "添付ファイル", match: byPattern("P9"), missing: NO_RULE },
  { key: "P10", name: "画像の位置情報など", match: byPattern("P10"), missing: NO_RULE },
  { key: "P11", name: "フォームの入力値", match: byPattern("P11"), missing: NO_RULE },
  { key: "P12", name: "スクリプト・外部動作", match: byPattern("P12"), missing: NO_RULE },
  {
    key: "個人情報",
    name: "個人情報らしい字",
    match: (r) => r.ruleId === "pii" || r.ruleId.startsWith("pii-"),
    missing: "本文の名前・番号などを探すルールは、この版にはまだ入っていません。",
  },
  {
    key: "お知らせ",
    name: "XFA のフォーム・来歴の情報",
    match: (r) => r.ruleId === "extras",
    countsNotices: true,
    missing: NO_RULE,
  },
];

function pagesText(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const shown = sorted.slice(0, 10).join("、");
  return sorted.length > 10 ? `${shown} ほか ${sorted.length - 10} ページ` : shown;
}

/** 調べたが一部を省いた理由（ルールのお知らせから作る。同じ理由はまとめる） */
function partialReasons(rules: RuleResult[]): string[] {
  const heavy: number[] = [];
  const unreadable: number[] = [];
  const tooLarge: number[] = [];
  const images: number[] = [];
  const largeImages: number[] = [];
  let imagesNoPage = false;
  const other = new Set<string>();
  for (const r of rules) {
    for (const n of r.notices) {
      if (n.kind === "skipped_pages") (n.reason === "unreadable" ? unreadable : n.reason === "too_large" ? tooLarge : heavy).push(...n.pages);
      else if (n.kind === "unchecked_images" && n.reason === "too_large") largeImages.push(...n.pages);
      else if (n.kind === "unchecked_images") {
        images.push(...n.pages);
        if (!n.pages.length) imagesNoPage = true;
      } else if (n.kind === "partial") other.add(n.message);
    }
  }
  const out: string[] = [];
  if (heavy.length) out.push(`図形が多すぎるため、ページ ${pagesText(heavy)} を省きました。`);
  if (unreadable.length) out.push(`読めなかったため、ページ ${pagesText(unreadable)} を省きました。`);
  if (tooLarge.length) out.push(`解くと大きすぎる中身があるため、ページ ${pagesText(tooLarge)} を省きました。`);
  if (largeImages.length) out.push(`ページ ${pagesText(largeImages)} に、大きすぎるため調べていない画像があります。`);
  if (images.length) out.push(`ページ ${pagesText(images)} に、読み解けなかった画像があります。`);
  else if (imagesNoPage) out.push("読み解けなかった画像があります。");
  out.push(...other);
  return out;
}

export function buildCoverage(summary: InspectSummary): CoverageRow[] {
  return CATALOG.map((c): CoverageRow => {
    const rules = summary.rules.filter((r) => c.match(r));
    const base = { key: c.key, name: c.name, found: 0, check: 0 };
    if (!rules.length) return { ...base, state: "not_in_version", reasons: [c.missing] };
    const ok = rules.filter((r) => r.status === "ok");
    const errors = rules.filter((r) => r.status === "error");
    const items = ok.flatMap((r) => r.items);
    const found = c.countsNotices
      ? ok.reduce((n, r) => n + r.notices.filter((x) => x.kind === "info").length, 0)
      : items.filter((i) => i.confidence !== "check").length;
    const check = c.countsNotices ? 0 : items.filter((i) => i.confidence === "check").length;
    const errorReasons = [...new Set(errors.map((r) => r.message ?? "調べられませんでした。"))];
    if (!ok.length) return { ...base, state: "failed", reasons: errorReasons };
    const partial = partialReasons(ok);
    // 一部のルールだけが止まったときは、止まったルールの名前を添える（理由がルールの文だけでは、どれのことか分からないため）
    if (errors.length) partial.push(...errors.map((r) => `「${r.label}」は調べられませんでした。${r.message ?? ""}`.trim()));
    return { ...base, found, check, state: partial.length ? "partial" : "checked", reasons: partial };
  });
}

/** 調べきれなかった型があるか（この版で調べていない型は数えない。それは毎回、一覧で示す） */
export function hasIncomplete(rows: readonly CoverageRow[]): boolean {
  return rows.some((r) => r.state === "partial" || r.state === "failed");
}

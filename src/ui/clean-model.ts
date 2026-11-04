// SPDX-License-Identifier: AGPL-3.0-only
//
// 「3 片付ける」「4 読み直す」の結果を、画面に並べる形に直す（画面の部品に頼らない計算だけ。テストで確かめる）。
// - 残っている所の数は、片付けた PDF を検査の入口に最初から入れ直した結果（after）だけで決める。
//   片付けの報告（removed）は「何をしたか」を見せるためだけに使い、「残っていない」の根拠にしない（sanitize/README.md「4 読み直す」）。
// - 「残っていません」は、読み直しで調べた型についてだけ言う（CLAUDE.md §11-5b）。

import type { NotDoneItem, RemovedItem, SanitizePattern } from "../../sanitize/types.ts";
import type { Rect } from "../inspect/report";
import type { ViewModel } from "./model";

/** 片付けの型の名前（docs/glossary.md の言葉） */
export const PATTERN_NAME: Record<SanitizePattern, string> = {
  P1: "文書情報",
  P2: "XMP メタデータ",
  P5: "旧版の残存",
  P6: "見せかけの黒塗り",
  P7: "隠れたテキスト",
  P8: "注釈・コメント",
  P9: "添付ファイル",
  P12: "スクリプト・外部動作",
};
const PATTERN_ORDER: SanitizePattern[] = ["P6", "P7", "P5", "P1", "P2", "P8", "P9", "P12"];

/** 1つの型の中で並べる行の上限。超えた分は数だけ出す */
export const MAX_LINES_PER_GROUP = 30;

export type RemovedGroup = { pattern: SanitizePattern; name: string; lines: string[]; total: number };
export type DoneMark = { page: number; rect: Rect; label: string };

export type CleanView = {
  /** clean＝読み直して残り 0 件で、片付けられなかった所も調べられなかった所もない（「全部緑」）。
   *  left＝読み直して、まだ残っている。unsure＝0 件だが、言い切れない所がある */
  verdict: "clean" | "left" | "unsure";
  headline: string;
  /** 片付ける前に見つかった所の数 */
  before: number;
  /** 読み直して残っていた所の数。読み直せなかったときは null */
  left: number | null;
  removed: RemovedGroup[];
  notDone: string[];
  notes: string[];
  /** 片付けた所のうち、ページの上の場所があるもの（ページの絵に「済」の枠を描く） */
  doneMarks: DoneMark[];
  /** 読み直しで調べた範囲の説明 */
  scope: string;
};

const withPage = (label: string, page: number | undefined) => (page !== undefined ? `${label}（ページ ${page}）` : label);

export function buildCleanView(input: {
  before: ViewModel;
  /** 読み直し（片付けた PDF の検査）の結果。読み直せなかったときは null */
  after: ViewModel | null;
  removed: RemovedItem[];
  notDone: NotDoneItem[];
  decrypted: boolean;
}): CleanView {
  const { before, after, removed, notDone, decrypted } = input;

  const groups = new Map<SanitizePattern, RemovedGroup>();
  for (const r of removed) {
    const g = groups.get(r.pattern) ?? { pattern: r.pattern, name: PATTERN_NAME[r.pattern], lines: [], total: 0 };
    g.total++;
    if (g.lines.length < MAX_LINES_PER_GROUP) g.lines.push(withPage(r.label, r.page));
    groups.set(r.pattern, g);
  }
  for (const g of groups.values()) {
    if (g.total > g.lines.length) g.lines.push(`ほか ${g.total - g.lines.length} 件`);
  }
  const removedGroups = PATTERN_ORDER.filter((p) => groups.has(p)).map((p) => groups.get(p)!);

  const notDoneLines = notDone.map((n) => withPage(n.label, n.page));
  const doneMarks: DoneMark[] = removed
    .filter((r): r is RemovedItem & { page: number; rect: Rect } => r.page !== undefined && r.rect !== undefined)
    .map((r) => ({ page: r.page, rect: r.rect, label: r.label }));

  const notes: string[] = [];
  if (decrypted) notes.push("パスワードなしで開ける暗号化がかかっていたので、外して書き出しました。");

  // 読み直しで調べた型と、片付けたが読み直しでは調べていない型
  const checked = after ? after.groups.filter((g) => g.status === "ok").map((g) => g.pattern) : [];
  const notChecked = removedGroups.map((g) => g.pattern).filter((p) => !checked.includes(p));
  let scope = checked.length
    ? `読み直しで調べたのは ${checked.map((p) => `${PATTERN_NAME[p as SanitizePattern] ?? p}（${p}）`).join("・")} です。`
    : "読み直しでは、どの型も調べられませんでした。";
  if (notChecked.length) scope += `${notChecked.join("・")} は片付けましたが、読み直しでは調べていません（調べるルールがまだありません）。`;
  // 調べた型の中でも、調べていない層があれば添える（決め打ちの中身は src/ui/scope.ts の1か所）
  if (after) scope += after.caveats.join("");

  const left = after ? after.rows.length : null;
  let verdict: CleanView["verdict"];
  let headline: string;
  if (left === null) {
    verdict = "unsure";
    headline = "片付けた PDF を読み直せませんでした。残っていないとは言えません。";
  } else if (left > 0) {
    verdict = "left";
    headline = `読み直したところ、まだ ${left} か所残っています。`;
  } else if (notDone.length > 0 || !after!.clean) {
    verdict = "unsure";
    headline = "読み直したところ、残っている所は 0 件でしたが、片付けられなかった所か、調べられなかった所があります。「全部消えた」ではありません。";
  } else {
    verdict = "clean";
    headline = "読み直したところ、調べた項目で残っている所は 0 件でした。";
  }

  return { verdict, headline, before: before.rows.length, left, removed: removedGroups, notDone: notDoneLines, notes, doneMarks, scope };
}

/** 保存するファイルの名前。元の名前の後ろに「_片付け済み」をつける */
export function cleanedFileName(original: string): string {
  const stem = original.replace(/\.pdf$/i, "").trim() || "document";
  return `${stem}_片付け済み.pdf`;
}

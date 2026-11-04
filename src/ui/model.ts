// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査の結果（InspectSummary）を、画面に並べる形に直す。画面の部品に頼らない計算だけを置き、テストで確かめる。
// 見た目（色・形）は持たない。design/ の案を選んだあとも、この形はそのまま使う。

import type { Item, PageBox, Rect, Severity, InspectSummary } from "../inspect/report";
import { scopeCaveats } from "./scope";

export type Row = {
  no: number;
  severity: Severity;
  severityLabel: string;
  patternLabel: string;
  page: number | null;
  pageLabel: string;
  hasRect: boolean;
  title: string;
  why: string;
  detail: string;
};

/** 型（ルール）ごとのまとまり。見つからなかった型も並べる */
export type Group = {
  label: string;
  pattern: string;
  status: "ok" | "error";
  /** status が error のときの文 */
  message: string | null;
  rows: Row[];
};

export type PageMarks = { box: PageBox; marks: Array<{ no: number; severity: Severity; title: string; rect: Rect }> };

export type ViewModel = {
  headline: string;
  tone: "neutral" | "ok" | "problem";
  rows: Row[];
  groups: Group[];
  notices: string[];
  unchecked: string[];
  coverage: string[];
  pages: PageMarks[];
  /** 図形が多すぎるとして、どれかのルールが省いたページ（ページの絵も描かない） */
  heavyPages: number[];
  /** 調べていない層の一言（src/ui/scope.ts。片付けたあとの読み直しの範囲に添える） */
  caveats: string[];
  /** 見つかった所が0件で、調べられなかった項目も省いたページもないとき true（「全部緑」の状態） */
  clean: boolean;
};

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const SEVERITY_LABEL: Record<Severity, string> = { high: "高", medium: "中", low: "低" };

function pagesText(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const shown = sorted.slice(0, 20).join("、");
  return sorted.length > 20 ? `${shown} ほか ${sorted.length - 20} ページ` : shown;
}

export function buildView(summary: InspectSummary): ViewModel {
  const all: Array<Item & { label: string; ruleIndex: number }> = [];
  summary.rules.forEach((r, ruleIndex) => {
    for (const it of r.items) all.push({ ...it, label: r.label, ruleIndex });
  });
  all.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.page ?? Infinity) - (b.page ?? Infinity) ||
      (b.rect ? b.rect[3] : 0) - (a.rect ? a.rect[3] : 0),
  );

  const rows: Row[] = all.map((it, i) => ({
    no: i + 1,
    severity: it.severity,
    severityLabel: SEVERITY_LABEL[it.severity],
    patternLabel: `${it.label}（${it.pattern}）`,
    page: it.page,
    pageLabel: it.page !== null ? `${it.page}` : "ファイル全体",
    hasRect: it.rect !== null,
    title: it.title,
    why: it.why,
    detail: it.detail,
  }));

  const groups: Group[] = summary.rules.map((r, i) => ({
    label: r.label,
    pattern: r.pattern,
    status: r.status,
    message: r.status === "error" ? (r.message ?? "調べられませんでした。") : null,
    rows: rows.filter((_, j) => all[j]!.ruleIndex === i),
  }));

  // お知らせ：同じ文はまとめ、ページ番号を合わせる
  const merged = new Map<string, { pages: number[]; problem: boolean }>();
  for (const r of summary.rules) {
    for (const n of r.notices) {
      // 省いたページは、ルールごとに上限が違うので、どのルールが省いたかを添える
      const key = n.kind === "skipped_pages" ? `${r.label}（${r.pattern}）：${n.message}` : n.message;
      const m = merged.get(key) ?? { pages: [], problem: n.kind !== "decrypted" };
      m.pages.push(...n.pages);
      merged.set(key, m);
    }
  }
  const notices = [...merged.entries()].map(([msg, m]) => (m.pages.length ? `${msg}（ページ ${pagesText(m.pages)}）` : msg));
  const partial = [...merged.values()].some((m) => m.problem);

  const errors = summary.rules.filter((r) => r.status === "error");
  const unchecked = errors.map((r) => `${r.label}（${r.pattern}）：${r.message ?? "調べられませんでした。"}`);
  const coverage = summary.rules
    .filter((r) => r.status === "ok")
    .map((r) => `${r.label}（${r.pattern}）：${r.items.length === 0 ? "見つかりませんでした" : `${r.items.length} 件`}`);

  const byPage = new Map<number, PageMarks>();
  const boxes = new Map(summary.pages.map((p) => [p.page, p]));
  rows.forEach((row, i) => {
    const it = all[i]!;
    if (it.page === null || it.rect === null) return;
    const box = boxes.get(it.page);
    if (!box) return;
    const pm = byPage.get(it.page) ?? { box, marks: [] };
    pm.marks.push({ no: row.no, severity: row.severity, title: row.title, rect: it.rect });
    byPage.set(it.page, pm);
  });
  const pages = [...byPage.values()].sort((a, b) => a.box.page - b.box.page);

  const clean = rows.length === 0 && errors.length === 0 && !partial;
  let headline: string;
  let tone: ViewModel["tone"];
  if (rows.length) {
    headline = `見た目では分からない情報が、${rows.length} か所見つかりました。`;
    tone = "problem";
  } else if (clean) {
    headline = "調べた項目では、見つかりませんでした。";
    tone = "ok";
  } else {
    headline = "見つかった所はありませんが、調べられなかった所があります。「問題なし」ではありません。";
    tone = "neutral";
  }
  const heavyPages = [
    ...new Set(summary.rules.flatMap((r) => r.notices.filter((n) => n.reason === "heavy").flatMap((n) => n.pages))),
  ].sort((a, b) => a - b);
  return { headline, tone, rows, groups, heavyPages, notices, unchecked, coverage, pages, clean, caveats: scopeCaveats(summary.rules) };
}

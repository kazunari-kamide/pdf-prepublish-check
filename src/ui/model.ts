// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査の結果（InspectSummary）を、画面に並べる形に直す。画面の部品に頼らない計算だけを置き、テストで確かめる。
// 見た目（色・形）は持たない。design/ の案を選んだあとも、この形はそのまま使う。

import type { Item, PageBox, Rect, Severity, InspectSummary } from "../inspect/report";
import { buildCoverage, hasIncomplete, type CoverageRow } from "./coverage";
import { scopeCaveats } from "./scope";
import { ruleOrigin, type RuleOrigin } from "./rule-origin";
import { CANDIDATE_PATTERNS } from "./picks";

export type Row = {
  no: number;
  severity: Severity;
  severityLabel: string;
  patternLabel: string;
  /** 型の番号（P6 など）。黒塗りの候補（P13【仮】）の行に「黒塗りに加える」を付けるのに使う */
  pattern: string;
  page: number | null;
  pageLabel: string;
  hasRect: boolean;
  /** ページの上の場所（ページの既定の座標）。黒塗りの候補を、選んだ所に加えるときに使う */
  rect: Rect | null;
  title: string;
  why: string;
  detail: string;
  /** ルールが「確かめてください」とした所（言い切れない所）。画面では断定しない形で出す */
  check: boolean;
  /**
   * 見えている個人情報らしい字（黒塗りの候補。P13【仮】）。「見た目では分からない情報」とは別に数える
   * （見えている字なので、黒塗りにするかは本人が決める。2026-11-05 本人が決めた）
   */
  candidate: boolean;
  /** 見つけた字の中身（あるときだけ）。画面の中だけで使い、伏せて出す（src/ui/reveal.ts） */
  content?: string;
  /** 文書情報・XMP の欄の値のとき、その欄の名前（Title・dc:title など） */
  field?: string;
  /** 見つける段から来た型のとき、その出どころ（取り入れた PR）。最初から人が書いた型にはない（src/ui/rule-origin.ts） */
  origin?: RuleOrigin;
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

export type PageMarks = { box: PageBox; marks: Array<{ no: number; severity: Severity; title: string; rect: Rect; candidate: boolean }> };

/**
 * 結論（3つ）。found＝見つかった（確かめてほしい所だけのときも含む）、none＝調べた範囲では見つからなかった、
 * incomplete＝見つからなかったが、調べきれなかった所がある
 */
export type Verdict = "found" | "none" | "incomplete";

export type ViewModel = {
  verdict: Verdict;
  headline: string;
  tone: "neutral" | "ok" | "problem";
  rows: Row[];
  /** 見た目では分からない情報の数（候補の行を除く）。見出し・手順の帯・整える前後の数は、これを読む */
  hidden: number;
  /** 見えている個人情報らしい字（候補）の数。見えない情報とは別の一文で出す */
  candidates: number;
  groups: Group[];
  notices: string[];
  /** notices のうち、字が 1 つもないページのお知らせ（no_text）の数。読み込んだ直後の結論は緑にしないが、
   *  整えたあとの読み直しの判定（clean-model）には数えない（整えると見えない字が消え、字のないページになるため） */
  noTextNotices: number;
  unchecked: string[];
  pages: PageMarks[];
  /** 図形が多すぎるとして、どれかのルールが省いたページ（ページの絵も描かない） */
  heavyPages: number[];
  /** 調べていない層の一言（src/ui/scope.ts。片付けたあとの読み直しの範囲に添える） */
  caveats: string[];
  /** 見つかった所が0件で、調べられなかった項目も省いたページもないとき true（「全部緑」の状態） */
  clean: boolean;
  /** 見た所・見なかった所（P1〜P12 と新しい型を1行ずつ。src/ui/coverage.ts） */
  coverage: CoverageRow[];
};

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const SEVERITY_LABEL: Record<Severity, string> = { high: "高", medium: "中", low: "低" };

function pagesText(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const shown = sorted.slice(0, 20).join("、");
  return sorted.length > 20 ? `${shown} ほか ${sorted.length - 20} ページ` : shown;
}

const isCandidatePattern = (pattern: string) => CANDIDATE_PATTERNS.includes(pattern);

export function buildView(summary: InspectSummary): ViewModel {
  // 種類（ルール）の中は、深刻度 → ページ → 上から の順に並べる
  const byPlace = (a: Item, b: Item) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    (a.page ?? Infinity) - (b.page ?? Infinity) ||
    (b.rect ? b.rect[3] : 0) - (a.rect ? a.rect[3] : 0);
  const perRule = summary.rules.map((r, ruleIndex) => r.items.map((it) => ({ ...it, label: r.label, ruleIndex })).sort(byPlace));
  // 種類の並び：見つかった種類を先に（見えない情報の種類を、いちばん重い項目の順に → 見えている候補の種類）、見つからなかった種類はルールの順で後ろに。
  // 番号は、この並べた順に上から 1, 2, 3… と振る（一覧の上から順に見ればよいように。2026-11-05 夜のレビュー §0）
  const order = summary.rules
    .map((_, i) => i)
    .sort((a, b) => {
      const ea = perRule[a]!.length === 0;
      const eb = perRule[b]!.length === 0;
      if (ea !== eb) return ea ? 1 : -1;
      if (ea) return a - b;
      const ca = isCandidatePattern(summary.rules[a]!.pattern);
      const cb = isCandidatePattern(summary.rules[b]!.pattern);
      if (ca !== cb) return ca ? 1 : -1;
      return SEVERITY_ORDER[perRule[a]![0]!.severity] - SEVERITY_ORDER[perRule[b]![0]!.severity] || a - b;
    });
  const all = order.flatMap((i) => perRule[i]!);

  const rows: Row[] = all.map((it, i) => {
    const origin = ruleOrigin(summary.rules[it.ruleIndex]!.ruleId, it.kind);
    return {
    no: i + 1,
    severity: it.severity,
    severityLabel: SEVERITY_LABEL[it.severity],
    patternLabel: `${it.label}（${it.pattern}）`,
    pattern: it.pattern,
    page: it.page,
    pageLabel: it.page !== null ? `${it.page}` : "ファイル全体",
    hasRect: it.rect !== null,
    rect: it.rect,
    title: it.title,
    why: it.why,
    detail: it.detail,
    ...(it.content ? { content: it.content } : {}),
    ...(it.field ? { field: it.field } : {}),
    check: it.confidence === "check",
    candidate: isCandidatePattern(it.pattern),
    ...(origin ? { origin } : {}),
    };
  });

  const groups: Group[] = order.map((i) => {
    const r = summary.rules[i]!;
    return {
      label: r.label,
      pattern: r.pattern,
      status: r.status,
      message: r.status === "error" ? (r.message ?? "調べられませんでした。") : null,
      rows: rows.filter((_, j) => all[j]!.ruleIndex === i),
    };
  });

  // お知らせ：同じ文はまとめ、ページ番号を合わせる
  const merged = new Map<string, { pages: number[]; problem: boolean; noText: boolean }>();
  for (const r of summary.rules) {
    for (const n of r.notices) {
      // 省いたページは、ルールごとに上限が違うので、どのルールが省いたかを添える
      const key = n.kind === "skipped_pages" ? `${r.label}（${r.pattern}）：${n.message}` : n.message;
      // 復号したこと・知らせるだけのもの（info。文字認識の層・XFA など）は、調べきれなかった所に数えない
      const m = merged.get(key) ?? { pages: [], problem: n.kind !== "decrypted" && n.kind !== "info", noText: n.kind === "no_text" };
      m.pages.push(...n.pages);
      merged.set(key, m);
    }
  }
  const notices = [...merged.entries()].map(([msg, m]) => (m.pages.length ? `${msg}（ページ ${pagesText(m.pages)}）` : msg));
  const partial = [...merged.values()].some((m) => m.problem);
  const noTextNotices = [...merged.values()].filter((m) => m.noText).length;

  const errors = summary.rules.filter((r) => r.status === "error");
  const unchecked = errors.map((r) => `${r.label}（${r.pattern}）：${r.message ?? "調べられませんでした。"}`);

  const byPage = new Map<number, PageMarks>();
  const boxes = new Map(summary.pages.map((p) => [p.page, p]));
  rows.forEach((row, i) => {
    const it = all[i]!;
    if (it.page === null || it.rect === null) return;
    const box = boxes.get(it.page);
    if (!box) return;
    const pm = byPage.get(it.page) ?? { box, marks: [] };
    pm.marks.push({ no: row.no, severity: row.severity, title: row.title, rect: it.rect, candidate: row.candidate });
    byPage.set(it.page, pm);
  });
  const pages = [...byPage.values()].sort((a, b) => a.box.page - b.box.page);

  const coverage = buildCoverage(summary);
  const clean = rows.length === 0 && errors.length === 0 && !partial && !hasIncomplete(coverage);
  // 見えない情報と、見えている候補を別に数える（候補は見出しの数に入れない）
  const hiddenRows = rows.filter((r) => !r.candidate);
  const hidden = hiddenRows.length;
  const candidates = rows.length - hidden;
  const sure = hiddenRows.filter((r) => !r.check).length;
  const check = hidden - sure;
  const candidateLine = candidates ? `ほかに、見えている個人情報らしい字が ${candidates} か所あります（黒塗りするかは、あなたが決めます）。` : "";
  let verdict: Verdict;
  let headline: string;
  let tone: ViewModel["tone"];
  if (hidden) {
    verdict = "found";
    tone = "problem";
    headline = (sure
      ? `見た目では分からない情報が、${sure} か所見つかりました。${check ? `ほかに、確かめてほしい所が ${check} か所あります。` : ""}`
      : `見た目では分からない情報が残っているかもしれない所が、${check} か所あります。確かめてください。`) + candidateLine;
  } else if (candidates) {
    // 見えない情報はなく、見えている候補だけ（紅にしない。黒塗りにするかは本人が決める）
    verdict = "found";
    tone = "neutral";
    const incomplete = errors.length > 0 || partial || hasIncomplete(coverage);
    headline =
      `見た目では分からない情報は、${incomplete ? "調べた範囲では" : ""}見つかりませんでした。見えている個人情報らしい字が ${candidates} か所あります（黒塗りするかは、あなたが決めます）。` +
      (incomplete ? "調べきれなかった所があります。「見た所・見なかった所」を確かめてください。" : "");
  } else if (clean) {
    verdict = "none";
    headline = "調べた範囲では、見つかりませんでした。";
    tone = "ok";
  } else {
    verdict = "incomplete";
    headline = "見つかった所はありませんが、調べきれなかった所があります。「見た所・見なかった所」を確かめてください。";
    tone = "neutral";
  }
  const heavyPages = [
    // 解くと大きすぎる中身のあるページも、絵を描かない（PDF.js には、解く大きさの上限を渡せないため）
    ...new Set(
      summary.rules.flatMap((r) =>
        r.notices.filter((n) => n.reason === "heavy" || (n.kind === "skipped_pages" && n.reason === "too_large")).flatMap((n) => n.pages),
      ),
    ),
  ].sort((a, b) => a - b);
  return { verdict, headline, tone, rows, hidden, candidates, groups, heavyPages, notices, noTextNotices, unchecked, coverage, pages, clean, caveats: scopeCaveats(summary.rules) };
}

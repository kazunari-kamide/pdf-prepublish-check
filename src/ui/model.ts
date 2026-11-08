// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査の結果（InspectSummary）を、画面に並べる形に直す。画面の部品に頼らない計算だけを置き、テストで確かめる。
// 見た目（色・形）は持たない。design/ の案を選んだあとも、この形はそのまま使う。

import type { Item, PageBox, Rect, Severity, InspectSummary } from "../inspect/report";
import { buildCoverage, CATALOG, hasIncomplete, type CoverageRow } from "./coverage";
import { scopeCaveats } from "./scope";
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

export type PageMarks = { box: PageBox; marks: Array<{ no: number; severity: Severity; title: string; rect: Rect; candidate: boolean; tier: TierKey; pattern: string }> };

/**
 * 深刻度の段（2026-11-06 本人が決定：深刻度ごとに分けて並べ、「中」「低」「個人情報の候補」は最初は閉じる）。
 * 並び：高 → 確かめる → 中 → 低 → 個人情報の候補。段の中は、種類ごとにまとめる
 */
export type TierKey = "high" | "check" | "medium" | "low" | "candidate";
export type Tier = {
  key: TierKey;
  /** 段の名前（印つき。色だけにしない） */
  label: string;
  /** 段の意味の一言 */
  note: string;
  /** 最初から開いておくか */
  open: boolean;
  count: number;
  groups: Group[];
};
export const TIER_ORDER: readonly TierKey[] = ["high", "check", "medium", "low", "candidate"];
const TIER_TEXT: Record<TierKey, { label: string; note: string; open: boolean }> = {
  high: { label: "▲ 高", note: "すぐに消す", open: true },
  check: { label: "？ 確かめる", note: "残っているかを、目で確かめる", open: true },
  medium: { label: "■ 中", note: "消しておくとよい", open: false },
  low: { label: "● 低", note: "念のため", open: false },
  candidate: { label: "ｉ 個人情報の候補", note: "見えている字。黒塗りにするかは、あなたが決める", open: false },
};

/** 1 件がどの段に入るか */
export function tierOf(r: { severity: Severity; check: boolean; candidate: boolean }): TierKey {
  if (r.candidate) return "candidate";
  if (r.check) return "check";
  return r.severity;
}

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
  /** 深刻度の段（見つかった段だけ。並びは TIER_ORDER） */
  tiers: Tier[];
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
  // 深刻度の段 → 種類の並び → 種類の中の並び（深刻度・ページ・上から）。番号は、この並べた順に振る
  const rank = new Map(order.map((ruleIndex, k) => [ruleIndex, k]));
  const tierRank = (it: Item & { ruleIndex: number }) =>
    TIER_ORDER.indexOf(tierOf({ severity: it.severity, check: it.confidence === "check", candidate: isCandidatePattern(it.pattern) }));
  const all = order
    .flatMap((i) => perRule[i]!)
    .map((it, k) => ({ it, k }))
    .sort((a, b) => tierRank(a.it) - tierRank(b.it) || rank.get(a.it.ruleIndex)! - rank.get(b.it.ruleIndex)! || a.k - b.k)
    .map((x) => x.it);

  const rows: Row[] = all.map((it, i) => {
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

  // 段ごとに、種類でまとめる（種類の並びは groups と同じ）
  const tiers: Tier[] = TIER_ORDER.map((key) => {
    const inTier = rows.filter((r) => tierOf(r) === key);
    const tierGroups = groups
      .map((g) => ({ ...g, rows: g.rows.filter((r) => tierOf(r) === key) }))
      .filter((g) => g.status !== "error" && g.rows.length > 0);
    return { key, ...TIER_TEXT[key], count: inTier.length, groups: tierGroups };
  }).filter((t) => t.count > 0);

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
    pm.marks.push({ no: row.no, severity: row.severity, title: row.title, rect: it.rect, candidate: row.candidate, tier: tierOf(row), pattern: row.pattern });
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
  return { verdict, headline, tone, rows, hidden, candidates, groups, tiers, heavyPages, notices, noTextNotices, unchecked, coverage, pages, clean, caveats: scopeCaveats(summary.rules) };
}

// ---------------------------------------------------------------- 結果の欄の要点（案 A。2026-11-07 本人が承認）

/** 要点の一覧に並べる種類の数の上限。これを超えた種類は「詳しく見る」の中だけに並べる（2026-11-07 本人が決定） */
export const KIND_LIMIT = 5;

/** 要点の一覧の 1 行（同じ種類は 1 行にまとめる。2026-11-07 本人が決定） */
export type KindRow = {
  pattern: string;
  /** 行の題（同じ種類の題がそろっていればその題、違えば種類の名前でまとめる） */
  title: string;
  /** 深刻度の札（印つき。色だけにしない） */
  sevLabel: string;
  /** 深刻度（色と形のため）。確かめる所だけの種類は check */
  sev: Severity | "check";
  count: number;
  /** そのうち確かめる所の数 */
  check: number;
  /** 場所の一言（「ページ 1」「ページ 1、3」「ファイル全体」） */
  where: string;
  /** なぜ危ないかの 1 文（いちばん重い行のもの） */
  why: string;
  /** その種類の最初の行の番号（押したとき、「詳しく見る」の中のその行を開く） */
  firstNo: number;
};

export type KindSummary = {
  /** 上限までの種類（並びは一覧の番号の順＝深刻度の順） */
  shown: KindRow[];
  /** 上限を超えた種類の数と、その中の所の数 */
  moreKinds: number;
  moreCount: number;
};

const SEV_TEXT: Record<Severity | "check", string> = { high: "▲ 高", medium: "■ 中", low: "● 低", check: "？ 確かめる" };

/**
 * 「整える」では消せない残り方のルール（画面の名前）。塗った所と同じ情報が、塗られていない所に出ている形で、
 * 消すには元の書類で直すしかない（2026-11-08。気づきにくい見本で、整えたあとに残るのを「壊れた」と思わせないため）
 */
export const FIX_IN_SOURCE_LABELS: ReadonlySet<string> = new Set(["塗った字が、ほかの所に出ている", "黒塗りのそばの記号", "同じ書式のページの塗り残し"]);

/** 整えたあとに残っている所の説明。残っている所が、すべて「整える」では消せない残り方のときだけ返す（ほかが混じれば null） */
export const FIX_IN_SOURCE_WHY =
  "「整える」では消せない残り方です。塗った所と同じ情報が、塗られていない所（ほかのページの同じ欄・本文・そばの記号など）に出ています。どこに出ているかは、下の行を押すと出ます。元の書類で、その所も塗るか書き直してから、PDF を作り直してください。";

export function fixInSourceWhy(rows: readonly Row[]): string | null {
  const left = rows.filter((r) => !r.candidate);
  if (!left.length) return null;
  return left.every((r) => FIX_IN_SOURCE_LABELS.has(r.patternLabel.replace(/（[^（）]*）$/, ""))) ? FIX_IN_SOURCE_WHY : null;
}

/** 型の名前（見た所・見なかった所の一覧と同じ。P6＝見せかけの黒塗り など） */
const KIND_NAME = new Map(CATALOG.map((c) => [c.key, c.name]));

/**
 * 題がそろわない種類の見出しの名前。当たった行が 1 つのルールだけなら、そのルールの名前。
 * 同じ型（P6 など）を見るルールが複数あり、当たったルールが 2 つ以上なら、型の名前（2026-11-08）。
 * 前は、型ごとに最後に並んだルールの名前を使っていたので、当たっていないルール（同じ書式のページの塗り残し など）の名前が出ていた
 */
function kindName(pattern: string, list: Row[], groups: ViewModel["groups"]): string {
  const rules = new Set(list.map((r) => r.patternLabel));
  if (rules.size === 1) {
    const g = groups.find((g) => g.pattern === pattern && `${g.label}（${g.pattern}）` === list[0]!.patternLabel);
    if (g) return g.label;
  }
  return KIND_NAME.get(pattern) ?? groups.find((g) => g.pattern === pattern)?.label ?? "見えない情報";
}

/** 見えない情報（候補を除く）を、種類ごとに 1 行にまとめる */
export function kindSummary(view: Pick<ViewModel, "rows" | "groups">, limit = KIND_LIMIT): KindSummary {
  const byKind = new Map<string, Row[]>();
  for (const r of view.rows) {
    if (r.candidate) continue;
    const list = byKind.get(r.pattern) ?? [];
    list.push(r);
    byKind.set(r.pattern, list);
  }
  const rows: KindRow[] = [...byKind.entries()].map(([pattern, list]) => {
    const sure = list.filter((r) => !r.check);
    const top = (sure.length ? sure : list).reduce((a, b) => (SEVERITY_ORDER[b.severity] < SEVERITY_ORDER[a.severity] ? b : a));
    const sev: KindRow["sev"] = sure.length ? top.severity : "check";
    const titles = new Set(list.map((r) => r.title));
    const pages = [...new Set(list.map((r) => r.page).filter((p): p is number => p !== null))];
    const whole = list.some((r) => r.page === null);
    const where = [pages.length ? `ページ ${pagesText(pages)}` : "", whole ? "ファイル全体" : ""].filter(Boolean).join("・");
    return {
      pattern,
      title: titles.size === 1 ? list[0]!.title : `${kindName(pattern, list, view.groups)}が見つかりました`,
      sevLabel: SEV_TEXT[sev],
      sev,
      count: list.length,
      check: list.length - sure.length,
      where,
      why: top.why,
      firstNo: list[0]!.no,
    };
  });
  // 並び：深刻度（確かめるは高の次）→ 一覧の番号の順
  const rank = (k: KindRow) => (k.sev === "high" ? 0 : k.sev === "check" ? 1 : k.sev === "medium" ? 2 : 3);
  rows.sort((a, b) => rank(a) - rank(b) || a.firstNo - b.firstNo);
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit);
  return { shown, moreKinds: rest.length, moreCount: rest.reduce((n, k) => n + k.count, 0) };
}

/** 結果の欄の大きな見出し（短く。くわしい文は状態の文 headline が読み上げで伝える） */
export function shortHeadline(view: Pick<ViewModel, "rows" | "hidden" | "verdict" | "headline">): string {
  if (view.hidden) {
    const sure = view.rows.filter((r) => !r.candidate && !r.check).length;
    return sure ? `${view.hidden} か所に、見えない情報が残っています` : `見えない情報が残っているかもしれない所が、${view.hidden} か所あります`;
  }
  return view.headline;
}

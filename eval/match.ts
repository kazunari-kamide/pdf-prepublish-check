// SPDX-License-Identifier: AGPL-3.0-only
//
// 報告と正解データを照らし合わせる。決まりは rubric/p6.md §2・§3 と rubric/p6.json の match。
// 値（重なりの下限など）は rubric/p6.json から読み、ここには書かない。

export type Rect = [number, number, number, number];

export type ReportItem = {
  pattern: string;
  layer: "text" | "image";
  cover: string;
  page: number;
  rect: Rect;
  remaining?: { chars?: number };
};

/** 検証器の出力と同じ形（verifier/schema.json のうち、採点に使う所） */
export type VerifierShapedReport = {
  status: "ok" | "error";
  items: ReportItem[];
  skipped_pages: Array<{ page: number; reason: string }>;
};

export type Leak = {
  id: string;
  layer: "text" | "image";
  cover: string;
  page: number;
  rect: Rect;
  remaining?: { chars?: number };
};
export type Negative = { id: string; kind: string; page: number; rect: Rect };
export type Expected = { file: string; pages: number; leaks: Leak[]; negatives: Negative[] };

export type MatchRule = { same_page: boolean; same_layer: boolean; min_overlap: number; one_to_one: boolean };

/** 重なり ＝ 2つの箱の重なった面積 ÷ 小さいほうの箱の面積（rubric/p6.md §3 の3） */
export function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  const small = Math.min(areaA, areaB);
  return small > 0 ? (w * h) / small : 0;
}

export type FileMatch = {
  file: string;
  matched: Array<{ leak: Leak; item: ReportItem; overlap: number }>;
  missed: Leak[];
  /** 漏れでないものに重なった報告 */
  falseOnNegative: Array<{ item: ReportItem; negative: Negative }>;
  /** 正解（漏れ・漏れでないもの）のどれにも重ならなかった報告 */
  falseNowhere: ReportItem[];
  /** 漏れに重なったが、その漏れには、もっと重なる報告が結ばれていた（1対1のため結べなかった）報告 */
  duplicates: ReportItem[];
  status: "ok" | "error";
  skippedPages: number;
};

export function matchFile(expected: Expected, report: VerifierShapedReport, rule: MatchRule): FileMatch {
  const items = report.status === "ok" ? report.items : [];
  const samePage = (p1: number, p2: number) => !rule.same_page || p1 === p2;

  // 漏れと報告の組を、重なりの大きい順に結ぶ（1つの正解に1つの報告）
  const pairs: Array<{ li: number; ri: number; ov: number }> = [];
  expected.leaks.forEach((leak, li) => {
    items.forEach((item, ri) => {
      if (!samePage(leak.page, item.page)) return;
      if (rule.same_layer && leak.layer !== item.layer) return;
      const ov = overlap(leak.rect, item.rect);
      if (ov >= rule.min_overlap) pairs.push({ li, ri, ov });
    });
  });
  pairs.sort((a, b) => b.ov - a.ov);
  const leakUsed = new Set<number>();
  const itemUsed = new Set<number>();
  const matched: FileMatch["matched"] = [];
  for (const p of pairs) {
    if (leakUsed.has(p.li)) continue;
    if (rule.one_to_one && itemUsed.has(p.ri)) continue;
    leakUsed.add(p.li);
    itemUsed.add(p.ri);
    matched.push({ leak: expected.leaks[p.li]!, item: items[p.ri]!, overlap: p.ov });
  }

  const falseOnNegative: FileMatch["falseOnNegative"] = [];
  const falseNowhere: ReportItem[] = [];
  const duplicates: ReportItem[] = [];
  items.forEach((item, ri) => {
    if (itemUsed.has(ri)) return;
    // 漏れでないものには層がないので、層は見ない（rubric/p6.md §3 の2）
    const neg = expected.negatives.find(
      (n) => samePage(n.page, item.page) && overlap(n.rect, item.rect) >= rule.min_overlap,
    );
    if (neg) {
      falseOnNegative.push({ item, negative: neg });
      return;
    }
    const onLeak = expected.leaks.some(
      (l) => samePage(l.page, item.page) && overlap(l.rect, item.rect) >= rule.min_overlap,
    );
    if (onLeak) duplicates.push(item);
    else falseNowhere.push(item);
  });

  return {
    file: expected.file,
    matched,
    missed: expected.leaks.filter((_, li) => !leakUsed.has(li)),
    falseOnNegative,
    falseNowhere,
    duplicates,
    status: report.status,
    skippedPages: report.skipped_pages.length,
  };
}

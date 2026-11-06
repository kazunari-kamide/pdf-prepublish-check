// SPDX-License-Identifier: AGPL-3.0-only
//
// 見ないで作るテスト集（blind）の判定。eval/blind/run.ts（作品）と baseline/one_prompt/blind-score.ts（1回の指示で作った版）が、同じ関数で判定するために分けた。
// 中身は run.ts にあったものをそのまま移した（判定は変えていない）。

// ---- 期待値の形 ----
export type Kind = "leak" | "control" | "notice" | "unchecked";
export type Expect = {
  patterns?: string[] | null;
  level?: "high" | "check" | "any";
  page?: number;
  maxItems?: number;
  also?: string[];
  forbid?: string[] | null;
  forbidNotice?: boolean;
};
export type Residual = { markers?: string[]; image?: { w: number; h: number; region: { x: number; y: number; w: number; h: number } } } | null;
export type Case = { id: string; type: string; kind: Kind; about: string; file: string; expect: Expect; residual: Residual };

// ---- 項目の形（出どころは問わない） ----
export type Found = { pattern: string; severity: string; page: number | null };
export type RunOut = { items: Found[]; notices: string[]; errors: string[]; versions: Record<string, string> };

// ---- 判定 ----
export type Verdict = {
  pass: boolean;
  /** 期待した型で見つかった数 */
  hits: number;
  /** 期待と違う型で出た項目の型（隠しのある PDF のとき） */
  otherPatterns: string[];
  /** 深刻度が期待と合ったか（level が any のときは null） */
  severityOk: boolean | null;
  why: string;
};

const isCheck = (s: string) => s === "medium" || s === "low";
const noticeKinds = (n: string[]) => n.filter((k) => k !== "decrypted");

export function judge(c: Case, r: RunOut): Verdict {
  const e = c.expect;
  if (c.kind === "control") {
    const bad = r.items.filter((it) => (e.forbid ? e.forbid.includes(it.pattern) : true));
    const badNotice = e.forbidNotice ? noticeKinds(r.notices) : [];
    const pass = bad.length === 0 && badNotice.length === 0 && r.errors.length === 0;
    const why = [
      bad.length ? `誤検知 ${bad.length} 件（${[...new Set(bad.map((b) => b.pattern))].join("・")}）` : "",
      badNotice.length ? `お知らせ ${badNotice.length} 件（${[...new Set(badNotice)].join("・")}）` : "",
      r.errors.length ? `ルールのエラー（${r.errors.join("・")}）` : "",
    ]
      .filter(Boolean)
      .join("、");
    return { pass, hits: 0, otherPatterns: [], severityOk: null, why: why || "出なかった" };
  }
  if (c.kind === "unchecked") {
    const n = r.notices.filter((k) => k === "partial" || k === "skipped_pages");
    const pass = r.errors.length > 0 || n.length > 0;
    return { pass, hits: r.errors.length + n.length, otherPatterns: [], severityOk: null, why: pass ? `調べられないと出た（エラー ${r.errors.length}、お知らせ ${n.length}）` : "調べられないと出なかった" };
  }
  const want = (it: Found) => (e.patterns ? e.patterns.includes(it.pattern) : true) && (e.page === undefined || it.page === null || it.page === e.page);
  const hitsList = r.items.filter(want);
  const other = [...new Set(r.items.filter((it) => !want(it)).map((it) => it.pattern))];
  if (c.kind === "notice") {
    const ns = noticeKinds(r.notices);
    const pass = ns.length > 0 || hitsList.length > 0;
    return {
      pass,
      hits: ns.length + hitsList.length,
      otherPatterns: other,
      severityOk: null,
      why: pass ? `お知らせ ${ns.length}、項目 ${hitsList.length}` : `出なかった${other.length ? `（別の型：${other.join("・")}）` : ""}`,
    };
  }
  let pass = hitsList.length > 0;
  let why = pass ? `${hitsList.length} 件` : `見逃し${other.length ? `（別の型で出た：${other.join("・")}）` : ""}`;
  if (pass && e.maxItems !== undefined && hitsList.length > e.maxItems) {
    pass = false;
    why = `${hitsList.length} 件に分かれた（${e.maxItems} 件以下にまとめてほしい）`;
  }
  let severityOk: boolean | null = null;
  if (hitsList.length && e.level && e.level !== "any") {
    severityOk = hitsList.some((it) => (e.level === "high" ? it.severity === "high" : isCheck(it.severity)));
  }
  return { pass, hits: hitsList.length, otherPatterns: other, severityOk, why };
}

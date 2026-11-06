// SPDX-License-Identifier: AGPL-3.0-only
//
// 整える内容を種類ごとに選ぶ（5 の案 B。2026-11-06 本人が決定。D168）。画面の部品に頼らない計算だけを置き、テストで確かめる。
// - 見つかった種類ごとに 1 行。外せる種類（sanitize/types.ts の KEEPABLE_PATTERNS）は印を付け外しでき、ほかは「外せない行」（理由を 1 行）。
// - 最初の印は defaultOn（1 つの関数）で決める：高か「確かめる」を 1 件でも含む種類だけ。例外は DEFAULT_ON_EXCEPTIONS に足す。
// - 外した種類の数は、整える数から除き、読み直しでは「残っている所」に数えない（clean-model.ts）。外した物は、結果の画面に必ず並べる。

import { KEEPABLE_PATTERNS } from "../../sanitize/types.ts";
import type { Row, TierKey } from "./model.ts";
import { tierOf } from "./model.ts";

export type KeepRow = {
  pattern: string;
  name: string;
  /** 見つかった数（見えている候補は入れない） */
  count: number;
  /** 段ごとの数（見つかった段だけ。並びは高 → 確かめる → 中 → 低） */
  tiers: Array<{ key: Exclude<TierKey, "candidate">; count: number }>;
  /** 印を付け外しできるか */
  keepable: boolean;
  /** 最初に印を入れるか（外せない行はいつも true） */
  defaultOn: boolean;
  /** 行に添える一言（外せない理由・外したときに気をつけること） */
  note: string;
};

/**
 * 最初の印の例外（種類 → 最初の印）。決まり（高・確かめるを含む種類だけ）より先に見る。
 * P12（JavaScript・外の動作）：最初から印あり（2026-11-06 本人が決定。決まりのとおりだと「低」なので印なしになり、JavaScript を残すのが既定になる。守りの面で弱いため）
 */
export const DEFAULT_ON_EXCEPTIONS: Readonly<Record<string, boolean>> = { P12: true };

/** 最初に印を入れるか（1 つの関数にまとめる。例外は DEFAULT_ON_EXCEPTIONS） */
export function defaultOn(pattern: string, tiers: ReadonlyArray<{ key: TierKey; count: number }>): boolean {
  if (pattern in DEFAULT_ON_EXCEPTIONS) return DEFAULT_ON_EXCEPTIONS[pattern]!;
  return tiers.some((t) => (t.key === "high" || t.key === "check") && t.count > 0);
}

/** 外せない種類の理由（画面に 1 行で出す） */
const NOT_KEEPABLE_NOTE: Readonly<Record<string, string>> = {
  P6: "外せません（ページの字と画像の片付けは、まとめて行うため）",
  P7: "外せません（ページの字と画像の片付けは、まとめて行うため）",
  P5: "外せません（PDF を書き直すと、必ず消えるため）",
  P1: "外せません（欄ごとの扱いは、下のプロパティで選べます）",
  P2: "外せません（作成の記録（XMP）は、まとめて消すため）",
  P3: "外せません（欄ごとの扱いは、下のプロパティで選べます）",
  P4: "外せません（プロパティと作成の記録の中にあるため）",
};

/** 外せる種類で、外したときに添える一言 */
const KEEPABLE_NOTE: Readonly<Record<string, string>> = {
  P10: "外しても、作成の記録（XMP）の中にある分は消えます",
};

const KEEPABLE = new Set<string>(KEEPABLE_PATTERNS);
export const isKeepable = (pattern: string): boolean => KEEPABLE.has(pattern);

/** 見つかった行（候補を除く）を、種類ごとの行にまとめる。並びは、最初に出てくる順（画面の一覧と同じ） */
export function buildKeepRows(rows: readonly Row[], nameOf: (pattern: string) => string): KeepRow[] {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.candidate) continue;
    by.set(r.pattern, [...(by.get(r.pattern) ?? []), r]);
  }
  return [...by.entries()].map(([pattern, list]) => {
    const tiers = (["high", "check", "medium", "low"] as const)
      .map((key) => ({ key, count: list.filter((r) => tierOf(r) === key).length }))
      .filter((t) => t.count > 0);
    const keepable = isKeepable(pattern);
    return {
      pattern,
      name: nameOf(pattern),
      count: list.length,
      tiers,
      keepable,
      defaultOn: keepable ? defaultOn(pattern, tiers) : true,
      note: keepable ? (KEEPABLE_NOTE[pattern] ?? "") : (NOT_KEEPABLE_NOTE[pattern] ?? "外せません"),
    };
  });
}

/** 段の数の短い字（例「高 1・中 2」） */
const TIER_SHORT: Record<string, string> = { high: "高", check: "確かめる", medium: "中", low: "低" };
export const tierCounts = (row: Pick<KeepRow, "tiers">): string => row.tiers.map((t) => `${TIER_SHORT[t.key]} ${t.count}`).join("・");

/** 最初に外しておく種類（印なしで始まる、外せる種類） */
export const initialKept = (rows: readonly KeepRow[]): Set<string> => new Set(rows.filter((r) => r.keepable && !r.defaultOn).map((r) => r.pattern));

/** 整える片付けの側へ渡す一覧（外せる種類だけ。並びは決まった順） */
export const keepList = (kept: ReadonlySet<string>): string[] => KEEPABLE_PATTERNS.filter((p) => kept.has(p));

/** 外す種類の一言（押す前の確かめ・結果の画面）。例「注釈 2 か所・JavaScript 1 か所」 */
export function keptSummary(rows: readonly KeepRow[], kept: ReadonlySet<string>): string {
  return rows
    .filter((r) => r.keepable && kept.has(r.pattern))
    .map((r) => `${r.name} ${r.count} か所`)
    .join("・");
}

/** 外した種類の数（見えない情報の数のうち、整えない分） */
export const keptCount = (rows: readonly KeepRow[], kept: ReadonlySet<string>): number =>
  rows.filter((r) => r.keepable && kept.has(r.pattern)).reduce((n, r) => n + r.count, 0);

// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする所（11/5 B の 9）の計算。画面の部品に頼らない計算だけを置き、テストで確かめる。
// - 選び方は2つ：ページの上をドラッグする、黒塗りの候補（個人情報らしい字。P13【仮】）の行から加える。
// - 片付けの redact（sanitize/redact.ts）に渡すのは、ページと場所（ページの既定の座標）だけ。字の中身は持たない。
// - redact が保存の前の読み直しで残りを見つけたら（blocked）、PDF は返らない。何がどこに残ったかを、ページ番号つきで並べる。

import type { NotDoneItem, RedactLeftover } from "../../sanitize/types.ts";
import type { Rect } from "../inspect/report.ts";
import { MAX_REDACT_AREAS, type RedactArea } from "../sanitize/areas.ts";
import type { Row } from "./model.ts";

/** 黒塗りの候補として示すだけの型（片付けでは消さない。利用者が選んで黒塗りにする） */
export const CANDIDATE_PATTERNS: readonly string[] = ["P13"];

/** 選んだ所1つ。candidate＝候補の行から加えたとき、その行の番号（一覧の番号） */
export type PickedArea = RedactArea & { candidate?: number };

/** この行を、黒塗りの候補として選べるか（候補の型で、ページの上の場所があるもの） */
export function isCandidate(r: Row): r is Row & { page: number; rect: Rect } {
  return CANDIDATE_PATTERNS.includes(r.pattern) && r.page !== null && r.rect !== null;
}

export const isPicked = (picks: readonly PickedArea[], row: Row) => picks.some((p) => p.candidate === row.no);

/** 候補の行を、選んだ所に加える／外す。上限を超えるときは加えない（そのまま返す） */
export function toggleCandidate(picks: readonly PickedArea[], row: Row): PickedArea[] {
  if (!isCandidate(row)) return [...picks];
  if (isPicked(picks, row)) return picks.filter((p) => p.candidate !== row.no);
  if (picks.length >= MAX_REDACT_AREAS) return [...picks];
  return [...picks, { page: row.page, rect: [...row.rect] as Rect, candidate: row.no }];
}

/** 候補を全部加える（もう選んだものは重ねない。上限まで） */
export function addAllCandidates(picks: readonly PickedArea[], rows: readonly Row[]): PickedArea[] {
  let out = [...picks];
  for (const r of rows) if (isCandidate(r) && !isPicked(out, r)) out = toggleCandidate(out, r);
  return out;
}

/** 一覧に出す名前 */
export function pickLabel(p: PickedArea, i: number): string {
  return p.candidate !== undefined ? `選んだ所 ${i + 1}：ページ ${p.page}（個人情報の候補 ${p.candidate}）` : `選んだ所 ${i + 1}：ページ ${p.page}`;
}

/** 片付けの Worker に渡す形（ページと場所だけ） */
export const toAreas = (picks: readonly PickedArea[]): RedactArea[] => picks.map((p) => ({ page: p.page, rect: [...p.rect] as Rect }));

/** 保存の前の読み直しで残りが見つかったとき（redact の blocked）の見せ方 */
export type BlockedView = { headline: string; lines: string[] };

const MAX_BLOCKED_LINES = 30;

export function buildBlockedView(leftovers: readonly RedactLeftover[], notDone: readonly NotDoneItem[]): BlockedView {
  // 同じ文・同じページのものは、まとめて数える（count は字・画素などの数で、文の中にもう書いてあるので、ここでは行の数を数える）
  const counts = new Map<string, number>();
  for (const l of leftovers) {
    const key = l.page !== undefined ? `${l.label}（ページ ${l.page}）` : l.label;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const all = [...counts].map(([k, n]) => (n > 1 ? `${k}：${n} 件` : k));
  const lines = all.slice(0, MAX_BLOCKED_LINES);
  if (all.length > lines.length) lines.push(`ほか ${all.length - lines.length} 件`);
  const headline = notDone.length
    ? "黒塗りした PDF を保存の前に読み直したところ、片付けられなかった所か、残っている所がありました。保存できるファイルは作っていません。"
    : "黒塗りした PDF を保存の前に読み直したところ、残っている所がありました。保存できるファイルは作っていません。";
  return { headline, lines };
}

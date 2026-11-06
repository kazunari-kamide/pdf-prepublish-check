// SPDX-License-Identifier: AGPL-3.0-only
//
// 結果の欄の「プロパティに入っていた情報」（2026-11-07 本人が承認した案 A）。
// どんな情報が入っているかを、詳しく見るを開かなくても分かるように、欄の名前と値の頭の 2 字だけを出す（残りは伏せる。src/ui/reveal.ts と同じ決まり）。
// 全部の値は「詳しく見る」の中のプロパティの一覧で、「中身を見る」を押したときだけ出す。
// - 独自の欄は、欄の名前そのものが団体や人をたどる手がかりになりうるので、名前を出さず「独自の欄」とだけ書く（src/inspect/rules.ts の P1 と同じ考え）
// - XMP（作ったときの記録）は欄の名前が専門の言葉なので、欄の数だけを出す
// 画面の部品に頼らない計算だけを置き、テストで確かめる（tests/result-face-a.test.ts）。

import { fullContent, maskContent, showsWhole } from "./reveal";

/** 結果の欄に並べる欄の数の上限（超えた分は「ほか n 欄」） */
export const GLANCE_LIMIT = 6;

/** 結果の欄での伏せ字の数の上限（長い値で行が折れて「整える」を押し下げないように短くする。全部の長さの伏せ字は「詳しく見る」の一覧で） */
export const GLANCE_DOTS = 4;

export type GlanceInput = {
  info: ReadonlyArray<{ key: string; value: string }>;
  xmp: ReadonlyArray<{ key: string; value: string }>;
};

export type Glance = {
  /** 値の入っていた欄が 1 つもない */
  empty: boolean;
  rows: Array<{ label: string; value: string }>;
  /** 上限を超えて並べなかった文書情報の欄の数 */
  more: number;
  /** XMP の欄の数 */
  xmp: number;
};

/** label は、文書情報の決まった欄の画面での名前（ない欄は null を返す＝独自の欄） */
export function buildGlance(p: GlanceInput, label: (key: string) => string | null): Glance {
  const shown = p.info.map((f) => ({ label: label(f.key) ?? "独自の欄", value: showsWhole(f.value) ? fullContent(f.value) : maskContent(f.value, GLANCE_DOTS) }));
  return {
    empty: p.info.length === 0 && p.xmp.length === 0,
    rows: shown.slice(0, GLANCE_LIMIT),
    more: Math.max(0, shown.length - GLANCE_LIMIT),
    xmp: p.xmp.length,
  };
}

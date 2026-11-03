// SPDX-License-Identifier: AGPL-3.0-only
//
// 判定に使う値。値の根拠（合成 PDF で測った値）は rules/p6-text/README.md に書く。
// 推測で動かさない。動かすときは、測った値と理由を docs/evolution.md に残す。

export type P6TextSettings = {
  /** 塗りを「濃い」とみなす明るさの上限（0＝黒、1＝白） */
  darkLuminanceMax: number;
  /** 塗りを「隠している」とみなす不透明さの下限 */
  opacityMin: number;
  /** 塗りを「四角に近い」とみなす、外枠の箱を埋める割合の下限 */
  rectangularityMin: number;
  /** 字が「覆われた」とみなす、字の箱が覆いに隠れる割合の下限 */
  coveredFractionMin: number;
  /** 1ページの命令の数の上限。超えたページは調べずに「省いた」と返す【仮の値】 */
  maxOperationsPerPage: number;
  /** 画像を「覆い」とみなす、濃い画素（明るさ darkLuminanceMax 以下）の割合の下限 */
  darkImageFractionMin: number;
  /** 解く画像の大きさの上限（バイト）。超えた画像は解かずに「調べられなかった画像」とする【仮の値】 */
  maxImageBytes: number;
};

export const DEFAULT_SETTINGS: P6TextSettings = {
  darkLuminanceMax: 0.35,
  opacityMin: 0.9,
  rectangularityMin: 0.9,
  coveredFractionMin: 0.5,
  maxOperationsPerPage: 200_000,
  darkImageFractionMin: 0.97,
  maxImageBytes: 64 * 1024 * 1024,
};

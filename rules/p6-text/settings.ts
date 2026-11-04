// SPDX-License-Identifier: AGPL-3.0-only
//
// 判定に使う値。値の根拠（合成 PDF で測った値）は rules/p6-text/README.md に書く。
// 推測で動かさない。動かすときは、測った値と理由を docs/evolution.md に残す。

export type P6TextSettings = {
  /** 塗りを「濃い」とみなす明るさの上限（0＝黒、1＝白） */
  darkLuminanceMax: number;
  /** 塗りを「隠している」とみなす不透明さの下限 */
  opacityMin: number;
  /** 線を「覆い」とみなす太さの下限（ページの座標のポイント）。これより細い線は、字を半分も隠せないので見ない（1.3.0 から） */
  minStrokeWidth: number;
  /** 字が「覆われた」とみなす、字の箱が覆いに隠れる割合の下限 */
  coveredFractionMin: number;
  /** 1ページの命令の数の上限。超えたページは調べずに「省いた」と返す【仮の値】 */
  maxOperationsPerPage: number;
  /** 1ページの覆いの数の上限（先に描いた字に重なる濃い塗りの数）。超えたページは「省いた」と返す【仮の値】（1.3.0 から） */
  maxCoversPerPage: number;
  /** 画像を「覆い」とみなす、濃い画素（明るさ darkLuminanceMax 以下）の割合の下限 */
  darkImageFractionMin: number;
  /** 解く画像の大きさの上限（バイト）。超えた画像は解かずに「調べられなかった画像」とする【仮の値】 */
  maxImageBytes: number;
  /** 画像の層（1.5.0 から）：白っぽい覆いとみなす明るさの下限。これと darkLuminanceMax の間の色の塗りは、覆いにしない */
  lightLuminanceMin: number;
  /** 画像の層：覆いの下の元の画像の画素の、明るさの標準偏差の下限。これ以上なら「下に何か写っている」とする */
  imageSpreadMin: number;
  /** 画像の層：覆いの中で、下に画像がある点の割合の下限。これより少ない覆いは、画像の上の覆いとみなさない */
  imageUnderFractionMin: number;
  /** 画像の層：1ページで調べる、画像の上の覆いの数の上限。超えたページは「省いた」と返す【仮の値】 */
  maxImageCoversPerPage: number;
  /**
   * 画像の層：白い覆いの上にあとから描いた塗り・線の形を、1ページで集める数の上限（1.10.0 から）。
   * 超えたページは集めた形を使わず、1.9.0 までの測り方（上に描いたものの下の点も数える）に戻す【仮の値】
   */
  maxOverPaintPerPage: number;
  /** 1ページの画像の数の上限。超えたページは「省いた」と返す【仮の値】（1.5.0 から） */
  maxImagesPerPage: number;
  /**
   * 塗りの形の詰まり具合（形の面積 ÷ 凸包の面積）の下限（1.6.0 から）。これより小さい、形のある塗り（アウトライン化した字など）は、
   * 覆いとして数えない。ふつうの四角・回した四角・角の丸い四角・楕円は 1 に近い【仮の値】
   */
  minSolidity: number;
  /** 画像の層：塗りの覆いの箱の短い辺の下限（ポイント）。これより細い塗りは、字の行を隠せないので数えない【仮の値】（1.6.0 から） */
  imageCoverMinSide: number;
  /** 画像の層：ほぼ同じ大きさの、正方形に近い塗りが、1ページにこの数以上あれば、くり返しの模様として数えない【仮の値】（1.6.0 から） */
  repeatMinCount: number;
  /** 画像の層：くり返しの模様で「ほぼ同じ大きさ」とみなす、幅・高さの差（ポイント）（1.6.0 から） */
  repeatSizeTolerance: number;
  /** 画像の層：くり返しの模様で「正方形に近い」とみなす、縦横の比の下限（上限はこの逆数）（1.6.0 から） */
  repeatAspectMin: number;
  /** 画像の層：白い塗りの、まわりの帯の幅（ポイント）（1.7.0 から） */
  ringWidth: number;
  /** 画像の層：まわりの帯で「明るい」とみなす、下の画像の画素の明るさの下限（1.7.0 から） */
  ringLightLuminanceMin: number;
  /** 画像の層：白い塗りを数える、まわりの帯の明るい点の割合の下限。これより少なければ、まわりに溶け込まない白い札として数えない【仮の値】（1.7.0 から） */
  ringLightFractionMin: number;
  /** 画像の層：覆いの下で「紙らしい」とみなす、画素の明るさの下限（1.7.0 から） */
  paperLuminanceMin: number;
  /** 画像の層：濃い塗りの下の紙らしい点の割合の下限。これより少なければ「確かめてください」（confidence: check）にする【仮の値】（1.7.0 から） */
  paperFractionMin: number;
  /** 文字の層：字1つ分の大きさとみなす、字の箱からの広げ方（縦横の倍率）（1.7.0 から） */
  glyphSizedRatio: number;
  /**
   * 解く画像の画素の数の上限（1.9.0 から）。超えた画像は解かずに「調べられなかった画像」（too_large）とする。
   * 600dpi の A3（約 7,000 万画素）まで入る【仮の値】（2026-11-04、人の承認）
   */
  maxImagePixels: number;
  /** 画像の層：色のある点とみなす、色の濃さ（RGB の最大と最小の差）の下限（1.9.0 から） */
  coloredChromaMin: number;
  /** 画像の層：覆いの下とまわりの帯で、色のある点の割合がこれ以上なら「確かめてください」（check）にする【仮の値】（1.9.0 から） */
  coloredFractionMin: number;
  /** 文字の層：覆われた字の箱の高さが、どれもこれより小さければ「確かめてください」にする（ポイント）【仮の値】（1.8.0 から） */
  tinyGlyphHeightMax: number;
};

export const DEFAULT_SETTINGS: P6TextSettings = {
  darkLuminanceMax: 0.35,
  opacityMin: 0.9,
  minStrokeWidth: 1,
  coveredFractionMin: 0.5,
  maxOperationsPerPage: 3_000_000,
  maxCoversPerPage: 100_000,
  darkImageFractionMin: 0.97,
  maxImageBytes: 256 * 1024 * 1024,
  lightLuminanceMin: 0.9,
  imageSpreadMin: 0.05,
  imageUnderFractionMin: 0.5,
  maxImageCoversPerPage: 5_000,
  maxOverPaintPerPage: 20_000,
  maxImagesPerPage: 10_000,
  minSolidity: 0.8,
  imageCoverMinSide: 4,
  repeatMinCount: 20,
  repeatSizeTolerance: 0.25,
  repeatAspectMin: 0.5,
  ringWidth: 3,
  ringLightLuminanceMin: 0.75,
  ringLightFractionMin: 0.6,
  paperLuminanceMin: 0.7,
  paperFractionMin: 0.4,
  glyphSizedRatio: 1.2,
  tinyGlyphHeightMax: 2,
  maxImagePixels: 72_000_000,
  coloredChromaMin: 0.2,
  coloredFractionMin: 0.2,
};

// SPDX-License-Identifier: AGPL-3.0-only
//
// 「ファイルを小さくする」（片付けの compress。sanitize/compress.ts）の結果を、画面に並べる形に直す。
// 画面の部品に頼らない計算だけを置き、テストで確かめる。
// - 選べる値は3つに絞る（sanitize/README.md「画面へのつなぎ方」の案）。範囲は COMPRESS_DPI・COMPRESS_QUALITY の中。
// - 小さくした PDF を保存できるかは、片付けと同じく、画面がもう一度検査し直した結果で決める（clean-model.ts の saveGate）。
//   compress の「残りが増えた」（blocked）のときは、PDF が返らないので、保存の場面に進まない。

import type { CompressImages, CompressIncrease } from "../../sanitize/types.ts";

export type CompressPreset = { id: "normal" | "small" | "fine"; label: string; note: string; maxDpi: number; jpegQuality: number };

export const COMPRESS_PRESETS: readonly CompressPreset[] = [
  { id: "normal", label: "ふつう", note: "画像を 150 dpi・JPEG の質 0.75 まで。画面で読むのに困らない細かさです", maxDpi: 150, jpegQuality: 0.75 },
  { id: "small", label: "もっと小さく", note: "画像を 100 dpi・JPEG の質 0.6 まで。細かい字の写真は読みにくくなることがあります", maxDpi: 100, jpegQuality: 0.6 },
  { id: "fine", label: "きれいに", note: "画像を 200 dpi・JPEG の質 0.85 まで。印刷するときに向きます", maxDpi: 200, jpegQuality: 0.85 },
];

export const DEFAULT_PRESET = COMPRESS_PRESETS[0]!;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} バイト`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export type CompressView = {
  /** ok＝小さくできた。same＝小さくできる画像がなかった（元のまま）。blocked＝読み直しで残りが増えたので、保存させない */
  kind: "ok" | "same" | "blocked";
  headline: string;
  /** 「前 ○ → 後 ○」 */
  sizes: string;
  /** 書き直した画像の数・手を付けなかった画像の理由と数、または増えた残り */
  lines: string[];
};

export function buildCompressView(
  r:
    | { status: "ok"; sizeBefore: number; sizeAfter: number; changed: boolean; images: CompressImages }
    | { status: "blocked"; sizeBefore: number; sizeAfter: number; increased: CompressIncrease[] },
): CompressView {
  const sizes = `小さくする前 ${formatBytes(r.sizeBefore)} → 小さくしたあと ${formatBytes(r.sizeAfter)}`;
  if (r.status === "blocked") {
    return {
      kind: "blocked",
      headline: "小さくしたあとに読み直したところ、残っている所が増えました。保存できるファイルは作っていません。",
      sizes,
      lines: r.increased.map((x) => `${x.label}（${x.before} → ${x.after}）`),
    };
  }
  const skipped = r.images.skipped.filter((x) => x.count > 0).map((x) => `${x.label}：${x.count} 個`);
  if (!r.changed) {
    return { kind: "same", headline: "小さくできる画像がありませんでした。元の大きさのままです。", sizes: `大きさ ${formatBytes(r.sizeBefore)}（変わりません）`, lines: skipped };
  }
  const pct = r.sizeBefore > 0 ? Math.round((1 - r.sizeAfter / r.sizeBefore) * 100) : 0;
  return {
    kind: "ok",
    headline: `ファイルを小さくしました（${pct}% 減りました）。`,
    sizes,
    lines: [`縮めて書き直した画像：${r.images.changed} 個`, ...skipped],
  };
}

/** 小さくした PDF の名前。「_片付け済み」のあとに「_小」をつける */
export function compressedFileName(cleaned: string): string {
  return cleaned.replace(/\.pdf$/i, "") + "_小.pdf";
}

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 種類ごとの結果の左に立てる「札」の短い名前（案 E2。design/README.md の「札」）。
 * 札は飾りで、読み上げでは見出し（種類の名前と P の番号）を読む。札だけで意味を伝えない。
 * 縦書きで 4 字までに収める。知らない種類は P の番号を出す（新しいルールが増えても、札が空にならない）。
 */

const SHORT: Record<string, string> = {
  見せかけの黒塗り: "黒塗り",
  隠れたテキスト: "隠れ字",
  文書情報: "文書情報",
  旧版の残存: "前の版",
  添付ファイル: "添付",
  "注釈・コメント": "注釈",
  "XMP メタデータ": "XMP",
  画像の位置情報など: "位置情報",
  フォームの入力値: "入力値",
  "スクリプト・外部動作": "動作",
  "ファイルパス・内部ホスト名": "パス",
  "しおりの題・代わりの文字": "しおり",
  "文書情報と XMP の食い違い": "食い違い",
  ページの縮小画像: "縮小画像",
  書体に残った字形: "字形",
};

export const FUDA_MAX = 4;

export function fudaLabel(label: string, pattern: string): string {
  const short = SHORT[label];
  if (short && [...short].length <= FUDA_MAX) return short;
  return pattern;
}

/** 見つからなかった種類をまとめた囲みの札 */
export const FUDA_NONE = "済";
/** 調べられなかった種類の札 */
export const FUDA_ERROR = "未";

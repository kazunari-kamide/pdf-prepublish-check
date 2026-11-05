// SPDX-License-Identifier: AGPL-3.0-only
//
// 文書のプロパティの欄の名前（画面に出す名前）。確かめる段（src/inspect/rules.ts）・整えるときの選び方（src/ui/tidy-model.ts）・
// 片付け（sanitize/properties.ts）が、みなこの 1 つの表を引く（段ごとに「件名／サブタイトル」「作成したソフト／作成したアプリ」と
// 名前が違っていたため。2026-11-05 夜のレビュー 11）。データの表だけを置き、ほかのものを読み込まない。

/** 文書情報（Info）の欄の名前 → 画面に出す名前 */
export const INFO_LABEL = {
  Title: "タイトル",
  Author: "作成者",
  Subject: "件名",
  Keywords: "キーワード",
  Creator: "作成したソフト",
  Producer: "PDF に変換したソフト",
  CreationDate: "作成日",
  ModDate: "更新日",
} as const;

// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページ（記事・プライバシーの説明）の中身の形。
// 中身は字だけで持ち、HTML はビルドの時に src/site/render.ts が作る（字はすべて HTML として解釈させない形に直す）。

/** 記事の1つの節。段落・箇条・手順のどれか（いくつ組み合わせてもよい） */
export interface Section {
  heading: string;
  paragraphs?: string[];
  /** 順番のない箇条 */
  list?: string[];
  /** 順番のある手順 */
  steps?: string[];
  /** 節の最後に添える注意（アプリの版の違いなど） */
  note?: string;
}

export interface Article {
  /** ファイルの名前（/articles/<slug>.html） */
  slug: string;
  /** 型の解説なら型の番号（P1〜P12）。手順の記事なら null */
  pattern: string | null;
  title: string;
  /** 検索の結果に出る説明（meta description）。記事の冒頭の1文にも使う */
  description: string;
  sections: Section[];
  /** 記事の最後に「関係する記事」として並べる、ほかの記事の slug（1つ以上。並べた順に出す） */
  related: string[];
}

/** サイトの1枚のページ（記事の一覧・プライバシーなど）が持つ値 */
export interface PageMeta {
  /** サイトの中の場所（/articles/ など）。canonical と sitemap に使う */
  path: string;
  title: string;
  description: string;
}

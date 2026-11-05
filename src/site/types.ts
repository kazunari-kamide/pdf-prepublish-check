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
  /** 記事の図（省いてよい。ないときは、図の場所を出さない）。src/site/figures/ に置いたファイル */
  figure?: Figure;
  /**
   * 記事の一覧の絞り込みに足すタグ（省いてよい）。種類（型の解説・手順）と話題のタグは、型の番号と slug から
   * src/site/tags.ts が付けるので、ここにはそれ以外に足したいものだけを書く。使えるタグは tags.ts の TAGS にあるものだけ
   */
  tags?: string[];
}

/** 記事の図。自分で描いた SVG か、合成 PDF（fixtures/ の架空のもの）を画面で撮った PNG。実在の団体・PDF は使わない */
export interface Figure {
  /** src/site/figures/ の中のファイルの名前（.svg か .png） */
  file: string;
  /** 図の代わりの文（読み上げ・画像が出ないとき）。図が何を示すかを1文で */
  alt: string;
  /** 図の下に出す説明（省いてよい） */
  caption?: string;
}

/** サイトの1枚のページ（記事の一覧・プライバシーなど）が持つ値 */
export interface PageMeta {
  /** サイトの中の場所（/articles/ など）。canonical と sitemap に使う */
  path: string;
  title: string;
  description: string;
}

/** ビルドの時に site.ts が置いた図の場所と大きさ（RenderOptions.figures。鍵は記事の slug） */
export interface FigureAsset {
  /** /assets/figures/<名前>-<ハッシュ>.<svg|png> */
  href: string;
  alt: string;
  caption?: string;
  /** ファイルから読んだ大きさ（画像を読み込む前に場所を取っておき、表示がずれないように） */
  width: number;
  height: number;
}

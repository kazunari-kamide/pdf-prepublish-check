// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトのページの動き（src/site/motion.css）に足す、記事ごとの view-transition-name の決まりを作る。ビルドの時に site.ts が、motion.css の後につなぐ。
// - CSP（style-src 'self'）で style 属性が使えないので、名前は HTML に書かず、data-article で選ぶ決まりを CSS に作る。
// - 同じ記事は、一覧の札（li.card）・札の題・札の図と、記事のページの題（h1）・図で、同じ名前にする（ページを移るとき、滑って入れ替わる）。

import { ARTICLES } from "./articles.ts";

const SLUG = /^[a-z0-9-]+$/;

/** 記事ごとの名前の決まり */
export function articleTransitionNames(slugs: readonly string[] = ARTICLES.map((a) => a.slug)): string {
  const rules = slugs.map((s) => {
    if (!SLUG.test(s)) throw new Error(`記事の slug「${s}」は、動きの名前に使えません（英小文字・数字・- だけ）`);
    return [
      `.card[data-article="${s}"] { view-transition-name: card-${s}; }`,
      `.card[data-article="${s}"] .card-head, .site-article[data-article="${s}"] h1 { view-transition-name: title-${s}; }`,
      `.card[data-article="${s}"] .card-figure, .site-article[data-article="${s}"] .site-figure img { view-transition-name: figure-${s}; }`,
    ].join("\n");
  });
  return `/* 記事ごとの名前（src/site/motion.ts が記事の一覧から作る） */\n${rules.join("\n")}\n`;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// 各ページの head に入れる、題・説明・canonical と、OGP・X のカードの <meta>（2026-11-05）。
// - 本文（h1・冒頭の文）は変えない。head の題と説明だけを、検索の結果とカードに向けて整える。
//   題は 30 字前後、説明は 80〜120 字（tests/site-head.test.ts で数える）。
// - カードの画像は、同じサイトから配る自前の画像（/og-image.png。作り方は site-og-image.ts）。外から読み込まない。
// - 構造化データ（JSON-LD）は入れていない。<script type="application/ld+json"> は、scripts/check-dist.mjs の
//   「直接書いたスクリプト」の確かめに当たるため（PR に理由を書いた）。
// - 「安全です」「初めて」「唯一」「上位互換」のような言い方を、題・説明に使わない（テストで確かめる）。

import { ARTICLES } from "./articles.ts";
import type { PageMeta } from "./types.ts";

export const SITE_NAME = "お守りPDF";
export const OG_IMAGE_PATH = "/og-image.png";
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;
export const OG_IMAGE_ALT = "お守りPDF のロゴと「公開・提出の前に、PDF を自分で確かめる」の一言";

/** 題・説明に使わない言い方（言い切り・比べての誇張） */
export const BANNED_WORDS = ["安全です", "初めて", "唯一", "上位互換", "完璧", "100%", "絶対"];

/** 検査のページ（index.html）の head */
export const INSPECTOR_HEAD = {
  path: "/",
  title: "お守りPDF｜公開前の PDF に残る情報を、ブラウザの中で確かめる",
  description:
    "黒塗りの下に残った文字、作成者の名前、前の版の残り、添付ファイルなど、PDF の見た目では分からない情報を、公開・提出の前に確かめて片付けます。PDF はブラウザの中だけで読み、どこにも送りません。",
};

/** 記事以外のページの、head だけの題と説明（本文の見出しは pages.ts・render.ts・privacy.ts のまま） */
const PAGE_HEAD: Record<string, { title: string; description: string }> = {
  "/articles/": {
    title: "記事の一覧：PDF に残る情報の型と直し方｜お守りPDF",
    description:
      "PDF を公開・提出する前に知っておきたい、見た目では分からない情報の残り方（12 の型）と、正しいやり方の手順をまとめました。型ごとに、なぜ起きるのか・見分け方・直し方を説明しています。",
  },
  "/privacy.html": {
    title: "プライバシーについて：PDF を送らない作り｜お守りPDF",
    description:
      "お守りPDF は、入れた PDF をどこにも送りません。このサイトが残す記録は、配信先のサーバーが残すものだけです。何が残り、何が残らないかを説明します。アクセス解析のタグは入れていません。",
  },
  "/faq.html": {
    title: "よくある質問：送らない仕組み・調べる範囲｜お守りPDF",
    description:
      "本当に PDF を送らないのか、何を調べるのか、黒塗りの直し方、「見つかりませんでした」の意味など、お守りPDF についてよく聞かれることをまとめました。使う前の疑問を確かめられます。",
  },
  "/checklist.html": {
    title: "公開前の自己点検：PDF を出す前の確かめ｜お守りPDF",
    description:
      "PDF を公開・提出する前に、作る時・書き出す時・出す前の3つの段で確かめることを、型の番号（P1〜P12）に沿って並べました。印刷して使えます。見落としを減らすための目安の一覧です。",
  },
  "/terms.html": {
    title: "利用規約：無料・登録なしで使うときの決まり｜お守りPDF",
    description:
      "お守りPDF の利用規約です。無料・登録なしで、PDF はブラウザの中だけで読むこと、見つけられる範囲に限りがあること、禁止すること、変え方を書いています。使う前に一度お読みください。",
  },
  "/licenses.html": {
    title: "ライセンス：AGPL-3.0 と使っている部品｜お守りPDF",
    description:
      "お守りPDF のライセンス（AGPL-3.0）とソースの場所、使っている部品・書体の名前・版・ライセンス・著作権の表示と、ライセンスの全文です。どの部品をどの条件で使っているかを確かめられます。",
  },
  "/contact.html": {
    title: "お問い合わせ：質問・不具合・脆弱性の知らせ方｜お守りPDF",
    description:
      "お守りPDF への質問・不具合の知らせは、GitHub の Issues で受け付けています。PDF や個人情報は貼らないでください。脆弱性は、公開の Issues ではなく、非公開の報告の窓口から知らせてください。",
  },
};

/** 記事の説明に足す1文（記事の節の並びに合わせる）。短い記事は、記事ごとに足す */
const ARTICLE_TAIL = {
  pattern: "なぜ起きるのか、見分け方、正しい直し方をまとめました。",
  guide: "公開・提出の前に、この手順のとおりに進めて確かめられます。",
};
const ARTICLE_EXTRA: Record<string, string> = {
  "p3-foreign-org": "ほかの団体の様式を流用して作った書類で起きやすい残り方です。",
  "p4-internal-path": "パスには、職場のサーバーの名前や、使った人の名前が入ることがあります。",
};

export type HeadInfo = { path: string; title: string; description: string; type: "website" | "article" };

/** サイトのページ（記事・案内のページ）の head の値。meta は本文と同じもの */
export function headFor(meta: PageMeta): HeadInfo {
  const page = PAGE_HEAD[meta.path];
  if (page) return { path: meta.path, ...page, type: "website" };
  const article = ARTICLES.find((a) => meta.path === `/articles/${a.slug}.html`);
  if (article) {
    const tail = article.pattern ? ARTICLE_TAIL.pattern : ARTICLE_TAIL.guide;
    const extra = ARTICLE_EXTRA[article.slug] ?? "";
    return { path: meta.path, title: `${meta.title}｜${SITE_NAME}`, description: `${meta.description}${extra}${tail}`, type: "article" };
  }
  return { path: meta.path, title: meta.path === "/" ? SITE_NAME : `${meta.title}｜${SITE_NAME}`, description: meta.description, type: "website" };
}

/** OGP と X のカードの <meta>（字は呼ぶ側の escape を通す） */
export function socialMeta(h: HeadInfo, origin: string): Array<{ property?: string; name?: string; content: string }> {
  return [
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:locale", content: "ja_JP" },
    { property: "og:type", content: h.type },
    { property: "og:title", content: h.title },
    { property: "og:description", content: h.description },
    { property: "og:url", content: origin + h.path },
    { property: "og:image", content: origin + OG_IMAGE_PATH },
    { property: "og:image:width", content: String(OG_IMAGE_SIZE.width) },
    { property: "og:image:height", content: String(OG_IMAGE_SIZE.height) },
    { property: "og:image:alt", content: OG_IMAGE_ALT },
    { name: "twitter:card", content: "summary_large_image" },
  ];
}

/** head に入れる行（題・説明・canonical・OGP・X のカード）。escape は呼ぶ側の関数を使う */
export function headLines(h: HeadInfo, origin: string, escape: (s: string) => string, indent = "    "): string {
  const lines = [
    `<title>${escape(h.title)}</title>`,
    `<meta name="description" content="${escape(h.description)}" />`,
    `<link rel="canonical" href="${escape(origin + h.path)}" />`,
    ...socialMeta(h, origin).map((m) => (m.property ? `<meta property="${m.property}" content="${escape(m.content)}" />` : `<meta name="${m.name}" content="${escape(m.content)}" />`)),
  ];
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

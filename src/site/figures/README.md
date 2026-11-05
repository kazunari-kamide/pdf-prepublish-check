<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# 記事の図の置き場

記事（`src/site/articles.ts`）の `figure` に書いたファイルを、ここに置きます。ビルドの時に `site-figures.ts` が、名前に中身のハッシュを付けて `dist/assets/figures/` に写し、記事のページ（説明の下）と記事の一覧（カードの上）に出します。

```ts
figure: { file: "p6-fake-redaction.svg", alt: "黒い四角の下に、選べる文字が残っている図", caption: "見た目は黒く塗られていても、下の字はコピーできる" },
```

## 決まり（ビルドとテストで止める）

- 使えるのは `.svg` と `.png` だけ。名前は英小文字・数字・`-` だけ。
- `alt`（図の代わりの文）は空にしない。図が何を示すかを1文で書く。
- SVG は、`width`・`height` か `viewBox` で大きさを持つ。スクリプト・`style`・イベント・別の画像・ファイルの外を指すリンクは入れない（`<img>` で読むので動かないが、置くものから除く）。
- 色は `design/tokens.css`・`design/sheet.css` にある値だけを使う（新しい色を足さない。CLAUDE.md §6）。
- 図は、自分で描いた SVG か、合成 PDF（`fixtures/` の架空のもの）を検査の画面で撮った PNG だけ。**実在の団体・人の名前、実在の PDF は使わない**（CLAUDE.md §2-7）。ほかのサイトの画像・図を写さない。
- 図がない記事は、`figure` を書かない（図の場所は出ない）。

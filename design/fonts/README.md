<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# 同梱の書体（本文：Noto Sans JP・見出し：Zen Maru Gothic）

画面の書体は、外から読み込まず、リポジトリに同梱する（CLAUDE.md §2-1・§6）。2026-11-05 本人が決定：**元のファイルをリポジトリに入れ、ここから字を絞って作る**（誰が作り直しても、同じものになるように。CLAUDE.md §11-4）。

## 元のファイル（`source/`）

google/fonts のリポジトリの、コミット `66a36c8c94b1a5d992ee4e7f392fccfe4945767c`（`ofl/notosansjp/` の最後の更新。2026-03-25）から、手を加えずに取った。

| ファイル | 大きさ | SHA-256 |
|---|---|---|
| `NotoSansJP[wght].ttf` | 9,589,900 バイト | `c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f` |
| `OFL.txt` | 4,388 バイト | `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9` |
| `METADATA.pb` | 983 バイト | `5aa23f70fba3eb1afa6d92cb89de3b5c4690018caddbdded678b5e595e56825b` |

- 版：2.004（書体の中の name 5 の値は `Version 2.004-H2`）。太さの軸 `wght` は 100〜900。
- ライセンス：SIL Open Font License 1.1。著作権は「Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'」。

## 作り方

```
npm run fonts:build   # src/assets/fonts/ に作り直す
npm run fonts:check   # 作り直したものが、リポジトリのものと1バイトも違わないかを確かめる
```

- 道具：npm の `subset-font` 2.9.0（BSD-3-Clause。中で harfbuzz を使う）。版は `package-lock.json` で固定する。開発用で、dist/ には入らない。
- 字：Shift_JIS で書ける字（JIS X 0208 の字・半角の英数と記号・半角カナ）と、画面で使う記号（✓▲■●◐○－⊘？→… など。`build.mjs` の `EXTRA`）。合わせて 7,488 字。ない字は、端末の書体で出る（`design/tokens.css` の `--font-body` の2つ目から）。
- 太さ：画面で使う 400〜700 だけを残す（可変のまま、範囲を狭める）。
- name の欄の 0〜14（著作権・ライセンス・ライセンスの URL など）は残す。
- できたもの：`src/assets/fonts/NotoSansJP-subset.woff2`（2,079,464 バイト、SHA-256 `9d1a45d799b824e99ee1bdf3ac39bf49b9c9ad320d5ab15411cf3306cb57c9e6`）と、`OFL.txt` の写し。ビルドで dist/assets/ に入る。
- 2026-11-05、同じ PC で2回作り、1バイトも違わなかった（`npm run fonts:check`）。ほかの OS で同じになるかは、まだ確かめていない。

## ライセンスの決まりをどう守るか（SIL OFL 1.1）

- **字を絞るのは「改変」に当たる**（OFL FAQ 2.6）。改変したものも OFL 1.1 のまま配る。
- **予約された名前（Reserved Font Name）は「Source」**。書体の名前（Noto Sans JP）には入っていないので、名前は変えない。name の 0・7 の欄にある「Source」は、著作権と商標の表示なので残す（消すと表示の決まりに反する）。
- **ライセンスの文を一緒に配る**（OFL FAQ 2.4）：`OFL.txt` を書体と同じ所に置き、画面の結果の欄のいちばん下から開けるようにした（「書体：Noto Sans JP（© 2014-2021 Adobe。字を絞って同梱。SIL Open Font License 1.1）」）。2026-11-05 から、著作権の表示とライセンスの文は、ライセンスのページ（`/licenses.html`。ビルドの時に `site-licenses.ts` が作り、文は `dist/licenses/Noto-Sans-JP-OFL.txt` に置く）にまとめ、画面にはそのページへのリンクを1行だけ置く。
- **AGPL-3.0 のプログラムと一緒に配ってよい**（OFL FAQ 1.2・1.3：書体は書体のライセンスのまま、ほかのソフトと一緒に配れる）。書体を自分のサイトから配るのもよい（OFL FAQ 2.1）。
- 書体だけを売らない（OFL の条件 1）。このリポジトリでは売らない。

## 見出しの書体：Zen Maru Gothic（2026-11-05 夜。案 C）

本人が決定：**見出しだけ**に使い（太さは 700・900）、本文は Noto Sans JP のまま。**見出しで使う字だけに絞る**（重さを測ってから本人が選んだ）。

### 元のファイル（`source/zen-maru-gothic/`）

google/fonts のリポジトリの、コミット `92503f07b74eab956c1abf4956fbf46170716caa`（`ofl/zenmarugothic/` の最後の更新。2026-03-12）から、手を加えずに取った（2026-11-05 夜、本人が承認）。

| ファイル | 大きさ | SHA-256 |
|---|---|---|
| `ZenMaruGothic-Bold.ttf` | 3,779,008 バイト | `fe24426b9c8b5523a0146a8235c8674eccf0493af354a53ec895c3596d9eb745` |
| `ZenMaruGothic-Black.ttf` | 3,710,324 バイト | `6bd74fe76cd39ee0ec18775c3661d845343fb3f6f8fa09a3076638417baf741f` |
| `OFL.txt` | 4,402 バイト | `2a20cf7ce1909d8ee1e949095d340f7d7656705f7c810a2d6faf56800ad0cb3d` |
| `METADATA.pb` | 2,612 バイト | `ca7003349939baf51b9d493fc556be2a02bcae9adf954750b64968aeb0bef784` |

- 版：1.001（name 5 の値は `Version 1.001`）。字の数（cmap）は 7,812。
- ライセンス：SIL Open Font License 1.1。著作権は「Copyright 2021 The Zen Maru Gothic Project Authors」。**予約された名前（Reserved Font Name）の指定はない**（`OFL.txt` の 1 行目に書かれていない）。

### 作り方

```
npm run build           # ページを作る
npm run fonts:headings  # dist/ の h1〜h3 の字を集め、design/fonts/heading-chars.txt を書き直す（前の一覧の字は残す）
npm run fonts:build     # 書体を作り直す（見出しの書体は、一覧の字だけ）
npm run fonts:check     # 1 バイトも違わないかを確かめる
```

- 字：`heading-chars.txt` の字だけ。中身は、いつも入れる字（半角の英数と記号・ひらがな・カタカナ・よく使う記号）と、ビルドしたページの h1〜h3 の字。2026-11-05 夜は 471 字。
- 一覧はリポジトリに入れる。同じ一覧と同じ元からは、同じファイルができる（`fonts:check` で確かめる）。
- **ビルドのたびに**、h1〜h3 の字が一覧にあるかを `scripts/check-dist.mjs` が確かめ、漏れていたら止める（漏れた字は本文の書体で出てしまうため）。止まったら、上の順に作り直す。
- 画面のスクリプトが後から作る見出し（検査のページの結果など）の漢字は、一覧にないことがある。そのときは本文の書体で出る（字は消えない）。
- できたもの（`src/assets/fonts/zen-maru-gothic/`）：

| ファイル | 字 | 大きさ | SHA-256 |
|---|---|---|---|
| `ZenMaruGothic-Bold-subset.woff2` | 471 | 71,084 バイト | `408ed3ee94da8aa75e9af6c84df3d8b29fcc65e588ffe49274586a0639c05c5c` |
| `ZenMaruGothic-Black-subset.woff2` | 471 | 69,756 バイト | `c29df92339cbafd9989168e91e0123b7bbed2fd6f64b8dc831cb0e4565c4ba9b` |

- 比べたもの（2026-11-05 夜に測った）：Shift_JIS の 7,488 字で作ると、Bold 1,580,972 バイト・Black 1,560,284 バイト（2 つで 3,141,256 バイト）。見出しの字だけにすると、2 つで 140,840 バイト（約 22 分の 1）。
- 2026-11-05 夜、同じ PC で 2 回作り、1 バイトも違わなかった。
- `@font-face` は `design/fonts.css` にだけ書く（検査のページとサイトのページで共通）。書体の名前は「Zen Maru Gothic Omamori」、変数は `--font-display`（`design/tokens.css`）。
- ライセンスの文は、配る書体の横（`src/assets/fonts/zen-maru-gothic/OFL.txt`）に置き、ライセンスのページ（`/licenses.html`）に並べる（`docs/licenses.md` の「フォント・素材」から `site-licenses.ts` が作る）。

## 中の名前について（気づいたこと）

name の 1（ファミリーの名前）は、元のまま「Noto Sans JP Thin」になっている（元の可変の書体の既定が Thin のため）。画面では CSS の `@font-face` で「Noto Sans JP Omamori」という名前を付けて使うので、表示には関わらない。

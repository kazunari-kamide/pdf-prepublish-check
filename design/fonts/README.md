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
npm run build         # ページを作る（画面の字の一覧が古いと止まる。そのときは npx vite build だけをしてから次へ）
npm run fonts:ui      # dist/ の画面の字を集め、design/fonts/ui-chars.txt を書き直す（前の一覧の字は残す）
npm run fonts:build   # src/assets/fonts/ の書体と、design/fonts.css の本文の書体の @font-face を作り直す
npm run fonts:check   # 作り直したものが、リポジトリのものと1バイトも違わないかを確かめる
```

- 道具：npm の `subset-font` 2.9.0（BSD-3-Clause。中で harfbuzz を使う）。版は `package-lock.json` で固定する。開発用で、dist/ には入らない。
- 字：Shift_JIS で書ける字（JIS X 0208 の字・半角の英数と記号・半角カナ・NEC と IBM の拡張の字）と、画面で使う記号（✓▲▶■●◐○－⊘？→… など。`chars.mjs` の `EXTRA`。▶ は 2026-11-06 に足した）。合わせて 7,489 字。ない字は、端末の書体で出る（`design/tokens.css` の `--font-body` の2つ目から）。
- 太さ：画面で使う 400〜700 だけを残す（可変のまま、範囲を狭める）。
- name の欄の 0〜14（著作権・ライセンス・ライセンスの URL など）は残す。

### 塊に分けて、要る塊だけを読ませる（2026-11-06。案 A）

本人が決定：字の形は今のまま、最初の表示で読む書体を軽くする（前は 7,489 字を 1 つのファイル〔2,080,064 バイト〕にしていて、どのページでも丸ごと読んでいた）。

- **画面の字の塊**（`ui`）：`design/fonts/ui-chars.txt` の字（ビルドしたページの HTML・JS・CSS にある字）と `EXTRA`。
  - PDF.js の写しからは集めない。Worker の束（`*.worker-*.js`）は、検出ルールの結果の文（画面に出る）を含むので集めるが、文字コードの表（ASCII 以外の字が 64 字以上続く並び。漢字が 1 万字以上入っているが、画面には出さない）は外す。初めは Worker の束ごと外していて、結果の文の字（「組織」の「織」など）で残りの塊を余分に読んでいたので直した（2026-11-06、Chrome で測って見つけた）。画面に出ない言葉の一覧（名前を見分けるための辞書など）の字も入るので、画面の字の塊は 822 字・288,884 バイトから 1,078 字・347,264 バイトになった。
  - ビルドのたびに、画面の字が一覧にあるかを `scripts/check-dist.mjs` が確かめ、漏れていたら止める。漏れた字も残りの塊で正しく出るが、最初の表示で余分な塊を読むことになるため。止まったら、上の順に作り直す。
- **残りの字の塊**（`r01`〜`r12`）：全部の字を、字の番号（Unicode）の順に並べて同じ字の数ずつ 12 個に区切り、そこから画面の字を除いたもの（区切りを全部の字で決めるので、画面の字が 1 字増えても、変わるのは画面の字の塊と、その字があった塊の 2 つだけ）。利用者の PDF から抜き出した字（名前など）は、ここから、その字のある塊だけを読み足す。
- `design/fonts.css` の本文の書体の `@font-face`（塊ごと。`unicode-range` つき）は、`fonts:build` が書く（印の間を手で直さない）。塊どうしで範囲は重ならない。CSS を短くするため、書体にない字の番号（字と字の間のすき間）も、どこかの塊の範囲に含める（19,116 バイト・gzip で 7,629 バイト。塊の字だけを並べると約 45KB）。そうした字がページにあると、その塊を読むが、形がないので端末の書体で出る。すき間は、両どなりが同じ塊ならその塊、どちらかが画面の字の塊なら画面の字の塊（先に読むので余分に読まない）、それ以外は前の塊に入れる。初めは「前の塊」だけにしていたが、改行しない空白（U+00A0）が r01 に入り、結果の欄を出すたびに r01（約 66KB）を余分に読んでいたので直した（2026-11-06、Chrome で測って見つけた）。
- 分ける数（12）：2026-11-06 に 6 個と 12 個で測り、1 個が約 0.07〜0.22MB になる 12 個にした（6 個だと 1 個が 0.25〜0.37MB）。
- できたもの（`src/assets/fonts/`。ビルドで dist/assets/fonts/ に入る）と、`OFL.txt` の写し：

| ファイル | 字 | 大きさ | SHA-256 |
|---|---|---|---|
| `NotoSansJP-ui.woff2` | 1085 | 349,664 バイト | `beb180472d9904707ffc2b952e5e4dafcc02b736be8b4f7b3076ea6daa96ab33` |
| `NotoSansJP-r01.woff2` | 284 | 50,892 バイト | `d112b75a166d20452c60d99c20ee341755f13a3679cd06190e06d4d302cd7f46` |
| `NotoSansJP-r02.woff2` | 512 | 128,340 バイト | `870d54231608649f6c421f015724c67de29346bd98a5612780db405fdf0751b2` |
| `NotoSansJP-r03.woff2` | 538 | 144,396 バイト | `b60ccb05ae34db6747e6135c1ccc106f692d99e0a4932a7670818f057d1db671` |
| `NotoSansJP-r04.woff2` | 560 | 162,652 バイト | `a30580d0560703db070602e5ca97041bd6e9532d5e971df2e9fa9651b8fc2620` |
| `NotoSansJP-r05.woff2` | 525 | 148,584 バイト | `32601ee2f2744520ff3b60c96a1e2c104ff44c3daf6e2e2115b121b36142269c` |
| `NotoSansJP-r06.woff2` | 566 | 174,104 バイト | `5f102531c34a8bfc784607bebc51b0d4ec1bf545fd6a9c78bf0725cc470bffc8` |
| `NotoSansJP-r07.woff2` | 574 | 185,312 バイト | `003e15da8ca1d74164ebfda62903e370089c089125d1f0bada28d7e02d8a734f` |
| `NotoSansJP-r08.woff2` | 556 | 184,768 バイト | `d837b34f5ddb78af6b5f9491decb7204e85a00ddc630f2d828d0b24d1a1e9316` |
| `NotoSansJP-r09.woff2` | 599 | 186,364 バイト | `0b5672ce5fd534a6917811b676bbff0e67379ce11f6751bdb4e31e38d860b315` |
| `NotoSansJP-r10.woff2` | 541 | 166,480 バイト | `0280b641814bf8bfa6558000cfbdd7799df54cc5202532bda78a7e54a4872bf4` |
| `NotoSansJP-r11.woff2` | 565 | 180,020 バイト | `64872aaf93887bf8ed6a5eda690c8315a23e7ac433ce252580dc56518e61b85f` |
| `NotoSansJP-r12.woff2` | 584 | 213,136 バイト | `08f4c86a8e0468f00bbedda4f109f5daa9bce964afc1655f9dc5df370fdf165f` |

- 合わせて 2,274,712 バイト（2026-11-08。記事を 3 本足して画面の字が 2 字〔宛・心〕増え、画面の字の塊と、その字が入っていた r03・r04 を作り直した。その前は 2,274,540 バイト〔2026-11-07。結果の画面の案 A で画面の字が 5 字増え、画面の字の塊と、その字が入っていた残りの塊を作り直した。1 つのファイルとの比べは、2026-11-06 の測りで 193,424 バイト多い。全部の塊を読むことは、ふつうはない〕）。
- 2026-11-06、同じ PC で2回作り、1バイトも違わなかった（`npm run fonts:check`）。ほかの OS で同じになるかは、まだ確かめていない。

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

- 字：`heading-chars.txt` の字だけ。中身は、いつも入れる字（半角の英数と記号・ひらがな・カタカナ・よく使う記号）と、ビルドしたページの h1〜h3 の字と、検査のページで画面のスクリプトが作る h3（種類の見出し）に出うる字。2026-11-05 夜は 471 字、2026-11-06 に 16 字（検出ルールの名前の漢字 13 字と、見出しの前の印「ｉ」「▶」「▼」）を足して 487 字。2026-11-08 に、足した記事の題の 5 字（便・宛・忘・枚・郵）を足して 492 字。このうち「▶」は Zen Maru Gothic に字がないので、本文の書体（Noto Sans JP。`build.mjs` の `EXTRA` に入れた）で出る。
- 一覧はリポジトリに入れる。同じ一覧と同じ元からは、同じファイルができる（`fonts:check` で確かめる）。
- **ビルドのたびに**、h1〜h3 の字が一覧にあるかを `scripts/check-dist.mjs` が確かめ、漏れていたら止める（漏れた字は本文の書体で出てしまうため）。止まったら、上の順に作り直す。
- 画面のスクリプトが後から作る見出し（検査のページの種類の見出し `.group-head`）は、ビルドした HTML には出ないので、`check-dist.mjs` では確かめられない。代わりに `tests/heading-chars.test.ts` が、作る元（検出ルールの名前 `src/inspect/rules.ts` の `RULES`・`src/main.ts` の `make("h3", "…")`・`src/style.css` の見出しの前の印）から字を集め、一覧から漏れていないかを確かめる。漏れていたら、その字を `heading-chars.txt` に足し、`npm run fonts:build` で作り直す（見つける段で型が増えたときなど）。
- できたもの（`src/assets/fonts/zen-maru-gothic/`）：

| ファイル | 字 | 大きさ | SHA-256 |
|---|---|---|---|
| `ZenMaruGothic-Bold-subset.woff2` | 492 | 74,740 バイト | `9d63ed384deff18ca8d00ef88a5b76846ea0c7c6562f1bd865a230345834e21e` |
| `ZenMaruGothic-Black-subset.woff2` | 492 | 73,448 バイト | `36b55eeac61f8a149c7bf6fac9768b1dbb465c2f01a748018d92172b14a8dea4` |

- 比べたもの（2026-11-05 夜に測った）：Shift_JIS の 7,488 字で作ると、Bold 1,580,972 バイト・Black 1,560,284 バイト（2 つで 3,141,256 バイト）。見出しの字だけにすると、2 つで 140,840 バイト（約 22 分の 1）。
- 2026-11-05 夜、同じ PC で 2 回作り、1 バイトも違わなかった。
- `@font-face` は `design/fonts.css` にだけ書く（検査のページとサイトのページで共通）。書体の名前は「Zen Maru Gothic Omamori」、変数は `--font-display`（`design/tokens.css`）。
- ライセンスの文は、配る書体の横（`src/assets/fonts/zen-maru-gothic/OFL.txt`）に置き、ライセンスのページ（`/licenses.html`）に並べる（`docs/licenses.md` の「フォント・素材」から `site-licenses.ts` が作る）。

## 中の名前について（気づいたこと）

name の 1（ファミリーの名前）は、元のまま「Noto Sans JP Thin」になっている（元の可変の書体の既定が Thin のため）。画面では CSS の `@font-face` で「Noto Sans JP Omamori」という名前を付けて使うので、表示には関わらない。

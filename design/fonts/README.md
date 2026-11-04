<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# 同梱の書体（Noto Sans JP）

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
- **ライセンスの文を一緒に配る**（OFL FAQ 2.4）：`OFL.txt` を書体と同じ所に置き、画面の結果の欄のいちばん下から開けるようにした（「書体：Noto Sans JP（© 2014-2021 Adobe。字を絞って同梱。SIL Open Font License 1.1）」）。
- **AGPL-3.0 のプログラムと一緒に配ってよい**（OFL FAQ 1.2・1.3：書体は書体のライセンスのまま、ほかのソフトと一緒に配れる）。書体を自分のサイトから配るのもよい（OFL FAQ 2.1）。
- 書体だけを売らない（OFL の条件 1）。このリポジトリでは売らない。

## 中の名前について（気づいたこと）

name の 1（ファミリーの名前）は、元のまま「Noto Sans JP Thin」になっている（元の可変の書体の既定が Thin のため）。画面では CSS の `@font-face` で「Noto Sans JP Omamori」という名前を付けて使うので、表示には関わらない。

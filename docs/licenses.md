# 外部のライブラリ・素材のライセンス

このリポジトリのコードは AGPL-3.0-only です。外部のライブラリ・データ・フォント・素材を足すたびに、この一覧を更新します（CLAUDE.md §10）。

## 直接の依存（すべて開発用。配るもの＝ビルドした dist/ には入らない）

| 名前 | 版 | ライセンス | 何に使うか | 足した日 | 出典 |
|---|---|---|---|---|---|
| vite | 8.3.5 | MIT | 開発サーバーとビルド | 2026-11-03 | https://github.com/vitejs/vite |
| typescript | 7.0.2 | Apache-2.0 | 型の確かめ | 2026-11-03 | https://github.com/microsoft/TypeScript |
| vitest | 5.0.5 | MIT | テスト | 2026-11-03 | https://github.com/vitest-dev/vitest |
| @types/node | 24.19.2 | MIT | テストと設定ファイルの型の確かめ（Node の型）。ブラウザで動くコードの型の確かめには使わない | 2026-11-03 | https://github.com/DefinitelyTyped/DefinitelyTyped |

## 間接の依存（package-lock.json から数えた。2026-11-03）

合わせて 83 件（OS ごとの部品のうち、この PC に入らない分も含む）。

| ライセンス | 件数 | 主なもの |
|---|---|---|
| MIT | 46 | rolldown、postcss、chai、magic-string、undici-types など |
| Apache-2.0 | 23 | typescript と、その OS ごとの部品、detect-libc、expect-type |
| MPL-2.0 | 12 | lightningcss と、その OS ごとの部品（Vite が CSS の処理に使う） |
| ISC | 1 | picocolors |
| BSD-3-Clause | 1 | source-map-js |

数え直すときは、package-lock.json の各項目の `license` を読む。

### MPL-2.0 の lightningcss について（2026-11-03 本人が使うことを承認）

- **何をするものか**：ビルドのときに CSS を処理する道具。Vite が中で使う。
- **配るものに入らないことの確かめ方と結果**（2026-11-03）
  1. `npm run build` で dist/ を作った。dist/ にできたのは、HTML 1つ、CSS 1つ、JavaScript 2つ（画面と検査の Worker）の4ファイルだけだった。
  2. dist/ の全ファイルを `mpl` と `lightningcss` の文字で検索した。当たったのは CSS の `grid-template-columns` の中の文字（te**mpl**ate）だけで、lightningcss のコードやライセンスの文は入っていなかった。
  3. dist/ の JavaScript に入っているのは、このリポジトリの `src/` のコードを変換したものだけ（Vite の「先読みの補い」も設定で外している）。
- そのため、lightningcss は開発の道具として使うだけで、利用者に配るものには含まれない。lightningcss のファイルを直して配ることもしない。
- ライブラリを足したり Vite の版を上げたりしたら、同じ確かめをやり直す。

## 配るもの（dist/）に入る外部のコード

なし（2026-11-03 時点）。

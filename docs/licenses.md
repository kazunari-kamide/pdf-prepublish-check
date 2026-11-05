# 外部のライブラリ・素材のライセンス

このリポジトリのコードは AGPL-3.0-only です。外部のライブラリ・データ・フォント・素材を足すたびに、この一覧を更新します（CLAUDE.md §10）。

## 直接の依存（package.json ではすべて開発用。dist/ に入るものは「何に使うか」に書く。2026-11-03 時点）

| 名前 | 版 | ライセンス | 何に使うか | 足した日 | 出典 |
|---|---|---|---|---|---|
| vite | 8.3.5 | MIT | 開発サーバーとビルド | 2026-11-03 | https://github.com/vitejs/vite |
| typescript | 7.0.2 | Apache-2.0 | 型の確かめ | 2026-11-03 | https://github.com/microsoft/TypeScript |
| vitest | 5.0.5 | MIT | テスト | 2026-11-03 | https://github.com/vitest-dev/vitest |
| @types/node | 24.19.2 | MIT | テストと設定ファイルの型の確かめ（Node の型）。ブラウザで動くコードの型の確かめには使わない | 2026-11-03 | https://github.com/DefinitelyTyped/DefinitelyTyped |
| pdf-lib | 1.17.1 | MIT | 合成 PDF（テスト用 PDF）を作る。検出ルール rules/p6-text で PDF の中の部品を読む（2026-11-03 から。画面に組み込むと dist/ に入る） | 2026-11-03 | https://github.com/Hopding/pdf-lib |
| @pdf-lib/fontkit | 1.1.1 | MIT | 合成 PDF に日本語のフォントを埋め込む | 2026-11-03 | https://github.com/Hopding/fontkit |
| pdfjs-dist | 6.4.299 | Apache-2.0 | 検証器で PDF を読む（検出ルールとは別の読み方）。画面でページの絵を描く（2026-11-03 から。`build/pdf.min.mjs` と `build/pdf.worker.min.mjs` を、手を加えずに dist/ に入れて配る。理由は docs/no-network.md）。最新の 6.5.438 は 2026-11-01 に出たばかりなので、1つ前の版にした | 2026-11-03 | https://github.com/mozilla/pdf.js |
| @napi-rs/canvas | 1.1.0 | MIT | Node（採点・テスト）で、片付けが塗った JPEG の画像を JPEG に書き直す。片付けの見た目の確かめ（npm run check:sanitized）で PDF.js がページを描く。ブラウザでは使わない（ブラウザは OffscreenCanvas で書く。dist/ に入らない）。これまでは pdfjs-dist の任意の依存として入っていたものを、package.json に明記した | 2026-11-04 | https://github.com/Brooooooklyn/canvas |
| subset-font | 2.9.0 | BSD-3-Clause | 同梱の書体（Noto Sans JP）を、使う字だけに絞って WOFF2 にする（`npm run fonts:build`。design/fonts/README.md）。開発用で、dist/ には入らない。中で使う harfbuzzjs 1.6.4（MIT）・fontverter 2.0.0（BSD-3-Clause）・wawoff2 2.0.1（MIT）・woff2sfnt-sfnt2woff 1.0.0（MIT）・p-limit 3.1.0（MIT）・yocto-queue 0.1.0（MIT）・argparse 2.0.1（Python-2.0）と、前から入っていた pako 1.0.11（MIT AND Zlib）も、どれも AGPL-3.0 と両立する（2026-11-05 本人が承認） | 2026-11-05 | https://github.com/papandreou/subset-font |

## 間接の依存（package-lock.json から数えた。2026-11-03、pdf-lib などを足したあと）

合わせて 102 件（OS ごとの部品のうち、この PC に入らない分も含む）。

| ライセンス | 件数 | 主なもの |
|---|---|---|
| MIT | 62 | rolldown、postcss、chai、@napi-rs/canvas（pdfjs-dist が Node で使う依存。2026-11-04 から直接の依存にもした。上の表）、@pdf-lib/standard-fonts、@pdf-lib/upng など |
| Apache-2.0 | 24 | typescript と、その OS ごとの部品、pdfjs-dist、detect-libc、expect-type |
| MPL-2.0 | 12 | lightningcss と、その OS ごとの部品（Vite が CSS の処理に使う） |
| MIT AND Zlib | 1 | pako（pdf-lib が圧縮に使う） |
| ISC | 1 | picocolors |
| BSD-3-Clause | 1 | source-map-js |
| 0BSD | 1 | tslib（pdf-lib が使う） |

## 配信で使う道具（GitHub Actions の中だけ。dist/ には入らない。2026-11-04 時点）

| 名前 | 版 | ライセンス | 何に使うか | 足した日 | 出典 |
|---|---|---|---|---|---|
| actions/checkout | v6.1.0（`d23441a48e516b6c34aea4fa41551a30e30af803` で固定） | MIT | コードを取り出す | 2026-11-04 | https://github.com/actions/checkout |
| actions/setup-node | v6.5.0（`249970729cb0ef3589644e2896645e5dc5ba9c38` で固定） | MIT | Node を用意する | 2026-11-04 | https://github.com/actions/setup-node |
| lftp | Ubuntu 24.04 の apt のもの | GPL-3.0-or-later | dist/ を FTPS で上げる（コマンドとして動かすだけで、コードは取り込まない） | 2026-11-04 | https://lftp.yar.ru/ |

## フォント・素材

| 名前 | ライセンス | 何に使うか | 置き場所 | 出典 | 足した日 |
|---|---|---|---|---|---|
| BIZ UDゴシック Regular（BIZUDGothic-Regular.ttf、SHA-256 `709fcd41e3209fb765da750472f55ccdf925653e9fa7e1eb007cb65c8f749c75`） | SIL Open Font License 1.1（予約フォント名の指定なし）。全文は同じフォルダの `OFL.txt` | 合成 PDF の字。PDF には使う字だけを埋め込む。埋め込む前に、字のデータを 4 バイトの区切りにそろえる（@pdf-lib/fontkit の不具合を避けるため。字の形は変えない） | `fixtures/p6/fonts/`（案の段階では `proposals/p6/fixtures/p6/fonts/`） | https://github.com/google/fonts/tree/main/ofl/bizudgothic （Google Fonts のリポジトリ。Windows に入っているフォントは使っていない） | 2026-11-03 |
| Noto Sans JP 2.004（`NotoSansJP[wght].ttf`、SHA-256 `c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f`） | SIL Open Font License 1.1（予約フォント名「Source」）。全文は `design/fonts/source/OFL.txt` と、配る書体の横の `OFL.txt` | 画面の書体。Shift_JIS の字と画面の記号だけ、太さ 400〜700 に絞った WOFF2（`src/assets/fonts/NotoSansJP-subset.woff2`）を dist/ に入れて配る。字を絞るのは改変に当たるので、OFL 1.1 のまま配り、ライセンスの文も配る（ライセンスのページ `/licenses.html` から開ける） | 元：`design/fonts/source/`。配るもの：`src/assets/fonts/` | https://github.com/google/fonts/tree/66a36c8c94b1a5d992ee4e7f392fccfe4945767c/ofl/notosansjp （Google Fonts のリポジトリ。コミットを固定） | 2026-11-05 |

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

外部の素材としては、2026-11-05 から、同梱の書体（Noto Sans JP を絞ったもの）と、そのライセンスの文（`OFL.txt`）が dist/ に入る（上の「フォント・素材」）。

2026-11-05 から、サイトのライセンスのページ（`/licenses.html`）を、ビルドの時にこのファイルの表（「直接の依存」の出典・「フォント・素材」・「配信で使う道具」）と package-lock.json から作る（`site-licenses.ts`）。表の見出しや列の名前を変えるときは、`site-licenses.ts` も直す（合わなければビルドが止まって知らせる）。

## 値を参考にしたもの（コード・ファイルは写していない）

| 名前 | ライセンス | 参考にした値 | 使った所 | 出典 | 日 |
|---|---|---|---|---|---|
| デジタル庁デザインシステム（DADS） | サイトの説明・図（値だけを参考にした） | 角の丸め 8・12px、本文 16px 以上、字の間 2%、押せる所 44 CSS px 以上 | `design/tokens.css` | https://design.digital.go.jp/dads/foundations/ | 2026-11-05 |
| digital-go-jp/design-tokens | MIT | 黄 `#FFD43D`（`--color-primitive-yellow-300`） | `design/tokens.css` の `--color-focus` | https://github.com/digital-go-jp/design-tokens | 2026-11-05 |
| digital-go-jp/design-system-example-components-html | MIT | フォーカスの形（黒の 4px の線・2px 離す・黄の 2px の縁） | `design/tokens.css` の `--focus-*` | https://github.com/digital-go-jp/design-system-example-components-html | 2026-11-05 |

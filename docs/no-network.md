<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# 通信しないことの確かめ方

検査器は、利用者の PDF をブラウザの外に出さない（CLAUDE.md §2-1）。この約束を、次の4つの層で確かめる。どれか1つで「送れないことの保証」になるわけではない（CLAUDE.md §11-4）。

## 通信の決まり（2026-11-05 本人が決定。依頼 G の案 1）

- **ブラウザから外への要求は、最初の表示でも、PDF を入れた後でも 0 件。** アクセス解析のスクリプト・広告・外の書体は入れない。Cookie も使わない。
- 開いた回数・参照元などは、配信先のサーバーがふつうに残す記録（アクセスログ）で数える。ページには何も足さない。サーバーの記録に残るのは、ページやファイルを渡したときの IP アドレス・参照元・ブラウザの種類・時刻・求められた場所（URL）だけ。PDF の中身・ファイル名・画面の操作は、サーバーに届かないので残らない（利用者向けの説明は `/privacy.html`。中身は `src/site/privacy.ts`）。
- PDF を入れた後にも、同じサイトへの要求はある（検査の Worker・PDF.js のファイルを読み込むため）。中身は配信しているファイルの読み込みだけで、PDF は入らない。層 4 は、この数も「PDF を入れた後」として分けて出す。
- 捨てた案：Cloudflare Web Analytics のスクリプトを入れる。読み込みの時とページを離れる時に送るため、PDF を入れた後にも送られる。スクリプトの版を固定できず（SRI が使えない）、`connect-src 'none'`（PDF.js の例外の条件）も崩れる。
- 検索エンジンの確認（Google Search Console）は、トップページの `<meta>` か、`public/` に置く確認のファイルで行う（`src/site/search-console.ts`）。検索エンジンがサイトを読みに来たときに見るだけで、ブラウザからの通信は増えない。
- 記事の一覧のページの見出しまわりに、3D の飾りを置く（2026-11-05 本人が承認）。はじめは CSS の版を出し、小さな読み込み役（`src/site/site-3d.js`）が、ページを読み終えて手が空いてから、同じサイトの `/assets/omamori-3d-<ハッシュ>.js`（`src/site/omamori-3d-scene.js` を three.js と一緒に束ねたもの）を `import()` で読む。形はコードで組み立て、モデル・画像・書体のファイルは読まない。束ねたものに通信の仕組み（`fetch`・`XMLHttpRequest` など）は入っていない（層 2 で見る）。動きを減らす設定の人と、WebGL が使えない端末では読まない。サイトのページで許すスクリプトは、記事の一覧のページの検索のスクリプトと、この読み込み役の 2 つだけ（`scripts/check-dist.mjs`）。
- SNS などに貼るリンクに付ける `utm_source` は、ページのスクリプトでは読まない。サーバーの記録に残る URL の一部として数えるだけ（書き方は README）。

| 層 | 何を見るか | どこで |
|---|---|---|
| 1. 自分たちのコード | `src/`・`rules/`・`index.html` に、`fetch`・`XMLHttpRequest`・`WebSocket`・`sendBeacon`・外の URL・`innerHTML`・`eval` がないこと | `tests/no-network.test.ts`（`npm test`） |
| 2. ビルドしたもの | `dist/` の JavaScript（`.js`・`.mjs`）に、通信の仕組みがないこと。CSP の `<meta>` に `connect-src 'none'` があること。サイトのページ（記事・プライバシー）を含む、すべての HTML に同じ CSP があり、スクリプトを直接書かず、外から読み込まないこと（公式の URL を指す canonical だけは許す） | `scripts/check-dist.mjs`（`npm run build` の最後） |
| 3. CSP | ページ全体の読み込み先と送り先を絞る（`connect-src 'none'`、`img-src 'self' data: blob:` など） | `csp.ts` |
| 4. 本物のブラウザ | 合成 PDF を入れて、ページを開いてから閉じるまでの要求を「最初の表示」と「PDF を入れた後」に分けて数え、どちらも外への要求が0件であること。サイトのページも1つずつ開き、外への要求が0件であること | `scripts/check-browser.mjs`（`npm run check:browser`） |

## PDF.js の例外（2026-11-03 本人が決定。PR #31 の返事 2）

ページの絵を描くために、PDF.js（`pdfjs-dist`）をブラウザで使う。PDF.js の中には、URL から PDF を読む道や、書体・CMap を取り寄せる道のために、`fetch` と `XMLHttpRequest` を使うコードがある。層 2 は、これを見つけて止める。

そこで、層 2 に1つだけ例外を置く。**次の2つがそろうときだけ、そのファイルの通信の仕組みを許す。**

1. ファイルが、npm の `pdfjs-dist`（`package-lock.json` で版を固定）の `build/pdf.min.mjs` か `build/pdf.worker.min.mjs` と、**1バイトも違わない写し**であること（SHA-256 で照らす）。
2. CSP の `<meta>` に `connect-src 'none'` があること。

そして、この例外を使う代わりに、**層 4（本物のブラウザで外への要求が0件）を必ず通す。**

### なぜ、この形にしたか

- PDF.js を自分たちのコードと一緒にバンドルすると、写しかどうかを確かめられない（自分たちのコードに `fetch` が入っても、PDF.js のせいと区別できない）。そのため、PDF.js は手を加えずに、そのままのファイルとして配る（`src/render/pdf-view.ts` の `?url`）。
- 写しであることは、ハッシュで機械的に確かめられる。版は lockfile で固定しているので、更新は PR で見える。
- PDF.js の通信の道は、使わない設定にしている（バイト列だけを渡す。`cMapUrl`・`standardFontDataUrl`・`wasmUrl`・`iccUrl` を渡さない。`useWorkerFetch: false`、`useWasm: false`）。それでもコードは残るので、CSP で止め、ブラウザで数える。
- 捨てた案：PDF.js のファイルの名前で許す。名前は変えられるので、自分たちのコードを同じ名前のファイルに入れても通ってしまう。

### 層 4 の数え方

- Chrome（または Edge）を headless で動かし、DevTools の決まり（CDP）で、ページと、その中で作られた Worker（検査の Worker・整える処理の Worker・PDF.js の Worker）の要求を数える。
- 既定では、検査のあとに「整える」を押し、読み直し（整えた PDF の検査）が終わるまで待ち、「整えた PDF を保存する」を押す。その間の要求も数える。保存は `blob:` の URL を `a[download]` で開くだけで、通信ではない。保存された PDF が `%PDF-` で始まり、名前が画面のとおりかも確かめる（`--no-sanitize` で押さない）。
- 要求は「最初の表示」（ページを開いて読み込みが終わるまで）と「PDF を入れた後」に分けて出す。どちらも、外への要求は0件のはず（解析のスクリプトを入れていないため）。
- サイトのページ（`dist/` の HTML から拾う。記事の一覧・各記事・プライバシー）も1つずつ開き、200 で返り、外への要求・CSP の違反・console のエラーがないことを確かめる。
- 同じサイト（`vite preview`）・`blob:`・`data:` 以外への要求が1件でもあれば失敗。CSP に止められた要求（要求になる前に止まり、console にだけ出るものも）も1件でもあれば失敗。
- `npm run check:browser -- --self-test` で、わざと外へ要求を出し、数える仕組みが捕まえられることを確かめる（捕まえられなければ失敗）。
- 入れる PDF は `fixtures/` の合成 PDF だけ。

### できていないこと

- `--self-test` で確かめられたのは、ページの中から出した要求（画像・`fetch`）を捕まえることまで。Worker の中から出した要求を捕まえることは、点検用の Worker を CSP（`worker-src 'self'`）が止めるため、まだ確かめていない。
- 層 4 は、選んだ合成 PDF を入れたときの結果。どんな PDF でも0件であることの証明ではない。
- 配信先（Xserver）で、CSP を HTTP ヘッダーとして返せるか、`.mjs` を JavaScript の種類（`text/javascript`）で返すかは、配信の手順と一緒に確かめる。

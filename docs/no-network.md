<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# 通信しないことの確かめ方

検査器は、利用者の PDF をブラウザの外に出さない（CLAUDE.md §2-1）。この約束を、次の4つの層で確かめる。どれか1つで「送れないことの保証」になるわけではない（CLAUDE.md §11-4）。

| 層 | 何を見るか | どこで |
|---|---|---|
| 1. 自分たちのコード | `src/`・`rules/`・`index.html` に、`fetch`・`XMLHttpRequest`・`WebSocket`・`sendBeacon`・外の URL・`innerHTML`・`eval` がないこと | `tests/no-network.test.ts`（`npm test`） |
| 2. ビルドしたもの | `dist/` の JavaScript（`.js`・`.mjs`）に、通信の仕組みがないこと。CSP の `<meta>` に `connect-src 'none'` があること | `scripts/check-dist.mjs`（`npm run build` の最後） |
| 3. CSP | ページ全体の読み込み先と送り先を絞る（`connect-src 'none'`、`img-src 'self' data: blob:` など） | `csp.ts` |
| 4. 本物のブラウザ | 合成 PDF を入れて、ページを開いてから閉じるまでの要求を数え、外への要求が0件であること | `scripts/check-browser.mjs`（`npm run check:browser`） |

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

- Chrome（または Edge）を headless で動かし、DevTools の決まり（CDP）で、ページと、その中で作られた Worker（検査の Worker・PDF.js の Worker）の要求を数える。
- 同じサイト（`vite preview`）・`blob:`・`data:` 以外への要求が1件でもあれば失敗。CSP に止められた要求（要求になる前に止まり、console にだけ出るものも）も1件でもあれば失敗。
- `npm run check:browser -- --self-test` で、わざと外へ要求を出し、数える仕組みが捕まえられることを確かめる（捕まえられなければ失敗）。
- 入れる PDF は `fixtures/` の合成 PDF だけ。

### できていないこと

- `--self-test` で確かめられたのは、ページの中から出した要求（画像・`fetch`）を捕まえることまで。Worker の中から出した要求を捕まえることは、点検用の Worker を CSP（`worker-src 'self'`）が止めるため、まだ確かめていない。
- 層 4 は、選んだ合成 PDF を入れたときの結果。どんな PDF でも0件であることの証明ではない。
- 配信先（Xserver）で、CSP を HTTP ヘッダーとして返せるか、`.mjs` を JavaScript の種類（`text/javascript`）で返すかは、配信の手順と一緒に確かめる。

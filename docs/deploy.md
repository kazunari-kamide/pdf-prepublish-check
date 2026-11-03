<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# 配信の手順

公式の URL は `https://omamoripdf.com/` だけ（CLAUDE.md §11-6）。配信先は Xserver（静的ファイル）。

## 流れ

`main` に入ると、GitHub Actions（`.github/workflows/deploy.yml`）が次の順に動く。手で動かすこともできる（Actions の画面の「Run workflow」）。

1. `npm ci`（`package-lock.json` のとおりに入れる）
2. `npm run build`（型の確かめ → `vite build` → `scripts/check-dist.mjs`）
3. `npm test`
4. 配信するファイルの SHA-256 をログに出す
5. `lftp` で `dist/` を FTPS で上げる。先に `assets/` を足し、あとで `index.html`・`.htaccess` を上げて、`dist/` にないものを消す（`mirror -R --delete`）
6. `npm run check:live`：本番のヘッダー・ファイルの種類・中身を確かめる
7. `npm run check:browser -- --url https://omamoripdf.com/`：本番を本物のブラウザで開き、外への要求が0件かを確かめる（docs/no-network.md の層 4）

6 か 7 で合わなければ、配信は済んでいても、ジョブは失敗になる。失敗したら、本番の状態をすぐ確かめる。

## Secrets（Environment「production」。値はここにもログにも書かない）

デプロイできるブランチは `main` だけ。値は GitHub の画面でだけ見られる（ログでは伏せられる）。

| 名前 | 意味 |
|---|---|
| `FTP_HOST` | FTP の接続先のホスト名（<伏せ字>） |
| `FTP_USER` | デプロイ専用の FTP アカウントの名前（<伏せ字>） |
| `FTP_PASSWORD` | そのアカウントのパスワード。`lftp` には引数ではなく環境変数（`LFTP_PASSWORD`）で渡す |
| `FTP_DIR` | 上げる先のフォルダ。`/`（アカウントの一番上が、そのまま公開のフォルダのため） |

## FTP アカウントは、公開のフォルダ（public_html）の中だけに入れる

- デプロイ専用の FTP アカウントは、`omamoripdf.com` の `public_html` の中だけに入れる。ほかのドメインやフォルダには入れない。
- そのため、`mirror --delete` で消えるのは `public_html` の中だけ。Xserver の初期ページ（`index.html` など）は、初回の配信で上書き・削除される。
- パスワードが漏れたときに被害が及ぶのも、このフォルダまで。漏れたら、Xserver でパスワードを変え、`FTP_PASSWORD` を入れ替える。

## .htaccess（CSP などをヘッダーで返す）

- `dist/.htaccess` は、`npm run build` のときに `htaccess.ts` が `csp.ts` から作る。CSP の値は `csp.ts` の1か所だけに書く。
- 中身：CSP・`X-Content-Type-Options: nosniff`・`Referrer-Policy: no-referrer` などのヘッダー、`.mjs` を `text/javascript`・`.wasm` を `application/wasm` で返す指定、`www` つきと `http` から `https://omamoripdf.com/` への 301。
- `index.html` の `<meta>` の CSP も残す。ヘッダーの CSP は、`<meta>` の CSP に `frame-ancestors 'none'`（`<meta>` では効かない）を足しただけで、ほかは同じ値。2つの CSP は両方とも効くが、値が同じなので食い違わない。`.htaccess` が効かなかったときの守りにもなる。食い違いは `scripts/check-dist.mjs` が止める。
- Xserver の「HTTPS転送設定」は、`public_html` の `.htaccess` に転送の行を書く仕組みなので（推測。Xserver のマニュアルで確かめていない）、配信のたびに上書きされても転送が消えないよう、同じ転送を `.htaccess` に書いている。

## 本番の確かめ（`npm run check:live`）

手元でも動かせる（先に `npm run build` で、配信したものと同じ `dist/` を作る）。

- トップページの `csp.ts` のヘッダーが、同じ値で1つずつ付いている（サーバーが別の値を足して二重になっても止まる）
- `.mjs` が `text/javascript`、`.wasm` が `application/wasm` で返る（今は `.wasm` を配っていないので、省いたと表示する）
- `dist/` のファイルが本番と1バイトも違わない。`.htaccess` は外から読めない
- `http://` と `www` つきは、301 で `https://omamoripdf.com/` へ（`www` の名前が引けないときは、省いたと表示する）

## まだ確かめていないこと

- Xserver の前に立つ nginx のキャッシュなどで、静的ファイルにヘッダーが付かないことがあるか。初回の配信のあと `check:live` で確かめる。
- GitHub Actions の Ubuntu で、`check:browser` の Chrome が headless で動くか。初回の配信で確かめる。
- `www.omamoripdf.com` の名前（DNS）と証明書があるか。

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# 配信の手順

公式の URL は `https://omamoripdf.com/` だけ（CLAUDE.md §11-6）。配信先は Xserver（静的ファイル）。

## 流れ

`main` に入ると、GitHub Actions（`.github/workflows/deploy.yml`）が動く。手で動かすこともできる（Actions の画面の「Run workflow」）。ジョブは 2 つに分けている。依存のライブラリやビルドの道具が、配信の Secrets に手を届かせないようにするため。

**① ビルドとテスト（`build`。Environment なし・Secrets なし）**

1. `npm ci --ignore-scripts`（`package-lock.json` のとおりに入れる。依存のインストールのスクリプトは動かさない。2026-11-05 の時点で、スクリプトを持つ依存は macOS でだけ使う `fsevents` だけで、これがなくてもビルドとテストは通る）
2. `npm run build`（型の確かめ → `vite build` → `scripts/check-dist.mjs`）
3. `npm test`
4. 配信するファイルごとの SHA-256 の一覧（`dist.sha256`）をログに出し、一覧そのもののハッシュをジョブの出力にする
5. `dist/` と `dist.sha256` を成果物にする（`.htaccess` が落ちないよう、`.` で始まるファイルも含める。7 日で消える）

**② 配信（`deploy`。Environment「production」。①のあとに動く）**

1. 確かめのスクリプトのためにコードを取り出し、Node を用意する。**npm は動かさない**（`check-live` と `check-browser` は、`node:` の部品と `csp.ts`・`htaccess.ts` しか読まない。`check-browser` は、手元の `vite preview` を立てるときだけ `vite` を読む）
2. 成果物を受け取る。受け取った中身が食い違えば止める（`digest-mismatch: error`）
3. ハッシュを照らす：一覧のハッシュが①の出力と同じこと、`dist/` のファイルが一覧と1つも違わないこと、一覧にないファイルがないこと
4. `lftp` で `dist/` を FTPS で上げる。先に `assets/` を足し、あとで `check.html`（検査のページ）・`.htaccess` を上げて、`dist/` にないものを消す（`mirror -R --delete`）
5. `node scripts/check-live.mjs`：本番のヘッダー・ファイルの種類・中身を確かめる
6. `node scripts/check-browser.mjs --url https://omamoripdf.com/check`：本番の検査のページを本物のブラウザで開き、外への要求が0件かを確かめる（docs/no-network.md の層 4）

5 か 6 で合わなければ、配信は済んでいても、ジョブは失敗になる。失敗したら、本番の状態をすぐ確かめる。

**③ ハッシュの一覧をリリースに載せる（`release`。②が成功したときだけ。2026-11-06 決定、D171）**

公開中のサイトが公開のコードと同じものだと、誰でも確かめられるようにするため（CLAUDE.md §11-4）。

1. 成果物を受け取り、一覧のハッシュが①の出力と同じことを確かめる
2. リリース `deploy-<コミットの短い印 7 字>` を作り、本文に一覧（`dist.sha256` の中身）とコミット・配信の記録の場所を載せ、`dist.sha256` を添付する
3. 同じコミットを手で配信し直したときは、作り直さない。前のリリースの一覧と同じかだけを確かめ、違えば失敗にする（同じコードから違うものができたことになるため）

書き込みの権限（`contents: write`）は、このジョブだけに渡す。Environment・Secrets は使わず、コードも取り出さない。

### 手元で確かめる

1. リリースのコミットを、行の終わりを LF のまま取り出す（Windows では `git clone -c core.autocrlf=false …`。CRLF に変えて取り出すと、作るファイルの一部が変わる）
2. Node 24.19.0 で `npm ci --ignore-scripts`、`npm run build`
3. `cd dist && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum` の出力を、リリースの一覧と比べる（Windows の Git Bash では、行の `*`（バイナリの印）を外して比べる：`| sed 's/ \*\.\//  .\//'`）

2026-11-06 に、769c439 の配信の記録の一覧（357 個）と、Windows（Node 24.19.0、LF で取り出した）で作った一覧を比べ、357 個すべてが同じだった。CRLF で取り出したときは 357 個中 200 個だけが同じだった。

依存の更新は Dependabot が PR で知らせる（`.github/dependabot.yml`。GitHub Actions と npm を週に1回。出てから 14 日たつまでは知らせない）。マージするかは人が決める。

## Secrets（Environment「production」。値はここにもログにも書かない）

デプロイできるブランチは `main` だけ。値は GitHub の画面でだけ見られる（ログでは伏せられる）。

| 名前 | 意味 |
|---|---|
| `FTP_HOST` | FTP の接続先のホスト名（<伏せ字>） |
| `FTP_USER` | デプロイ専用の FTP アカウントの名前（<伏せ字>） |
| `FTP_PASSWORD` | そのアカウントのパスワード。`lftp` には引数ではなく環境変数（`LFTP_PASSWORD`）で渡す |

上げる先は FTP アカウントの一番上（`/` = `public_html`）で、ワークフローに直接書く。値が `/` の Secret はログの `/` を全部伏せてしまうので、Secret にしない。

## FTP アカウントは、公開のフォルダ（public_html）の中だけに入れる

- デプロイ専用の FTP アカウントは、`omamoripdf.com` の `public_html` の中だけに入れる。ほかのドメインやフォルダには入れない。
- そのため、`mirror --delete` で消えるのは `public_html` の中だけ。Xserver の初期ページ（`index.html` など）は、初回の配信で上書き・削除される。
- パスワードが漏れたときに被害が及ぶのも、このフォルダまで。漏れたら、Xserver でパスワードを変え、`FTP_PASSWORD` を入れ替える。

## .htaccess（CSP などをヘッダーで返す）

- `dist/.htaccess` は、`npm run build` のときに `htaccess.ts` が `csp.ts` から作る。CSP の値は `csp.ts` の1か所だけに書く。
- 中身：CSP・`X-Content-Type-Options: nosniff`・`Referrer-Policy: no-referrer`・`X-Frame-Options: DENY` などのヘッダー、`.mjs` を `text/javascript`・`.wasm` を `application/wasm` で返す指定、`www` つきと `http` から `https://omamoripdf.com/` への 301。
- `Options -Indexes` は書かない（2026-11-05 に外した）。フォルダの一覧は、いまの配信先ですでに 403 で出ておらず、書いても得がないのに、配信先が `.htaccess` の `Options` を許していないとサイト全体が 500 になるおそれがあるため。一覧が出ていないことは `check-live` で確かめる。
- 見つからないときは、自前の 404 のページ（`ErrorDocument 404 /404.html`。`site.ts` が作る）を返す。ヘッダーは `Header always set` で付けるので、404 の応答にも同じ CSP などが付く。
- キャッシュ（`Cache-Control`）：ふだんは `no-cache`（毎回、新しい版があるかを確かめさせる。古い画面が残らないように）。名前に中身のハッシュが付いた `assets/` の、見つかった応答（200）だけ `max-age=31536000, immutable`。`assets/` に名前の変わらないファイルを置くと古いものが残るので、`scripts/check-dist.mjs` が、ハッシュのない名前を止める。
- HSTS（`Strict-Transport-Security`）：条件を付けずに、いつも付ける。値は `htaccess.ts` の `HSTS`。延ばし方は下。
  - 初めは https の応答だけに付けていた（`"expr=%{HTTPS} == 'on'"`）が、2026-11-05 の初回の配信の `check-live` で、本番の応答に付いていなかった。Xserver は前の nginx で https を受けて後ろの Apache に渡すので、この条件が真にならないため（推測）。ブラウザは http の応答の HSTS を使わず（RFC 6797 §8.1）、http で来た要求は 301 で https へ移すだけなので、条件を外した。`X-Forwarded-Proto` で見分ける形は、nginx がそのヘッダーを付けるかが分からず、同じように黙って付かなくなるおそれがあるので選ばなかった。

### HSTS の延ばし方

HSTS は、一度ブラウザに覚えさせると、期間が切れるまで取り消せない（https で開けなくなると、その間はサイトに入れない）。そのため短い期間で始め、本番で問題がないことを確かめてから延ばす。

1. **いま**：`max-age=86400`（1 日）
2. 1 週間、`check-live` が通り、https の証明書の更新（自動）が一度でも済んでいれば：`max-age=604800`（1 週）
3. さらに 2 週間問題がなければ：`max-age=2592000`（30 日）
4. さらに 1 か月問題がなければ：`max-age=31536000`（1 年）
5. `includeSubDomains`：`www` など、使っているサブドメインがすべて https で開けると確かめてから。使っていないサブドメインも含めて縛ることになる。
6. `preload`（ブラウザに最初から組み込ませる）：取り消しに数か月かかる。1〜5 が済み、ドメインを長く使うと決めてから、本人が決める。

延ばすときは `htaccess.ts` の `HSTS` と、`tests/htaccess.test.ts` の期待を直す（`check-live` は `HSTS` の値と照らす）。縮めるときも同じ（ただし、すでに覚えたブラウザは、前の期間が切れるまで忘れない）。
- `check.html`（検査のページ）の `<meta>` の CSP も残す。ヘッダーの CSP は、`<meta>` の CSP に `frame-ancestors 'none'`（`<meta>` では効かない）を足しただけで、ほかは同じ値。2つの CSP は両方とも効くが、値が同じなので食い違わない。`.htaccess` が効かなかったときの守りにもなる。食い違いは `scripts/check-dist.mjs` が止める。
- Xserver の「HTTPS転送設定」は、`public_html` の `.htaccess` に転送の行を書く仕組みなので（推測。Xserver のマニュアルで確かめていない）、配信のたびに上書きされても転送が消えないよう、同じ転送を `.htaccess` に書いている。

## お問い合わせのフォーム（PHP）

- `dist/contact-send.php` は、配信で `public_html/` に上がる（ほかのファイルと同じ）。届け先などの本物の設定（`contact-config.php`）と迷惑防止の記録（`contact-data/`）は、`public_html` の **1 つ上**に本人が置く。配信用の FTP アカウントはそこに入れないので、配信（`mirror --delete`）で消えたり上書きされたりしない。
- お問い合わせのページの場所は `/contact`（`/contact.html` は 301 で移す）。`.htaccess` が `/contact` を中で `contact-send.php` へ回し、PHP がフォームを返す。
- `.htaccess` は、`contact.html` と `contact-send.php` にだけ、CSP の `form-action 'self'` と `Referrer-Policy: same-origin` を返す（`<FilesMatch>`。値は `csp.ts` の `contactHeaders`）。
- 決まり・本人がすること（送信元のアドレス・SPF・DKIM・設定のファイルの置き方）は `docs/contact.md`。

## 開いた回数の数え方（アクセス解析）

- ページには解析のスクリプトを入れない（2026-11-05 本人が決定。`docs/no-network.md` の「通信の決まり」）。そのため、解析のための Secrets はない。
- 開いた回数・参照元・ブラウザの種類は、Xserver のアクセスログ（サーバーパネルの「アクセスログ」「アクセス解析」）で見る。ログの残る期間と、取り出し方は【本人が Xserver のマニュアルで確かめる】。
- SNS などに貼るリンクには `?utm_source=<貼った所>` を付ける（README）。アクセスログの「求められた場所」に、そのまま残る。

## 検索エンジンの確認（Google Search Console）

確認のコードは秘密の値ではない（公開されるページに載る）。同じ手順で同じものをビルドできるよう、リポジトリに書く。

- **メタタグで確かめるとき**：`src/site/search-console.ts` の `GOOGLE_SITE_VERIFICATION` に、渡された `content="…"` の中の値を入れる。ビルドでトップページの `<head>` に `<meta name="google-site-verification" …>` が入る。
- **確認のファイルで確かめるとき**：渡された `googleXXXX.html` を、中身を変えずに `public/` に置く。ビルドで `dist/` の一番上に写る。`scripts/check-dist.mjs` は、中身が `google-site-verification: <ファイルの名前>` の1行のときだけ通す。
- サイトマップは `https://omamoripdf.com/sitemap.xml`（`site.ts` がビルドの時に作る）。Search Console の「サイトマップ」に、この場所を入れる。

## 本番の確かめ（`npm run check:live`）

手元でも動かせる（先に `npm run build` で、配信したものと同じ `dist/` を作る）。

- 検査のページ（`/check`）の `csp.ts` のヘッダーが、同じ値で1つずつ付いている（サーバーが別の値を足して二重になっても止まる）
- `/` が `/check` へ 302 で移る（`?sample=1` などの `?` のあとも引き継ぐ）。302 の応答にも、同じヘッダーと `Strict-Transport-Security` が付いている。`/check/`・`/check.html`・前の `/index.html` は `/check` へ 301（2026-11-05 に検査のページを `/` から `/check` へ移した。`/` はハッカソンのあとに別の機能を置くので、ブラウザが覚える 301 にしない）
- サイトのページ（記事の一覧・記事1つ・プライバシー）も 200 で返り、同じヘッダーが付いている
- 検査のページが、外のサイトからスクリプトを読み込んでいない
- https の応答に `Strict-Transport-Security`（`htaccess.ts` の `HSTS`）が付いている。`Cache-Control` が、検査のページは `no-cache`、`assets/` のファイルは `max-age=31536000, immutable`
- 見つからない場所（一番上と `assets/` の中）が、404 で、自前の 404 のページ（`dist/404.html` と同じ中身）を、同じヘッダー・`no-cache` で返す。`assets/` を開いても、ファイルの一覧が出ない
- `.mjs` が `text/javascript`、`.wasm` が `application/wasm` で返る（今は `.wasm` を配っていないので、省いたと表示する）
- お問い合わせのページと `contact-send.php` だけ、`form-action 'self'` の CSP と `same-origin` の参照元の決まり。`/contact` と `contact-send.php` は、PHP のソースを出さずにフォームを返し、中身は `dist/contact.html` と開いた時刻の印だけが違う。`/contact.html` は `/contact` へ 301
- `dist/` のファイルが本番と1バイトも違わない（`contact-send.php` と `contact.html` は、PHP が返すので上で別に照らす）。`.htaccess` は外から読めない
- `http://` と `www` つきは、301 で `https://omamoripdf.com/` へ（`www` の名前が引けないときは、省いたと表示する）

## まだ確かめていないこと

- `Header` の `expr=`（`%{REQUEST_STATUS}`）は、2026-11-05 の初回の配信の `check-live` で、`assets/` のキャッシュが付くことを確かめた（`%{HTTPS}` は真にならなかったので、HSTS では使わない）。
- 成果物の受け渡し（upload-artifact v7.0.2・download-artifact v8.0.2。2026-11-05 時点のいちばん新しい版を SHA で固定）が、初回の配信で動くか。

- Xserver の前に立つ nginx のキャッシュなどで、静的ファイルにヘッダーが付かないことがあるか。初回の配信のあと `check:live` で確かめる。
- GitHub Actions の Ubuntu で、`check:browser` の Chrome が headless で動くか。初回の配信で確かめる。
- `www.omamoripdf.com` の名前（DNS）と証明書があるか。
- `https://omamoripdf.com/articles`（末尾の / なし）を開いたとき、Apache が `/articles/` へ送り直すか。送り直す先が `http://` になって、もう一度 301 が挟まらないか。

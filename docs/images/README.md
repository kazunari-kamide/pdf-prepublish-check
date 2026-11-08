<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# README の画像

| ファイル | 中身 |
|---|---|
| `check-demo.gif` | 本番の検査ページ（`https://omamoripdf.com/check`）に、架空の見本 PDF（`demo/scan-minutes/scan-minutes-large-synthetic.pdf`。中身はすべて架空）を置き、3 か所が見つかる → 「整える」→ 確かめの窓 → 読み直して 0 か所、までを撮ったもの。2026-11-08 に撮影。11.3 秒・10 コマ／秒・960 × 600（下の帯を除く） |

- 撮り方：headless の Chrome を DevTools Protocol で動かし、画面の動き（screencast のコマ）を撮りました。押す所は、本物のマウスの操作で押しています。
- 縮めたのは待ち時間だけです（読み込みの 4.7 秒を 1.6 秒に、整える間の 4.6 秒を 1.4 秒に）。整えた直後の 0.2 秒は、ページを描き直す間で白く抜けるので飛ばしました。
- PDF を置いたあと、ほかのサイトへの要求は 0 件でした（ページの中で作る `data:` の画像だけ）。
- 下の帯の字は、あとから足したものです。書体は同梱の Noto Sans JP（`design/fonts/source/`）。

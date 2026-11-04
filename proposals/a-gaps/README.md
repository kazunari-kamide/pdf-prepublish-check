# 採点する側の直しの案：P6 の合成 PDF に、使われていないフォントを残さない

CLAUDE.md §2-3 に従い、`fixtures/` に入れる直しの案をここに置く。人が中身を見て、移すコミットを作る。

## 何を直すか

`fixtures/p6/build.mjs` は、合成 PDF を1つ作るたびに、最初に BIZ UDゴシックを埋め込む（`embedFont`）。
pdf-lib は、埋め込むと決めたフォントを、ページで使ったかどうかにかかわらず保存のときに書き込む。
そのため、字を1つも書かないスキャンの見本 6 個に、どこからも使われていないフォントの部品が 5 個ずつ残っていた
（フォントの辞書 3 個・フォントの本体 1 個・文字の対応表 1 個。P5 の検証器 `verifier/p5-cli.mjs` でも `not_counted` の structure として 5 件出る）。

- 対象：`p6-i01-scan-rect`・`p6-i02-scan-black-image`・`p6-i03-scan-square-annotation`・`p6-i04-scan-redact-annotation`・`p6-i05-scan-several`・`p6-n02-scan-burned`
- 本物のスキャンの PDF には、ふつう使われていないフォントは入っていない。見本だけに余計な部品があると、P5（旧版の残存）の検出ルールが、版が1つしかない見本で「前の版の残り」と出してしまう（検出ルール 1.1.0 では、フォントの本体のバイト列がたまたま字の命令に見えて「高」になった。1.2.0 でこの取り違えは直したが、見本そのものも本物に近づける）。

## なぜこう直すか

`Fixture` の `font` を「読んだら使ったと印をつける」形にし、保存の前に、使わなかったフォントを pdf-lib の埋め込み待ちの一覧から外す。

- 捨てた案：フォントを使う見本だけで `embedFont` を呼ぶ（見本ごとに印をつける）。見本を足すたびに付け忘れが起きるので、使ったかどうかを自動で見る形にした。
- フォントの番号は `embedFont` のときに1つ取られるので、外した見本ではその番号が xref に載らない（空き番。`0 3` と `4 4` の2つの区切りになる）。ほかのオブジェクトの番号は変わらないので、正解データ（`*.expected.json`）は 26 個とも1バイトも変わらない。

## 直した版で確かめたこと（2026-11-04）

直した版 `proposals/a-gaps/p6/build.mjs` を、作業用のフォルダ（`.tmp/a-gaps/p6run/`。コミットしない）に写し、同じフォントを置いて実行した。

| 確かめたこと | 結果 |
|---|---|
| 作れた数 | 合成 PDF 26 個（漏れ 23 件、漏れでない 16 件）。いまと同じ |
| 正解データ（`*.expected.json`） | 26 個とも、いまの `fixtures/p6` と同じバイト列 |
| PDF の SHA-256 | 字を書く 20 個は同じ。スキャンの見本 6 個だけ変わる（下の表） |
| 使われていないフォント | 6 個とも、P5 の検出ルール（1.2.0）の `cleanupOnly` が 0 件、P5 の検証器の `not_counted` が 0 件 |
| P6 の検証器（`verifier/cli.mjs`）の出力 | 6 個とも、いまの PDF と同じ（`verifier`・`file` の欄を除いて比べた） |
| PDF.js（6.4.299）で開く | `p6-i01`・`p6-n02` で1ページ目を読み、警告なし |

SHA-256 が変わる 6 個：

| ファイル | いま | 直した版 |
|---|---|---|
| p6-i01-scan-rect.pdf | `21ea8a43ffa5f4f6…` | `acc7a9edacfa2991…` |
| p6-i02-scan-black-image.pdf | `a922661468d305d2…` | `4a3ff2b0e1a01463…` |
| p6-i03-scan-square-annotation.pdf | `ba33d00eec019149…` | `b119cbc07d00a608…` |
| p6-i04-scan-redact-annotation.pdf | `cc154c560f7e5055…` | `ae0f49dcb613785c…` |
| p6-i05-scan-several.pdf | `c46e4fd46ca245c6…` | `365ad846986941b4…` |
| p6-n02-scan-burned.pdf | `cfef84158c222b71…` | `3573cc6a12758b8a…` |

## 移し方（人が行う）

```
cp proposals/a-gaps/p6/build.mjs fixtures/p6/build.mjs
node fixtures/p6/build.mjs        # PDF・正解データ・index.md・hashes.txt を作り直す
git diff --stat fixtures/p6        # 変わるのは build.mjs・index.md・hashes.txt と、上の 6 個の PDF だけのはず
npm run eval:p6
npx vitest run tests/p6 tests/sanitize-reinspect.test.ts tests/inspect-all.test.ts
```

- `proposals/scoring-fixes/fixtures/p6/build.mjs` は、いまの `fixtures/p6/build.mjs` と同じ中身。そちらを先に移す場合も、同じ直しを当てる。
- 移したあとは、この `proposals/a-gaps/` を消してよい。

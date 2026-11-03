# 採点する側の案：P9（添付ファイル）

CLAUDE.md §2-3 に従い、`rubric/`・`verifier/`・`fixtures/` に入れるものの案を、ここに置く。人が中身を見て、移すコミットを作る。

## P9 を選んだ理由

- **見つかったときの被害が大きい。** 元の Excel・Word がそのまま入っていると、黒塗りする前の表や、公開しない列（氏名・住所など）がまるごと取り出せる。
- **作りやすい。** 合成 PDF は pdf-lib の `attach` と、手で組んだファイル指定で作れる。正解（どの添付が残っているか）が、作り方からそのまま決まる。
- PRD でも、P1・P5・P9 は削らないと決めている（docs/prd.md §10）。P1 の案は PR #10。

## 中身

```
proposals/p9/
  rubric/p9.md, p9.json             合格基準の案
  verifier/p9.mjs                   検証器の中身（PDF → 残っている添付の一覧）
  verifier/p9-pdfbytes.mjs          PDF のバイト列の読み方（pdf-lib を使わない）
  verifier/p9-cli.mjs               コマンド（node verifier/p9-cli.mjs 入力.pdf）
  verifier/p9-schema.json           出力の形
  verifier/p9-selfcheck.mjs         合成 PDF と正解データで、検証器そのものを確かめる
  verifier/P9.md                    考え方・限界・確かめた結果
  fixtures/p9/build.mjs             合成 PDF と正解データを作るスクリプト
  fixtures/p9/*.pdf                 合成 PDF（20 個）
  fixtures/p9/*.expected.json       正解データ（漏れ 21 件、漏れでないもの 15 件）
  fixtures/p9/index.md, hashes.txt  一覧と SHA-256（build.mjs が書く）
  fixtures/p9/README.md             正解データの形
```

- `p9-pdfbytes.mjs` は、P1 の案の検証器（`proposals/p1/verifier/p1.mjs`）の読み方の部分と同じ考え方で書いた写し。P1 と P9 を別々に移せるように、いまは別のファイルにした。両方を移したら、1つにまとめるかを決めてほしい（決めてほしいこと 5）。

## 移し方（人が行う）

```
git mv proposals/p9/rubric/p9.md rubric/p9.md
git mv proposals/p9/rubric/p9.json rubric/p9.json
git mv proposals/p9/verifier/p9.mjs verifier/p9.mjs
git mv proposals/p9/verifier/p9-pdfbytes.mjs verifier/p9-pdfbytes.mjs
git mv proposals/p9/verifier/p9-cli.mjs verifier/p9-cli.mjs
git mv proposals/p9/verifier/p9-schema.json verifier/p9-schema.json
git mv proposals/p9/verifier/p9-selfcheck.mjs verifier/p9-selfcheck.mjs
git mv proposals/p9/verifier/P9.md verifier/P9.md
git mv proposals/p9/fixtures/p9 fixtures/p9
git commit -m "P9 の合格基準・検証器・合成 PDF を、採点する側に移す"
```

移したあとの確かめ：

```
node verifier/p9-selfcheck.mjs
node fixtures/p9/build.mjs && git status --short fixtures   # 何も変わらなければ、作り直しても同じ
```

## 確かめた結果（2026-11-03、Node 24.19.0、Windows）

- `node proposals/p9/verifier/p9-selfcheck.mjs`：合成 PDF 20 個すべてで正解データと合った。漏れ 21 件中 21 件、漏れでないもの 15 件中 0 件に反応、正解にない出力 0 件。2つの読み方（バイト列・PDF.js）が食い違った PDF は 0 個。壊れた入力など 6 種で止まらなかった。
- `node proposals/p9/fixtures/p9/build.mjs` を3回続けて実行し、PDF・正解データ・一覧の SHA-256 がすべて同じだった。
- `npm test`・`npm run typecheck` は通過（下の PR の本文に結果）。

## 独立について

- この案は、P6 の検出ルールを書いたのと同じセッションが書いた。P9 の検出ルールはまだない。
- P9 の検出ルールは、この案の中身を読まない別のセッションで書くのがよい（P1 と同じ。決めてほしいこと 4）。

## 決めてほしいこと

1. **どこからも指されていない添付（`unreferenced`）を、漏れと数えるか。** 案では数える（`p9-08`、`p9-09`）。画面では見えないが、ファイルの中に中身が残っていて取り出せるため。
   - 片付けで「名前の木から外すだけ」では残り 0 件にならず、中身のストリームまで消す必要がある。
   - 増分更新で外したもの（`p9-09`）は P5 とも重なる。P5 の案で、重なる分をどう数えるかも決める必要がある。
2. **照らし合わせで、場所（`where`）まで同じことを求めるか。** 案では求める。同じ中身を名前の木と注釈の両方が指すとき、どちらの場所として報告するかの順番（names → annotation → af）も決まりに入れた。求めないなら、ファイル名だけで結ぶ。
3. **中身のない（外のファイルを指すだけの）ファイル指定を、漏れでないものとするか。** 案では漏れでないもの。ただし、ファイル名そのもの（個人名が入ることがある）は残る。ファイル名を P9 で数えるか、別の型にするか。
4. **P9 の検出ルールを、別のセッションで書くか**（上の「独立について」）。
5. **`p9-pdfbytes.mjs` と P1 の検証器の読み方を、移したあとに1つのファイルにまとめるか。** まとめると直す所が1つになるが、P1 と P9 の検証器が同じ間違いを共有する。
6. 合格の値は、P6 にならって「検出率 95% 以上、誤検知率 5% 以下、片付けたあとに残る情報 0 件」とする案。

## 書き込みの見張りに止められたこと（そのまま）

1. P1 の案の読み方の部分を写すため、シェルのヒアドキュメントで `.tmp/` に小さなスクリプトを書こうとした（スクリプトの中で `proposals/p9/verifier/p9-pdfbytes.mjs` に書き出す）。
   - 表示：「止めました：シェルのコマンドが verifier/ に書き込もうとしています（シェルやスクリプトに読ませる部分に、書き込みらしい操作がある）」
   - 原因（推測）：書き先 `proposals/p9/verifier/…` の中の `verifier/` を、守る場所として数えた。`docs/write-guard.md` の「誤検知（2026-11-03、P6 の採点する側の案を書いたとき）」と同じ型。
   - **回り道はしていない。** スクリプトで書くのはやめ、`p9-pdfbytes.mjs` は Write ツールで直接書いた。
2. はじめはこの案を別の作業場所（worktree）のエージェントに作らせたが、作業フォルダの外として止められ、何も書けなかった（PR #9 の本文）。

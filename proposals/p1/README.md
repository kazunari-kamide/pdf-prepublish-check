# 採点する側の案：P1（文書情報）

CLAUDE.md §2-3 に従い、`rubric/`・`verifier/`・`fixtures/` に入れるものの案を、ここに置く。人が中身を見て、移すコミットを作る。

## P1 を次の型に選んだ理由

- **公開前の PDF で、いちばん起きやすい。** Word・Excel から書き出すと、作成者の欄にパソコンの利用者名が自動で入る。本人は画面で見ないので気づかない。
- **作りやすい。** 合成 PDF は pdf-lib の文書情報の設定だけで作れる。正解（どの欄が残っているか）が、作り方からそのまま決まる。
- PRD でも、柱 B のうち P1・P5・P9 は削らないと決めている（docs/prd.md §10）。P5（旧版の残存）と重なる「増分更新の前の版に残った文書情報」も、合成 PDF に入れた（P1 の分母には入れず、数だけを出す）。

## 中身

```
proposals/p1/
  rubric/p1.md, p1.json             合格基準の案（人が読む版と、機械で読む版）
  verifier/p1.mjs                   検証器の中身（PDF → 残っている欄の一覧）
  verifier/p1-cli.mjs               コマンド（node verifier/p1-cli.mjs 入力.pdf）
  verifier/p1-schema.json           出力の形
  verifier/p1-selfcheck.mjs         合成 PDF と正解データで、検証器そのものを確かめる
  verifier/P1.md                    考え方・限界・確かめた結果
  fixtures/p1/build.mjs             合成 PDF と正解データを作るスクリプト
  fixtures/p1/*.pdf                 合成 PDF（18 個）
  fixtures/p1/*.expected.json       正解データ（漏れ 22 件、漏れでない欄 20 件）
  fixtures/p1/index.md, hashes.txt  一覧と SHA-256（build.mjs が書く）
  fixtures/p1/README.md             正解データの形
```

- 既存の `verifier/` の P6 のファイル（`cli.mjs`・`schema.json`・`selfcheck.mjs`・`README.md`）と名前がぶつからないように、P1 のものには `p1-` を付けた。

## 移し方（人が行う）

```
git mv proposals/p1/rubric/p1.md rubric/p1.md
git mv proposals/p1/rubric/p1.json rubric/p1.json
git mv proposals/p1/verifier/p1.mjs verifier/p1.mjs
git mv proposals/p1/verifier/p1-cli.mjs verifier/p1-cli.mjs
git mv proposals/p1/verifier/p1-schema.json verifier/p1-schema.json
git mv proposals/p1/verifier/p1-selfcheck.mjs verifier/p1-selfcheck.mjs
git mv proposals/p1/verifier/P1.md verifier/P1.md
git mv proposals/p1/fixtures/p1 fixtures/p1
git commit -m "P1 の合格基準・検証器・合成 PDF を、採点する側に移す"
```

移したあとの確かめ：

```
node verifier/p1-selfcheck.mjs
node fixtures/p1/build.mjs && git status --short fixtures   # 何も変わらなければ、作り直しても同じ
```

- パスは、どれも `import.meta.url` からの相対で書いているので、移しても書き換えは要らない。
- 採点（`npm run eval` の P1 版）と、検出ルール（`rules/p1-…`）は、移したあとに作る。

## 確かめた結果（2026-11-03、Node 24.19.0、Windows）

- `node proposals/p1/verifier/p1-selfcheck.mjs`：合成 PDF 18 個すべてで正解データと合った。漏れ 22 件中 22 件、漏れでない欄 20 件中 0 件に反応、正解にない出力 0 件。2つの読み方（バイト列・PDF.js）が食い違った PDF は 0 個。壊れた入力 5 種で止まらなかった。
- `node proposals/p1/fixtures/p1/build.mjs` を3回続けて実行し、PDF・正解データ・一覧の SHA-256 がすべて同じだった。
- 途中で見つけて直したこと：
  - pdf-lib を `updateMetadata: false` で使うと、文書情報に触らない PDF の trailer には `/Info` が書かれない。そのため、最初の版の「trailer に直接書いた文書情報」の PDF に、文書情報が入っていなかった（検証器が見逃しとして見つけた）。trailer に足すように直した。
  - PDF.js が独自の欄を Map で返すのを、読み違えていた（`verifier/P1.md`）。

## 独立について

- この案は、P6 の検出ルール（`rules/p6-text/`）を書いたのと同じセッションが書いた。P1 の検出ルールはまだない。
- 同じ間違いを共有しないように、**P1 の検出ルールは、この案を読まない別のセッションで書く**のがよい（読むのは、合格基準・検証器の P1.md と出力の形・正解データの形だけにする）。→ 決めてほしいこと 5
- 検証器は pdf-lib を使っていない。検出ルールは pdf-lib で書く予定なので、読み方は分かれる。

## 決めてほしいこと

1. **課の名前に書き換えた作成者（「○○市 総務部 ○○課」）を、漏れと数えるか。** 案では、値があれば数える（`p1-14`、`p1-09`）。
   - A（案）：値があれば数える。検証器は値の中身を判定しない。
   - B：片付けで利用者が選んだ書き換えの値を、検証器に渡す。同じ値なら数えない。片付けたあとの「残り 0 件」は、B でないと満たせない（課の名前に書き換えても1件残るため）。
2. **作成アプリ（Creator）を数えるか。** 案では数える（`p1-02`、`p1-15`）。アプリの名前だけのことが多いが、元のファイル名が入ることもある。Producer は数えない。
3. **前の版に残った文書情報を、P1 の分母に入れるか。** 案では入れない（P5 の範囲。検証器は数だけを出す）。片付けたあとの「残り 0 件」にも入れない案。P5 の案を作るときに、そちらで数える。
4. **Producer・日付に、人名やパスが入っている場合。** 案では P1 では数えない。P4（ファイルパス）の案で見る。
5. **P1 の検出ルールを、別のセッションで書くか**（上の「独立について」）。
6. 合格の値は、P6 にならって「検出率 95% 以上、誤検知率 5% 以下、片付けたあとに残る情報 0 件」とする案。

## 書き込みの見張りに止められたこと

この案を書いている間は、止められていない（ファイルは Write で書き、PDF は `node proposals/p1/fixtures/p1/build.mjs` で作った）。

ただし、はじめはこの案を別の作業場所（worktree）のエージェントに作らせようとして、止められた。詳しくは PR #9 の本文の「書き込みの見張りに止められたこと」。

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# 「1回の指示で作った版」を、見ないで作るテスト集で測る

`ADAPTER.md` の道具に、見ないで作るテスト集（`npm run eval:blind` の 246 個・98 の型）にかける写し方を足したものです。決まりは `ADAPTER.md` と同じく、**その版が出したものだけを写す**こと。

## 作品の採点と同じになる理由

- 期待値は、作品の採点と同じ `expected.json`。PDF も同じフォルダの 246 個。
- 判定は、作品の採点と同じ関数（`eval/blind/judge.ts` の `judge`）。もとは `eval/blind/run.ts` の中にあったものを、そのまま移した。移す前と後で、作品の `report.json` は日時のほかは同じ。
- 型ごとのまとめ方も同じ：型の PDF がすべて期待どおりなら「合」、誤検知は対照のうち合にならなかった数。
- 違うのは項目の出どころだけ：作品は検出ルール（`RULES`）、その版は、生の結果を対応表で写したもの。

## 対応表（`blind-map.json`）

- その版の出力の見出し（`app.js` の `add()` の title）ごとに、当てる型（P1〜P13）か「当てない」と、理由を 1 行ずつ書いた。
- 決め方は、`docs/glossary.md` の P1〜P13 の「意味」だけ。テスト集の個々の PDF の期待は見ていない。
- 迷う見出しは「当てない」にした（隠しのある PDF で合にならない側）。いまは 3 つ：縮小画像（/Thumb）、編集用データ（/PieceInfo）、XFA。
- ページは、その版が項目の頭に「p.<数>」を出したときだけ付けた。ほかはページなし（作品の項目でページがないときと同じ扱い）。
- 深刻度：その版の high → 高、mid → 中、info → 低。
- その版には、作品の「お知らせ」にあたる仕組みがない。出力は、項目にするか当てないかのどちらか。
- 開けなかった PDF（パスワードの窓をキャンセルした・時間切れ・例外）と「検査できなかったページがあります」は、作品の「ルールのエラー」と同じ扱い（調べられない）。

## 数え方は 2 通り

- A：その版が出したものすべて（info の「参考」も含む）
- B：high と mid だけ（info を除く）

片付けたあとの残りは測らない（その版に片付ける機能がない）。

## 手順（PowerShell。リポジトリの根で）

```powershell
$env:ONE_PROMPT_APP_DIR = "<その版のフォルダ>"
node baseline/one_prompt/run-baseline.mjs --dir proposals/blind/fixtures/blind/pdf --name blind
node baseline/one_prompt/blind-score.ts
```

書き出し：`.tmp/one-prompt/blind/`。中身は report-A.md・report-B.md・report.json と、`mapping-log.tsv`（どの PDF の、どの出力の何番目の項目を、どの型に当てたか。1 行ずつ。項目の字の中身は書かない）。

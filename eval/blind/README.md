# 見ないで作るテスト集の採点（eval/blind）

型の一覧の説明だけから作った合成 PDF（`fixtures/blind/`。人が移すまでは `proposals/blind/fixtures/blind/`）を、画面と同じルールの一覧（`src/inspect/rules.ts` の `RULES`）に通し、型ごとの合否表を出す。

- 検出ルールのコード（`rules/`）と `eval/adapters/` は読まない・import しない。`RULES` は import して `run(bytes)` を呼ぶだけ。結果の形は `src/inspect/report.ts` の型で読む。
- 隠しのある PDF は片付け（`sanitizePdf`）にかけ、出来上がった PDF を**ゼロから**読んで、仕込んだ目印の字と覆いの下の画素が残っているかを数える。片付けの報告（`removed`）も、`RULES` の結果も使わない。
- 測り方の確かめ：片付ける**前の** PDF でも同じ測り方をかけ、目印と画素が見つかることを毎回確かめる（見つからない所は表に出す）。
- 表に字の中身は入れない（型・数・ページだけ）。

## 使い方

```
npm run eval:blind                                              # .tmp/blind/report.md と report.json に書く
npm run eval:blind -- --compare eval/blind/results/2026-11-04-main-009c663/report.json   # 前の結果との差も出す
npm run eval:blind -- --out eval/blind/results/<日付>-<名前>     # 残しておく結果
npm run eval:blind -- --save-sanitized .tmp/blind/sanitized     # 片付けた PDF も書き出す（調べるとき）
```

夜（ほかのセッションがマージされたあと）は、`main` で 2 つめの形で動かすと、型ごとに変わった所だけが表の上に出る。

## 合否の決め方

`proposals/blind/fixtures/blind/README.md` の「期待値の形」のとおり。型の合否は、その型の PDF（隠しあり・対照・お知らせ・調べられない）がすべて期待どおりのときだけ「合」。深刻度は合否に入れず、列で合った数だけを出す。

## 結果

- `results/2026-11-04-main-009c663/`：`origin/main`（009c663）のルールと片付けで測った最初の結果。表の「コミット」は、このテスト集を足したブランチのもの（6adbc77）だが、ルールと片付けのコードは 009c663 と同じ（このブランチは新しいファイルを足しただけ）。

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# 案：XMP の元の文書・素材の一覧（xmp-derived）の採点

人が確かめて `rubric/`・`verifier/`・`fixtures/` へ移すための案。ループは移さない。

## 合格基準の案（rubric）

- 型 P2 の仲間。合成 PDF で検出率 95% 以上、誤検知率 5% 以下（今の基準と同じ）。
- 片付けたあとに残る情報 0 件：文書全体の XMP の `xmpMM:DerivedFrom`・`xmpMM:Ingredients`・`xmpMM:Manifest` の中に、`stRef:filePath`・`stRef:lastURL` の値が 1 つも無いこと。

## 検証器の案（verifier）

- 検出ルールを import せず、カタログの `/Metadata` をゼロから読み直す（圧縮あり・なし）。
- 上の 3 つの欄のまとまりを取り出し、中の `stRef:filePath`・`stRef:lastURL`（属性・要素）の、空でない値の数を欄ごとに数える。
- 1 つでもあれば「残っている」。文書 ID・インスタンス ID は数えない。

## 正解データの案（fixtures）

- 隠しあり 4・対照 4（`eval/cases/xmp-derived.ts` と同じ形を、ファイルに書き出したもの）。中身はすべて架空。
- 正解は「種類:欄」の鍵の並び（例：`ingredients:xmpMM:Ingredients`）。

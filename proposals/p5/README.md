# 採点する側の案：P5（旧版の残存）

CLAUDE.md §2-3 に従い、`rubric/`・`verifier/`・`fixtures/` に入れるものの案を、ここに置く。人が中身を見て、移すコミットを作る。P5 の検出ルールは、別のセッションが書く。

## 中身

```
proposals/p5/
  rubric/p5.md, p5.json             合格基準の案。§3 に、P1・P9 との分け方の案
  verifier/p5.mjs                   検証器の中身（PDF → 残っている前の版の中身の一覧）
  verifier/p5-cli.mjs               コマンド（node verifier/p5-cli.mjs 入力.pdf）
  verifier/p5-schema.json           出力の形
  verifier/p5-selfcheck.mjs         合成 PDF と正解データで、検証器そのものを確かめる
  verifier/P5.md                    考え方・限界・確かめた結果
  fixtures/p5/build.mjs             合成 PDF と正解データを作るスクリプト（PDF を手で書く小さな書き手つき）
  fixtures/p5/*.pdf                 合成 PDF（21 個）
  fixtures/p5/*.expected.json       正解データ（漏れ 21 件、漏れでないもの 18 件）
  fixtures/p5/index.md, hashes.txt  一覧と SHA-256（build.mjs が書く）
  fixtures/p5/README.md             正解データの形
```

- 検証器は、バイト列の読み方の部品に、`verifier/p9-pdfbytes.mjs`（P9 の検証器のもの）を使う。`proposals/` にある間は `verifier/` のものを、移したあとは同じフォルダのものを読む。

## 移し方（人が行う）

```
git mv proposals/p5/rubric/p5.md rubric/p5.md
git mv proposals/p5/rubric/p5.json rubric/p5.json
git mv proposals/p5/verifier/p5.mjs verifier/p5.mjs
git mv proposals/p5/verifier/p5-cli.mjs verifier/p5-cli.mjs
git mv proposals/p5/verifier/p5-schema.json verifier/p5-schema.json
git mv proposals/p5/verifier/p5-selfcheck.mjs verifier/p5-selfcheck.mjs
git mv proposals/p5/verifier/P5.md verifier/P5.md
git mv proposals/p5/fixtures/p5 fixtures/p5
git commit -m "P5 の合格基準・検証器・合成 PDF を、採点する側に移す"
```

移したあとの確かめ：

```
node verifier/p5-selfcheck.mjs
node fixtures/p5/build.mjs && git status --short fixtures   # 何も変わらなければ、作り直しても同じ
```

## 確かめた結果（2026-11-03、Node 24.19.0、Windows）

- `node proposals/p5/verifier/p5-selfcheck.mjs`：合成 PDF 21 個すべてで正解データと合った。漏れ 21 件中 21 件、漏れでないもの 18 件中 0 件に反応、正解にない出力 0 件。壊れた入力 5 種で止まらなかった。
- `node proposals/p5/fixtures/p5/build.mjs` を3回続けて実行し、PDF・正解データ・一覧の SHA-256 がすべて同じだった。
- 合成 PDF は手で書いたので、PDF.js で 21 個すべてを開けること、いまの版の字と文書情報が見えることを確かめた（書き直したあとの中身が見え、前の版の中身は見えない）。
- `npm test`（116 件）と型の確かめは通過。

## 独立について

- この案を書いたセッションは、P5 の検出ルールを書かない（あなたの指示）。
- 検証器は pdf-lib を使わない（pdf-lib は前の版を見せない）。検出ルールが pdf-lib を使うなら、前の版はバイト列から自分で読むことになる。そのとき、検証器と同じ読み方（xref を版ごとにたどる）にならないよう、別の見つけ方を選ぶとよい（例：各版のバイト列の終わりで切って、それぞれを pdf-lib で読み、オブジェクトを比べる）。

## 決めてほしいこと

1. **1件の単位**：案では「残っているオブジェクトの定義1つ」。前の版のページの字を、字の差分（どの字が消えたか）で数える案は捨てた。中身が同じでも、残っていれば取り出せるため。
2. **数える種類**：案では、文書情報・字のある中身・字のある注釈・値のあるフォームの欄・XMP・画像・添付の中身。次の扱いを決めてほしい。
   - 画像と XMP は、中身を見ずに「いつも」数える案。暗い写真なども数えるので、誤検知に見えるかもしれない。
   - ファイル指定（添付のファイル名だけ）は、数えない案。ファイル名に個人名が入ることはある（P9 の決めてほしいことと同じ）。
   - フォントや骨組みは数えない。
3. **ほかの型との分け方**（`rubric/p5.md` §3）：P1・P9 は、いまの版だけを数え、いまの版で使っていないものは P5 で数える案。
   - P1 の前の版の文書情報 → P5（info）。
   - P9 の「xref で使っていないと印をつけただけの中身」（PR #20 の返事の 1）→ P5（embedded_file・free）。
   - P9 の「名前の木から外しただけ（いまの xref にまだある）」→ これまでどおり P9（unreferenced）。P5 は数えない。
   - 同じ番号で書き直した前の添付 → P5（embedded_file・superseded）。合成 PDF にはまだない。
4. **「根からたどれない」（unreferenced）を P5 に入れるか。** 増分更新でいちばんよくある残り方は、前の中身が xref に載ったまま、どこからも指されなくなる形（p5-02・p5-03 など）。版の書き直しではないので P5 から外す考え方もあるが、案では入れた。外すと、21 件中 10 件が P5 の外になる。
5. **暗号化された PDF。** 案の検証器は `encrypted` で止める（前の版の中身も暗号化されているため）。検証器にも、パスワードなしで開ける暗号化の復号を書くか（検出ルールを読まないセッションで）。
6. 合格の値は、P6 にならって「検出率 95% 以上、誤検知率 5% 以下、片付けたあとに残る情報 0 件」とする案。

## 書き込みの見張りに止められたこと（そのまま）

1. 検証器の出力を見るため、合成 PDF 3つを順にコマンドにかけ、`.tmp/` に書き出そうとした（`for f in …; do node proposals/p5/verifier/p5-cli.mjs … > .tmp/$f.json; done`）。
   - 表示：「止めました：シェルのコマンドが verifier/・fixtures/ に書き込もうとしています（書き先が変数などで決まる：.tmp/$f.json）」
   - 対応：やめた。Write ツールで `.tmp/p5-peek.mjs` を書き、それを動かして出力を見た（PR #16・#20 の返事で認められたやり方）。採点する側には書いていない。

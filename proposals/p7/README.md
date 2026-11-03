# 採点する側の案：P7（隠れたテキスト）

CLAUDE.md §2-3 に従い、`rubric/`・`verifier/`・`fixtures/` に入れるものの案を、ここに置く。人が中身を見て、移すコミットを作る。P7 の検出ルールは、別のセッションが書く。

## 中身

```
proposals/p7/
  rubric/p7.md, p7.json             合格基準の案（見えない理由の順番と判定の値、P6・P8 との分け方）
  verifier/p7.mjs                   検証器の中身（PDF → 見えない字の一覧）
  verifier/p7-cli.mjs               コマンド（node verifier/p7-cli.mjs 入力.pdf）
  verifier/p7-schema.json           出力の形
  verifier/p7-selfcheck.mjs         合成 PDF と正解データで、検証器そのものを確かめる
  verifier/P7.md                    考え方・限界・確かめた結果
  fixtures/p7/build.mjs             合成 PDF と正解データを作るスクリプト
  fixtures/p7/*.pdf                 合成 PDF（24 個）
  fixtures/p7/*.expected.json       正解データ（漏れ 20 件、漏れでないもの 16 件）
  fixtures/p7/index.md, hashes.txt  一覧と SHA-256（build.mjs が書く）
  fixtures/p7/README.md             正解データの形
```

## 移し方（人が行う）

```
git mv proposals/p7/rubric/p7.md rubric/p7.md
git mv proposals/p7/rubric/p7.json rubric/p7.json
git mv proposals/p7/verifier/p7.mjs verifier/p7.mjs
git mv proposals/p7/verifier/p7-cli.mjs verifier/p7-cli.mjs
git mv proposals/p7/verifier/p7-schema.json verifier/p7-schema.json
git mv proposals/p7/verifier/p7-selfcheck.mjs verifier/p7-selfcheck.mjs
git mv proposals/p7/verifier/P7.md verifier/P7.md
git mv proposals/p7/fixtures/p7 fixtures/p7
git commit -m "P7 の合格基準・検証器・合成 PDF を、採点する側に移す"
```

移したあとの確かめ：

```
node verifier/p7-selfcheck.mjs
node fixtures/p7/build.mjs && git status --short fixtures   # 何も変わらなければ、作り直しても同じ
```

## 確かめた結果（2026-11-03、Node 24.19.0、Windows）

- `node proposals/p7/verifier/p7-selfcheck.mjs`：合成 PDF 24 個すべてで正解データと合った。漏れ 20 件中 20 件、漏れでないもの 16 件中 0 件に反応、正解にない出力 0 件、字数もすべて一致。壊れた入力 3 種で止まらなかった。
- `node proposals/p7/fixtures/p7/build.mjs` を3回続けて実行し、PDF・正解データ・一覧の SHA-256 がすべて同じだった。
- P6 の合成 PDF 33 個にもかけ、P6 との分け目を確かめた（`verifier/P7.md`）。
- `npm test`（116 件）と型の確かめは通過。

## 決めてほしいこと

1. **見えない理由と判定の値**（`rubric/p7.md` §2）。値はどれも案で、合成 PDF の作り方から置いた。
   - とても小さい字：字の高さ 1.0 ポイント未満。大きさ 3 の字は読めるとして、漏れでないものにした。
   - 字と下の色が同じ：明るさの差 0.1 未満。0.97 の字（差 0.03）は漏れ、0.85 の字（差 0.15）は漏れでないものにした。
   - 見えない字：描き方 3・7、または不透明さ 0.1 未満。
2. **P6 の d03（薄い色のマーカー）の扱いが、P6 と P7 で食い違う。**
   - P6 の正解データでは「濃くないので隠れていない」（漏れでない）としている。
   - P7 の検証器は、不透明な塗りなら色が薄くても下の字は見えないので、「白っぽい覆いで隠した字」（covered_light）と判定した。
   - どちらに合わせるかを決めてほしい。P7 に合わせるなら、d03 のマーカーを半透明か乗算にして「隠れていない」形に作り直すか、P7 の漏れとして P7 の合成 PDF に移す。
3. **ページの外の字を、漏れと数えるか。**
   - PDF.js の字の取り出し（`getTextContent`）は、ページの見える範囲の外の字を返さなかった（p7-04・p7-05・p7-20 で確かめた）。
   - ファイルの中には残っているが、ほかの道具がその字を取り出すかは、まだ確かめていない。
   - 案では、漏れと数える。
4. **文字認識の層の見分け方。** 案では、描き方 3 の字の中心の下に、先に描いた画像があれば「文字認識の層」として数えない。
   - 画像のあとではなく、画像の前に字を描く道具もある。そのとき、字は画像に隠れるので、covered_light とも見られる。案では、画像は濃さを問わず「上に重ねた覆い」としても数えるので、明るい画像なら covered_light、暗い画像なら P6（`excluded.p6`）になる。合成 PDF にはまだその形がない。
5. **P6 との分け目**：濃い覆い（明るさ 0.3 以下）の下の字は P6、濃くない不透明な覆いの下の字は P7。P6 の検証器の README にある「白い覆いは P7 の範囲」と同じ考え方にした。
6. 合格の値は、P6 にならって「検出率 95% 以上、誤検知率 5% 以下、片付けたあとに残る情報 0 件」とする案。

## 書き込みの見張りに止められたこと（そのまま）

1. 検証器を直すため、ヒアドキュメントで `.tmp/patch-p7.mjs` を書こうとした。中身は、`proposals/p7/verifier/p7.mjs` を読み、置き換えて書き戻すスクリプト。
   - 表示：「止めました：シェルのコマンドが verifier/・fixtures/ に書き込もうとしています（シェルやスクリプトに読ませる部分に、書き込みらしい操作がある）」
   - 対応：やめた。Edit ツールで `proposals/p7/verifier/p7.mjs` を1か所ずつ直した（道具での書き込みは、パスで正しく見分けられる）。採点する側には書いていない。

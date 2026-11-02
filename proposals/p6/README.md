# 採点する側の案：P6（見せかけの黒塗り）

CLAUDE.md §2-3・PRD §9 の1 に従い、`rubric/`・`verifier/`・`fixtures/` に入れるものの案を、ここに置く。人が中身を見て、移すコミットを作る。

- 書いたセッションは、検出ルール（`src/`・`rules/`）を読んでいない。同じ間違いを共有しないため。
- 字の層だけでなく、画像の層（スキャン画像の上に黒い図形・画像・注釈を重ねただけで、下の画素が残っている型）も数える。最初の検出ルールは画像・注釈の型で不合格になる。これは意図したもの（2026-11-03 決定）。

## 中身

```
proposals/p6/
  rubric/p6.md, p6.json           合格基準（人が読む版と、機械で読む版）
  verifier/p6.mjs                 検証器の中身（PDF → 残っている所の一覧）
  verifier/cli.mjs                コマンド（node verifier/cli.mjs 入力.pdf）
  verifier/schema.json            出力の形
  verifier/selfcheck.mjs          合成 PDF と正解データで、検証器そのものを確かめる
  verifier/README.md              考え方・判定の値・限界
  fixtures/p6/build.mjs           合成 PDF と正解データを作るスクリプト
  fixtures/p6/*.pdf               合成 PDF（26 個）
  fixtures/p6/*.expected.json     正解データ
  fixtures/p6/index.md            出来上がりの一覧（build.mjs が書く）
  fixtures/p6/hashes.txt          SHA-256 の一覧（build.mjs が書く）
  fixtures/p6/README.md           正解データの形
  fixtures/p6/fonts/              BIZ UDゴシック Regular と、ライセンスの全文（OFL.txt）
```

## 移し方（人が行う）

いま、根元に `rubric/`・`verifier/`・`fixtures/` はない。フォルダごと移せる。

```
git mv proposals/p6/rubric rubric
git mv proposals/p6/verifier verifier
git mv proposals/p6/fixtures fixtures
git commit -m "P6 の合格基準・検証器・合成 PDF を、採点する側に移す"
```

移したあとの確かめ：

```
node verifier/selfcheck.mjs
node fixtures/p6/build.mjs && git status --short fixtures   # 何も変わらなければ、作り直しても同じ
```

- パスは、どちらも `import.meta.url` からの相対で書いているので、移しても書き換えは要らない。
- `npm run eval`（採点）は、まだ作っていない。検出ルールの報告を検証器の形にそろえる変換と一緒に、eval の側で作る（PRD §2-3-1 の3）。

## 確かめた結果（2026-11-03、Node 24.19.0、Windows）

- `node verifier/selfcheck.mjs`：合成 PDF 26 個すべてで正解データと合った。漏れ 23 件中 23 件、漏れでないもの 16 件中 0 件に反応、正解にない出力 0 件。壊れた入力 3 種で止まらずに `error` を返した。
- `node fixtures/p6/build.mjs` を3回続けて実行し、PDF・正解データ・一覧の SHA-256 がすべて同じだった。
- 合成 PDF のうち 7 個を画像にして目で確かめた。字がすべて描かれ、黒い四角が意図した所に重なっていた。
  - 最初は字の一部が描かれていなかった。原因は @pdf-lib/fontkit 1.1.1 の、使う字に絞る処理。位置の表（loca）を「2で割った値」の形で書くのに、BIZ UDゴシックには奇数バイトの字があるため、そのあとの字の位置がずれていた（`node_modules/@pdf-lib/fontkit/dist/fontkit.es.js` の 18796〜18806 行と 32744〜32778 行）。埋め込む前に字のデータを 4 バイトの区切りにそろえて直した（`build.mjs` の `padGlyphs`）。

## 人にお願いすること

1. **フォントの写し**：書き込みの見張りのため、Claude はシェルでフォントのファイルを `proposals/p6/fixtures/p6/fonts/` に写せなかった（下の「書き込みの見張りの誤検知」）。この PR では、人が写したものをコミットしている。
2. **合格基準の未決定の点**：`rubric/p6.md` §6（片付けたあとのページが「使える」ことの条件を入れるか）。
3. **判定の値の見直し**：本物の PDF での件数を見てから（`verifier/README.md` の限界）。

## 書き込みの見張りの誤検知（2026-11-03）

`proposals/p6/verifier/…` や `proposals/p6/fixtures/…` の名前が入ったシェルのコマンドで、書き込みの操作（`cp`・`mkdir`・`sed -i`・`>`）があると、hook が止めた。hook は、コマンドの文字の中で、`/` のあとに続く `verifier/` なども守る場所の名前とみなすため。決まりに従い、回り道は探さなかった。そのため、案のファイルは Write・Edit（パスで正しく見分ける）で書き、PDF は `node fixtures/p6/build.mjs`（スクリプトの中で書く）で作った。詳しくは `docs/write-guard.md`。

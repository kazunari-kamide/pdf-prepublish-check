# 採点する側の直し（P5・P6・P7）

PR #12・#16・#21・#22 の返事で決まった、採点する側（`rubric/`・`verifier/`・`fixtures/`）の直しの案です。直した版は、元と同じ相対パスで、このフォルダに置きました。差し替えるのは人です。

- 書いたセッションは、検出ルール（`rules/`）と `eval/adapters/` を読んでいません。読んだのは、`rubric/`・`verifier/`・`fixtures/`・`proposals/`・`eval/`（adapters を除く）・`docs/`・PR の本文とコメントだけです。
- ライブラリは足していません。実在の PDF は使っていません（名前はすべて架空）。

## 直したもの

| # | 決めたこと | 直した所 |
|---|---|---|
| 1 | 正解データに「期待するエラー」の欄（`expected_error`）を足す（PR #16 の返事の 2） | `verifier/selfcheck.mjs`（P6）が読む。値は検証器の `error.code`。このとき `leaks`・`negatives` は空。P5 の暗号化の確かめにも要るので、`verifier/p5-selfcheck.mjs` にも同じ決まりで足した。形は `fixtures/p6/README.md`・`fixtures/p5/README.md` |
| 2 | P6 の検証器が、楕円・回した四角・角の丸い四角の覆いを見つける（PR #12 の返事の 2） | `verifier/p6.mjs`（0.2.0）。四角に近くない濃い塗りは、箱でなく形そのもので見る。曲線は 8 本の直線に分け、字の箱の中の 8×8 の点のうち形の中にある割合で「隠れた割合」を測る。斜めの太い線も、回した四角の形で見る |
| 3 | P6 の d03 を、半透明か乗算のマーカーに作り直す（PR #22 の返事の 2） | `fixtures/p6/build.mjs`。薄い灰色は不透明さ 0.4、黄色は不透明のまま乗算（Multiply）。正解（漏れでないもの 2 件、箱）は同じ |
| 4 | P5 の検証器に、パスワードなしで開ける暗号化の復号を入れる（PR #21 の返事の 5） | `verifier/p5-decrypt.mjs`（新しいファイル）と `verifier/p5.mjs`（0.2.0）。RC4・AES-128・AES-256。暗号化した合成 PDF を 4 個足した（`fixtures/p5/build.mjs` の p5-22〜25） |
| 5 | P7：画像と重なる見えない字は、描く順番に関係なく文字認識の層（PR #22 の返事の 4） | `verifier/p7.mjs`（0.2.0）。合成 PDF p7-25（見えない字を先に書き、あとから画像）を足した。合格基準の文言 `rubric/p7.md`・`rubric/p7.json` も合わせた |

あわせて、PR #12・#16 の案のうち「検証器が直るまで移さない」としていた合成 PDF（`proposals/p6/additions/` の t14〜t16、`proposals/p6/encrypted/` の e03）も、下の手順で `fixtures/p6/` に移します。

## 差し替えのコマンド（PowerShell。リポジトリの根で、1行ずつ）

```powershell
Copy-Item -LiteralPath "proposals\scoring-fixes\rubric\p7.md" -Destination "rubric\p7.md" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\rubric\p7.json" -Destination "rubric\p7.json" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\verifier\p6.mjs" -Destination "verifier\p6.mjs" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\verifier\selfcheck.mjs" -Destination "verifier\selfcheck.mjs" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\verifier\README.md" -Destination "verifier\README.md" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\verifier\p5.mjs" -Destination "verifier\p5.mjs" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\verifier\p5-decrypt.mjs" -Destination "verifier\p5-decrypt.mjs" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\verifier\p5-selfcheck.mjs" -Destination "verifier\p5-selfcheck.mjs" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\verifier\P5.md" -Destination "verifier\P5.md" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\verifier\p7.mjs" -Destination "verifier\p7.mjs" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\verifier\P7.md" -Destination "verifier\P7.md" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p6\build.mjs" -Destination "fixtures\p6\build.mjs" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p6\README.md" -Destination "fixtures\p6\README.md" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p6\index.md" -Destination "fixtures\p6\index.md" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p6\hashes.txt" -Destination "fixtures\p6\hashes.txt" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p6\p6-d03-light-highlight.pdf" -Destination "fixtures\p6\p6-d03-light-highlight.pdf" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p6\p6-d03-light-highlight.expected.json" -Destination "fixtures\p6\p6-d03-light-highlight.expected.json" -Force
Copy-Item -LiteralPath "proposals\p6\additions\fixtures\p6\p6-t14-ellipse.pdf" -Destination "fixtures\p6\p6-t14-ellipse.pdf" -Force
Copy-Item -LiteralPath "proposals\p6\additions\fixtures\p6\p6-t14-ellipse.expected.json" -Destination "fixtures\p6\p6-t14-ellipse.expected.json" -Force
Copy-Item -LiteralPath "proposals\p6\additions\fixtures\p6\p6-t15-rotated-rects.pdf" -Destination "fixtures\p6\p6-t15-rotated-rects.pdf" -Force
Copy-Item -LiteralPath "proposals\p6\additions\fixtures\p6\p6-t15-rotated-rects.expected.json" -Destination "fixtures\p6\p6-t15-rotated-rects.expected.json" -Force
Copy-Item -LiteralPath "proposals\p6\additions\fixtures\p6\p6-t16-rounded-rects.pdf" -Destination "fixtures\p6\p6-t16-rounded-rects.pdf" -Force
Copy-Item -LiteralPath "proposals\p6\additions\fixtures\p6\p6-t16-rounded-rects.expected.json" -Destination "fixtures\p6\p6-t16-rounded-rects.expected.json" -Force
Copy-Item -LiteralPath "proposals\p6\encrypted\fixtures\p6\p6-e03-encrypted-user-password.pdf" -Destination "fixtures\p6\p6-e03-encrypted-user-password.pdf" -Force
Copy-Item -LiteralPath "proposals\p6\encrypted\fixtures\p6\p6-e03-encrypted-user-password.expected.json" -Destination "fixtures\p6\p6-e03-encrypted-user-password.expected.json" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\build.mjs" -Destination "fixtures\p5\build.mjs" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\README.md" -Destination "fixtures\p5\README.md" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\index.md" -Destination "fixtures\p5\index.md" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\hashes.txt" -Destination "fixtures\p5\hashes.txt" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\p5-22-encrypted-rc4-info.pdf" -Destination "fixtures\p5\p5-22-encrypted-rc4-info.pdf" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\p5-22-encrypted-rc4-info.expected.json" -Destination "fixtures\p5\p5-22-encrypted-rc4-info.expected.json" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\p5-23-encrypted-aes128-content.pdf" -Destination "fixtures\p5\p5-23-encrypted-aes128-content.pdf" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\p5-23-encrypted-aes128-content.expected.json" -Destination "fixtures\p5\p5-23-encrypted-aes128-content.expected.json" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\p5-24-encrypted-aes256-objstm.pdf" -Destination "fixtures\p5\p5-24-encrypted-aes256-objstm.pdf" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\p5-24-encrypted-aes256-objstm.expected.json" -Destination "fixtures\p5\p5-24-encrypted-aes256-objstm.expected.json" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\p5-25-encrypted-user-password.pdf" -Destination "fixtures\p5\p5-25-encrypted-user-password.pdf" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p5\p5-25-encrypted-user-password.expected.json" -Destination "fixtures\p5\p5-25-encrypted-user-password.expected.json" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p7\build.mjs" -Destination "fixtures\p7\build.mjs" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p7\README.md" -Destination "fixtures\p7\README.md" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p7\index.md" -Destination "fixtures\p7\index.md" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p7\hashes.txt" -Destination "fixtures\p7\hashes.txt" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p7\p7-25-ocr-layer-before-image.pdf" -Destination "fixtures\p7\p7-25-ocr-layer-before-image.pdf" -Force
Copy-Item -LiteralPath "proposals\scoring-fixes\fixtures\p7\p7-25-ocr-layer-before-image.expected.json" -Destination "fixtures\p7\p7-25-ocr-layer-before-image.expected.json" -Force
```

- 新しく増えるファイルは、`verifier\p5-decrypt.mjs`、P6 の t14〜t16・e03、P5 の p5-22〜25、P7 の p7-25。ほかは上書き。
- `proposals\` の中は消さない（消すかは人が決める）。消すなら、差し替えを確かめたあとに `git rm -r proposals/scoring-fixes` など。

## 差し替えたあとの確かめ（PowerShell。1行ずつ）

```powershell
node verifier/selfcheck.mjs
node verifier/p5-selfcheck.mjs
node verifier/p7-selfcheck.mjs
node verifier/p1-selfcheck.mjs
node verifier/p9-selfcheck.mjs
node fixtures/p6/build.mjs
node fixtures/p5/build.mjs
node fixtures/p7/build.mjs
git status --short fixtures
```

期待する結果：

| コマンド | 期待する最後の行など |
|---|---|
| `node verifier/selfcheck.mjs` | 「漏れ 32 件中 32 件を見つけた。漏れでないもの 21 件中 0 件に反応。正解にない出力 0 件」「期待するエラー 1 件中 1 件で、同じエラーを返した」「すべて正解データと合った」 |
| `node verifier/p5-selfcheck.mjs` | 「合成 PDF 25 個：漏れ 24 件中 24 件を見つけた。漏れでないもの 20 件中 0 件に反応。正解にない出力 0 件」「期待するエラー 1 件中 1 件」「すべて正解データと合った」 |
| `node verifier/p7-selfcheck.mjs` | 「合成 PDF 25 個：漏れ 20 件中 20 件を見つけた。漏れでないもの 17 件中 0 件に反応。正解にない出力 0 件」「すべて正解データと合った」 |
| `node verifier/p1-selfcheck.mjs`・`p9-selfcheck.mjs` | 「すべて正解データと合った」（変えていない） |
| 3つの `build.mjs` | それぞれ「合成 PDF 26 個（漏れ 23 件、漏れでない 16 件）を書きました」「合成 PDF 25 個、漏れ 24 件、漏れでないもの 20 件」「合成 PDF 25 個、漏れ 20 件、漏れでないもの 17 件」 |
| `git status --short fixtures` | 何も出ない（作り直しても、差し替えたものと同じバイト列） |

- 画面で目で確かめるなら：`fixtures/p6/p6-d03-light-highlight.pdf` をビューアーで開き、灰色と黄色のマーカーの下の字が読めること。`fixtures/p7/p7-25-ocr-layer-before-image.pdf` は灰色の四角だけが見え、字は見えないこと（画像の下の見えない字）。**このセッションでは、画像にして目で見る確かめはしていない**（Node で描く道具がないため。字が取り出せることと、描き方の命令は確かめた）。

## このセッションで確かめたこと（2026-11-03、Node 24.19.0、Windows）

本物の `rubric/`・`verifier/`・`fixtures/` には書いていません。差し替えたあとの形を `.tmp/scoring-fixes/stage/` に組み立てて（今の3つのフォルダを写し、上のコマンドと同じファイルを重ねた）、そこで動かしました。`.tmp/` はコミットしていません。

### 各型の selfcheck

| | 差し替える前（今の `verifier/` と `fixtures/`） | 差し替えたあと |
|---|---|---|
| P6 | 合格（26 個。追加の 7 個を含め 33 個） | 合格。37 個、漏れ 32 件中 32、漏れでないもの 21 件中 0、正解にない出力 0、期待するエラー 1 件中 1 |
| P5 | 合格（21 個） | 合格。25 個、漏れ 24 件中 24、漏れでないもの 20 件中 0、正解にない出力 0、期待するエラー 1 件中 1 |
| P7 | 合格（24 個） | 合格。25 個、漏れ 20 件中 20、漏れでないもの 17 件中 0、正解にない出力 0 |
| P1・P9 | 合格 | 合格（変えていない） |

前から合っていたものは、すべて合ったままです（どの型も、前からある合成 PDF で NG は 0）。

### 直しが効いているか（直す前の検証器と比べた）

| 合成 PDF | 直す前の検証器 | 直したあと |
|---|---|---|
| P6 t14（楕円） | 1 件中 0 件 | 1 件中 1 件（字数 10、正解 10） |
| P6 t15（1度・3度回した四角） | 2 件中 1 件 | 2 件中 2 件（字数 10・13、正解と同じ） |
| P6 t16（角の丸い四角） | 2 件中 1 件 | 2 件中 2 件（字数 10・9、正解と同じ） |
| P6 e03（パスワードつき） | selfcheck が「読めなかった」と NG にする | `encrypted` を返し、`expected_error` と合う |
| P5 p5-22〜24（パスワードなしで開ける暗号化） | 3 個とも `encrypted` で止まる | 3 個とも読め、漏れ 3 件中 3 件 |
| P5 p5-25（パスワードつき） | `encrypted` | `encrypted`（`expected_error` と合う） |
| P7 p7-25（見えない字のあとに画像） | invisible と誤って 1 件出す | 出さない（`excluded.ocr_layer` に数える） |
| P7 で P6 の d03 | covered_light を 2 件出す（作り直す前の d03） | 作り直した d03 では 0 件 |

### 合成 PDF を作り直したもの（3回作って SHA-256 を比べた）

| 作り方 | 3回 | 今の `fixtures/` と比べて |
|---|---|---|
| `fixtures/p6/build.mjs` | 3回とも同じ | 変わったのは d03（PDF と正解データ）と、`index.md`・`hashes.txt` だけ。ほかの 25 個は同じバイト列 |
| `fixtures/p5/build.mjs` | 3回とも同じ | 前からの 21 個は同じバイト列。p5-22〜25 が増えた |
| `fixtures/p7/build.mjs` | 3回とも同じ | 前からの 24 個は同じバイト列。p7-25 が増えた |

増えた・変わった PDF の SHA-256：

```
00d5cdf628668ee98b80799d1343f1d28f67c95858b63476175171db1db29078  p6-d03-light-highlight.pdf
a78d6dc93ae4212c0e080d738e866e3e05e1bab4293da31fa3364e251d84a3b8  p5-22-encrypted-rc4-info.pdf
0d4ebed7e2727f15ed3956b32e33efdd183ff48a0e6f7664ebf7142a13179cfa  p5-23-encrypted-aes128-content.pdf
5093915f13b58b8d85b31ab0c334eb44146e6ba5c3b186ee8f11652f0b38beca  p5-24-encrypted-aes256-objstm.pdf
5d3fd1208866fc47d8f47f8b95c4cd51283c235ec1e9c564330131d521425f08  p5-25-encrypted-user-password.pdf
59774d3d13b285ebcdee07ad4ad1dd65d72357bb268cdaf77bdeae0860bf83e0  p7-25-ocr-layer-before-image.pdf
```

### そのほか

- **暗号化した合成 PDF が正しいか**：作り方の暗号化は、検証器の復号を import せずに別に書いた。PDF.js（別の実装）で、p5-22〜24 はパスワードなしで開け、本文の字と文書情報がいまの版の値と同じだった。p5-25 はパスワードを求められた（`PasswordException`）。
- **復号を、別のセッションが書いた暗号化にもかけた**：`fixtures/p6/` の e01・e02（RC4。e02 はオブジェクトストリームごと暗号化）。P5 の検証器は `ok` で読めた。復号の部品で解いた文書情報のタイトルは、PDF.js の値と同じだった。
- **d03**：中に `/BM /Multiply` と `/ca 0.4` があることと、PDF.js で字が 26 字取り出せる（下の字が残っている）ことを確かめた。直した P6 の検証器は 0 件。
- **P7 を P6 の合成 PDF 37 個にかけた**：報告 0 件。開けなかったのは e03（パスワードつき）だけ。
- **重いページ（h01）**：P6 の検証器の時間は変わらない（3回ずつ、直す前 395〜518 ms、直したあと 385〜431 ms）。

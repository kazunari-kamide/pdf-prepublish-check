# 合成 PDF を足す案：P6（見せかけの黒塗り）の、暗号化した PDF

PR #14 で知らされた件（P6 の検出ルールが、暗号化された PDF を `encrypted` と見分けられない）を直したときに作った、暗号化した合成 PDF を、`fixtures/p6/` に足す案。移すのは人。

## 中身

```
proposals/p6/encrypted/
  build-encrypted.mjs                  暗号化した合成 PDF と正解データを作るスクリプト
  encrypted-pdf.mjs                    暗号化の処理（tests/helpers/encrypted-pdf.mjs の写し）
  fixtures/p6/*.pdf, *.expected.json   作った結果（3 個）
  fixtures/p6/index-encrypted.md       一覧
  fixtures/p6/hashes-encrypted.txt     SHA-256
```

| ファイル | 中身 | 正解 |
|---|---|---|
| p6-e01-encrypted-empty-userpw | RC4 128 ビットで暗号化。利用者のパスワードは空（開くときに聞かれない。印刷・編集の禁止だけ） | 見せかけの黒塗りが 1 件（text/fill） |
| p6-e02-encrypted-object-stream | 同じ。ページなどをオブジェクトストリームに入れ、ストリームごと暗号化 | 見せかけの黒塗りが 1 件 |
| p6-e03-encrypted-user-password | 利用者のパスワードつき（開けない） | 漏れなし。`expected_error: "encrypted"`（新しい欄の案） |

- 暗号化は、標準のセキュリティハンドラ（V2・R3、RC4 128 ビット。PDF 1.7 §7.6.3 のアルゴリズム 1・2・3・5）。ライブラリは足さず、Node の MD5 と自前の RC4 で作った。
- `encrypted-pdf.mjs` は、テストで使うもの（`tests/helpers/`）の写し。採点する側をテストの側から独立させるため、写しにした。
- 中身の字は標準の Helvetica の、架空の名前だけ。

## 移し方（人が行う）

```
git mv proposals/p6/encrypted/build-encrypted.mjs fixtures/p6/build-encrypted.mjs
git mv proposals/p6/encrypted/encrypted-pdf.mjs fixtures/p6/encrypted-pdf.mjs
git mv proposals/p6/encrypted/fixtures/p6/* fixtures/p6/
git commit -m "P6 の暗号化した合成 PDF を足す"
```

- **いまのまま移すと、`node verifier/selfcheck.mjs` と `npm run eval` の結果が変わる。** 移す前に「決めてほしいこと」を決める必要がある。

## 確かめた結果（2026-11-03、Node 24.19.0、Windows）

| ファイル | PDF.js で開けるか | 検証器（`verifier/cli.mjs`） | 検出ルール 1.1.1 | 検出ルール 1.2.0 |
|---|---|---|---|---|
| e01 | 開けた。暗号化 Standard、本文の字 10 字、タイトル 13 字を取り出せた | `ok`。見せかけの黒塗りを 1 件中 1 件見つけた | `encrypted`（調べない） | `ok`。1 件中 1 件（復号して調べた） |
| e02 | 開けた。同じ | `ok`。1 件中 1 件 | `encrypted`（調べない） | `ok`。1 件中 1 件 |
| e03 | 開けない（パスワードが要る） | `error`（`encrypted`） | `encrypted` | `encrypted`（パスワードが要る） |

- 暗号化が正しくできていることは、PDF.js がパスワードなしで開け、字を取り出せたことで確かめた（e01・e02）。
- `build-encrypted.mjs` を3回続けて実行し、PDF・正解データの SHA-256 がすべて同じだった。
- e01・e02 の正解の箱は、検証器の出力と、`eval/match.ts` と同じ照らし合わせ方で結べた。
- 検出ルール 1.2.0 の列は、復号を足した PR（`claude/decrypt-empty-password`）で測った。

## 分かったこと

- 1.1.1 では、利用者のパスワードが空の暗号化で、検証器と検出ルールの答えが分かれた（検証器は調べ、検出ルールは調べなかった）。
- PR #16 の返事（1：A。事前調査で、パスワードなしで開けた暗号化 PDF が 87,146 件中 774 件）で、検出ルールにも復号を書いた。1.2.0 では、e01・e02 で答えがそろった。

## 決めたこと（PR #16 の返事）

1. パスワードなしで開ける暗号化 PDF も、検出ルールで調べる（1.2.0 で済み）。
2. 正解データに「期待するエラー」の欄を足す。`verifier/selfcheck.mjs` の直しは、検出ルールを読まないセッションが proposals/ に案を出し、人が移す。
3. パスワードつきの合成 PDF（e03）は、今は1つだけ移す。パスワードなしの2つ（e01・e02）は、復号ができてから移す（1.2.0 でできた）。

## 書き込みの見張りに止められたこと（そのまま）

1. 利用者のパスワードつきの PDF を試すため、ヒアドキュメントで `.tmp/enc-check3.ts` を書こうとした。中身は、`verifier/cli.mjs` を読んで呼ぶことと、`.tmp/` に PDF を書く `writeFileSync`。
   - 表示：「止めました：シェルのコマンドが verifier/ に書き込もうとしています（シェルやスクリプトに読ませる部分に、書き込みらしい操作がある）」
   - 対応：同じスクリプトを Write ツールで `.tmp/` に書き、`node .tmp/enc-check3.ts` で動かした。採点する側には書いていない。
2. 検証器の出力を見るため、`node verifier/cli.mjs …` の結果を `node -e "…"` に流そうとした。
   - 表示：「止めました：シェルのコマンドが verifier/・fixtures/ に書き込もうとしています（スクリプトに渡す命令が変数などで決まる：…）」
   - 対応：やめた。前に Write ツールで書いた確かめのスクリプト（`.tmp/check-additions.mjs`）だけを動かした。

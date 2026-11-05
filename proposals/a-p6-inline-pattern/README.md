# 採点する側に足す案：埋め込み画像・模様の覆いの型

CLAUDE.md §2-3 に従い、`fixtures/` に足す合成 PDF と正解データの案、検証器（`verifier/`）を直す案をここに置く。人が中身を見て、移すコミットを作る。

## 何を足すか

検出ルール P6 1.12.0・P7 1.3.0 で足した型（埋め込み画像・模様の覆い）の、採点用の合成 PDF。字はすべて架空。

| 合成 PDF | 型 | 中身 |
|---|---|---|
| `p6/p6-t11-inline-image-over-name` | 漏れ（text/image） | 氏名の上に、黒い埋め込み画像を重ねただけ |
| `p6/p6-t12-pattern-over-name` | 漏れ（text/fill） | 氏名の上に、黒い模様（すき間なく塗るタイルの模様）で塗った四角 |
| `p6/p6-t13-shading-over-name` | 漏れ（text/fill） | 氏名の上の四角の切り抜きの中を、濃いシェーディング（`sh`）で塗った |
| `p6/p6-d11-inline-image-and-pattern-controls` | 漏れでない 2 | 字のない所の白い埋め込み画像、字の下の黒い埋め込み画像（上に白い字）、字の上の細い斜線の模様、字のない所の模様 |
| `p7/p7-28-pattern-white-text` | 漏れ（same_color） | 白い地のタイルの模様の中に白い字で氏名を書き、その模様で四角を塗った |

作り方：`node proposals/a-p6-inline-pattern/build.mjs [出力先]`。出力先を省くと `out/`（コミットしない）に書く。日時も乱数も使わないので、何度作っても同じバイト列になる。

## 確かめた結果（2026-11-05）

検出ルール（このブランチの版）と、検証器（`verifier/`。呼ぶだけで変えていない）にかけた。

| 合成 PDF | 検出ルール | 検証器 | 移せるか |
|---|---|---|---|
| p6-t11-inline-image-over-name | P6：text/image 1 件（10 字） | `cli.mjs`：text/image 1 件（10 字） | **移せる** |
| p6-t12-pattern-over-name | P6：text/fill 1 件（10 字） | `cli.mjs`：text/fill 1 件（10 字） | **移せる** |
| p6-t13-shading-over-name | P6：text/fill 1 件（10 字） | `cli.mjs`：**0 件**（`sh` を覆いとして見ていない） | 検証器を直さないと、検証器そのものの確かめ（selfcheck）が通らない |
| p6-d11-inline-image-and-pattern-controls | P6：0 件 | `cli.mjs`：**1 件**（細い斜線の模様の下の 13 字を text/fill として出す） | 同上 |
| p7-28-pattern-white-text | P7：same_color 1 件（10 字） | `p7-cli.mjs`：**0 件**（模様の中の字を読んでいない） | 同上 |

## 検証器を直す案（人の判断）

- P6：`sh`（シェーディング）で、いまの切り抜きの中（`/BBox` があればその中）を塗ったものを、覆いとして見る。明るさは関数の両端の色の明るい方（`FunctionType 2` の `C0`・`C1`）。
- P6：タイルの模様は、1つのタイルの四角の塗りが、タイルの送り（`XStep`×`YStep`）を 9 割以上埋めるときだけ覆いにする（細い斜線・網の模様は、下の字が透ける）。
- P7：タイルの模様の中に字を描く命令があれば、塗った所にタイルを並べ、タイルの中の字も字として見る。

## 移し方（人が行う）

```
node proposals/a-p6-inline-pattern/build.mjs .tmp/inline-pattern
# p6-t11・p6-t12 の .pdf と .expected.json を fixtures/p6 に写す（検証器を直したら、残りの3つも）
npm run eval
```

- 写したら、`fixtures/p6/index.md`・`fixtures/p7/index.md` と `hashes.txt` も直す。
- 各 `build.mjs` に同じ型を足すか、この build.mjs を fixtures の下に置くかは、人が決める。

# 採点する側に足す案：画像の OPI 辞書に残った元の画像の場所（P4）

CLAUDE.md §2-3 に従い、`fixtures/` に足す合成 PDF と正解データの案をここに置く。人が中身を見て、移すコミットを作る。利用者名・サーバー名はすべて架空（yamada、fileserver）。

## 何を足すか

| 合成 PDF | 型 | 中身 |
|---|---|---|
| `p4-o01-opi-original-image-path` | 漏れ 2（P4。user_path・server） | 画像 XObject 2 つの辞書の中に、直接 `/OPI` を入れた。1.3 版は `/F (C:\Users\yamada\Desktop\kouhou\photo_hires.tif)`、2.0 版は `/F (\\fileserver\share\kouhou\photo2_hires.tif)`。`/F` は字の並び |
| `p4-oc01-opi-file-name-only` | 漏れでない 1 | OPI 1.3 の `/F` が、ドライブ名もフォルダも無いファイル名だけ（`photo_hires.tif`） |

作り方：`node build.mjs [出力先]`。出力先を省くと、横の `out/`（コミットしない）に書く。日時も乱数も使わないので、何度作っても同じバイト列になる。

## なぜ漏れか

OPI 辞書の `/F` は、印刷のときに差し替える元の高解像度の画像の場所で、`C:\Users\<名前>\…` や `\\サーバー\…` がそのまま残る。画面には出ないが、中を見る道具で読める。DTP のソフトの書き出しや、Distiller の「OPI コメントを保持」で作られる形（PDF 2.0 では非推奨）。

## 今の型との違い

- `rules/p4-paths/index.ts` では、ストリームは `/Type /Metadata` のものだけを読み（154〜159 行）、辞書は Annot・Filespec・`/EF`・`/S` と `/URI` か `/F` を持つ動作だけを見る（162〜176 行）。画像の辞書の中の `/OPI /1.3 /F` は読まれない。OPI 辞書を間接オブジェクトにしても、`/S` も `/Type /Filespec` も無いので見えない。
- `eval/cases/p4.ts`、`proposals/blind` の t12・t13・t08-b にも、ほかの案にも OPI は無い。

## 確かめた結果（2026-11-07、Node 24.19.0、Windows）

`node build.mjs` を2回（`out/` と `out-again/`）実行し、PDF 2 個と正解データ 2 個の SHA-256 がすべて同じだった。

| 合成 PDF | SHA-256（先頭16桁） | 検出ルール | 検証器（`verifier/` の CLI。呼ぶだけ） |
|---|---|---|---|
| p4-o01-opi-original-image-path | `018e750e5824f783` | **見逃し**：P4 0 件（漏れ 2 件とも）。P10・P11・P12 も 0 件。`omamori.ts check` は項目 0・stage `none` | P6・P1・P5・P7・P9 とも 0 件（P4 を見る検証器は無い） |
| p4-oc01-opi-file-name-only | `471a4968d9a33902` | 0 件（正しい） | 5 つとも 0 件 |

- PDF のバイト列に `/F (C:\\Users\\yamada\\…)` と `/F (\\\\fileserver\\…)` の形で入っていることを確かめた（字の並びの中の `\` は `\\` と書く決まり）。
- 実物の PDF でどれくらい出る形かは確かめていない（古い DTP の印刷用の PDF に多いと推測）。

## 正解の決め方（人の判断）

- `where` に新しい値 `opi` を足す案（画像の中の場所だと分かるように。`image` にする案もある）。
- `/F` を `/Type /Filespec` の辞書にした形は入れなかった：今の `filespec` の見方で見つかってしまい、新しい型にならないため。
- 同じ画像に 1.3 と 2.0 の両方がある形は、値が違えば 2 件（今の「同じ値は1件にまとめる」に従う）。

## 捨てた案

- OPI 辞書を間接オブジェクトにした版だけを置く：直接の辞書の方が DTP のソフトの書き出しに近い（推測）。間接にした版は、直し方が片方だけに合わせたものにならないよう、補助として足してもよい。

## 移し方（人が行う）

```
node proposals/e-shapes/p4-opi-original-image-path/build.mjs fixtures/p4
npm run eval
```

- fixtures に P4 のフォルダは無いので、置き場所は人が決める。`index.md` と `hashes.txt` も足す。
- 検出ルールの直し方の案：間接オブジェクトを回るとき、画像のストリームの辞書（`/Subtype /Image`）と フォームの部品の辞書の `/OPI` を開き、`/1.3`・`/2.0` の中の `/F`（字の並びか Filespec）を `findPaths` にかける。

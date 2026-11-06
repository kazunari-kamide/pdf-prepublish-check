# 採点する側に足す案：画面の注釈の「再生」の動作に入った JavaScript（P12）

CLAUDE.md §2-3 に従い、`fixtures/` に足す合成 PDF と正解データの案をここに置く。人が中身を見て、移すコミットを作る。JavaScript の中身は `app.alert('test')` だけ（送信先の URL は入れない）。

## 何を足すか

| 合成 PDF | 型 | 中身 |
|---|---|---|
| `p12-r01-rendition-js` | P12 2（javascript・annotation） | ページの `/Annots` に Screen の注釈 2 つ。押したときの動作（`/A`）が `/S /Rendition /OP 0 /AN（その注釈）` で、`/JS` に JavaScript。1つは字の並び、1つは Flate で圧縮したストリーム |
| `p12-rc01-rendition-media-only` | 漏れでない 1 | Screen の注釈の Rendition の動作で、`/JS` が無く `/R`（`/Type /Rendition /S /MR`、中に `/MediaClip` と `movie.mp4` のファイル指定）だけ。ふつうの動画の再生 |

作り方：`node build.mjs [出力先]`。出力先を省くと、横の `out/`（コミットしない）に書く。日時も乱数も使わないので、何度作っても同じバイト列になる。

## なぜ注意が要るか

漏れ（情報の漏れ）ではないが、`docs/glossary.md` で P12 は「漏洩ではないが、安全上の注意として示す」型。ISO 32000 の 12.6.4.13 で、Rendition の動作の `/JS` は、動作のときに動く JavaScript と決まっている。JavaScript の動作と同じく、利用者が押すと動く。

## 今の型との違い

- `rules/p12-actions/index.ts` の `KIND_OF`（70〜78 行）に Rendition が無い。Screen の注釈の `/A`（押したときだけ動く所）では、種類が無いので `notCounted.link` に回り、数えられない（130〜135 行）。どこからも指されていない動作を探す所（196〜206 行）も、`/S /JavaScript` しか見ない。
- `eval/cases/p12.ts`、`proposals/blind` の t87・t88・t89 に Rendition・Screen は無い。
- ページを開いたとき（ページの `/AA /O`）に置いた版は、今でも `other_action` として見つかる（`!kind && !clicked`）。見つからないのは javascript という種類と字数だけなので、主な型には `/A` の形を使った。

## 確かめた結果（2026-11-07、Node 24.19.0、Windows）

`node build.mjs` を2回（`out/` と `out-again/`）実行し、PDF 2 個と正解データ 2 個の SHA-256 がすべて同じだった。

| 合成 PDF | SHA-256（先頭16桁） | 検出ルール | 検証器（`verifier/` の CLI。呼ぶだけ） |
|---|---|---|---|
| p12-r01-rendition-js | `11689aaa8eb78263` | **見逃し**：P12 0 件（2 件とも `notCounted.link` 2 に回った）。`omamori.ts check` は項目 0・stage `none` | P6・P1・P5・P7・P9 とも 0 件（P12 を見る検証器は無い） |
| p12-rc01-rendition-media-only | `b7e8a0ac7747157c` | 0 件（`notCounted.link` 1。正しい）。`movie.mp4` のファイル指定は P4・P9 にも数えられなかった | 5 つとも 0 件 |

## 正解の決め方（人の判断）

- 正解は P12 の `javascript`・`where: annotation`・`trigger: null`・ページ 1。今のルールは同じ所・同じ種類を1件にまとめるので、ルールの出力では `count: 2` の1件になる見込み。正解データでは、字の並びとストリームを分けて 2 件に書いた（まとめ方に合わせて直すかは人が決める）。
- `chars` は JavaScript の字数（字の並び 18 字、ストリーム 25 字）。
- どこからも指されていない Rendition の `/JS` も、同じ直し方で拾う案（`/S /Rendition` で `/JS` を持つものを、JavaScript と同じに扱う）。

## 捨てた案

- ページの `/AA /O`（開いたとき）の版を主な型にする：今でも `other_action` として見つかるので、新しい見逃しにならない。種類が `other_action` から `javascript` になることを確かめる補助としてなら足してよい（新しい漏れの数には入れない）。

## 移し方（人が行う）

```
node proposals/e-shapes/p12-rendition-js/build.mjs fixtures/p12
npm run eval
```

- fixtures に P12 のフォルダは無いので、置き場所は人が決める。`index.md` と `hashes.txt` も足す。
- 検出ルールの直し方の案：動作の辞書が `/S /Rendition` で `/JS` を持つときは、`javascript`（`ALWAYS` に入る種類）として数え、`jsChars` で字数を出す。

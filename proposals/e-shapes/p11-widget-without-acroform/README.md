# 採点する側に足す案：AcroForm の無い PDF のウィジェットに残った欄の値（P11）

CLAUDE.md §2-3 に従い、`fixtures/` に足す合成 PDF と正解データの案をここに置く。人が中身を見て、移すコミットを作る。字はすべて架空（山田太郎、090-0000-0000）。

## 何を足すか

| 合成 PDF | 型 | 中身 |
|---|---|---|
| `p11-o01-orphan-widget-hidden` | 漏れ（P11。見え方は新しい区分 `orphan_widget`） | カタログに `/AcroForm` が無い。ページの `/Annots` に、欄とウィジェットが一体の辞書（`/FT /Tx /T (氏名) /V (山田太郎　090-0000-0000) /F 2`、`/AP` なし）を直接置いた |
| `p11-oc01-orphan-widget-empty` | 漏れでない 2 | 同じく AcroForm の無いページのウィジェットで、`/V ()`（空の字）のものと、`/V` が無いもの |

作り方：`node build.mjs [出力先]`。出力先を省くと、横の `out/`（コミットしない）に書く。日時も乱数も使わないので、何度作っても同じバイト列になる。

## なぜ漏れか

記入済みの申請書から一部のページだけを抜き出す（pdf-lib の `copyPages` など）と、ページの注釈は写るが、カタログの `/AcroForm` は写らない。欄の値（`/V`）は字としてファイルに残り、取り出せる。ビューアはフォームとして扱わず、`/F 2`（隠し）で見た目も無いので、本人は気づかない。

## 今の型との違い

- `rules/p11-forms/index.ts` は `/AcroForm /Fields` の木から欄をたどる。`/Fields` が無いと `hasForm=false` にして、すぐ返す（120〜122 行）。README の限界にも「/Fields の木から外れた欄は見ない」とある。
- `rules/p8-annot/index.ts` は 180 行で Widget を飛ばす。`rules/p4-paths/index.ts` は Widget の字を見ない。`rules/p12-actions` はウィジェットの動作だけを見る。
- テスト集の `eval/cases/p11.ts`（p11-l01〜l08・c01〜c04）、`fixtures/p5` の p5-07・p5-20、`proposals/blind` の t84・t85 は、どれも `/Fields` に載った欄。t85-a-no-widget は逆の形（欄はあるがウィジェットが無い）。fixtures に P11 のフォルダは無い。

## 確かめた結果（2026-11-07、Node 24.19.0、Windows）

`node build.mjs` を2回（`out/` と `out-again/`）実行し、PDF 2 個と正解データ 2 個の SHA-256 がすべて同じだった。

| 合成 PDF | SHA-256（先頭16桁） | 検出ルール | 検証器（`verifier/` の CLI。呼ぶだけ） |
|---|---|---|---|
| p11-o01-orphan-widget-hidden | `7554ec500cf72b65` | **見逃し**：P11 0 件（`hasForm=false`、`fields=0`）。P4・P10・P12 も 0 件。`omamori.ts check` は項目 0・stage `none` | P6・P1・P5・P7・P9 とも 0 件（P11 を見る検証器は無い） |
| p11-oc01-orphan-widget-empty | `3ac2900cbc85dae6` | 0 件（正しい） | 5 つとも 0 件 |

- 漏れが本物であることの確かめ：pdf-lib で読むと `/V` は 18 字に戻せた。PDF.js の `getAnnotations` でも、この Widget の `fieldValue` が空でない字として返った（字そのものは記録していない）。

## 正解の決め方（人の判断）

- 見え方は、今の 3 つ（visible・hidden・no_widget）のどれにも合わないので、新しい区分 `orphan_widget` を案とした。`hidden` に入れる案もある。
- `/F 2` を外した版は、PDF.js などでは値が見えることがある。足すなら、深刻度を分けるか先に決める（この案には入れていない）。
- `/Parent` の付いたウィジェットを `copyPages` で写すと、親の欄の `/V` まで写る。その形（ウィジェットの `/Parent` の側に値がある）も、同じ `orphan_widget` で1件にする案。この案の PDF は一体の辞書の形だけ。

## 捨てた案

- `copyPages` で実際に別の文書からページを写して作る：作り方が pdf-lib の写し方に依存し、`/Parent` の扱いが版で変わるおそれがある。辞書を直接置く方が、形がはっきりする。

## 移し方（人が行う）

```
node proposals/e-shapes/p11-widget-without-acroform/build.mjs fixtures/p11
npm run eval
```

- fixtures に P11 のフォルダは無いので、`fixtures/p11/` を作るか、ほかの型のフォルダに置くかは人が決める。`index.md` と `hashes.txt` も足す。
- 検出ルールの直し方の案：`/Fields` が空でも、ページの `/Annots` の Widget（と、その `/Parent` の鎖）を見て、`/V` を読む。

# 採点する側に足す案：誤検知しない型の対照（型の一覧の F01・F04・F05・F06・F07）

CLAUDE.md §2-3 に従い、`fixtures/` に足す合成 PDF の案をここに置く。人が中身を見て、移すコミットを作る。

## 何を足すか

型の一覧の「誤検知しない型」F01〜F07 のうち、採点用の合成 PDF（`fixtures/`）に対照がなかったもの。

| 型 | 今あったもの | 足す案 |
|---|---|---|
| F01 Word の「ハイブリッド xref」を前の版と誤らない | なし | `p5/p5-26-word-hybrid-xref`：古い形の表＋`/XRefStm` の xref ストリームで保存した、版が1つの PDF |
| F02 黒い帯の上の白い見出しを白い字と誤らない | あり（`fixtures/p7/p7-03`・`fixtures/p6/p6-d01`） | 足さない |
| F03 作成日などの数字をカード番号と誤らない | 個人情報のルールの範囲（持ち場 F） | このセッションでは足さない |
| F04 使われていないフォントの部品を前の版と誤らない | 偶然あった（`fixtures/p6` のスキャンの見本 6 個。`proposals/a-gaps/p6/` の直しを当てると消える） | `p5/p5-27-scan-unused-font`：スキャン画像だけのページに、使われていないフォントの辞書・説明・本体が残る、版が1つの PDF |
| F05 輪郭の見える、塗りが透明な字を見えない字と誤らない | なし | `p7/p7-26-outline-transparent-fill`：描き方 2、塗りの不透明さ 0、輪郭は黒く不透明 |
| F06 帯の下の字を帯の上に同じに描き直したものを誤らない | テストだけ（`tests/p6-text-on-top.test.ts`） | `p6/p6-d10-same-text-redrawn`：黒い帯の下の見出しを、帯の上に同じ字で白く描き直した |
| F07 太字の2度描き・合字・素直な ActualText を誤らない | なし | `p7/p7-27-bold-ligature-actualtext`：同じ字を 0.35pt ずらした2度描き、合字 fi を fi と取り出す対応表、描いた字と同じ ActualText |

作り方：`node proposals/a-gaps/controls/build.mjs [出力先]`。出力先を省くと `out/`（コミットしない）に書く。日時も乱数も使わないので、何度作っても同じバイト列になる。

## 確かめた結果（2026-11-04）

検出ルール（このブランチの版）と、採点する側の検証器（`verifier/`。呼ぶだけで変えていない）にかけた。

| 合成 PDF | 検出ルール | 検証器 | 移せるか |
|---|---|---|---|
| p5-26-word-hybrid-xref | P5 1.2.1：findings 0、片付けで消せる残り 0 | `p5-cli.mjs`：items 0、not_counted 0 | **移せる** |
| p5-27-scan-unused-font | P5 1.2.1：findings 0、片付けで消せる残り 3（画面では「低」の1行） | `p5-cli.mjs`：items 0、not_counted 3（6・7・8、structure・unreferenced。正解データと同じ） | **移せる** |
| p6-d10-same-text-redrawn | P6 1.10.0：findings 0 | `cli.mjs`：**items 1**（帯の下の 14 字を text/fill として出す） | 検証器を直さないと、検証器そのものの確かめ（selfcheck）が通らない |
| p7-26-outline-transparent-fill | P7 1.1.0：findings 0 | `p7-cli.mjs`：**items 1**（12 字を invisible として出す。P7 1.0.2 と同じ見方） | 同上 |
| p7-27-bold-ligature-actualtext | P7 1.1.0：findings 0 | `p7-cli.mjs`：items 0 | **移せる** |

- PDF.js（6.4.299）で5つとも開け、字を取り出せた（警告は、標準書体のデータを渡していないためのものだけ）。
- p6-d10 と p7-26 は、検証器が漏れとして数える。どちらも「見える字なのに、見えないと数える」向きで、検証器の見方を変えるのは人の判断（CLAUDE.md §2-3）。案：検証器の P7 で、描き方 2・6 は輪郭の不透明さも見る。P6 で、覆いのあとに同じ字を同じ所に描き直した字は数えない（検出ルール 1.6.0 と同じ条件）。

## 移し方（人が行う）

```
node proposals/a-gaps/controls/build.mjs .tmp/controls
# p5-26・p5-27・p7-27 の .pdf と .expected.json を fixtures/p5・fixtures/p7 に写す
# 各 build.mjs にも同じ型を足すか、この build.mjs を fixtures の下に置くかは、人が決める（下の「決めてほしいこと」）
npm run eval
```

- 写したら、`fixtures/p5/index.md`・`fixtures/p7/index.md` と `hashes.txt` も直す（数：P5 は合成 PDF 25 → 27 個、漏れでない 20 → 23 件。P7 は 25 → 26 個、漏れでない 17 → 20 件）。
- 決めてほしいこと：対照を、いまの `fixtures/p5/build.mjs`・`fixtures/p7/build.mjs` の中に足すか、別の build に分けるか。

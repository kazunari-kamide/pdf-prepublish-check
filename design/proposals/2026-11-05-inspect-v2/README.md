<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# 検査の画面の見た目の案・第2版（2026-11-05、選ぶ前の見本）

**2026-11-05 決定：E2**（本人の返事）。見出しのゴシックとフォーカスの黄も承認された。決まりは `design/README.md` と `design/tokens.css` に移した。D2・F2 は選ばなかった案として残す。

前の案 D・E・F（`../2026-11-04-inspect/`、そのまま残す）を、本人の返事「もっとモダンに、角は丸めて、ISO の Web アクセシビリティに準拠、デジタル庁のデザインシステムも参考に」で作り直した。動かない見本で、項目と数字は架空のもの。**選ぶのは本人。選ばなかった案も、ここに残す。**

| 案 | ファイル | 考え方 |
|---|---|---|
| D2 台帳 | `d2-ledger.html` | 結果を罫線の行で並べる。選んだ行は薄い紅の地と左の紅の線。いまの画面からの変更がいちばん小さい |
| E2 お守りの札 | `e2-fuda.html` | 種類ごとに角を丸めた囲みと、左に縦書きの紅の札。見つからなかった種類は緑の「済」の札にまとめる |
| F2 ページに赤字 | `f2-akaji.html` | 見つかった所の説明を、ページの横に引き出し線つきで出す。右の欄は件数と「片付ける」だけ。幅 70rem 未満では、説明をページの下に並べる |

3つで共通の部分は `base.css`、決まりへの足し案は `tokens-v2.css` にまとめた。画像は `screenshots/`（幅 1440・幅 320・Tab で動かしたあと）。

## 何を変えたか（`tokens-v2.css`。まだ決まりではない）

| 項目 | いまの決まり | 第2版の案 | 根拠 |
|---|---|---|---|
| 角の丸め | 0（丸めない） | ボタン・項目 8px、欄 12px、ページの紙 4px、札 丸 | DADS「角の形状」の 8・12・16px |
| 見出しの書体 | 明朝 | ゴシック（本文と同じ書体の太字） | DADS「タイポグラフィ」は Noto Sans JP（ゴシック）。**書体の決まりを変えるので、本人の承認が要る** |
| 字の間 | なし | 0.02em | DADS：26px 以下の字は 2% |
| フォーカス | 墨の 3px の線 | 黒の 4px の線＋黄 `#FFD43D` の 2px の縁 | DADS のボタンの CSS（`design-system-example-components-html` の `button.css`） |
| 押せる所の大きさ | 決まりなし | 高さ 44px 以上（ボタンは 48・56px） | DADS のボタン「ターゲット領域は 44 CSS px 以上」 |
| 押せる所の枠の色 | なし | `#8A857C`（白の上で 3.67:1） | WCAG 1.4.11（3:1 以上） |
| 黄 | なし | フォーカスにだけ使う状態の色 | **2色の決まりの外に置くので、緑と同じく本人の承認が要る** |

色の墨 `#2B2A28` と紅 `#A3201B` は変えていない（DADS の青は使っていない）。本文 18px も変えていない（DADS の基準 16px 以上を満たす）。

## アクセシビリティで確かめたこと（2026-11-05 測った値）

ISO/IEC 40500:2012 は WCAG 2.0 と同じ内容で、JIS X 8341-3:2016 も同じ内容（DADS の「基本デザイン」のページの説明）。DADS は WCAG 2.2 も並べて示しているので、**WCAG 2.2 の AA を目標にした**。下は見本で確かめた項目だけで、「準拠」とは言えない（準拠を言うには、本物の画面で全項目を試験する必要がある）。

| 項目 | 確かめ方 | 結果 |
|---|---|---|
| 1.4.3 文字のコントラスト（4.5:1） | 計算 | 墨/白 14.34、補足の字/白 7.63、補足の字/札の地 6.82、紅/白 7.55、紅/紅の薄い地 6.39、白/紅 7.55、緑/白 5.91、緑/緑の薄い地 5.09 |
| 1.4.11 押せる所の枠（3:1） | 計算 | 押せる所の枠/白 3.67、/札の地 3.28 |
| 1.4.1 色だけで示さない | 目で見る | 深刻度は「▲ 高」「■ 中」の形と字、見つからなかった種類は「✓」と字、選んだ項目は線の太さも変える |
| 1.4.10 リフロー（幅 320px） | Chrome で幅 320 にして、横の長さを測った | 3案とも scrollWidth 320 = clientWidth 320（横にはみ出さない） |
| 2.4.1 ブロックスキップ | Tab を1回押して撮った | 「結果へ移る」（F2 は「見つかった所の説明へ移る」）が黄の地で出る |
| 2.4.7 フォーカスが見える | Tab を6回押して撮った | 黒の線と黄の縁が出る（`screenshots/*-focus-tab6.png`） |
| 2.5.8 押せる所の大きさ（24px） | CSS の値 | 44px 以上 |

まだ確かめていないこと：スクリーンリーダーでの読み上げ、200% の拡大、ハイコントラストの設定、自動の検査の道具（axe など。依存を足すので承認が要る）。

## 書体について

DADS が勧める Noto Sans JP は SIL Open Font License 1.1。使うなら、外から読み込まずリポジトリに同梱する（CLAUDE.md §2-1）。同梱する前に、ライセンスと版を確かめて `docs/licenses.md` に足し、承認を得る。見本はいまの決まりのまま、端末の書体で表示している。

## 出典

- デジタル庁デザインシステム「基本デザイン」 https://design.digital.go.jp/dads/foundations/
- 同「角の形状」 https://design.digital.go.jp/dads/foundations/corner-shapes/
- 同「タイポグラフィ」 https://design.digital.go.jp/dads/foundations/typography/
- 同「ボタン／使い方」 https://design.digital.go.jp/dads/components/button/usage/
- digital-go-jp/design-tokens（MIT。`examples/tokens.css` の `--color-primitive-yellow-300: #ffd43d`、`--border-radius-*`） https://github.com/digital-go-jp/design-tokens
- digital-go-jp/design-system-example-components-html（MIT。`src/components/button/button.css` のフォーカスの形） https://github.com/digital-go-jp/design-system-example-components-html
- 値を参考にしただけで、コードは写していない（CLAUDE.md §2-8・§10）。

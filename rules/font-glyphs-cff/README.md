<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# CFF の書体に残った字形 `font-glyphs-cff`

`font-glyphs`（TrueType の CIDFontType2 と Type3 だけを見る）の範囲の外にある、CFF（FontFile3）の部分埋め込みの書体に、ページのどこにも描かれていない字の形が残っているものを、**数だけ**返す。前に書いてあって消した字（黒塗りの下だけにあった字など）の手がかりになる。型は P7 の仲間【仮】、画面の深刻度は中【仮】。

- 見る書体：
  - Type0 の CIDFontType0（`/FontFile3 /Subtype /CIDFontType0C`）で、Identity-H・V のもの。CFF が CID の形（Top DICT に ROS）なら charset で CID → 字の形、そうでなければ CID ＝ 字の形。
  - 1 バイトの Type1（`/FontFile3 /Subtype /Type1C`）。コード → 字の形の名前（`/Differences`、なければ基の符号の表の 32〜126、CFF の中の独自の符号の表）→ charset で字の形。
  - 名前が部分埋め込みの印（`ABCDEF+`）で始まるものだけ（印の無いものは `fullFonts`）。
- 描かれた字：ページ・部品（フォーム XObject）・注釈の見た目（/AP）の、字を描く命令のコード。
- 数えない：字の形 0（.notdef）、形の無い字（CharString に線を引く命令の無いもの。空白など）。**余りが 3 個より少ない書体は出さない**（`belowThreshold`）。
- 描いたコードのうち、字の形を引けないものが 1 つでもある書体は、誤検知を避けて見ない（`unresolvedFonts`）。

## 確かめたこと

- 合成 PDF 7 件（隠しあり 3・対照 4。`eval/cases/font-glyphs-cff.ts`）。書体は、その場で組み立てる架空の CFF。結果は採点の結果を待つ【要確認】。

## できないこと（限界）

- 余った字形が**どの字か**は出さない。
- Type1（FontFile）・1 バイトの TrueType は見ない。
- 標準の字の名前は、欧字・数字・記号の 95 個だけを持つ。それ以外の標準の名前を引く書体は `unresolvedFonts` になる。
- CFF の部品の呼び出し（subr）だけで描く字形は、形があるものとみなす。
- 日本の公開 PDF の束での誤検知は、まだ測っていない。

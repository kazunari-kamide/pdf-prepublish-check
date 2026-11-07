<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# 検出ルール：XMP の元の文書・素材の一覧 `xmp-derived`

カタログの `/Metadata`（文書全体の XMP）の、元の文書・素材・リンクした資源の欄に残った**ファイルの名前**を、**数と字数**で返す。型は P2（文書全体の XMP）の仲間【仮】、画面の深刻度は低【仮】。値そのものは返さない（`includeValues` のときだけ）。
画面の名前は「XMP に残る元のファイル」、札は「元の文書」。名前の字は、見出しの書体の字の一覧（design/fonts/heading-chars.txt）にある字だけで書く（無い字があると tests/heading-chars.test.ts が落ちる）。

組版・画像のソフトで作った PDF には、元にした文書のファイル名や、組み込んだ画像などの素材のファイル名が、編集の履歴（`xmpMM:History`）とは別の欄に残る。ファイル名に、人の名前・案件の名前・版の手がかりが入ることがある。

```ts
import { detectXmpDerived } from "./rules/xmp-derived/index.ts";
const report = await detectXmpDerived(bytes);                          // 欄・数・字数だけ
const report2 = await detectXmpDerived(bytes, { includeValues: true }); // 名前そのものも（調べるときだけ）
```

| 種類（`kind`） | 欄 | 見る所 |
|---|---|---|
| `derived` | `xmpMM:DerivedFrom` | 中の `stRef:filePath`・`stRef:lastURL`（属性・要素の両方） |
| `ingredients` | `xmpMM:Ingredients` | 同上（`rdf:li` ごと） |
| `manifest` | `xmpMM:Manifest` | 同上（`stMfs:reference` の中） |

1件 ＝ 欄 1 つ。`files` に名前の数（同じ名前は 1 つ）、`chars` に字数の合計。

## 数えないもの

- ユーザーのフォルダを含むパス（`notCounted` の `user_folder`）：`p2-xmp` の `path` で出る。
- ドライブ名・共有フォルダ・`file:` などから始まるパス（`notCounted` の `path`）：`p4-paths` で出る。
- 文書 ID・インスタンス ID（`stRef:documentID`・`stRef:instanceID`）：漏れではないので見ない。
- 編集の履歴（`p2-xmp` の `history`）、部品ごとの XMP（`p2-parts`）。

## 確かめたこと

- 合成 PDF 8 件（隠しあり 4・対照 4。`eval/cases/xmp-derived.ts`。`npm run eval:new`）。結果は、こちらで流したあとに書く【 】。
- 採点用の合格基準・検証器・正解データの案は `proposals/xmp-derived/`（人が移す）。

## できないこと（限界）

- XMP を XML として正しく読んでいない（`p2-xmp` と同じく、決まった欄を正規表現で拾う）。名前空間の接頭辞が違う XMP は見逃す。
- ファイル名の中身（人の名前か、決まった名前か）は見分けない。`image1.png` のような名前も数える。
- 前の版の XMP は見ない（P5 の範囲）。

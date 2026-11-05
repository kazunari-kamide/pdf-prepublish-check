# 検出ルール：P2（文書全体の XMP メタデータ）`p2-xmp`

PDF を入れると、カタログの `/Metadata`（文書全体の XMP）に残った、人名らしい欄・題や説明・独自の欄・パス・編集の履歴・GPS を返す。**値そのものは返さない**（欄・字数だけ）。圧縮あり（Flate）・なしの両方を読む。

部品ごとの XMP（画像・フォーム XObject など）は `rules/p2-parts` の範囲で、ここでは見ない。

```ts
import { detectP2Xmp } from "./rules/p2-xmp/index.ts";
const report = await detectP2Xmp(bytes);                          // 欄と字数だけ
const report2 = await detectP2Xmp(bytes, { includeValues: true }); // 値そのものも返す（調べるときだけ。記録やログには使わない）
```

| 種類（`kind`） | 型 | 欄 | 字数 |
|---|---|---|---|
| `person` | P2 | `dc:creator`・`dc:contributor`・`pdf:Author`・`xmp:Author`・`xmpRights:Owner`・`photoshop:CaptionWriter` | 名前の字数 |
| `text` | P2 | `dc:title`・`dc:description`・`dc:subject`・`pdf:Keywords`、独自の欄（`pdfx:` の名前空間。文書情報の独自の欄が写されたもの） | 値の字数 |
| `path` | P4 | `stRef:filePath`・`stRef:lastURL`・`photoshop:DocumentAncestors`・`stEvt:parameters` のうち、ユーザーのフォルダ（`Users\<名前>\` など）を含むもの | ユーザーのフォルダの名前の字数 |
| `history` | P2 | `xmpMM:History`（`events` に出来事の数） | 0 |
| `gps` | P10 | `exif:GPSLatitude`・`exif:GPSLongitude` | 0 |

## 数えないもの

- ソフト名（`xmp:CreatorTool`・`pdf:Producer`）、文書 ID（`xmpMM:DocumentID`・`InstanceID`）、日付、形式（`dc:format`）。欄ごと見ない。
- 人名らしい欄の、決まり文句（Administrator など）・ソフト名・数字の入ったアカウント名（`user01` など）。`p2-parts` と同じ見分け方で、`notCounted` に回す。
- ユーザーのフォルダを含まないパス（`Links/photo.jpg` など）。

## 確かめたこと

- 合成 PDF 9 件（隠しあり 5・対照 4。`eval/cases/p2.ts`。`npm run eval:new`）：検出 9/9、誤検知 0。
- 採点用の合格基準・検証器・正解データ（`rubric/`・`verifier/`・`fixtures/`）は、まだない（人が決めて置く）。

## できないこと（限界）

- XMP は XML として正しく読んでいない（`p2-parts` と同じく、決まった欄を正規表現で拾う）。名前空間の接頭辞が違う XMP は見逃す。
- `pdfx:` 以外の名前空間の独自の欄は見ない。
- 前の版（増分更新の前）の XMP は見ない（P5 の範囲）。
- XMP は 16 MB まで読む。超えたら `limits` に出す。

## 1.1.0（2026-11-05）

- 題・説明・キーワード（`text`）が、文書情報（`/Info`）の同じ欄（Title・Subject・Keywords）と同じ値なら数えない（`notCounted` の `same_as_info`）。P1 と同じ値を二重に出さないため。
- 人名の欄（`person`）は、同じ値でも数える（XMP にも名前が残っていることを知らせるため）。

# 検出ルール：P10（画像の位置情報など）`p10-exif`

PDF を入れると、中の JPEG の画像（`/DCTDecode`。前に `FlateDecode` などが付いていても）の Exif（APP1）に残った、撮った場所（GPS）・撮った人・カメラの機種・ソフト・**縮小画像**などを返す。**値そのものは返さない**（字数・大きさだけ）。画素は読まない。

```ts
import { detectP10Exif } from "./rules/p10-exif/index.ts";
const report = await detectP10Exif(bytes);
```

| 種類（`kind`） | 欄 | 画面の深刻度【仮】 |
|---|---|---|
| `gps` | GPSLatitude・GPSLongitude | 高 |
| `person` | Artist・XPAuthor・CameraOwnerName | 中 |
| `serial` | BodySerialNumber | 中 |
| `thumbnail` | IFD1 の縮小画像（`bytes` に大きさ） | 中 |
| `description` | ImageDescription・XPComment・UserComment | 低 |
| `copyright` | Copyright | 低 |
| `camera` | Make・Model（1件にまとめる） | 低 |
| `software` | Software | 低 |

- **縮小画像**：写真を切り抜いても、Exif の中の縮小画像は切り抜く前のままのことがある。有る・無いと大きさを返す。
- 1件 ＝ 画像1つ × 種類1つ。`object` に画像のオブジェクト番号、`pages` に置いたページ（ページの `/Resources` と、その中の部品をたどる）。
- バイトの並び（`II`・`MM`）の両方を読む。

## 数えないもの

- 向き・解像度・撮影の日時・露出などの撮影の条件。

## 確かめたこと

- 合成 PDF 8 件（隠しあり 5・対照 3。`eval/cases/p10.ts`。`npm run eval:new`）：検出 9/9、誤検知 0。

## できないこと（限界）

- JPEG の中の XMP（APP1 の別の形）・IPTC（APP13）は見ない。部品の XMP の GPS は `p2-parts` が見る。
- JPEG 2000（`/JPXDecode`）の中の情報は見ない。
- UserComment の JIS の符号は読まず、字数は目安。
- 1つの画像は 64 MB まで、IFD の欄は 1,000 個まで読む。壊れた Exif は `limits` に `broken_exif` を出す。
- 片付け（`sanitize/`）は、まだ Exif を消さない（片付けの担当に頼む）。

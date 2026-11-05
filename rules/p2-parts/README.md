# 検出ルール：部品に残った情報（p2-parts）

PDF を入れると、文書全体の XMP とは別に、**部品ごとに残った情報**を返す。見つけたもの1件ごとに、型の番号を付ける（2026-11-04、人の決定）。**値そのものは返さない**（欄・字数・部品の数だけ）。

| 型 | 何を | 例（架空） |
|---|---|---|
| P2（XMP メタデータ） | 部品の XMP の人名らしい欄、Illustrator の編集用データの利用者名（`%%For`）、編集用データが残っていること | `dc:creator` に「山田太郎」 |
| P4（ファイルパス） | パソコンのユーザーのフォルダを含むパス | `stRef:filePath` に `C:\Users\yamada\…` |
| P10（画像の位置情報など） | 写真の XMP の GPS の緯度・経度 | `exif:GPSLatitude` |

見つける段（公開 PDF 100 件を、型のヒントなしで Claude に調べさせた回）で見つかった型。

```ts
import { detectP2Parts } from "./rules/p2-parts/index.ts";
const report = await detectP2Parts(bytes);                          // 欄と字数だけ
const report2 = await detectP2Parts(bytes, { includeValues: true }); // 値そのものも返す（調べるときだけ。記録やログには使わない）
```

## 見る所

1. **部品の XMP**：画像・部品（フォーム XObject）・マーク付きの中身の `/Properties`・ページなどの `/Metadata`。どこからも指されていない XMP のストリーム（`/Type /Metadata`）も見る（`owner: "unreferenced"`）。
   - **文書全体の XMP（カタログの `/Metadata`）は見ない。** P2 の文書全体の検出ルールの範囲（まだない）。
   - 人名らしい欄：`dc:creator`・`dc:contributor`・`pdf:Author`・`xmp:Author`・`xmpRights:Owner`・`photoshop:CaptionWriter`。
   - パスの欄：`stRef:filePath`（`xmpMM:DerivedFrom`・`xmpMM:Ingredients` の中も）・`stRef:lastURL`・`photoshop:DocumentAncestors`。
   - GPS：`exif:GPSLatitude`・`exif:GPSLongitude`。
   - XML の部品は使わず、決まった欄の属性（`ns:name="…"`）と要素（`<ns:name>…</ns:name>`、中の `rdf:li` は1つずつ）を正規表現で拾う。
2. **Illustrator の編集用データ**：`/PieceInfo /Illustrator /Private`（「編集機能を保持」のまま書き出したもの）。
   - `AIMetaData`（圧縮されていないことが多い）と、`AIPrivateData1`〜`N`（`AIPDFPrivateData` も）を番号の順につないだもの。
   - 先頭が `%AI12_CompressedData`：続きを zlib として展開する（ブラウザと Node の標準の `DecompressionStream`。ライブラリは足していない）。
   - 先頭が `%AI24_ZStandard_Data`：zstd は**展開しない**。「残っているが中身は調べていない」（`checked: false`）として返す（2026-11-04、人の決定。展開するにはライブラリが要るため）。
   - 展開した字から、`%%For: (…)`（作ったパソコンの利用者名）と `%%DocumentFiles:`（使ったファイルのパス。`%%+` の続きの行も）を拾う。
   - 編集用データがあれば、中身にかかわらず `private_data` を1件返す。

## 数えないもの（見つける段の誤検知の型）

広報紙では、ほぼ全部の部品に XMP がある。人名らしい部分・ユーザー名・GPS に絞る。

- ソフト名（Adobe・Illustrator・Photoshop・Microsoft・複合機の会社名など）、文書 ID（`uuid:`・`xmp.did:`・`xmp.iid:`）→ `software`
- 数字の入った値（端末名・`user01` などの英数字のアカウント）→ `account`
- 決まり文句（Author・user・Administrator・Public・Default・ユーザー・管理者など）→ `generic`
- ユーザーのフォルダ（`Users\<名前>`・`Documents and Settings\<名前>`・`home/<名前>`）を含まないパス（「Links」「画像」などの中立なフォルダだけのもの）→ `no_user_folder`
- 素材の配布元の名前（`photoshop:Credit`・`photoshop:Source` など）、色の情報、ソフト名の欄（`xmp:CreatorTool`）は、欄ごと見ない。

数えなかったものは、欄と理由ごとの数を `notCounted` に出す。

## 数え方

- 1件 ＝ 型・欄・値の組み1つ。同じ値が何個の部品にあっても1件にまとめ、部品の数（`parts`）を添える。
- `chars`：人名はその字数、パスはユーザーのフォルダの名前の字数、GPS と編集用データは 0。

## 確かめたこと

- テストの中で作った PDF（`tests/p2-parts.test.ts`、14 件）。採点用の合成 PDF は、まだない（E が `proposals/` に作る）。`npm run eval` にはまだ入っていない。

## できないこと（限界）

- **ユーザーのフォルダでない所の名前**（`D:\広報\山田\…` のような、作業者の姓のフォルダ）は見つけない。名前の辞書を持たないため。
- **数字の入った人名**（`yamada2` など）は、アカウントとみなして数えない。逆に、数字のない端末名・アカウント（`kouhou` など）は数える。
- 人名らしい欄の値が、人名か部署名か会社名かは見分けない。
- zstd の形の編集用データの中身は調べない。
- XMP は XML として正しく読んでいない（正規表現で拾う）。名前空間の接頭辞が違う（`dc:` 以外の接頭辞で同じ名前空間を使う）XMP は見逃す。
- 文書全体の XMP、写真の EXIF（JPEG の中の APP1。P10）は見ない。
- 1つのストリームは 16 MB まで、展開した編集用データは 64 MB まで、オブジェクトは 1,000,000 個まで見る。超えたら `limits` に出す。
- パスワードが要る暗号化 PDF は読まない（`encrypted`）。

## 1.1.0（2026-11-05）

- 画面のルールの一覧（`RULES`）に入れた。名前は「部品の XMP・アプリのデータ」（型は P2）。
- Illustrator 以外のアプリの `/PieceInfo /<アプリ> /Private` に中身があれば、`private_data`（`source: "app"`、中身は読まない）として返す。文書（カタログ）の `/PieceInfo` も見る（`owner: "document"`）。`/Private` が空のもの、`/LastModified` だけのものは数えない。
- 人名の見分け方（`classifyName`）：数字の入った値は、空白で区切った語が 2 つ以上あり、そのうち 1 つが字だけの語（小文字か、漢字・かななどを含む）なら、名前として数える（例：`Taro KAKUU-0123`）。`user01`・`PC-1234`・`PC 1234` は、いままでどおりアカウント・端末の名前として数えない。`p2-xmp` も同じ見分け方を使う。
- 合成 PDF：4 件（隠しあり 2・対照 2。`eval/cases/p2-parts.ts`）で、検出 3/3、誤検知 0。

## 1.2.0（2026-11-05）

- 画像・部品の XMP の、製造番号（`aux:SerialNumber`・`exifEX:BodySerialNumber` など）と機種（`tiff:Make`・`tiff:Model`・`exifEX:LensModel`・`aux:Lens`）を P10 として返す（画面では、製造番号が中・機種が低【仮】）。作った人の欄に `tiff:Artist` を足した。
- Illustrator の編集用データ（`/PieceInfo /Illustrator /Private`。`%AI12_CompressedData` の zlib）の中の `%%For`（作った人のユーザー名）は、1.0.0 から返している。合成 PDF（`pp-l04`）で確かめた。zstd の形は、展開せずに「中身は調べていない」として返す。
- 合成 PDF：7 件（隠しあり 4・対照 3）で、検出 9/9、誤検知 0。

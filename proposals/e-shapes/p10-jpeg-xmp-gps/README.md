# 採点する側に足す案：JPEG の中の XMP に残った撮った場所と撮った人（P10）

CLAUDE.md §2-3 に従い、`fixtures/` に足す合成 PDF と正解データの案をここに置く。人が中身を見て、移すコミットを作る。名前は架空（山田太郎）、座標は海の上の架空の値（北緯 30 度・東経 140 度）。

## 何を足すか

| 合成 PDF | 型 | 中身 |
|---|---|---|
| `p10-x01-jpeg-xmp-gps-creator` | 漏れ 2（P10。gps・person） | 画像 XObject（`/DCTDecode`）の JPEG に、APP1 の `http://ns.adobe.com/xap/1.0/\0` で始まる XMP の包み。`exif:GPSLatitude`・`exif:GPSLongitude` と、`dc:creator` の `rdf:li` に「山田太郎」。Exif の APP1（`Exif\0\0`）は無い。画像に `/Metadata` も付けない |
| `p10-xc01-jpeg-xmp-orientation-only` | 漏れでない 2 | 同じ形の XMP に、`tiff:Orientation` と大きさ（`exif:PixelXDimension`・`exif:PixelYDimension`）だけ |

作り方：`node build.mjs [出力先]`。出力先を省くと、横の `out/`（コミットしない）に書く。JPEG は `@napi-rs/canvas`（リポジトリの依存にある）で 16×16 の画像を符号化し、APP0 のすぐあとに APP1 を足す。日時も乱数も使わないので、何度作っても同じバイト列になる。

## なぜ漏れか

写真の編集ソフトで Exif を消しても、XMP の側に位置と撮った人が残ることがある。PDF に貼ると、画像のバイト列の中にそのまま入り、画像を書き出せばふつうの写真の道具で読める。

## 今の型との違い

- `rules/p10-exif/index.ts` の `exifOf`（66〜90 行）は、APP1 のうち `Exif\0\0` で始まるものだけを読む（README の限界「JPEG の中の XMP・IPTC は見ない」）。
- `rules/p2-parts`・`rules/p2-xmp` は PDF の `/Metadata` のストリームの XMP だけを見て、画像のバイト列の中は見ない。`rules/extras` は JPEG の中の C2PA だけを見る。
- `proposals/blind` の t78・t79・t80 は Exif の欄、t08-a-image-xmp は画像に付けた `/Metadata`。`eval/cases/pdf.ts` の `tinyJpeg` には 2 つめの APP1 を足す引数 `extraApp` があるが、どの合成 PDF でも使っていない。

## 確かめた結果（2026-11-07、Node 24.19.0、Windows）

`node build.mjs` を2回（`out/` と `out-again/`）実行し、PDF 2 個と正解データ 2 個の SHA-256 がすべて同じだった。

| 合成 PDF | SHA-256（先頭16桁） | 検出ルール | 検証器（`verifier/` の CLI。呼ぶだけ） |
|---|---|---|---|
| p10-x01-jpeg-xmp-gps-creator | `c99bc51656274a10` | **見逃し**：P10 0 件（`jpegImages=1`・`withExif=0`）。P2・P4 などほかの型も 0 件。`omamori.ts check` は項目 0 | P6・P1・P5・P7・P9 とも 0 件（P10 を見る検証器は無い） |
| p10-xc01-jpeg-xmp-orientation-only | `a6be3d277896e689` | 0 件（正しい） | 5 つとも 0 件 |

- `omamori.ts check` は、2 つとも stage が `unchecked` になる（P6 の「この版では読み解けない形式の画像」のお知らせ）。テスト集の t78-a-gps でも同じお知らせが出るので、この案の PDF のせいではなく、コマンドの道具が JPEG を読み解かないため（推測。`rules/p6-text` の画像の読み方は確かめていない）。
- 漏れが本物であることの確かめ：PDF のバイト列に XMP の包みの印と `exif:GPSLatitude` があり、`Exif\0\0` は無かった。対照には `GPS`・`creator`・`CreatorTool` の字が無かった。

## 正解の決め方（人の判断）

- 1件 ＝ 画像1つ × 種類1つ（今の P10 と同じ）。`where` に新しい値 `jpeg_xmp` を足す案。
- 対照に `xmp:CreatorTool` を入れなかった：Exif の `Software` を P10 の `software` として数える今の決まりとぶつかり、対照が「見つかってよいもの」になってしまうため。CreatorTool を software として数えるかは、直すときに決める（案：数える。Exif と同じ扱いにそろえる）。
- Exif と XMP の両方に同じ GPS がある版は、この案に入れていない。足すなら「画像1つ × gps で1件にまとめる」案。

## 捨てた案

- `eval/cases/pdf.ts` の `tinyJpeg` と同じ、符号だけの小さな JPEG を使う：画像として読み解けないので、ほかの検査（P6 の画像の層）に「読めない画像」とされるおそれがある。本物の符号の JPEG にした。

## 移し方（人が行う）

```
node proposals/e-shapes/p10-jpeg-xmp-gps/build.mjs fixtures/p10
npm run eval
```

- fixtures に P10 のフォルダは無いので、置き場所は人が決める。`index.md` と `hashes.txt` も足す。
- 検出ルールの直し方の案：`exifOf` と並べて、APP1 の XMP の包み（と、続きの Extended XMP）を上限つきで読み、`exif:GPSLatitude`・`exif:GPSLongitude`・`dc:creator`・`tiff:Artist` などを今の種類に当てる。

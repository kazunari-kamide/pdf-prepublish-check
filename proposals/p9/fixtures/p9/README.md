# 合成 PDF と正解データ：P9（添付ファイル）

- 一覧は `index.md`（`build.mjs` が書く）。SHA-256 の全桁は `hashes.txt`。
- 作り直し：`node fixtures/p9/build.mjs`。日時を固定しているので、何度作っても同じバイト列になる（2026-11-03、3回作って同じことを確かめた）。
- 名前・団体・添付の中身は、すべて架空のもの（山田太郎、○○市 など）。Excel・Word のふりをした中身は、先頭の数バイトだけそれらしくした作り物で、開けるファイルではない。
- ページの字は ASCII だけ（標準の Helvetica）。

## 正解データ（`<名前>.expected.json`）の形

```json
{
  "file": "p9-01-names-xlsx.pdf",
  "description": "何を再現しているか",
  "leaks": [{ "id": "p9-01-names-xlsx#L1", "pattern": "P9", "name": "名簿.xlsx", "where": "names" }],
  "negatives": [{ "id": "…#N1", "kind": "external_ref", "name": "参考資料.docx" }]
}
```

- `leaks`：ファイルの中に残っている添付の中身（検出率の分母）。`where` は `names`・`annotation`・`af`・`unreferenced`。
- `negatives`：紛らわしいが添付でないもの（誤検知率の分母）。`kind` は次のどれか。

| kind | 中身 |
|---|---|
| `external_ref` | 外のファイルを指すだけで、中身（/EF）のないファイル指定 |
| `url_link` | URL を開くリンク |
| `launch_external` | 外のファイルを開くリンク（P12 とも重なる） |
| `goto_remote` | 別の PDF に飛ぶリンク |
| `empty_names_tree` | 中が空の名前の木 |
| `other_stream` | 画像・XMP など、添付でないストリーム |
| `javascript_names` | JavaScript の名前の木（P12 の範囲） |
| `decoy_text` | ページの字に書かれた「/Type /EmbeddedFile」の文字 |

# 合成 PDF と正解データ：P1（文書情報）

- 一覧は `index.md`（`build.mjs` が書く）。SHA-256 の全桁は `hashes.txt`。
- 作り直し：`node fixtures/p1/build.mjs`。日時を固定しているので、何度作っても同じバイト列になる（2026-11-03、3回作って同じことを確かめた）。
- 名前・団体は、すべて架空のもの（山田太郎、○○市、○○課、株式会社○○ など）。実在の PDF・個人名・団体名は入れない。
- ページの字は ASCII だけ（標準の Helvetica）。フォントは埋め込まない。

## 正解データ（`<名前>.expected.json`）の形

```json
{
  "file": "p1-01-author-name.pdf",
  "description": "何を再現しているか",
  "leaks": [{ "id": "p1-01-author-name#L1", "pattern": "P1", "key": "Author", "where": "current" }],
  "negatives": [{ "id": "p1-01-author-name#N1", "kind": "producer", "key": "Producer" }],
  "out_of_scope": [{ "key": "Author", "where": "previous", "note": "前の版（P5 の範囲）" }],
  "previous_info": false
}
```

- `leaks`：いまの版の文書情報で、数える欄（検出率の分母）。
- `negatives`：あるが漏れでない欄（誤検知率の分母）。`kind` は `producer`・`date`・`trapped`・`empty` のどれか。
- `out_of_scope`：前の版の文書情報など、P1 の分母に入れないもの（参考）。
- `previous_info`：前の版の文書情報があるか（検証器の `previous_info` が 1 以上になるか）。

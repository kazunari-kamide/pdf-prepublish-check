# 合成 PDF と正解データ：P5（旧版の残存）

- 一覧は `index.md`（`build.mjs` が書く）。SHA-256 の全桁は `hashes.txt`。
- 作り直し：`node fixtures/p5/build.mjs`。日時も乱数も使わないので、何度作っても同じバイト列になる（2026-11-03、3回作って同じことを確かめた）。
- オブジェクトの番号を決めて正解に書くため、PDF は pdf-lib を使わず、`build.mjs` の中の小さな書き手で書く。増分更新は、元のバイト列のあとに、変えたオブジェクトと新しい xref と trailer を書き足す。
- 名前・団体は、すべて架空のもの（山田太郎、○○市、○○課 など）。

## 正解データ（`<名前>.expected.json`）の形

```json
{
  "file": "p5-01-info-overwritten.pdf",
  "description": "何を再現しているか",
  "leaks": [{ "id": "p5-01-info-overwritten#L1", "pattern": "P5", "object": 6, "kind": "info", "where": "superseded" }],
  "negatives": [{ "id": "…#N1", "object": 3, "kind": "structure", "where": "superseded" }]
}
```

- `leaks`：いまの版では使っていないのに残っている、漏れになりうる中身（検出率の分母）。
- `negatives`：残っているが漏れでないもの（誤検知率の分母）。`kind` は `structure`（骨組み）、`filespec`、字のない `annotation`、数える欄のない `info`、P9 で数える `embedded_file`（unreferenced）。
- `kind`・`where` の意味は `rubric/p5.md` §2。

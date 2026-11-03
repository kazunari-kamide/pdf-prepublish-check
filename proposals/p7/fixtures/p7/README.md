# 合成 PDF と正解データ：P7（隠れたテキスト）

- 一覧は `index.md`（`build.mjs` が書く）。SHA-256 の全桁は `hashes.txt`。
- 作り直し：`node fixtures/p7/build.mjs`。日時も乱数も使わないので、何度作っても同じバイト列になる（2026-11-03、3回作って同じことを確かめた）。
- 名前は、すべて架空のもの（Taro Yamada など）。字は標準の Helvetica（ASCII だけ）なので、フォントは埋め込まない。

## 正解データ（`<名前>.expected.json`）の形

```json
{
  "file": "p7-01-white-text.pdf",
  "description": "何を再現しているか",
  "pages": 1,
  "leaks": [{ "id": "p7-01-white-text#L1", "pattern": "P7", "reason": "same_color", "page": 1, "rect": [x0, y0, x1, y1], "chars": 10 }],
  "negatives": [{ "id": "…#N1", "kind": "light_gray_text", "page": 1, "rect": [x0, y0, x1, y1], "note": "なぜ漏れでないか" }]
}
```

- `leaks`：取り出せるのに見えない字（検出率の分母）。`reason` は `rubric/p7.md` §2。`rect` は字の並びの箱（Helvetica の Ascent 0.718・Descent −0.207 で計算）。
- `negatives`：紛らわしいが見える字など（誤検知率の分母）。`kind` は次のどれか。

| kind | 中身 |
|---|---|
| `light_gray_text` | 薄い灰色だが読める字（白い地との明るさの差 0.15 以上） |
| `visible_on_dark` | 黒い地（四角・円）の上の白い字 |
| `visible_on_gray` | 灰色の地の上の黒い字 |
| `visible_on_dark_image` | 暗い写真の上の白い字 |
| `near_edge` | ページの端の内側の字 |
| `small_legible` | 小さいが読める字（大きさ 3・6） |
| `ocr_layer` | スキャン画像の上の、描き方 3 の字（文字認識の層） |
| `visible_layer` | 表示するレイヤーの中の字 |
| `inside_clip` | 切り抜きの中の字 |
| `translucent_highlight` | 半透明・乗算のマーカーの下の字 |
| `p6_dark_cover` | 黒い四角の下の字（P6 で数える） |
| `plain_text` | ふつうの字 |

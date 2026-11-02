# 合成 PDF と正解データ：P6（見せかけの黒塗り）

- 一覧は `index.md`（`build.mjs` が書く）。SHA-256 の全桁は `hashes.txt`。
- 作り直し：`node fixtures/p6/build.mjs`。日時と乱数を固定しているので、何度作っても同じバイト列になる（2026-11-03、3回作って SHA-256 が同じことを確かめた）。
- 名前・住所・番号は、すべて架空のもの（山田太郎、○○市、000-1234-5678 など）。実在の PDF・個人名・団体名は入れない。
- 字のフォント：BIZ UDゴシック Regular（`fonts/`。SIL Open Font License 1.1、全文は `fonts/OFL.txt`）。出典と SHA-256 は `docs/licenses.md`。
  - 埋め込む前に、字のデータを 4 バイトの区切りにそろえる（`build.mjs` の `padGlyphs`）。@pdf-lib/fontkit 1.1.1 で使う字だけに絞ると、一部の字の形が抜ける不具合を避けるため。字の形は変わらない。

## 正解データ（`<名前>.expected.json`）の形

```json
{
  "file": "p6-t01-rect-over-name.pdf",
  "description": "何を再現しているか",
  "pages": 1,
  "leaks": [
    { "id": "p6-t01-rect-over-name#L1", "pattern": "P6", "layer": "text", "cover": "fill",
      "page": 1, "rect": [x0, y0, x1, y1], "remaining": { "chars": 4 } }
  ],
  "negatives": [
    { "id": "…#N1", "kind": "design_band", "page": 1, "rect": [x0, y0, x1, y1], "note": "なぜ漏れでないか" }
  ]
}
```

- `leaks`：漏れ（検出率の分母）。`layer` と `cover` の組み合わせが、合格基準の内訳の型になる。
  - `remaining.chars`：字の層で、覆われた字の数（空白は数えない）。画像の層では `{}`（画素の数は、作り方ではなく検証器が数える）。
- `negatives`：紛らわしいが漏れでない黒い四角など（誤検知率の分母）。`kind` は次のどれか。

| kind | 中身 |
|---|---|
| `redacted_correctly` | 正しく消してある（下の字を消してある／下の画素を黒くしてある） |
| `design_band` | 見出しの黒い帯。字は帯のあとに描いてある |
| `table_header` | 表の見出しの濃い塗り。字は塗りのあと |
| `decorative_bar` | 下に字のない飾りの帯 |
| `adjacent_box` | 字のすぐ横の黒い四角。字には重なっていない |
| `underline` | 字の下端に少しかかる黒い下線 |
| `light_highlight` | 字の上の薄い色のマーカー（濃くないので隠れていない） |
| `dark_photo` | 暗い写真。説明の字は写真の上 |
| `dark_background` | 黒い背景の表紙 |
| `label_box` | 黒い四角の上に白い字（下には何もない） |
| `blank_area` | スキャンの余白（何も書かれていない所）の上の黒い四角 |

- 座標は、ページの既定の座標（ポイント。左下が原点。ページの回転 `/Rotate` はかけない）。

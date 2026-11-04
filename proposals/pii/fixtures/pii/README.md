# 見える文字の個人情報らしい字（rules/pii）の合成 PDF と正解データ

`node build.mjs` で作る（一覧は `index.md`、SHA-256 は `hashes.txt`）。

- 名前・住所・番号はすべて架空。地名は「架空県みどり市」のように、実在しない名前にした。
- 電話番号は、実際には割り当てられない形にした（固定電話の市内局番・携帯の番号の4けた目を 0 で始める）。
- マイナンバー・カード番号は、検査用の数字だけを合わせた、手で決めた並び。法人番号も同じ。
- 字のフォントは BIZ UDゴシック（SIL Open Font License 1.1。`fixtures/p6/fonts/OFL.txt`）。使う字だけを埋め込む。縦書きは、同じフォントの辞書を写して CMap を Identity-V にした。
- 型ごとに、個人情報のある PDF と、紛らわしいが個人情報ではない対照（役職名だけ、団体の代表電話、日付の並び、見本の値、条文の番号など）を入れた。横書き・縦書き・表の中。

## 正解データの形（`<名前>.expected.json`）

```json
{
  "file": "pii-01-name-label.pdf",
  "description": "…",
  "pages": 1,
  "leaks": [
    { "id": "pii-01-name-label#1", "type": "name", "page": 1, "rect": [x0, y0, x1, y1], "confidence": "high", "chars": 4 }
  ],
  "negatives": [
    { "id": "pii-01-name-label#n1", "kind": "organization", "page": 1, "rect": [x0, y0, x1, y1] }
  ]
}
```

| 欄 | 意味 |
|---|---|
| `leaks[].type` | `name`・`address`・`phone`・`my_number`・`bank_account`・`birth_date`・`email`・`card_number` |
| `leaks[].rect` | 個人情報らしい字の箱（ページの既定の座標。ポイント、左下が原点）。字の外枠の上下は 0.879em・−0.12em |
| `leaks[].confidence` | このルールが出すべき確からしさ（`high`・`check`）。合否には使わず、一致の数だけを見る |
| `leaks[].chars` | 字数（空白を除く） |
| `negatives[].kind` | 紛らわしいが個人情報ではないものの種類（`organization`・`role`・`heading`・`sample`・`office_phone`・`date` など） |

## 照らし合わせ（`eval/pii.ts`）

同じページ・同じ型で、重なり（重なった面積 ÷ 小さいほうの箱の面積）が 0.5 以上の報告を、1対1で結ぶ。結べなかった報告が `negatives` に重なれば誤検知、どれにも重ならなくても誤検知に数える。

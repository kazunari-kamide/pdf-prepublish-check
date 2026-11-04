# 検出ルール：P11（フォームの入力値）`p11-forms`

PDF を入れると、フォームの欄（`/AcroForm /Fields` の木）に入ったままの値（`/V`）を、**字数**で返す。値そのものも、欄の名前も返さない（欄の名前が人をたどる手がかりになりうるため）。

```ts
import { detectP11Forms } from "./rules/p11-forms/index.ts";
const report = await detectP11Forms(bytes);                          // 字数だけ
const report2 = await detectP11Forms(bytes, { includeValues: true }); // 値も返す（調べるときだけ）
```

| 見え方（`visibility`） | 何か | 画面の深刻度【仮】 |
|---|---|---|
| `visible` | ページに見えるウィジェットがある | 低 |
| `hidden` | ウィジェットがあるが、すべて隠しの印（Hidden・NoView）か、大きさが 0 | 中 |
| `no_widget` | ウィジェットが無い、または、どのページにも置かれていない | 中 |

- 欄の種類（`fieldType`）：`text`・`choice`・`button`（チェックボックスなど。字数は 0）・`unknown`。種類（`/FT`）は親の欄から受け継ぐ。
- 親子の欄は、名前（`/T`）のある子を子の欄、名前のない子をウィジェットとして見る。

## 数えないもの（`notCounted`）

- 空・空白だけの値、チェックボックスなどの `/Off`、署名の欄、`/V` の無い欄（既定の値 `/DV` だけ）。

## 確かめたこと

- 合成 PDF 9 件（隠しあり 6・対照 3。`eval/cases/p11.ts`。`npm run eval:new`）：検出 8/8、誤検知 0。
- 今ある P5 の合成 PDF 2 件（フォームの値を変えた増分更新）で、ウィジェットの無い欄の値を 3 件見つけた。片付け（`sanitize/`）は、まだフォームの値を消さない（片付けの担当に頼む）。

## できないこと（限界）

- XFA のフォーム（XML のフォーム）の値は見ない（26 項目の 26 で「お知らせ」として出す予定）。
- `/Fields` の木から外れた欄は見ない。
- 欄は 100,000 個まで、入れ子は 32 段まで見る。

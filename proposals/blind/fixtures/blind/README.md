# 見ないで作るテスト集（blind）

型の一覧（漏れの型 T・誤検知しない型 F）の**説明の1行だけから**、一から作った合成 PDF と期待値。検出ルールのコード（`rules/`）・`eval/adapters/`・ほかの fixtures の作り方は見ずに作った（ルールの作り方に合わせたテストにしないため）。中身はすべて架空。

- `fixtures/` は採点する側で、Claude は書き込めない（CLAUDE.md §2-3）。そのため、いまは `proposals/blind/fixtures/blind/` に置いている。人が確かめて `fixtures/blind/` に移す。`npm run eval:blind` は、`fixtures/blind/` があればそちらを、なければこのフォルダを読む。
- 期待値（`expected.json`）は、ルールを一度も動かす前に決めてコミットした。動かしたあとに期待値を合わせない。

## 作り方

```
node build.mjs     # pdf/ に PDF を、expected.json・index.md・hashes.txt を書き出す（同じ入力なら同じバイト列）
```

- `lib/pdfw.mjs`：PDF のバイト列を一から組み立てる小さな書き手（普通の xref 表・xref ストリーム・オブジェクトストリーム・ハイブリッド・増分更新・RC4 128bit の暗号化・EXIF つきの JPEG）。外のライブラリは、JPEG を作るのに `@napi-rs/canvas` を使うだけ。
- `cases.mjs`：型の一覧と、型ごとの PDF・期待値。
- 目印の字 `KAKUSHI` ＋型の番号＋文字（例：`KAKUSHI23A`）を、隠した所にだけ入れている。見える字には入れない。片付けたあとに、この字が残っていないかを数える。

## 期待値の形

| kind | 意味 | 合格の条件 |
|---|---|---|
| `leak` | 隠しのある PDF | `expect.patterns` のどれかの型の項目が出る（`null` は型を問わない）。`page` があれば、ページも合う。`maxItems` があれば、その数以下にまとまる |
| `control` | 紛らわしいが漏れではない PDF | `expect.forbid` の型の項目が出ない（`null` はすべての型）。`forbidNotice` なら、お知らせも出ない |
| `notice` | 「知らせるだけ」の型 | お知らせ（`decrypted` 以外）か、`expect.patterns` の型の項目が出る |
| `unchecked` | 「調べられない」と出てほしい | ルールの `status` が `error` か、`partial`・`skipped_pages` のお知らせが出る |

- `expect.level`：`high`（深刻度が高）・`check`（中か低＝確認してほしい所）・`any`。深刻度は合否には入れず、表の「深刻度」の列で合った数を出す。
- `residual`：片付けたあとに残っていないはずのもの。`markers`（目印の字。バイト列・展開したストリーム・16進・UTF-16・PDF.js で取り出した字で探す）と `image`（覆いの下の画素。字の模様が残っていれば「残り」）。

## 作らなかった型

`index.md` の最後と、`cases.mjs` の `SKIPPED` に理由と案を書いた。

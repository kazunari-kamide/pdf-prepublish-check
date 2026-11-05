# 採点する側の案：見える文字の個人情報らしい字（rules/pii）

CLAUDE.md §2-3 に従い、`fixtures/` に入れるものの案を、ここに置く。人が中身を見て、移すコミットを作る。
11/5 の頼み（F）では `fixtures/pii` も持ち場だったが、`.claude/settings.json` の deny で Claude は `fixtures/` に書けないため、前例（P6・P7）どおり案の置き場所に置いた。

- **書いたのは、検出ルール（`rules/pii`）と同じセッション。** 同じ見落としを共有している可能性がある（P6 の案のように、ルールを読まない別のセッションが書いたものではない）。
- 合格基準（`rubric/pii.json`）と検証器はない。この型は片付けをしない（黒塗りにするかは利用者が決める）ので、片付けたあとの読み直しもない。採点（`eval/pii.ts`）は、`rubric/pii.json` ができるまで CLAUDE.md §4 の値（検出率 95% 以上、誤検知率 5% 以下）を【仮】として使う。

## 中身

```
proposals/pii/
  fixtures/pii/build.mjs            合成 PDF と正解データを作るスクリプト（フォントは fixtures/p6/fonts/ を読む）
  fixtures/pii/*.pdf                合成 PDF（16 個）
  fixtures/pii/*.expected.json      正解データ（漏れ 48 件、漏れでないもの 76 件）
  fixtures/pii/index.md, hashes.txt 一覧と SHA-256（build.mjs が書く）
  fixtures/pii/README.md            正解データの形
```

## 移し方（人が行う）

```
git mv proposals/pii/fixtures/pii fixtures/pii
git commit -m "見える文字の個人情報の合成 PDF を、採点する側に移す"
```

移したあと、`eval/pii.ts` は自動で `fixtures/pii/` を読む（`fixtures/pii/` がないときだけ、この案の場所を読む）。

移したあとの確かめ：

```
npm run eval:pii
node fixtures/pii/build.mjs && git status --short fixtures   # 何も変わらなければ、作り直しても同じ
```

## 確かめた結果（2026-11-04、Node 24.19.0、Windows）

- `node proposals/pii/fixtures/pii/build.mjs` を3回続けて実行し、`hashes.txt` が3回とも同じだった。
- `npm run eval:pii`：検出 47 件中 47 件、誤検知 75 件中 0 件（直す前の数は docs/evolution.md）。
- 2026-11-05：pii-09-email に、例示用のドメインのアドレスを2件（漏れ1件・記入例の対照1件）足した。見ないで作るテスト集（T95 の c-email）が、例示用のドメインのアドレスを漏れとして作っていて、この案ではその形を作っていなかった（漏れは `.test`、対照は `example.com` で作っていた）ため。足したあと、作り直しを3回続けて `hashes.txt` が同じだった。`npm run eval:pii`：直す前 48 件中 47 件・誤検知 76 件中 0 件 → 直したあと 48 件中 48 件・76 件中 0 件

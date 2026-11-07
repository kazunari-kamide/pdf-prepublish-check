# Ratchet を定時に回す設定

検査のルールを育てるループ（Ratchet。`docs/ratchet.md`）を、決まった時刻に起こすための設定と手順です。

**定時に回す設定はあります。まだ定時で回したことはありません。** タスクスケジューラへの登録もしていません（2026-11-07 時点）。

## 何を・いつ・いくらまで

設定は `ratchet/schedule.json` にあります。

| 項目 | 値 | 意味 |
|---|---|---|
| `times` | 05:00・20:00 | 毎日起こす時刻（CLAUDE.md §4-1） |
| 読むもの | 手元の束だけ | 環境変数 `OMAMORI_RATCHET_CORPUS` のフォルダにある、事前に集めた公開 PDF。ウェブには向けない（新しく取りに行かない） |
| `via` | `api` | 下読み・判断・反証は Claude API（Messages API）、ルールと見本を書く段は `claude -p` |
| `dryRun` | `true` | PR の本文を記録のフォルダに書くだけで、PR は出さない。マージはしない |
| `runBudgetUsd` | 5 | 1 回の費用の上限（ドル）。届いたら、それ以上は Claude を呼ばない |
| `bundle` | 50 | 1 回に読む数 |

束の場所・記録の場所・API キーは、このファイルにもリポジトリにも書きません。環境変数で渡します。

起こすものは `npm run ratchet:scheduled`（`ratchet/schedule.ts`）です。設定を読み、`npm run ratchet` と同じ道具（`ratchet/run.ts`）を、上の値で起こします。設定の中身は `npm run ratchet:scheduled -- --show` で見られます（Claude は呼びません）。

## 要るもの

| 環境変数 | 中身 |
|---|---|
| `ANTHROPIC_API_KEY` | 運営の Claude API のキー。Anthropic のコンソールで、月の費用の上限もかけておく |
| `OMAMORI_RATCHET_CORPUS` | 束のフォルダ |
| `OMAMORI_RATCHET_STATE` | 記録のフォルダ（リポジトリの外） |
| `OMAMORI_RATCHET_EXCLUDE` | 採点用の実データの sha256 の一覧（あれば） |

- ほかに、`claude`（ルール書きの段）・`gh`・`git`・Node が要ります。
- キーが無いと、変数の名前だけを出して、何もせずに止まります。

## 手で 1 回回す（登録しない）

キーは、その PowerShell の中だけで設定します。ユーザーの環境変数には置きません。

```powershell
$env:ANTHROPIC_API_KEY = "<キー>"          # 画面に映さない。打ったあと履歴を残さない
$env:OMAMORI_RATCHET_CORPUS = "<束のフォルダ>"
$env:OMAMORI_RATCHET_STATE = "<記録のフォルダ>"
npm run ratchet -- --via api --bundle 3 --run-budget 5   # dry-run（--pr を付けない）
Remove-Item Env:ANTHROPIC_API_KEY                         # 終わったら消す
```

ほかの Ratchet の実行が終わっていることを、先に確かめてください（記録のフォルダの「読んだもの」を、同時に書き換えないため）。

## タスクスケジューラに登録する（するときだけ）

1. **キーをユーザーの環境変数に置く。** タスクはログオンしているときだけ動き、登録した人のユーザーの環境変数を引き継ぎます。Windows のタスクスケジューラには、タスクごとに環境変数を持たせる仕組みがありません。登録するなら、`ANTHROPIC_API_KEY`・`OMAMORI_RATCHET_CORPUS`・`OMAMORI_RATCHET_STATE` をユーザーの環境変数に置きます（「システムのプロパティ」→「環境変数」。置くのは本人）。
2. **登録する中身を見る**（リポジトリのフォルダで。登録はしません）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/ratchet-schedule.ps1
   ```
   時刻・起こすコマンド・作業のフォルダと、3 つの環境変数が「ある／ない」かを表示します（値は表示しません）。
3. **登録する**：
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/ratchet-schedule.ps1 -Register
   ```
   `OmamoriPDF-Ratchet-0500` と `OmamoriPDF-Ratchet-2000` を登録します。ログオンしているときだけ動き（パスワードを保存しない）、前の回が動いていれば重ねて起こさず、3 時間で止めます。
4. **消す**：
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/ratchet-schedule.ps1 -Unregister
   ```

## 登録したあとに確かめること

- 1 回目の結果（記録のフォルダの `runs/<回の番号>/summary.json`）に、呼び方（`via`）・段ごとのモデル ID（`models`）・呼んだ回数（`calls`）・費用（`costUsd`）・読んだ件数（`counts.read`）が残っているか。
- タスクの中でも、書き込みの見張りが効くか（`docs/write-guard.md` の「まだ確かめていないこと」）。
- 定時に回しても、マージは人がします。画面や README に「毎晩更新」とは書きません。

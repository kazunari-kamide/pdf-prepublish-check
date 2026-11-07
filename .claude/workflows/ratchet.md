<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Ratchet の 1 回分のループ（段取り）

docs/ratchet.md §3 の「1 回分を回す道具」の段取り。人が 1 回起こすと、PR を出したところで止まる。マージはしない。

- 呼び出しは `claude -p`（2026-11-07 本人の決定）。そのため、段取りは Workflow のスクリプト（`*.js`）ではなく、Node のスクリプト `ratchet/run.ts` に置いた。このファイルは、その段取りの説明。
- 定時の実行（予定タスク・`/loop`）は、まだ作っていない（docs/ratchet.md §4.1）。

## 起こし方

```sh
# 束の置き場所は、環境変数でだけ渡す（パスをコマンドの履歴・画面・リポジトリに残さないよう、シェルの設定などから読む）
export OMAMORI_RATCHET_CORPUS=…   # 公開 PDF の束のフォルダ
export OMAMORI_RATCHET_STATE=…    # 読んだ記録・ログ・PR の本文の下書きを置くフォルダ（リポジトリの外）
export OMAMORI_RATCHET_EXCLUDE=…  # 採点用の実データの sha256 の一覧（1 行に 1 つ）。無ければ省く

npm run ratchet                          # 既定は dry-run：PR の本文を記録のフォルダに書くだけ
npm run ratchet -- --publish <回の番号>  # 人が dry-run を見てから：残したブランチと本文を、作り直さずに PR にする
npm run ratchet -- --pr                  # 人が見ずに、その回のうちに push して PR を出す（ラベル ratchet を付ける）
```

ふだんの流れ（2026-11-07 本人の決定）：

1. dry-run で回す。
2. 人が、記録のフォルダの `runs/<回の番号>/pr-N.md` と、ブランチ `claude/ratchet-<回の番号>-N` の差分を見る。
3. 出すと決めたら `--publish <回の番号>`。Claude は呼ばない。束も読まない（束のファイル名の一覧を取るだけ）。1 本ずつ次を確かめ、どれかで止まったら、その 1 本は出さない（`ratchet/publish.ts`）：
   - 作業の木とブランチがあり、コミットしていない変更が残っていない。
   - 本文・題・コミットの文・変えたファイルの名前に、手元のパス・束の置き場所・束のファイル名（束のフォルダの全部の名前）・sha256 が無い（`findLeaks`）。
   - 今の main を一時的な作業の木（`.tmp/ratchet-work/<回の番号>/publish-cN`）に出してブランチを重ね（`--no-commit`。ブランチ自体は変えない）、ぶつかる所が無い。dry-run のあとに main が進んでいても、きれいに重なれば先へ進む。
   - 重ねた状態で `npm test` と `npm run build` が通る。
   - 通ったら、`--force` なしで push し、`gh pr create`（ラベル ratchet）。一時的な作業の木は、通っても止まっても消す。
4. 画面と `log.jsonl` に出すのは、PR の番号と題・止まった理由だけ。結果は `summary.json` の `published` に足す。歯止めを通らなかった候補・本文の確かめで止めた候補・もう PR を出した候補は、選ばない。

道具を確かめるときは、架空の束を作って渡す（実物の公開 PDF は使わない）：

```sh
npm run ratchet:synthetic -- .tmp/ratchet-synth/corpus
OMAMORI_RATCHET_CORPUS=.tmp/ratchet-synth/corpus OMAMORI_RATCHET_STATE=.tmp/ratchet-synth/state npm run ratchet
```

画面とログに出るのは、件数・時刻・エラーの種類・番号（b01 など）だけ。束のパス・ファイル名・PDF の中身は出さない。

## 段

| 段 | 何をするか | 誰が | 道具 |
|---|---|---|---|
| 0'. 今あるルールの一覧 | main を作業の木（base）に出し、画面の一覧（RULES）・README の要点と種類・採点している型を集める。下読み（短い形）・候補・反証・ルール書きに渡す | `ratchet/catalog.ts` | — |
| 0. 却下を読む | ラベル ratchet の、マージされずに閉じた PR の「却下：〈理由〉」のコメントから、型と理由だけを読む | `ratchet/rejections.ts`（gh） | — |
| 1. 束を選ぶ | 採点用の実データを sha256 で除き、まだ読んでいない PDF を sha256 の順に 50 件。止まった束があれば、その続きから | `ratchet/bundle.ts` | — |
| 2. 下読み | 1 件ずつ、構造の要約（値は伏せる）と今のルールの判定を作り、今のルールで捕まっていない疑いを挙げる | `ratchet/probe.ts`（子のプロセス・時間で打ち切り）＋ Haiku 5.5 | 道具なし |
| 3. 候補 | 疑いを束ねて、ルールにする価値のある候補を挙げる（今あるルールが見ているもの・前に却下されたものは挙げない）。いちばん近い今のルールと、足りない理由（`nearestRule`）を書かせる | Opus 5.5 | 道具なし |
| 4. 反証 | 候補ごとに、もう捕まる（一覧のどれかのルールがすでに見ている）・漏れではない・合成で再現できない・前に却下された、のどれかなら落とす | Opus 5.5 | 道具なし |
| 5. 前の数 | 0' の main の作業の木で、採点の数をそろえて測る | `ratchet/metrics.ts` | — |
| 6. ルールと見本 | 候補ごとに main から作業の木を作り、ルール・合成 PDF（その場で作る）・テスト・合格基準の案（proposals/）を書く | Opus 5.5 | 読み書きだけ（Read・Edit・Write・Glob・Grep）。コマンド・ウェブなし |
| 7. 歯止め | 変えてよいファイルかを確かめ、採点・テスト・ビルド・外への要求 0 件を測り、main と比べる。新しい型の合成 PDF の隠しありを main の検査器にかけ、全部捕まるなら「すでに捕まる」で止める（直させない）。ほかで届かなければ理由を渡して直させる（3 回まで） | `ratchet/gate.ts`・`ratchet/known.ts`・`ratchet/metrics.ts` | — |
| 8. PR | 通ったものだけ、決まった形の本文で PR（dry-run なら本文を書くだけ）。本文にパス・ファイル名が混ざっていたら出さない | `ratchet/prbody.ts`・gh | — |
| 9. 出す（あとで、人が起こす） | 人が dry-run を見たあと、`--publish <回の番号>` で、残したブランチと本文を作り直さずに PR にする。出す前に、出してはいけない字・今の main に重なるか・テストとビルドを確かめる | `ratchet/publish.ts`・gh | — |

## 上限（2026-11-07 本人の決定）

- 直す回数：候補 1 件につき 3 回。ルールにまで進める候補は 1 回に 3 件まで。
- 費用：まず呼び出しの回数でかける（下読み 50 回・判断と反証あわせて 10 回・ルール書き 9 回）。金額の上限（`--run-budget`・`--call-budget`）は、測ってから本人が決める【要確認：値】。実物の束の 1 回目は 10.06 ドル・65.1 分だった（`--run-budget 15 --call-budget 2`）。2 回目は 10.26 ドル・60.9 分（docs/ratchet.md §3.10）。`--publish` は Claude を呼ばないので、費用はかからない。月の上限は Anthropic のコンソールで本人が決める。
- モデル：下読み Haiku 5.5。判断・反証・ルール書き Opus 5.5。

## 守り

- どの呼び出しも `claude -p --restricted`：道具を作業のフォルダの中に閉じこめる。下読み・判断・反証は道具なし（`--tools ""`）なので、PDF の中に指示が埋め込まれていても何もできない。データは指示と分けて囲んで渡す。
- ルール書きは、作業の木の `.claude/settings.json` を `--settings` で渡し、書き込みの見張り（deny とフック）を効かせる。止められたら、その候補はそこで止めて記録する（回り道をしない）。2026-11-07、`fixtures/` への書き込みが止まり、`rules/` へは書けることを確かめた。
- 歯止めは、差分のファイルでも確かめる。変えてよいのは `rules/`・`src/inspect/rules.ts`・新しい `eval/cases/*.ts`・`eval/cases/registry.ts` に足すこと・新しい `tests/*`・`proposals/`（`proposals/blind/` を除く）・`sanitize/` だけ。今ある合成 PDF・採点の道具・テスト・`rubric/`・`verifier/`・`fixtures/`・画面（`src/ui/`）を変えたら通さない。
- 例外は、ルールの一覧を固定で並べた 2 か所への「1 行足すだけ」（2026-11-07 本人の決定）：`tests/inspect-all.test.ts`（RULES の id の一覧）と `src/ui/fuda.ts`（札の短い名前）。足した行が 1・消した行が 0 のときだけ通す。
- 新しい型は、その合成 PDF の隠しありを main の検査器（全部のルール）にかけ、同じ型の番号の報告が出たものを「main がすでに捕まえた」と数える。捕まえないものが 1 つも無ければ通さない。一部なら、採点表に「main がすでに捕まえた隠しあり N/M」を出して通す（2026-11-07 本人の決定）。
- ルール書きが、今あるルールで足りると判断したときは、書かずに `alreadyCovered` に id を入れて返す。その候補はそこで止める。
- 新しい型があるときは、画面の一覧（`src/inspect/rules.ts` の RULES）にルールが増えていることも確かめる（入っていなければ、マージしても検査器に入らないので通さない）。今あるルールが一覧から消えても通さない。
- Claude の答えは決めた JSON スキーマで受け取り、`ratchet/schema.ts` でもう一度確かめて、合わなければ捨てる。
- 失敗（API の失敗・上限・採点のエラー）は、それ以上進めずに止めて記録する。

## 片付け

1 回ごとに、作業の木（`.tmp/ratchet-work/<回の番号>/base`・`c1`…）と、候補ごとのブランチ（`claude/ratchet-<回の番号>-<n>`）が残る。dry-run のときも、ブランチはこの手元にだけ作られる（push はしない）。要らなくなったら：

```sh
# node_modules は本体のものへのつなぎ（Windows は junction）。先につなぎだけを外す（外さずに木を消すと、本体の node_modules まで消えることがある）
cmd //c rmdir .tmp\ratchet-work\<回の番号>\base\node_modules       # Windows。ほかは rm .tmp/ratchet-work/<回の番号>/base/node_modules
git worktree remove --force .tmp/ratchet-work/<回の番号>/base       # c1 なども同じ手順
git branch -D claude/ratchet-<回の番号>-<n>                         # PR を出したものは、マージか却下のあとで
```

`--publish` の一時的な作業の木（`publish-c<n>`）は、道具が自分で消す。途中で止めたなどで残っていたら、同じ手順で消してからやり直す（残っていると、その候補は「前の確かめの作業の木が残っている」で止まる）。

`--from-candidates <JSON>` を付けると、束を読む・下読み・候補・反証を省いて、渡した候補（`ratchet/schema.ts` の CANDIDATES の形）からルール書きを始める。道具の確かめと、撮影のやり直しのため。

`--refute-only <JSON>` を付けると、渡した候補で反証の段だけを回して止まる（束は読まない）。`ratchet/testdata/known-misses.json` は、実物の束の 1 回目（2026-11-07）で main がすでに見ている型を「無い」とした 3 件を、架空の形にしたもの（docs/ratchet.md §3.9）。

1 回ごとに、はじめに main の作業の木（base）を作る。束を読む段で止まった回も、base は残る（片付けは下と同じ）。

## 記録（記録のフォルダの runs/<回の番号>/）

- `log.jsonl`：段ごとの件数・時刻・エラーの種類
- `summary.json`：読んだ数・疑い・候補・反証で落とした数と理由・PR・呼び出しの回数・費用・かかった分。`--publish` のあとは `published`（候補ごとの PR の番号と題・止まった理由）
- `pr-<n>.md`：PR の本文（docs/evolution.md に足す行も入れてある）
- `metrics-*`：採点の数（main と候補）
- `catalog.json`：その回に渡した、今あるルールの一覧
- `known-c<n>-<回>/`：新しい型の合成 PDF（架空の中身。main の検査器にかけたもの）

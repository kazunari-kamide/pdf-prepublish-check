# 書き込みの見張り

採点する側（`rubric/`・`verifier/`・`fixtures/`）を Claude が書き換えないように、Claude Code の設定で止めています（CLAUDE.md §2-3）。この文書は、その仕組みと、止められないことの一覧です。

## 2つの層

| 層 | 置き場所 | 止めるもの | 止めたときの表示 |
|---|---|---|---|
| 1. 権限の拒否（deny） | `.claude/settings.json` の `permissions.deny` | 採点する側の3つ、`.claude/settings.json`、`.claude/hooks/` への、Claude のファイル操作の道具（Edit・Write など）での書き込み。`.env` の読み込み | `File is in a directory that is denied by your permission settings.` |
| 2. フック（PreToolUse） | `.claude/hooks/guard-writes.mjs` | 1 と同じ場所に加えて、作業フォルダの外への書き込み。シェル（Bash・PowerShell）のコマンドで、守る場所の名前と書き込みの操作が両方あるもの | `止めました：…` と、止めた理由（CLAUDE.md のどの決まりか） |

- 道具で書き込もうとしたときは、1 が先に止めます。そのため、2 の理由は出ません。
- シェルからの書き込みと、作業フォルダの外への書き込みは、2 が止めて理由を出します。
- フックが落ちた・入力が読めないときは、止める側に倒します（`onFailure: "block"`、exit 2）。
- `.claude/settings.json` と `.claude/hooks/` は Claude が書き換えられないので、変えるときは人が手で直します。

## 止められないこと（限界）

- **スクリプトの中の書き込み。** `node x.js` や `python x.py` が中でファイルを開いて書く場合は、コマンドの文字に場所の名前が出てこないので止まりません。公式の説明にも、権限の拒否はこの場合に効かないとあります（出典：https://code.claude.com/docs/en/permissions の Read and Edit の注意書き）。
- **シェルのコマンドの読み解きは目安。** 変数や別名で場所の名前を隠すと、すり抜けます。
- **シェルからの、作業フォルダの外への書き込み。** フックは、道具（Write・Edit）で書く場合しか見ていません。
- **OS の層の囲い（sandbox）は使えない。** sandbox は macOS・Linux・WSL2 だけで、Windows で直接動かす場合は対象外です（出典：https://code.claude.com/docs/en/sandboxing ）。
- **フックを外して起動した場合。** 設定で `disableAllHooks` を指定するなど、フックを切って起動すると 2 は効きません。予定タスクの起動のしかたを決めるときに確かめます。
- **人が手で書き換えるのは止めない。** 最後の守りは、GitHub の `main` の保護（PR だけにする）です。

## 試した結果（2026-11-02、Claude Code 2.1.316、Windows）

- フックのスクリプトを単体で試しました。用意した例 24 件中 24 件が期待どおりでした（止めるべきもの 18 件、通すべきもの 6 件）。
- 実際のセッションで、わざと書き込ませました。

| 試したこと | 結果 |
|---|---|
| Write で `rubric/test-write.md` | 1 が止めた |
| Edit で `.claude/settings.json` | 1 が止めた |
| Bash で `echo test > rubric/test-write.md` | 2 が止め、理由を表示 |
| PowerShell で `Set-Content -Path .\fixtures\test-write.md` | 2 が止め、理由を表示 |
| Write で作業フォルダの外（一時フォルダ） | 2 が止め、理由を表示 |

止めたあとに、`rubric/`・`fixtures/` にも、作業フォルダの外にも、ファイルができていないことを確かめました。

- **誤検知が2回ありました。** どちらも、コミットメッセージに `rubric/` などの名前が入っていたときに `git commit` を止めたものです。
  1. 「`write-guard.md に`」の `md`（PowerShell でフォルダを作る別名）を、書き込みと取り違えた。→ コマンド名は、文の頭か `;` `&` `|` `(` 改行・引用符のあとにあるときだけ数えるようにした。
  2. `Co-Authored-By: … <…>` の閉じかっこ `>` を、ファイルへの書き出しと取り違えた。→ 文として渡すだけの部分（ヒアドキュメントの中身、引用符の中）は、書き込みの判定から外すようにした。ただし、シェルやスクリプト（`bash`・`node`・`eval` など）に読ませる部分は命令なので外さない。
- 直し方の案は Claude が作業フォルダの中で作って試し、`.claude/hooks/` への差し替えは人が手で行いました。
- 直したあと、本物のフックで、例 36 件中 36 件が期待どおりでした。例には、止まった2つのコミット、`bash -c "rm -rf fixtures"`、`bash <<EOF` の中の `rm`、`node -e` での `writeFileSync`、`git commit … && rm -rf verifier` などのすり抜けを狙った書き込みを入れています。
- 実際のセッションでも、Bash（`rubric/`）・PowerShell（`fixtures/`）・Write（`verifier/`）の書き込みが、引き続き止まることを確かめました。

## 誤検知（2026-11-03、P6 の採点する側の案を書いたとき）

`proposals/p6/verifier/…`・`proposals/p6/fixtures/…` のように、**`proposals/` の下の**同じ名前のフォルダへのシェルでの書き込みも止めました。

| 止まったコマンド | 何をしようとしたか |
|---|---|
| `mkdir -p proposals/p6/fixtures/p6/fonts …` と `cp … proposals/p6/fixtures/p6/fonts/` | フォントのファイルを写す |
| `sed -i … proposals/p6/fixtures/p6/build.mjs` | スクリプトの1行を直す |
| `cat > .tmp/dump.mjs <<EOF …` のあとに `node .tmp/dump.mjs proposals/p6/fixtures/…` | 手元の試しのスクリプトを書いて、合成 PDF に当てる |

- **原因**：シェルのコマンドの判定では、`/` のあとに続く `verifier/` なども、守る場所の名前とみなしている（`guard-writes.mjs` の `checkShell`）。道具（Write・Edit）の判定はパスを解決して比べるので、`proposals/` の下は止めない。
- **このときの対応**：決まりどおり、回り道は探しませんでした。案のファイルは Write・Edit で書き、フォントのファイルは人が写しました。合成 PDF は、`node fixtures/p6/build.mjs`（スクリプトの中でファイルを書く。上の「止められないこと」の1つめ）で作りました。書き先は `proposals/` の中だけです。
- **直し方の案**（人が判断して直す）：シェルの判定で、守る場所の名前の前が `proposals/` のときは数えない。または、コマンドの中のパスを作業フォルダからのパスに直してから、先頭が `rubric/`・`verifier/`・`fixtures/` かを見る。

## まだ確かめていないこと

- 予定タスク（scheduled tasks）・クラウドのルーティンの中で、同じ設定が効くか。試し方の案は、PRD の作業計画に入れます。

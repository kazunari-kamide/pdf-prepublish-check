// SPDX-License-Identifier: AGPL-3.0-only
//
// 書き込みの見張りの試し：今の版（.claude/hooks/guard-writes.mjs）と直した版（proposals/guard/guard-writes.mjs）の
// 両方に同じ例をかけ、結果を表にする。フックは別のプロセスで動かし、標準入力に Claude Code と同じ形の JSON を渡す。
// フックは判定するだけで、ファイルには書き込まない（例のコマンドは実行しない）。
//
// 使い方：node proposals/guard/cases.mjs        （表を Markdown で出す）
//         node proposals/guard/cases.mjs --ng   （期待と違ったものだけ出す）

import { spawnSync } from "node:child_process";
import path from "node:path";

const P = path.resolve(import.meta.dirname, "..", "..");
const HOOKS = {
  今の版: path.join(P, ".claude", "hooks", "guard-writes.mjs"),
  直した版: path.join(P, "proposals", "guard", "guard-writes.mjs"),
};

const r = String.raw;
const Pf = P.replace(/\\/g, "/"); // C:/dev/...
const Pmsys = Pf.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`); // /c/dev/...
const parent = path.basename(P); // 作業フォルダの名前
const W = (fp) => ({ tool_name: "Write", cwd: P, tool_input: { file_path: fp } });
const E = (fp) => ({ tool_name: "Edit", cwd: P, tool_input: { file_path: fp } });
const B = (c, cwd = P) => ({ tool_name: "Bash", cwd, tool_input: { command: c } });
const S = (c, cwd = P) => ({ tool_name: "PowerShell", cwd, tool_input: { command: c } });

const commitHeredoc =
  `cd ${Pmsys} && ` + "git commit -q -F - <<'EOF'\n採点する側への書き込みを止める\n\n.claude/settings.json の deny で rubric/・verifier/・fixtures/ を守り、\nPreToolUse のフックで止める。docs/write-guard.md に書いた。\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nEOF\ngit log --oneline -4; git status -sb | head -1";

// PR #6 の本文の 1〜3 を、本文の説明から再現したもの（コマンドの原文は残っていない）
const pr6Body =
  "## 採点表（`npm run eval`、合成 PDF 26 個）\n\n- 合格基準・照らし合わせ方の値は `rubric/p6.json` から読む。\n" +
  "- 検証器の中身（`verifier/p6.mjs`）と合成 PDF の作り方（`fixtures/p6/build.mjs`）は読まなかった\n" +
  "- ステージを外す `git reset -q` と、採点の決まりのファイル名を含むコミットメッセージ（rubric/p6.md）\n" +
  "- 採点する側（`rubric/`・`verifier/`・`fixtures/`）は1行も変えていない。\n- 1対1のため結べなかった報告 (rubric/p6.md §2) を、まだ誤検知に数えていない\n\n" +
  "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

// [グループ, 期待, 名前, 入力]
const cases = [
  // ---- これまでの 36 件（docs/write-guard.md の「試した結果」）----
  ["これまで", "止める", "Write rubric/x.md", W(P + r`\rubric\x.md`)],
  ["これまで", "止める", "Edit fixtures（/ 区切り）", E(Pf + "/fixtures/a.json")],
  ["これまで", "止める", "Write 大文字 VERIFIER", W(P + r`\VERIFIER\a.ts`)],
  ["これまで", "止める", "Write 相対パス rubric/y", W(r`rubric\y.md`)],
  ["これまで", "止める", "Write src/../../ で外へ", W(P + r`\src\..\..\x.txt`)],
  ["これまで", "止める", "Write 作業フォルダの外", W(r`C:\Windows\Temp\x.txt`)],
  ["これまで", "止める", "Write 似た名前のフォルダ（外）", W(P + r`-copy\a.txt`)],
  ["これまで", "止める", "Write .claude/settings.json", W(P + r`\.claude\settings.json`)],
  ["これまで", "止める", "Edit .claude/hooks/guard-writes.mjs", E(P + r`\.claude\hooks\guard-writes.mjs`)],
  ["これまで", "止める", "NotebookEdit fixtures", { tool_name: "NotebookEdit", cwd: P, tool_input: { notebook_path: P + r`\fixtures\a.ipynb` } }],
  ["これまで", "通す", "Write src/a.ts", W(P + r`\src\a.ts`)],
  ["これまで", "通す", "Write rules/fixtures_note.md", W(P + r`\rules\fixtures_note.md`)],
  ["これまで", "通す", "Write docs/prd.md", W(P + r`\docs\prd.md`)],
  ["これまで", "止める", "Bash echo > rubric", B("echo x > rubric/a.md")],
  ["これまで", "止める", "Bash rm -rf fixtures", B("rm -rf fixtures")],
  ["これまで", "止める", "Bash git checkout -- rubric/", B("git checkout -- rubric/")],
  ["これまで", "止める", "Bash sed -i verifier", B("sed -i 's/a/b/' verifier/x.ts")],
  ["これまで", "止める", "PowerShell Set-Content verifier", S(r`Set-Content -Path .\verifier\a.ts -Value x`)],
  ["これまで", "止める", "PowerShell Remove-Item fixtures", S("Remove-Item -Recurse fixtures")],
  ["これまで", "通す", "Bash cat fixtures", B("cat fixtures/a.json 2>/dev/null")],
  ["これまで", "通す", "Bash npm run eval", B("npm run eval")],
  ["これまで", "通す", "Bash git diff fixtures", B("git diff --cached fixtures/")],
  ["これまで", "止める", "壊れた入力", "not json"],
  ["これまで", "止める", "Edit 書き先なし", { tool_name: "Edit", tool_input: {} }],
  ["これまで", "通す", "止まったコミット（ヒアドキュメント）", B(commitHeredoc)],
  ["これまで", "通す", "止まったコミット（write-guard.md に）", B('git commit -m "rubric/ を守る。docs/write-guard.md に書いた"')],
  ["これまで", "通す", "git commit -m に <メール> と rubric/", B('git commit -m "rubric/ を守る" -m "Co-Authored-By: A <a@example.com>"')],
  ["これまで", "通す", "PowerShell のヒア文字列のコミット", S("git commit -m @'\nfixtures/ を足す\nCo-Authored-By: A <a@example.com>\n'@")],
  ["これまで", "止める", 'echo x > "rubric/a"（引用符の中の書き先）', B('echo x > "rubric/a.md"')],
  ["これまで", "止める", "cat <<EOF > rubric/x", B("cat <<EOF > rubric/x.md\nhi\nEOF")],
  ["これまで", "止める", "bash <<EOF の中で rm fixtures", B("bash <<'EOF'\nrm -rf fixtures\nEOF")],
  ["これまで", "止める", 'bash -c "rm -rf fixtures"', B('bash -c "rm -rf fixtures"')],
  ["これまで", "止める", "node -e で writeFileSync rubric", B(`node -e "require('fs').writeFileSync('rubric/x','')"`)],
  ["これまで", "止める", 'PowerShell Set-Content "fixtures/a"', S('Set-Content -Path "fixtures/a.md" -Value x')],
  ["これまで", "止める", "echo 'x' > fixtures/a", B("echo 'x' > fixtures/a.md")],
  ["これまで", "止める", "git commit のあとに rm -rf verifier", B('git commit -m "verifier/ の話" && rm -rf verifier')],

  // ---- 今回の誤検知（直した版では通ること）----
  // docs/write-guard.md の 2026-11-03 の節
  ["誤検知 11/3", "通す", "mkdir と cp で proposals/p6/fixtures にフォントを写す",
    B(`mkdir -p proposals/p6/fixtures/p6/fonts && cp /c/Windows/Fonts/sample.ttf proposals/p6/fixtures/p6/fonts/`)],
  ["誤検知 11/3", "通す", "sed -i で proposals/p6/fixtures の1行を直す",
    B(`sed -i 's/const A = 1/const A = 2/' proposals/p6/fixtures/p6/build.mjs`)],
  ["誤検知 11/3", "通す", "試しのスクリプトを書いて proposals/p6/fixtures の PDF に当てる",
    B(`cat > .tmp/dump.mjs <<'EOF'\nimport { readFileSync } from "node:fs";\nconsole.log(readFileSync(process.argv[2]).length);\nEOF\nnode .tmp/dump.mjs proposals/p6/fixtures/p6/a.pdf`)],
  // PR #6 の「書き込みの見張りに止められたこと」1〜3（本文の説明からの再現）
  ["誤検知 PR#6", "通す", "1. git pull と、採点する側のフォルダの一覧", B("git pull && find rubric verifier fixtures -type f | head -50")],
  ["誤検知 PR#6", "通す", "2. git reset -q と、rubric/p6.md を含むコミットメッセージ",
    B(`git reset -q && git add rules/ eval/ && git commit -q -F - <<'EOF'\nP6 の検出ルールを作る（rubric/p6.json の値を読む）\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nEOF`)],
  ["誤検知 PR#6", "通す", "3. push と PR の作成（タイトルに npm run eval、本文はヒアドキュメント）",
    B(`git push -u origin claude/p6-text-rule-v1 && gh pr create --title "P6 文字の層の検出ルールと npm run eval" --body "$(cat <<'EOF'\n${pr6Body}\nEOF\n)"`)],
  ["誤検知 PR#6", "通す", "3'. 同じ PR を --body-file - <<EOF で渡す",
    B(`gh pr create --title "npm run eval を足す" --body-file - <<'EOF'\n${pr6Body}\nEOF`)],
  // 同じ種類の誤検知
  ["誤検知（同じ種類）", "通す", "コミットメッセージに writeFileSync と verifier/", B('git commit -m "writeFileSync を verifier/ から使わない"')],
  ["誤検知（同じ種類）", "通す", "fixtures から .tmp へ写す（読むだけ）", B("cp fixtures/p6/a.pdf .tmp/a.pdf")],
  ["誤検知（同じ種類）", "通す", "PowerShell で proposals/p6/fixtures に書く", S(r`Set-Content -Path .\proposals\p6\fixtures\x.md -Value "rubric/ の話"`)],
  ["誤検知（同じ種類）", "通す", "cd proposals/p6 のあとに fixtures/ に書く", B("cd proposals/p6 && mkdir -p fixtures/p6/fonts")],

  // この PR の作業中に止まったもの（試しのスクリプトの中に .claude/hooks/ の文字があった。書き先は作業フォルダの外）
  // 直した版でも止まる：書いたスクリプトを同じコマンドで動かし、中に書き込み（writeFileSync）と .claude/hooks/ の文字がある。
  // スクリプトがどこに書くかはフックから分からないので、止める側に倒す
  ["直した版でも止まる", "止める", "試しのスクリプトを書いて動かす（中に writeFileSync と .claude/hooks/）",
    B(`cat > .tmp/diff-corpus.mjs <<'EOF'\nconst a = run(path.join(P, ".claude/hooks/guard-writes.mjs"), inp);\nwriteFileSync(out, "");\nEOF\nnode .tmp/diff-corpus.mjs`)],
  ["直した版でも止まる", "止める", "書き先が変数（\"$SP/…\"）で、コマンドに .claude/hooks/ の文字がある",
    B(`SP=.tmp; cat > "$SP/diff-corpus.mjs" <<'EOF'\nconst a = run(path.join(P, ".claude/hooks/guard-writes.mjs"), inp);\nEOF\nnode "$SP/diff-corpus.mjs"`)],

  // ---- すり抜けを狙った例（止まること）----
  ["すり抜け", "止める", "./rubric/ と書く", B("echo x > ./rubric/a.md")],
  ["すり抜け", "止める", "Windows の絶対パス（Bash）", B(`echo x > ${P}\\rubric\\a.md`)],
  ["すり抜け", "止める", "Windows の絶対パス（PowerShell）", S(`Set-Content -Path ${P}\\fixtures\\a.md -Value x`)],
  ["すり抜け", "止める", "../作業フォルダ名/rubric/", B(`echo x > ../${parent}/rubric/a.md`)],
  ["すり抜け", "止める", "Git Bash の /c/… の書き方", B(`echo x > ${Pmsys}/verifier/a.md`)],
  ["すり抜け", "止める", "C:/… の書き方で .claude/settings.json", B(`echo {} > ${Pf}/.claude/settings.json`)],
  ["すり抜け", "止める", "proposals/../rubric", B("echo x > proposals/../rubric/a.md")],
  ["すり抜け", "止める", "&& のあとの rm", B("git status && rm -rf verifier")],
  ["すり抜け", "止める", "; のあとの rm（名前は1回だけ）", B("ls; rm -rf fixtures")],
  ["すり抜け", "止める", "bash -c の中の > ", B(`bash -c 'echo x > rubric/a.md'`)],
  ["すり抜け", "止める", "sh -c の中で cd してから rm", B(`sh -c "cd fixtures && rm -rf p6"`)],
  ["すり抜け", "止める", "eval の中の rm", B(`eval "rm -rf rubric"`)],
  ["すり抜け", "止める", "echo … | bash", B(`echo "rm -rf rubric" | bash`)],
  ["すり抜け", "止める", "cd rubric のあとに rm（名前は cd にだけ）", B("cd rubric && rm -f x.md")],
  ["すり抜け", "止める", "今いるフォルダが proposals/p6 で ../../rubric", B("rm -rf ../../rubric", path.join(P, "proposals", "p6"))],
  ["すり抜け", "止める", "今いるフォルダが rubric で、名前を書かずに >", B("echo x > a.md", path.join(P, "rubric"))],
  ["すり抜け", "止める", "ワイルドカード r*", B("rm -rf r*")],
  ["すり抜け", "止める", "かっこの展開 {rubric,src}", B("rm -rf ./{rubric,src}")],
  ["すり抜け", "止める", "変数に入れて rm", B("D=rubric; rm -rf $D")],
  ["すり抜け", "止める", "xargs で rm", B("echo rubric | xargs rm -rf")],
  ["すり抜け", "止める", "find -delete", B("find rubric -name '*.md' -delete")],
  ["すり抜け", "止める", "find . -exec rm", B(`find . -name "*.json" -exec rm {} \\;`)],
  ["すり抜け", "止める", "python -c で shutil.rmtree", B(`python -c "import shutil; shutil.rmtree('rubric')"`)],
  ["すり抜け", "止める", "node -e で rmSync", B(`node -e "require('fs').rmSync('fixtures',{recursive:true})"`)],
  ["すり抜け", "止める", "cp の書き先が rubric/", B("cp src/a.ts rubric/")],
  ["すり抜け", "止める", "cp -t verifier", B("cp -t verifier src/a.ts")],
  ["すり抜け", "止める", "cp -r で同じ名前のフォルダを . に写す", B("cp -r proposals/p6/fixtures .")],
  ["すり抜け", "止める", "mv rubric を外へ", B("mv rubric .tmp/old")],
  ["すり抜け", "止める", "rm -rf .（作業フォルダごと）", B("rm -rf .")],
  ["すり抜け", "止める", "末尾に . をつける（Windows では同じ場所）", B("echo x > rubric./a.md")],
  ["すり抜け", "止める", "tee で .claude/settings.json", B("echo {} | tee .claude/settings.json")],
  ["すり抜け", "止める", "rm -rf .claude/hooks", B("rm -rf .claude/hooks")],
  ["すり抜け", "止める", ">| と &> で書く", B("echo x >| fixtures/a.md; echo y &> fixtures/b.md")],
  ["すり抜け", "止める", "引用符なしのヒアドキュメントの中の $(rm …)", B("cat <<EOF > .tmp/x\n$(rm -rf rubric)\nEOF")],
  ["すり抜け", "止める", "git -C rubric checkout .", B("git -C rubric checkout .")],
  ["すり抜け", "止める", "$(echo rm) で命令の名前を隠す", B("$(echo rm) -rf rubric")],
  ["すり抜け", "止める", "$'…' の中に \\x72 で r を隠す", B("rm -rf $'\\x72ubric'")],
  ["すり抜け", "止める", "PowerShell：パイプで Remove-Item に渡す", S("Get-ChildItem fixtures | Remove-Item -Recurse")],
  ["すり抜け", "止める", "PowerShell：(Join-Path …) で書き先を作る", S("Remove-Item (Join-Path . 'rubric') -Recurse")],
  ["すり抜け", "止める", "PowerShell：powershell -Command の中", S(`powershell -Command "Remove-Item -Recurse fixtures"`)],
  ["すり抜け", "止める", "PowerShell：-EncodedCommand", S(`powershell -EncodedCommand ${Buffer.from("Remove-Item -Recurse fixtures", "utf16le").toString("base64")}`)],
  ["すり抜け", "止める", "PowerShell：[IO.File]::WriteAllText", S(`[IO.File]::WriteAllText('rubric/x.md', 'y')`)],
  ["すり抜け", "止める", "PowerShell：; のあとの Copy-Item の書き先", S(`git status; Copy-Item src\\a.ts -Destination verifier\\`)],
  ["すり抜け", "止める", "cmd /c del", B(`cmd /c "del /q rubric\\x.md"`)],
  ["すり抜け", "止める", "コミットのあとに cp で verifier/", B('git commit -m "x" && cp a.txt verifier/a.txt')],
  // 直した版の最初の案が通してしまい、直したもの（今の版はたまたま止める）
  ["すり抜け（案の見直し）", "止める", "スクリプトのファイルを書いて、同じコマンドで動かす", B("echo 'rm -rf rubric' > .tmp/x.sh && bash .tmp/x.sh")],
  ["すり抜け（案の見直し）", "止める", "ヒアドキュメントでスクリプトを書いて ./ で動かす", B("cat > .tmp/x.sh <<'EOF'\nrm -rf fixtures\nEOF\n./.tmp/x.sh")],
  ["すり抜け（案の見直し）", "止める", "リンクを作ってから、リンクを通して書く", B("ln -s ../rubric .tmp/l && echo x > .tmp/l/a.md")],
  ["すり抜け（案の見直し）", "止める", "PowerShell：ジャンクションを作ってから書く", S("New-Item -ItemType Junction -Path .tmp\\j -Value rubric; Set-Content .tmp\\j\\a.md x")],
  ["すり抜け（案の見直し）", "止める", "~+（今いるフォルダ）で書く", B("echo x > ~+/rubric/a.md")],
  ["すり抜け（案の見直し）", "止める", "拡張ワイルドカード @(…)", B("shopt -s extglob; rm -rf @(rubric)")],
  ["すり抜け（案の見直し）", "止める", "知らない命令（watch）の中の rm と、別の所の node", B('watch "rm -rf rubric"; node x.js')],
  ["すり抜け（案の見直し）", "止める", "trap に書いた rm", B("trap 'rm -rf rubric' EXIT")],
  // 今の版でも通ってしまうもの
  ["すり抜け（今の版も通す）", "止める", "git apply（パッチの中に rubric/）", B("git apply <<'EOF'\n--- a/rubric/p6.md\n+++ b/rubric/p6.md\n@@ -1 +1 @@\n-a\n+b\nEOF")],
  ["すり抜け（今の版も通す）", "止める", "patch（パッチの中に verifier/）", B("patch -p1 <<'EOF'\n--- a/verifier/p6.mjs\n+++ b/verifier/p6.mjs\n@@ -1 +1 @@\n-a\n+b\nEOF")],
  ["すり抜け（今の版も通す）", "止める", "git clone の行き先が fixtures", B("git clone https://example.com/x.git fixtures")],
  // 通すもの（直した版で、新しく止めないこと）
  ["通す（追加）", "通す", "git apply（パッチの中は src/ だけ）", B("git apply <<'EOF'\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\nEOF")],
  ["通す（追加）", "通す", "スクリプトを書いて動かす（守る場所の名前なし）", B("echo 'console.log(1)' > .tmp/x.mjs && node .tmp/x.mjs")],
  ["通す（追加）", "通す", "fixtures を読むだけの node のスクリプト", B("node .tmp/dump.mjs fixtures/p6/a.pdf > .tmp/out.txt")],
  ["通す（追加）", "通す", "PowerShell：fixtures を読んで .tmp に書く", S("Get-Content fixtures\\p6\\truth.json | Set-Content .tmp\\truth.json")],
  ["通す（追加）", "通す", "find で fixtures を探して cat", B("find fixtures -name '*.json' -exec cat {} \\;")],
];

// ---- 組み合わせの例（--gen）：書く操作 × パスの書き方 × 前後の書き方 ----
// 書き先が守る場所なら「止める」、同じ形で書き先を .tmp/ に変えたものは「通す」と期待する。
function generated() {
  const out = [];
  const bashOps = [
    (t) => `echo x > ${t}`, (t) => `echo x >> ${t}`, (t) => `printf x | tee ${t}`, (t) => `rm -rf ${t}`,
    (t) => `mv .tmp/a ${t}`, (t) => `cp .tmp/a ${t}`, (t) => `touch ${t}`, (t) => `mkdir -p ${t}`,
    (t) => `sed -i s/a/b/ ${t}`, (t) => `truncate -s0 ${t}`, (t) => `dd if=/dev/zero of=${t} count=1`,
    (t) => `chmod 777 ${t}`, (t) => `ln -sf .tmp/a ${t}`, (t) => `git checkout -- ${t}`, (t) => `git restore ${t}`,
    (t) => `tar -xf .tmp/a.tar -C ${t}`, (t) => `install -D .tmp/a ${t}`, (t) => `rsync -a .tmp/ ${t}`,
    (t) => `cat .tmp/a 1> ${t}`, (t) => `curl -o ${t} https://example.com/`,
  ];
  const forms = [
    (p) => p, (p) => `./${p}`, (p) => `"${p}"`, (p) => `'${p}'`, (p) => (P + "\\" + p).replace(/\//g, "\\\\").replace(/\\(?!\\)/g, "\\\\"),
    (p) => `${Pf}/${p}`, (p) => `${Pmsys}/${p}`, (p) => `../${parent}/${p}`, (p) => `proposals/../${p}`,
    (p) => p.toUpperCase(), (p) => p.replace(/^([^/]+)/, "$1."),
  ];
  const wraps = [
    (c) => c, (c) => `sudo ${c}`, (c) => `env ${c}`, (c) => `command ${c}`, (c) => `bash -c '${c}'`, (c) => `sh -c "${c}"`,
    (c) => `eval "${c}"`, (c) => `( ${c} )`, (c) => `{ ${c}; }`, (c) => `git status && ${c}`, (c) => `${c} ; echo done`,
    (c) => `true || ${c}`, (c) => `cd src && cd .. && ${c}`, (c) => `git commit -m "x" && ${c}`,
  ];
  const quoteOk = (w, c) => !((w(" ").startsWith("bash -c '") && c.includes("'")) || ((w(" ").startsWith("sh -c") || w(" ").startsWith("eval")) && c.includes('"')));
  const targets = ["rubric/a.md", "fixtures/p6/x.json", "verifier/v.mjs", ".claude/settings.json", ".claude/hooks/guard-writes.mjs"];
  const safe = ".tmp/gen/a.md";
  // 操作 × 書き方（守る場所は rubric/a.md）
  for (const op of bashOps) for (const f of forms) {
    out.push(["組み合わせ（Bash・書き方）", "止める", op(f(targets[0])), B(op(f(targets[0])))]);
  }
  // 操作 × 前後の書き方（守る場所は5つを順に）
  bashOps.forEach((op, k) => {
    for (const w of wraps) {
      const t = targets[k % targets.length];
      if (!quoteOk(w, op(t))) continue;
      out.push(["組み合わせ（Bash・前後）", "止める", w(op(t)), B(w(op(t)))]);
      out.push(["組み合わせ（Bash・前後・.tmp）", "通す", w(op(safe)), B(w(op(safe)))]);
    }
  });
  const psOps = [
    (t) => `Set-Content -Path ${t} -Value x`, (t) => `Add-Content ${t} x`, (t) => `Out-File -FilePath ${t} -InputObject x`,
    (t) => `"x" > ${t}`, (t) => `Remove-Item ${t} -Recurse -Force`, (t) => `ri ${t}`, (t) => `del ${t}`,
    (t) => `Move-Item .tmp\\a ${t}`, (t) => `Copy-Item .tmp\\a ${t}`, (t) => `Copy-Item -Path .tmp\\a -Destination ${t}`,
    (t) => `New-Item -Path ${t} -Force`, (t) => `ni ${t}`, (t) => `Clear-Content ${t}`, (t) => `Rename-Item ${t} b.md`,
    (t) => `mkdir ${t}`, (t) => `Set-Content -LiteralPath:${t} -Value x`,
  ];
  const psForms = [
    (p) => p.replace(/\//g, "\\"), (p) => `.\\${p.replace(/\//g, "\\")}`, (p) => `"${p}"`, (p) => `'${p}'`,
    (p) => `${P}\\${p.replace(/\//g, "\\")}`, (p) => `${Pf}/${p}`, (p) => `..\\${parent}\\${p.replace(/\//g, "\\")}`, (p) => p.toUpperCase(),
  ];
  const psWraps = [
    (c) => c, (c) => `git status; ${c}`, (c) => `& { ${c} }`, (c) => `if ($true) { ${c} }`, (c) => `powershell -NoProfile -Command "${c.replace(/"/g, "'")}"`,
    (c) => `git commit -m "x"; ${c}`, (c) => `cd src; cd ..; ${c}`,
  ];
  for (const op of psOps) for (const f of psForms) out.push(["組み合わせ（PowerShell・書き方）", "止める", op(f(targets[0])), S(op(f(targets[0])))]);
  psOps.forEach((op, k) => {
    for (const w of psWraps) {
      const t = targets[k % targets.length];
      out.push(["組み合わせ（PowerShell・前後）", "止める", w(op(t)), S(w(op(t)))]);
      out.push(["組み合わせ（PowerShell・前後・.tmp）", "通す", w(op(safe)), S(w(op(safe)))]);
    }
  });
  return out;
}
if (process.argv.includes("--gen")) cases.push(...generated());

function runHook(hook, inp) {
  const res = spawnSync("node", [hook], {
    input: typeof inp === "string" ? inp : JSON.stringify(inp),
    env: { ...process.env, CLAUDE_PROJECT_DIR: P },
    encoding: "utf8",
  });
  return res.status === 2 || /"permissionDecision":"deny"/.test(res.stdout) ? "止める" : "通す";
}

const onlyNg = process.argv.includes("--ng");
const rows = [];
const score = Object.fromEntries(Object.keys(HOOKS).map((k) => [k, {}]));
for (const [i, [group, want, name, inp]] of cases.entries()) {
  const got = {};
  for (const [label, hook] of Object.entries(HOOKS)) {
    got[label] = runHook(hook, inp);
    const s = (score[label][group] ??= { ok: 0, n: 0 });
    s.n++;
    if (got[label] === want) s.ok++;
  }
  if (!onlyNg || got.直した版 !== want) rows.push({ i: i + 1, group, name, want, got });
  if (got.今の版 === "止める" && got.直した版 === "通す") (score.oldOnly ??= []).push(`${i + 1} ${name}`);
}

const mark = (got, want) => (got === want ? got : `**${got}**（違う）`);
console.log("| # | 種類 | 例 | 期待 | 今の版 | 直した版 |");
console.log("|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.i} | ${r.group} | ${r.name.replace(/\|/g, "\\|")} | ${r.want} | ${mark(r.got.今の版, r.want)} | ${mark(r.got.直した版, r.want)} |`);
}
console.log("\n| 種類 | 今の版 | 直した版 |");
console.log("|---|---|---|");
const groups = [...new Set(cases.map((c) => c[0]))];
let tot = Object.fromEntries(Object.keys(HOOKS).map((k) => [k, { ok: 0, n: 0 }]));
for (const g of groups) {
  const cells = Object.keys(HOOKS).map((k) => {
    const s = score[k][g];
    tot[k].ok += s.ok;
    tot[k].n += s.n;
    return `${s.n} 件中 ${s.ok} 件`;
  });
  console.log(`| ${g} | ${cells.join(" | ")} |`);
}
console.log(`| 合計 | ${Object.keys(HOOKS).map((k) => `${tot[k].n} 件中 ${tot[k].ok} 件`).join(" | ")} |`);
const oldOnly = score.oldOnly ?? [];
console.log(`\n今の版が止め、直した版が通したもの：${oldOnly.length} 件`);
for (const s of oldOnly) console.log(`- ${s}`);

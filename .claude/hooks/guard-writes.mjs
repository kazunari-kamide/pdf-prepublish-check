// SPDX-License-Identifier: AGPL-3.0-only
//
// 書き込みの見張り（PreToolUse フック）
// - 採点する側（rubric/・verifier/・fixtures/）への書き込みを止める
// - 作業フォルダ（プロジェクトのルート）の外への書き込みを止める
// - このフック自身と .claude/settings.json の書き換えを止める
// 止めたときは、理由を Claude（permissionDecisionReason）と利用者（systemMessage）の両方に出す。
// 入力が読めないなど、判断できないときは止める側に倒す（exit 2）。

import { readFileSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";

const PROTECTED_DIRS = ["rubric", "verifier", "fixtures"];
const GUARD_FILES = [".claude/settings.json", ".claude/hooks"];

const WHY_PROTECTED =
  "採点する側（rubric/・verifier/・fixtures/）は、テストを通すために書き換えてはいけない決まりです（CLAUDE.md §2-3）。" +
  "変える必要があるなら、理由を書いて人の承認を待ってください。回り道は探さないでください。";
const WHY_OUTSIDE =
  "作業フォルダの外への書き込みは止めています。必要なら、理由を書いて人に頼んでください。";
const WHY_GUARD =
  "書き込みの見張りの設定（.claude/settings.json と .claude/hooks/）は、Claude が書き換えない決まりです。変更は人が行います。";

function deny(reason, target) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `止めました：${target}\n${reason}`,
    },
    systemMessage: `【書き込みを止めました】${target}\n${reason}`,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function failClosed(message) {
  process.stderr.write(`【書き込みの見張り】判断できないため止めました：${message}`);
  process.exit(2);
}

// Windows でも比べられるよう、区切りを / にそろえ、大文字小文字をそろえる
function norm(p) {
  let s = p.replace(/\\/g, "/");
  if (process.platform === "win32") s = s.toLowerCase();
  return s.replace(/\/+$/, "");
}

// シンボリックリンクをたどった先も見る。まだ無いファイルは、在る親フォルダまでたどる
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    cur = realpathSync.native(cur);
  } catch {
    /* たどれなければそのまま */
  }
  return path.join(cur, ...rest);
}

function isInside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + "/");
}

// 書き先そのものと、リンクをたどった先の両方を調べる。どちらかが当たれば止める
function checkFilePath(filePath, projectDir, projectReal, cwd) {
  const raw = path.resolve(cwd, filePath);
  const pairs = [
    [raw, projectDir],
    [realish(raw), projectReal],
  ];
  for (const [abs, root] of pairs) {
    for (const d of PROTECTED_DIRS) {
      if (isInside(abs, path.join(root, d))) deny(WHY_PROTECTED, filePath);
    }
    for (const g of GUARD_FILES) {
      if (isInside(abs, path.join(root, g))) deny(WHY_GUARD, filePath);
    }
    if (!isInside(abs, root)) deny(WHY_OUTSIDE, filePath);
  }
}

// シェルのコマンドは完全には読み解けないので、目安で止める（限界は docs に書く）。
// 守るフォルダの名前が出てきて、かつ書き込みにつながる操作があれば止める。
// 書き込みの操作は、文として渡すだけの部分（コミットメッセージのヒアドキュメント、引用符の中）を外して探す。
// ただし、シェルやスクリプトに読ませる部分は命令なので外さない。
const SHELL_WRITE =
  /(^|[^0-9&<>=-])>>?(?!\s*(&\d|\/dev\/null|\$null))|(^|[;&|(\n"'`]\s*|\b(xargs|sudo)\s+)(rm|rmdir|mv|cp|tee|touch|mkdir|ln|chmod|chown|truncate|dd|install|rsync|unzip|tar|ni|ri|del|erase|move|copy|ren|md|rd|sc|ac)\b|\bsed\s+(-[a-z]*i|--in-place)|\bgit\s+(checkout|restore|rm|mv|apply|stash|reset|clean|am|cherry-pick|revert|merge|pull|switch)\b|\b(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content|set-item|expand-archive)\b/i;
const CODE_WRITE = /\b(writefile|writefilesync|appendfile|createwritestream|unlink|rmsync|copyfile|renamesync)\b/i;
const INTERPRETER = /\b(bash|sh|zsh|pwsh|powershell|node|python3?|perl|ruby|cmd|eval|invoke-expression|iex)(\.exe)?\b/i;

function stripLiterals(cmd) {
  // ヒアドキュメントの中身（シェルやスクリプトに読ませるものは残す）
  let s = cmd.replace(
    /^([^\n]*?)(<<-?\s*(['"]?)([A-Za-z_]\w*)\3)([^\n]*\n)[\s\S]*?\n\4[ \t]*(?=\n|$)/gm,
    (m, pre, op, _q, tag, rest) => (INTERPRETER.test(pre) ? m : pre + op + rest + tag),
  );
  // シェルやスクリプトに文字で命令を渡すときは、引用符の中も命令なので残す
  if (INTERPRETER.test(s)) return s;
  // PowerShell のヒア文字列と、引用符の中
  s = s.replace(/@'[\s\S]*?\n'@/g, "@''@").replace(/@"[\s\S]*?\n"@/g, '@""@');
  s = s.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return s;
}

function checkShell(command) {
  const c = command.replace(/\\/g, "/");
  const lower = c.toLowerCase();
  const mentions = PROTECTED_DIRS.filter((d) =>
    new RegExp(`(^|[\\s"'=/(:;|&])${d}(/|\\s|"|'|$|\\*)`, "i").test(lower),
  );
  const mentionsGuard = /\.claude\/(settings\.json|hooks)/i.test(lower);
  const writes = SHELL_WRITE.test(stripLiterals(c)) || CODE_WRITE.test(c);
  if ((mentions.length || mentionsGuard) && writes) {
    const target = mentions.length ? mentions.map((d) => `${d}/`).join("・") : ".claude/";
    deny(mentions.length ? WHY_PROTECTED : WHY_GUARD, `シェルのコマンドが ${target} に書き込もうとしています`);
  }
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  failClosed("フックへの入力（JSON）が読めません");
}

const projectDir = process.env.CLAUDE_PROJECT_DIR;
if (!projectDir) failClosed("CLAUDE_PROJECT_DIR が渡されていません");
const projectReal = realish(projectDir);
const cwd = input.cwd || projectDir;
const tool = input.tool_name || "";
const ti = input.tool_input || {};

if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(tool)) {
  const fp = ti.file_path || ti.notebook_path;
  if (typeof fp !== "string" || fp === "") failClosed(`${tool} の書き込み先が分かりません`);
  checkFilePath(fp, projectDir, projectReal, cwd);
} else if (tool === "Bash" || tool === "PowerShell") {
  if (typeof ti.command === "string") checkShell(ti.command);
}

process.exit(0);

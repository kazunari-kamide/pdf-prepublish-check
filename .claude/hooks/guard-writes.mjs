// SPDX-License-Identifier: AGPL-3.0-only
//
// 書き込みの見張り（PreToolUse フック）【直した版の案】
// - 採点する側（rubric/・verifier/・fixtures/）への書き込みを止める
// - 作業フォルダ（プロジェクトのルート）の外への書き込みを止める（道具 Write・Edit の場合）
// - このフック自身と .claude/settings.json の書き換えを止める
// 止めたときは、理由を Claude（permissionDecisionReason）と利用者（systemMessage）の両方に出す。
// 入力が読めないなど、判断できないときは止める側に倒す（exit 2）。
//
// 今の版からの変更は、シェルのコマンドの判定（checkShell 以降）だけ。
// 道具（Edit・Write など）の判定と、作業フォルダの外の判定は、今の版と同じ。
//
// 11/6 の直し（読むだけのコマンドを止める誤検知を減らす。止める範囲は狭めすぎない）：
// - 名前の前が「書いたとおりのフォルダ名」（proposals/blind/fixtures の blind）で、作業フォルダの名前と違えば、
//   奥の同じ名前のフォルダとみなして数えない（nestedElsewhere）。$X/fixtures・../fixtures などは今までどおり数える。
// - スクリプトに読ませる部分は、その部分に出てくる名前で見る。コマンドの別の所（grep verifier/ など）の名前は、
//   引数・環境変数・標準入力を読むとき、今いるフォルダが分からないとき、シェルで書いた中身に名前があるときだけ足す。
// - open( は、書く形（'w'・'a'・'+'・'>' など、またはモードが分からない）のときだけ書き込みとみなす。
//   replace・remove も、ファイルの操作の形（os.replace、引数1つの .replace、os.remove など）のときだけ。
//   スクリプトの言語（node・python）では、> を書き出しとみなさない（比べる記号のため）。
// - PowerShell の代入（$x = …、$env:X=1）と、値だけの文（"$($_.Name)" など）は、命令とみなさない。
// - 書いた中身を命令として見るのは、書いたファイルと動かしたファイルが同じ（か分からない）ときだけ。

import { readFileSync, realpathSync, existsSync, statSync } from "node:fs";
import os from "node:os";
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

// ===========================================================================
// シェルのコマンド（Bash・PowerShell）
//
// 考え方：
// 1. コマンドを、命令ごと・語ごとに読み分ける（引用符・ヒアドキュメント・$(…)・パイプなど）。
// 2. 「書き込む命令」の書き先の語と、> などの書き先だけを、作業フォルダからのパスに直す。
//    先頭が rubric/・verifier/・fixtures/・.claude/settings.json・.claude/hooks/ なら止める。
//    それらを丸ごと含む上のフォルダ（作業フォルダそのものなど）も止める（rm -rf . など）。
// 3. 文として渡すだけの部分（コミットメッセージ、PR の本文、echo の引数、ヒアドキュメントの中身）は、
//    書き込む命令の書き先でなければ見ない。
// 4. シェルやスクリプトに読ませる部分（bash -c、node -e、eval、bash <<EOF、… | bash など）は命令なので、
//    中身を同じように読み、さらに今の版と同じ目安（名前と書き込みらしい操作の両方）でも見る。
// 5. 書き先が変数などで決まり、パスに直せないときは、今の版と同じ目安（コマンドのどこかに守る場所の名前があるか）で止める。
// 6. 読み分けられないコマンド（引用符が閉じていないなど）は、今の版と同じ判定にする。
// ===========================================================================

const SHELL_PROTECTED = [
  { rel: "rubric", guard: false },
  { rel: "verifier", guard: false },
  { rel: "fixtures", guard: false },
  { rel: ".claude/settings.json", guard: true },
  { rel: ".claude/hooks", guard: true },
];

// ---- 今の版の目安（読み分けられないとき・命令として読ませる部分に使う）----
const SHELL_WRITE =
  /(^|[^0-9&<>=-])>>?(?!\s*(&\d|\/dev\/null|\$null))|(^|[;&|(\n"'`]\s*|\b(xargs|sudo)\s+)(rm|rmdir|mv|cp|tee|touch|mkdir|ln|chmod|chown|truncate|dd|install|rsync|unzip|tar|ni|ri|del|erase|move|copy|ren|md|rd|sc|ac)\b|\bsed\s+(-[a-z]*i|--in-place)|\bgit\s+(checkout|restore|rm|mv|apply|stash|reset|clean|am|cherry-pick|revert|merge|pull|switch)\b|\b(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content|set-item|expand-archive)\b/i;
const CODE_WRITE = /\b(writefile|writefilesync|appendfile|createwritestream|unlink|rmsync|copyfile|renamesync)\b/i;
// スクリプトに読ませる部分だけに使う、広めの一覧（Node・Python・Perl・PHP・.NET などの書き込み）
// 11/6：open・fopen・replace・remove は外し、codeWrites() で形を見る。save・copy・extractall などを足した（止める側に広げる）
const CODE_WRITE_WIDE =
  /\b(writefile|writefilesync|appendfile|appendfilesync|createwritestream|unlink|unlinksync|rm|rmsync|rmdir|rmdirsync|mkdir|mkdirsync|copyfile|copyfilesync|cp|cpsync|rename|renamesync|truncate|truncatesync|symlink|symlinksync|link|linksync|writealltext|writeallbytes|writealllines|appendalltext|appendalllines|streamwriter|rmtree|copytree|copy2|move|removedirs|makedirs|write_text|write_bytes|touch|chmod|file_put_contents|writetextfile|writefile|system|exec|execsync|spawn|spawnsync|writesync|writev|writevsync|save|savefig|ez_save|copy|extract|extractall|urlretrieve|subprocess|popen|child_process|execfile|execfilesync|shell_exec|passthru|proc_open|symlink_to|hardlink_to|link_to|delete|deletefile|moveto|copyto|openwrite|createtext|appendtext|replacefile|movefile)\b/i;
// open( などに渡す、書く形のモード（'w'・'a+'・'r+'・'x'・'w:gz' など）
const WRITE_MODE_LIT = /(['"])(?:[rbtU]*[wax+][rwaxbtU+]*(?::[\w*]*)?)\1/;
const INTERPRETER = /\b(bash|sh|zsh|pwsh|powershell|node|python3?|perl|ruby|cmd|eval|invoke-expression|iex)(\.exe)?\b/i;
// スクリプトがコマンドの別の所の値（引数・環境変数・標準入力・シェルの変数）を読んでいるか
const REFS_OUTSIDE =
  /argv|environ|getenv|process\.env|\$env:|\benv\s*\[|%env|\$args\b|\$input\b|stdin|\binput\s*\(|readline|fileinput|\$\{?[A-Za-z_0-9@*#?!]|%[A-Za-z_]\w*%|\bENV\b/i;
// スクリプトの言語（node・python）では、> は比べる記号なので、書き出しとみなさない
const SHELL_WRITE_NOREDIR = new RegExp(SHELL_WRITE.source.replace(/^\(\^\|\[\^0-9&<>=-\]\)>>\?\(\?!\\s\*\(&\\d\|\\\/dev\\\/null\|\\\$null\)\)\|/, ""), "i");

// ---- 11/6：スクリプトの中の書き込みを、形で見る ----
// s[k] が開きかっこのとき、対応する閉じかっこの位置と、かっこの中の引数（上の層の , で分けたもの）を返す
function callArgs(s, k) {
  const args = [];
  let depth = 0;
  let cur = "";
  for (let j = k; j < s.length; j++) {
    const ch = s[j];
    if (ch === "'" || ch === '"' || ch === "`") {
      const e = s.indexOf(ch, j + 1);
      if (e < 0) return null;
      cur += s.slice(j, e + 1);
      j = e;
      continue;
    }
    if ("([{".includes(ch)) { depth++; if (depth === 1) continue; }
    else if (")]}".includes(ch)) {
      depth--;
      if (depth === 0) { if (cur.trim() !== "" || args.length) args.push(cur.trim()); return { end: j, args }; }
    } else if (ch === "," && depth === 1) { args.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  return null;
}

const strLit = (a) => {
  const m = /^\s*[rRbBuUfF]{0,2}(['"`])([^'"`]*)\1\s*$/.exec(a);
  return m ? m[2] : null;
};
// モードの文字列を見分ける："write"・"read"・null（モードではない＝パスなど）
function modeKind(lit) {
  if (/^[rwaxbtU+]{1,4}(:[\w*]*)?$/.test(lit)) return /[wax+]/.test(lit.split(":")[0]) ? "write" : "read";
  if (/^\s*(\+?>|\+<|\|)/.test(lit) || /\|\s*$/.test(lit)) return "write"; // Perl の '>'・'>>'・'+<'・'|cmd'
  if (/^\s*<\s*$/.test(lit) || /^\s*<(?!.*\|)/.test(lit)) return "read";
  return null;
}

// open(…) が書く形か。読むだけと言い切れる形（モードなし・読むモードだけ）以外は、書く形とみなす（安全側）
function openWrites(code) {
  const re = /(\.)?\b(open|fopen|opensync)\s*\(/gi;
  let m;
  while ((m = re.exec(code))) {
    const dotted = !!m[1];
    const r = callArgs(code, m.index + m[0].length - 1);
    if (!r) return true;
    const pos = [];
    for (const a of r.args) {
      const kw = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(a);
      if (kw) {
        const key = kw[1].toLowerCase();
        if (["encoding", "errors", "newline", "buffering", "closefd"].includes(key)) continue;
        if (key === "mode") {
          const lit = strLit(kw[2]);
          if (lit == null || modeKind(lit) !== "read") return true;
          pos.push({ kind: "read" });
          continue;
        }
        return true; // 知らないキーワード（opener=・flags= など）
      }
      if (/\bO_(WRONLY|RDWR|CREAT|TRUNC|APPEND|EXCL)\b/.test(a)) return true;
      if (/\bO_RDONLY\b/.test(a)) { pos.push({ kind: "read" }); continue; }
      if (/^\{[\s\S]*\}$/.test(a)) {
        // { flag: 'w' } など
        if (/\b(flags?|mode)\s*:/.test(a) && !/\b(flags?|mode)\s*:\s*['"]r['"]/.test(a)) return true;
        pos.push({ kind: "neutral" });
        continue;
      }
      const lit = strLit(a);
      if (lit == null) { pos.push({ kind: "expr" }); continue; }
      const k = modeKind(lit);
      if (k === "write") return true;
      pos.push({ kind: k ?? "path" });
    }
    const firstMode = pos.findIndex((p) => p.kind === "read");
    if (firstMode >= 0) {
      // モードより前に、1つめ（パスやファイルの入れ物）のほかの式があれば、形が分からない
      if (pos.slice(1, firstMode).some((p) => p.kind === "expr")) return true;
      continue;
    }
    if (pos.length === 0) continue; // p.open() など
    if (pos.length === 1) {
      // open(p)・fitz.open(p)。ただし Path(…).open(m) の m が書くモードかもしれないので、
      // 点つきで中身が式のときは、コードのどこかに書くモードの文字列があれば書く形とみなす
      if (dotted && pos[0].kind === "expr" && WRITE_MODE_LIT.test(code)) return true;
      continue;
    }
    return true; // open(p, m) のようにモードが式で、分からない
  }
  // Perl の、かっこなしの open（open my $fh, '>', $f）
  const pm = /\bopen\s+(?:my\s+)?[$\w]+\s*,([^;\n]*)/g;
  while ((m = pm.exec(code))) {
    const lits = [...m[1].matchAll(/(['"])([^'"]*)\1/g)].map((x) => modeKind(x[2]));
    if (!lits.includes("read") || lits.includes("write")) return true;
  }
  return false;
}

// os.replace・Path.replace（引数1つ）・os.remove などのファイルの操作か。str.replace(a, b)・list.remove(x) は数えない
function fileOpCalls(code, name, osNames) {
  const re = new RegExp(`\\b${name}\\s*\\(`, "gi");
  let m;
  while ((m = re.exec(code))) {
    let k = m.index;
    while (k > 0 && /\s/.test(code[k - 1])) k--;
    if (code[k - 1] === "-") continue; // PowerShell の -replace（演算子）
    if (code[k - 1] !== ".") return true; // from os import remove; remove(p)
    k--;
    while (k > 0 && /\s/.test(code[k - 1])) k--;
    let h = k;
    while (h > 0 && /[\w.$]/.test(code[h - 1])) h--;
    const recv = code.slice(h, k);
    if (recv && osNames.includes(recv.split(".")[0])) return true;
    const r = callArgs(code, m.index + m[0].length - 1);
    if (!r) return true;
    if (name === "replace" && r.args.length === 1) return true; // pathlib の Path.replace(target)
  }
  return false;
}

function codeWrites(code) {
  if (CODE_WRITE_WIDE.test(code)) return true;
  if (openWrites(code)) return true;
  // open 以外の呼び出しに、書くモードを渡すもの（zipfile.ZipFile(p, 'w') など）
  if (/(['"])(w[bt]?\+?|[ra]\+[bt]?|xb|w:\w*|wb\+)\1/.test(code)) return true;
  const osNames = ["os", "shutil", "pathlib", "fs", "fse", "process"];
  for (const m of code.matchAll(/\bimport\s+(?:os|shutil)\s+as\s+(\w+)/g)) osNames.push(m[1]);
  if (fileOpCalls(code, "replace", osNames) || fileOpCalls(code, "remove", osNames)) return true;
  return false;
}

function stripLiterals(cmd) {
  let s = cmd.replace(
    /^([^\n]*?)(<<-?\s*(['"]?)([A-Za-z_]\w*)\3)([^\n]*\n)[\s\S]*?\n\4[ \t]*(?=\n|$)/gm,
    (m, pre, op, _q, tag, rest) => (INTERPRETER.test(pre) ? m : pre + op + rest + tag),
  );
  if (INTERPRETER.test(s)) return s;
  s = s.replace(/@'[\s\S]*?\n'@/g, "@''@").replace(/@"[\s\S]*?\n"@/g, '@""@');
  s = s.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return s;
}

// ---- 11/6：名前の前のフォルダを見る ----
let ROOT_NAMES = []; // 作業フォルダの名前（小文字。末尾の . と空白を除く）。下の main で入れる
let ROOT_KEYS = []; // 作業フォルダの絶対パス（比べる形）
let ROOT_DIR = "."; // 書いたとおりのパスを解くときの元
// コマンドがリンクを作るときは、フォルダのつながりが変わるので、奥の同じ名前のフォルダとみなさない（main で入れる）
let MAKES_LINKS = false;
const PREFIX_CACHE = new Map();
const LINK_WORDS = /\b(ln|mklink|junction|symboliclink|hardlink|symlink|symlinksync|symlink_to|hardlink_to|link_to|link|linksync|new-psdrive|ndr|subst|mount|bindfs)\b|\bcp\s+(-[a-z]*s|--symbolic-link)/i;
const PLAIN_CH = /[a-z0-9_.\-\u0080-\uffff]/;
const SEG_EDGE = /[\s"'=(,;|&<>]/;

// lower（小文字・/ 区切り）の idx から始まる名前の直前が / のとき、その前のフォルダが
// 書いたとおりの名前で、作業フォルダの名前と違えば、奥の同じ名前のフォルダ（proposals/blind/fixtures など）とみなす。
// $X/・${X}/・%X%/・$env:X/・*/・../・./・C:/ などは、作業フォルダかもしれないので数える（今までどおり）
function nestedElsewhere(lower, idx) {
  if (MAKES_LINKS || lower[idx - 1] !== "/") return false;
  const j = idx - 1;
  let k = j;
  while (k > 0 && PLAIN_CH.test(lower[k - 1])) k--;
  const seg = lower.slice(k, j);
  if (!seg || /^\.+$/.test(seg)) return false;
  const before = k > 0 ? lower[k - 1] : "";
  if (before && before !== "/" && !SEG_EDGE.test(before)) return false;
  if (ROOT_NAMES.includes(seg.replace(/[. ]+$/, ""))) return false;
  // 前が書いたとおりのパスなら、リンクをたどった先が作業フォルダそのものでないかも見る
  let s = k;
  while (s > 0 && !SEG_EDGE.test(lower[s - 1])) s--;
  const prefix = lower.slice(s, j);
  if (!/[$%~*?{}[\]`@!^]/.test(prefix)) {
    if (!PREFIX_CACHE.has(prefix)) {
      let isRoot;
      try {
        isRoot = ROOT_KEYS.includes(segsOf(realish(path.resolve(ROOT_DIR, hostPath(prefix)))).join("/"));
      } catch {
        isRoot = true; // 分からなければ数える
      }
      PREFIX_CACHE.set(prefix, isRoot);
    }
    if (PREFIX_CACHE.get(prefix)) return false;
  }
  return true;
}

function anyMention(lower, re, accept) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(lower))) {
    const idx = m.index + m[1].length;
    if (!nestedElsewhere(lower, idx) && (!accept || accept(idx))) return true;
  }
  return false;
}

// 11/6：名前のあとの ; | & ) と、前の < > + ` , も足した（D=fixtures;、Perl の ">fixtures/a" など。止める側に広げる）
const oldRe = (d) => new RegExp(`(^|[\\s"'=/(:;|&<>+\`,])${d}(?=/|\\s|"|'|$|\\*|[;|&),\`])`, "gi");
const wideRe = (d) => new RegExp(`(^|[^a-z0-9_-])${d}(?=[^a-z0-9_-]|$)`, "g");

function mentionsOld(text, accept) {
  const lower = text.replace(/\\/g, "/").toLowerCase();
  const dirs = PROTECTED_DIRS.filter((d) => anyMention(lower, oldRe(d), accept));
  const guard = /\.claude\/(settings\.json|hooks)/i.test(lower);
  return { dirs, guard };
}

// スクリプトの中の名前：今いるフォルダが分かり、中で cd していなければ、書いたとおりの相対パスは解いて比べる
// （.tmp/omamori-verifier-p7/verifier/… は数えない。fixtures/… や、組み立てたパスは数える）
function mentionsAt(text, base, ctx) {
  const lower0 = text.replace(/\\/g, "/").toLowerCase();
  // リンクを作るコード（相対パスはリンクを置く場所からになる）も、解かずに数える
  if (base == null || MAKES_LINKS || /\b(chdir|cd|set-location|push-location|pushd|sl)\b/.test(lower0)) return mentionsOld(text);
  const accept = (idx) => {
    let a = idx;
    while (a > 0 && !/[\s"'`(),;|&<>=[\]{}+]/.test(lower0[a - 1])) a--;
    let b = idx;
    while (b < lower0.length && !/[\s"'`(),;|&<>=[\]{}+]/.test(lower0[b])) b++;
    const tok = lower0.slice(a, b);
    const edge = a > 0 ? lower0[a - 1] : "";
    if (edge && !/[\s"'`(,=[]/.test(edge)) return true; // }fixtures・)/fixtures など（組み立てたパス）
    if (/[$%~*?@!^:]/.test(tok.replace(/^[a-z]:\//, ""))) return true;
    if (tok.startsWith("/") && !/^\/(mnt\/|cygdrive\/)?[a-z]\//.test(tok)) return true;
    const abs = path.resolve(base, hostPath(tok));
    return !!(hitProtected(abs, ctx) || hitProtected(realish(abs), ctx));
  };
  return mentionsOld(text, accept);
}

function denyByMention(m, why) {
  const target = m.dirs.length ? m.dirs.map((d) => `${d}/`).join("・") : ".claude/";
  deny(m.dirs.length ? WHY_PROTECTED : WHY_GUARD, `シェルのコマンドが ${target} に書き込もうとしています（${why}）`);
}

// 今の版の判定そのもの（読み分けられなかったとき）
function legacyTop(command) {
  const c = command.replace(/\\/g, "/");
  const m = mentionsOld(c);
  if ((m.dirs.length || m.guard) && (SHELL_WRITE.test(stripLiterals(c)) || CODE_WRITE.test(c))) {
    denyByMention(m, "コマンドを読み分けられなかったため、今までの目安で判定");
  }
}

// シェルやスクリプトに読ませる部分：引用符も外さずに、今の版の目安（と広めの一覧）で見る。
// 11/6：コマンド全体を読んでから判定する（シェルで書いた中身に名前があるかを知るため）。
// base はその部分を動かすときの今いるフォルダ（分からなければ null）。lang は "script"（node・python）か "shell"
function legacyCode(code, ctx, base = null, lang = "shell") {
  ctx.codeChecks.push({ code, base: base ?? null, lang });
}

function legacyCodeNow({ code, base, lang }, ctx) {
  const c = code.replace(/\\/g, "/");
  const mc = base != null ? mentionsAt(c, base, ctx) : mentionsOld(c);
  const dirs = [...mc.dirs];
  let guard = mc.guard;
  // 今いるフォルダが守る場所の中なら、相対パスで書くだけで当たる
  const inside = base != null ? insideProtected(base, ctx) : null;
  if (inside) inside.guard ? (guard = true) : dirs.push(inside.rel);
  // コマンドの別の所の名前を足すのは、その部分が外の値を読むとき・今いるフォルダが分からないとき・
  // シェルで書いた中身に名前があるとき（書いたファイルを読むかもしれない）だけ
  if (base == null || REFS_OUTSIDE.test(c) || ctx.writtenMentions) {
    dirs.push(...ctx.mentionWhole.dirs);
    guard = guard || ctx.mentionWhole.guard;
  }
  const m = { dirs: [...new Set(dirs)], guard };
  const sw = lang === "script" ? SHELL_WRITE_NOREDIR : SHELL_WRITE;
  if ((m.dirs.length || m.guard) && (sw.test(c) || CODE_WRITE.test(c) || codeWrites(c))) {
    denyByMention(m, "シェルやスクリプトに読ませる部分に、書き込みらしい操作がある");
  }
}

// 知らない命令：今の版と同じ目安（引用符の中は外す。ただし今の版と同じく、
// コマンドのどこかにシェルやスクリプトの名前があれば外さない。watch "…" などが中で命令を動かすため）
function legacyUnknown(text, ctx) {
  const c = text.replace(/\\/g, "/");
  const m = ctx.mentionWhole;
  const s = ctx.interpWhole ? c : stripLiterals(c);
  if ((m.dirs.length || m.guard) && (SHELL_WRITE.test(s) || CODE_WRITE.test(c))) {
    denyByMention(m, "知らない命令に、書き込みらしい操作がある");
  }
}

// 書き先がパスに直せないとき：コマンドのどこかに守る場所の名前があれば止める。
// 今の版の目安より広く探す（D=rubric; のように、名前のあとに何が続いても数える）
function fallback(ctx, why) {
  if (!ctx.mentionWide) {
    const lower = ctx.whole.replace(/\\/g, "/").toLowerCase();
    // 11/6：奥の同じ名前のフォルダ（proposals/blind/fixtures など）は数えない
    const dirs = PROTECTED_DIRS.filter((d) => anyMention(lower, wideRe(d)));
    ctx.mentionWide = { dirs, guard: /\.claude([^a-z0-9_-]|$)/.test(lower) };
  }
  const m = ctx.mentionWide;
  if (m.dirs.length || m.guard) denyByMention(m, why);
}

// ---- 読み分け（字句解析）----
class ParseError extends Error {}

const short = (s) => (s.length > 60 ? s.slice(0, 57) + "…" : s).replace(/\s+/g, " ");

// $( の対応する ) を探す。引用符・ヒアドキュメント・コメントを飛ばす
function findClose(str, idx, ps) {
  let depth = 0;
  let k = idx;
  const pend = [];
  while (k < str.length) {
    const ch = str[k];
    if (!ps && ch === "\\") { k += 2; continue; }
    if (ps && ch === "`") { k += 2; continue; }
    if (ch === "'") {
      const j = str.indexOf("'", k + 1);
      if (j < 0) return -1;
      k = j + 1;
      continue;
    }
    if (ch === '"') {
      k++;
      while (k < str.length && str[k] !== '"') {
        if ((!ps && str[k] === "\\") || (ps && str[k] === "`")) k++;
        k++;
      }
      if (k >= str.length) return -1;
      k++;
      continue;
    }
    if (!ps && ch === "<" && str[k + 1] === "<" && str[k + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(str.slice(k));
      if (m) {
        pend.push({ tag: m[3], strip: m[1] === "-" });
        k += m[0].length;
        continue;
      }
    }
    if (ch === "\n" && pend.length) {
      k++;
      for (const h of pend) {
        while (k < str.length) {
          let e = str.indexOf("\n", k);
          if (e < 0) e = str.length;
          let line = str.slice(k, e).replace(/\r$/, "");
          if (h.strip) line = line.replace(/^\t+/, "");
          k = e + 1;
          if (line === h.tag) break;
        }
      }
      pend.length = 0;
      continue;
    }
    if (ch === "#" && (k === 0 || /[\s;(]/.test(str[k - 1]))) {
      while (k < str.length && str[k] !== "\n") k++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return k;
    }
    k++;
  }
  return -1;
}

function closeBacktick(str, k) {
  let j = k + 1;
  while (j < str.length) {
    if (str[j] === "\\") { j += 2; continue; }
    if (str[j] === "`") return j;
    j++;
  }
  return -1;
}

// 引用符なしのヒアドキュメントの中で実行される $(…) と `…` を拾う
function subsIn(str, dialect) {
  const ps = dialect !== "bash";
  const out = [];
  for (let k = 0; k < str.length; k++) {
    const ch = str[k];
    if (!ps && ch === "\\") { k++; continue; }
    if (ps && ch === "`") { k++; continue; }
    if (ch === "$" && str[k + 1] === "(") {
      const e = findClose(str, k + 1, ps);
      if (e < 0) throw new ParseError("$( が閉じていない");
      out.push(str.slice(k + 2, e));
      k = e;
      continue;
    }
    if (!ps && ch === "`") {
      const e = closeBacktick(str, k);
      if (e < 0) throw new ParseError("` が閉じていない");
      out.push(str.slice(k + 1, e).replace(/\\`/g, "`"));
      k = e;
    }
  }
  return out;
}

function ansiC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/g, (m, e) => {
    const t = e[0];
    if (t === "x" || t === "u" || t === "U") return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/[0-7]/.test(t)) return String.fromCharCode(parseInt(e, 8));
    const map = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
    return map[t] ?? m;
  });
}

// コマンドを命令の並びに分ける。命令 = { words, redirs, stdin, subs, pipe, raw }
function parse(src0, dialect) {
  const ps = dialect !== "bash";
  const isCmd = dialect === "cmd";
  // PowerShell は曲がった引用符も引用符として扱う
  const src = ps ? src0.replace(/[‘’‚‛]/g, "'").replace(/[“”„]/g, '"') : src0;
  const n = src.length;
  let i = 0;
  let pipeId = 0;
  const cmds = [];
  const pending = [];
  const fresh = () => ({ words: [], redirs: [], inputs: [], stdin: [], subs: [], pipe: pipeId, start: i });
  let cur = fresh();
  const finish = (pipe) => {
    cur.raw = src.slice(cur.start, i);
    if (cur.words.length || cur.redirs.length || cur.stdin.length || cur.subs.length) cmds.push(cur);
    if (!pipe) pipeId++;
    cur = fresh();
  };
  const skipWs = () => {
    while (i < n && (src[i] === " " || src[i] === "\t")) i++;
  };

  function readHeredocBodies() {
    for (const h of pending) {
      let body = "";
      while (i < n) {
        let e = src.indexOf("\n", i);
        if (e < 0) e = n;
        const line = src.slice(i, e).replace(/\r$/, "");
        i = Math.min(e + 1, n);
        const cmp = h.strip ? line.replace(/^\t+/, "") : line;
        if (cmp === h.tag) break;
        body += line + "\n";
      }
      h.body = body;
      if (!h.quoted) for (const code of subsIn(body, dialect)) h.owner.subs.push({ code, dialect });
    }
    pending.length = 0;
  }

  function readDollar() {
    // src[i] === "$"
    const nx = src[i + 1];
    if (nx === "(") {
      const e = findClose(src, i + 1, ps);
      if (e < 0) throw new ParseError("$( が閉じていない");
      cur.subs.push({ code: src.slice(i + 2, e), dialect });
      i = e + 1;
      return { text: "", dynamic: true };
    }
    if (nx === "{") {
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) break;
      }
      if (j >= n) throw new ParseError("${ が閉じていない");
      for (const code of subsIn(src.slice(i + 2, j), dialect)) cur.subs.push({ code, dialect });
      i = j + 1;
      return { text: "", dynamic: true };
    }
    const nameRe = ps ? /[A-Za-z0-9_:?^$]/ : /[A-Za-z0-9_@*#?$!-]/;
    if (nx !== undefined && nameRe.test(nx)) {
      i++;
      if (!ps && /[@*#?$!0-9-]/.test(src[i])) { i++; return { text: "", dynamic: true }; }
      while (i < n && /[A-Za-z0-9_:]/.test(src[i])) i++;
      return { text: "", dynamic: true };
    }
    i++;
    return { text: "$", dynamic: false };
  }

  function readWord() {
    const start = i;
    let text = "";
    let alt = "";
    let dynamic = false;
    let quoted = false;
    const metas = ps ? " \t\r\n;|&(){}<>" : " \t\r\n;|&()<>";
    while (i < n) {
      const c = src[i];
      if (!ps && (c === "<" || c === ">") && src[i + 1] === "(") {
        const e = findClose(src, i + 1, ps);
        if (e < 0) throw new ParseError("<( が閉じていない");
        cur.subs.push({ code: src.slice(i + 2, e), dialect });
        i = e + 1;
        dynamic = true;
        continue;
      }
      if (metas.includes(c)) break;
      if (c === "'" && !isCmd) {
        quoted = true;
        if (ps) {
          let j = i + 1;
          let s = "";
          for (;;) {
            if (j >= n) throw new ParseError("' が閉じていない");
            if (src[j] === "'") {
              if (src[j + 1] === "'") { s += "'"; j += 2; continue; }
              break;
            }
            s += src[j++];
          }
          text += s;
          alt += s;
          i = j + 1;
          continue;
        }
        const j = src.indexOf("'", i + 1);
        if (j < 0) throw new ParseError("' が閉じていない");
        text += src.slice(i + 1, j);
        alt += src.slice(i + 1, j);
        i = j + 1;
        continue;
      }
      if (!ps && c === "$" && src[i + 1] === "'") {
        quoted = true;
        let j = i + 2;
        while (j < n && src[j] !== "'") {
          if (src[j] === "\\") j++;
          j++;
        }
        if (j >= n) throw new ParseError("$' が閉じていない");
        const s = ansiC(src.slice(i + 2, j));
        text += s;
        alt += s;
        i = j + 1;
        continue;
      }
      if (c === '"') {
        quoted = true;
        i++;
        for (;;) {
          if (i >= n) throw new ParseError('" が閉じていない');
          const d = src[i];
          if (d === '"') {
            if (ps && src[i + 1] === '"') { text += '"'; alt += '"'; i += 2; continue; }
            break;
          }
          if (!ps && d === "\\" && i + 1 < n) {
            const e = src[i + 1];
            if ('$`"\\\n'.includes(e)) {
              if (e !== "\n") { text += e; alt += e; }
              i += 2;
            } else {
              text += "\\";
              alt += "\\";
              i++;
            }
            continue;
          }
          if (ps && !isCmd && d === "`" && i + 1 < n) {
            text += src[i + 1];
            alt += src[i + 1];
            i += 2;
            continue;
          }
          if (d === "$" && !isCmd) {
            const r = readDollar();
            if (r.dynamic) dynamic = true;
            text += r.text;
            alt += r.text;
            continue;
          }
          if (isCmd && d === "%") {
            const e = src.indexOf("%", i + 1);
            if (e > i + 1 && !src.slice(i + 1, e).includes('"')) { dynamic = true; i = e + 1; continue; }
          }
          if (!ps && d === "`") {
            const e = closeBacktick(src, i);
            if (e < 0) throw new ParseError("` が閉じていない");
            cur.subs.push({ code: src.slice(i + 1, e).replace(/\\`/g, "`"), dialect });
            dynamic = true;
            i = e + 1;
            continue;
          }
          text += d;
          alt += d;
          i++;
        }
        i++;
        continue;
      }
      if (ps && !isCmd && c === "@" && (src[i + 1] === "'" || src[i + 1] === '"') && /^\r?\n/.test(src.slice(i + 2, i + 4))) {
        const q = src[i + 1];
        const endRe = new RegExp(`\\n${q}@`);
        const rest = src.slice(i + 2);
        const m = endRe.exec(rest);
        if (!m) throw new ParseError("ヒア文字列が閉じていない");
        const body = rest.slice(0, m.index);
        if (q === '"') {
          const subs = subsIn(body, dialect);
          for (const code of subs) cur.subs.push({ code, dialect });
          if (subs.length || /\$[A-Za-z_{]/.test(body)) dynamic = true;
        }
        text += body;
        alt += body;
        quoted = true;
        i += 2 + m.index + 3;
        continue;
      }
      if ((c === "$" && !isCmd)) {
        const r = readDollar();
        if (r.dynamic) dynamic = true;
        text += r.text;
        alt += r.text;
        continue;
      }
      if (isCmd && c === "%") {
        const e = src.indexOf("%", i + 1);
        if (e > i + 1 && !/\s/.test(src.slice(i + 1, e))) { dynamic = true; i = e + 1; continue; }
      }
      if (!ps && c === "`") {
        const e = closeBacktick(src, i);
        if (e < 0) throw new ParseError("` が閉じていない");
        cur.subs.push({ code: src.slice(i + 1, e).replace(/\\`/g, "`"), dialect });
        dynamic = true;
        i = e + 1;
        continue;
      }
      if (!ps && /[@!+*?]/.test(c) && src[i + 1] === "(") {
        // 拡張ワイルドカード @(…)・!(…) など。何にでも当たるものとして扱う（安全側）
        const e = findClose(src, i + 1, ps);
        if (e < 0) throw new ParseError("@( が閉じていない");
        text += "*";
        alt += "*";
        i = e + 1;
        continue;
      }
      if (!ps && c === "\\") {
        // シェルでは \ は次の1字をそのまま。Windows のパスとして / と読む場合も見る（安全側）
        if (i + 1 < n) {
          text += src[i + 1];
          alt += "/" + src[i + 1];
          i += 2;
        } else i++;
        continue;
      }
      if (ps && !isCmd && c === "`") {
        if (i + 1 < n) { text += src[i + 1]; alt += src[i + 1]; i += 2; } else i++;
        continue;
      }
      if (isCmd && c === "^") {
        if (i + 1 < n) { text += src[i + 1]; alt += src[i + 1]; i += 2; } else i++;
        continue;
      }
      text += c;
      alt += c;
      i++;
    }
    if (i === start) return null;
    return { text, alt: alt === text ? null : alt, raw: src.slice(start, i), dynamic, quoted, dialect };
  }

  function readRedirect() {
    while (i < n && /[0-9*&]/.test(src[i])) i++;
    if (src[i] === "<") {
      if (src.startsWith("<<<", i)) {
        i += 3;
        skipWs();
        const w = readWord();
        if (w) cur.stdin.push({ body: w.text, quoted: true });
        return;
      }
      if (!ps && src.startsWith("<<", i)) {
        i += 2;
        let strip = false;
        if (src[i] === "-") { strip = true; i++; }
        skipWs();
        const w = readWord();
        if (!w) throw new ParseError("ヒアドキュメントの終わりの印がない");
        const h = { tag: w.text, quoted: w.quoted || w.raw.includes("\\"), strip, body: "", owner: cur };
        cur.stdin.push(h);
        pending.push(h);
        return;
      }
      i++;
      if (src[i] === ">") {
        // <> は読み書き両方で開く
        i++;
        skipWs();
        const w = readWord();
        if (w) cur.redirs.push({ word: w });
        return;
      }
      if (src[i] === "&") i++;
      skipWs();
      const iw = readWord(); // 入力（書き込みではない。パッチを読む命令のために残す）
      if (iw) cur.inputs.push(iw);
      return;
    }
    // ">"
    i++;
    if (src[i] === ">") i++;
    if (src[i] === "|") i++;
    if (src[i] === "&") {
      i++;
      skipWs();
      const w = readWord();
      if (w && !/^(\d+|-)$/.test(w.text)) cur.redirs.push({ word: w });
      return;
    }
    skipWs();
    const w = readWord();
    if (!w) throw new ParseError("書き先のない >");
    cur.redirs.push({ word: w });
  }

  while (i < n) {
    const c = src[i];
    if (c === "\n") { i++; readHeredocBodies(); finish(false); continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") { i++; continue; }
    if (!ps && c === "\\" && (src[i + 1] === "\n" || (src[i + 1] === "\r" && src[i + 2] === "\n"))) {
      i += src[i + 1] === "\r" ? 3 : 2;
      continue;
    }
    if (ps && !isCmd && c === "`" && (src[i + 1] === "\n" || (src[i + 1] === "\r" && src[i + 2] === "\n"))) {
      i += src[i + 1] === "\r" ? 3 : 2;
      continue;
    }
    if (c === "#" && !isCmd) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ps && c === "<" && src[i + 1] === "#") {
      const e = src.indexOf("#>", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === ";") { i++; if (src[i] === ";") i++; finish(false); continue; }
    if (c === "&") {
      if (src[i + 1] === "&") { i += 2; finish(false); continue; }
      if (!ps && src[i + 1] === ">") { readRedirect(); continue; }
      i++;
      if (!ps || isCmd) finish(false); // PowerShell では呼び出しの記号
      else cur.callOp = true; // 11/6：& $x … は命令の呼び出し（値の文ではない）
      continue;
    }
    if (c === "|") {
      if (src[i + 1] === "|") { i += 2; finish(false); continue; }
      i++;
      if (src[i] === "&") i++;
      finish(true);
      continue;
    }
    if (!ps && (c === "<" || c === ">") && src[i + 1] === "(") {
      cur.words.push(readWord());
      continue;
    }
    if (c === "<" || c === ">" || (ps && c === "*" && src[i + 1] === ">") || /^\d+[<>]/.test(src.slice(i, i + 4))) {
      readRedirect();
      continue;
    }
    if (c === "(") {
      if (ps && cur.words.length) {
        const e = findClose(src, i, ps);
        if (e < 0) throw new ParseError("( が閉じていない");
        cur.subs.push({ code: src.slice(i + 1, e), dialect });
        cur.words.push({ text: "", alt: null, raw: src.slice(i, e + 1), dynamic: true, quoted: false, dialect });
        i = e + 1;
        continue;
      }
      i++;
      finish(false);
      continue;
    }
    if (c === ")") { i++; finish(false); continue; }
    if (ps && !isCmd && (c === "{" || c === "}")) { i++; finish(false); continue; }
    if (!ps && c === "{" && /\s/.test(src[i + 1] ?? " ")) { i++; finish(false); continue; }
    if (!ps && c === "}" && cur.words.length === 0) { i++; finish(false); continue; }
    const w = readWord();
    if (!w) throw new ParseError(`読めない文字 ${c}`);
    cur.words.push(w);
  }
  readHeredocBodies();
  finish(false);
  return cmds;
}

// ---- パスの比べ方 ----
const WIN = process.platform === "win32";

function segsOf(p) {
  let s = p.replace(/\\/g, "/").replace(/^\/\/[?.]\//, "");
  if (WIN) s = s.toLowerCase();
  const out = [];
  for (const [k, x0] of s.split("/").entries()) {
    let x = x0;
    if (x === "" || x === ".") continue;
    if (WIN && !(k === 0 && /^[a-z]:$/.test(x))) {
      const co = x.indexOf(":"); // 代替データストリーム（a.md:zone）
      if (co >= 0) x = x.slice(0, co);
      if (x !== "..") x = x.replace(/[. ]+$/, ""); // Windows は末尾の . と空白を無視する
      if (x === "") continue;
    }
    out.push(x);
  }
  return out;
}

function globRe(p) {
  let re = "";
  for (let k = 0; k < p.length; k++) {
    const ch = p[k];
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "[") {
      const j = p.indexOf("]", k + 2);
      if (j < 0) re += "\\[";
      else {
        let body = p.slice(k + 1, j).replace(/\\/g, "\\\\");
        if (body[0] === "!" || body[0] === "^") body = "^" + body.slice(1);
        re += `[${body}]`;
        k = j;
      }
    } else re += ch.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return /^.*$/; // 読めない形は何にでも当たるものとして扱う（安全側）
  }
}

function segMatch(pat, name) {
  if (!/[*?[]/.test(pat)) return pat === name;
  return globRe(pat).test(name);
}

// abs が、守る場所そのもの・その中・それを含む上のフォルダのどれかに当たれば、その場所を返す
function hitProtected(abs, ctx) {
  const a = segsOf(abs);
  for (const t of ctx.protectedSegs) {
    let ok = true;
    for (let k = 0; k < Math.min(a.length, t.segs.length); k++) {
      if (a[k] === "**") break;
      if (!segMatch(a[k], t.segs[k])) { ok = false; break; }
    }
    if (ok) return t;
  }
  return null;
}

// abs が守る場所そのものか、その中なら、その場所を返す（上のフォルダは含めない）
function insideProtected(abs, ctx) {
  const a = segsOf(abs);
  for (const t of ctx.protectedSegs) {
    if (a.length >= t.segs.length && t.segs.every((s, k) => s === a[k])) return t;
  }
  return null;
}

// 書いたファイルと動かしたファイルが同じ（か、分からない）か
function samePath(t, tb, e, eb) {
  if (!e || !t || e.dynamic || t.dynamic) return true;
  const keys = (w, b) => {
    const out = [];
    for (const x of candidates(w)) {
      if (/[*?[{]/.test(x)) return null;
      const hp = hostPath(x);
      if (b == null && !path.isAbsolute(hp)) return null;
      const abs = path.resolve(b ?? "/", hp);
      out.push(segsOf(abs).join("/"), segsOf(realish(abs)).join("/"));
    }
    return out;
  };
  const A = keys(t, tb);
  const B = keys(e, eb);
  if (!A || !B) return true;
  return A.some((a) => B.includes(a));
}

function starBraces(s) {
  let prev;
  do { prev = s; s = s.replace(/\{[^{}]*\}/g, "*"); } while (s !== prev);
  return s;
}

function braceExpand(s, budget = { n: 64 }) {
  for (let a = 0; a < s.length; a++) {
    if (s[a] !== "{") continue;
    let depth = 0;
    let b = a;
    const commas = [];
    for (; b < s.length; b++) {
      if (s[b] === "{") depth++;
      else if (s[b] === "}") { if (--depth === 0) break; }
      else if (s[b] === "," && depth === 1) commas.push(b);
    }
    if (b >= s.length) return [s];
    const inner = s.slice(a + 1, b);
    let alts;
    if (commas.length) {
      alts = [];
      let prev = a + 1;
      for (const c of commas) { alts.push(s.slice(prev, c)); prev = c + 1; }
      alts.push(s.slice(prev, b));
    } else if (inner.includes("..")) alts = ["*"];
    else continue;
    const out = [];
    for (const alt of alts) {
      for (const e of braceExpand(s.slice(0, a) + alt + s.slice(b + 1), budget)) {
        out.push(e);
        if (--budget.n <= 0) return [starBraces(s)];
      }
    }
    return out;
  }
  return [s];
}

// Git Bash・WSL の書き方（/c/…、/mnt/c/…）と ~ を、Windows のパスに直す
function hostPath(t) {
  if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) t = os.homedir() + t.slice(1);
  if (WIN) {
    t = t.replace(/^(\\\\|\/\/)[?.][\\/]/, "");
    let m;
    if ((m = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/.exec(t))) t = `${m[1]}:/${m[2] ?? ""}`;
  }
  return t;
}

const isSink = (t) => /^(\/dev\/(null|stdout|stderr|tty|fd\/\d+)|nul|\$null|con)$/i.test(t);

function candidates(w) {
  const out = new Set();
  for (const b of [w.text, w.alt]) {
    if (b == null) continue;
    const forms = [b];
    const eq = b.indexOf("=");
    if (eq >= 0) forms.push(b.slice(eq + 1));
    if (b.startsWith("-")) {
      const co = b.indexOf(":");
      if (co >= 0) forms.push(b.slice(co + 1));
    }
    for (const f of forms) {
      const pieces = w.dialect === "bash" ? braceExpand(f) : [f, ...f.split(",")];
      for (const p of pieces) if (p !== "") out.add(p.trim());
    }
  }
  return out;
}

function target(w, base, ctx) {
  if (!w || w.sink) return;
  if (w.raw === "$null" || w.raw === "$Null") return;
  if (w.dynamic) return fallback(ctx, `書き先が変数などで決まる：${short(w.raw)}`);
  for (const t0 of candidates(w)) {
    if (t0 === "" || isSink(t0)) continue;
    let t = t0;
    // ~+ は今いるフォルダ。~- や ~名前 は分からない
    if (/^~\+([\\/]|$)/.test(t)) {
      if (base == null) { fallback(ctx, `今いるフォルダが分からない：${short(w.raw)}`); continue; }
      t = base + t.slice(2);
    } else if (/^~[^\\/]/.test(t)) {
      fallback(ctx, `書き先が ~ で始まり、場所が分からない：${short(w.raw)}`);
      continue;
    }
    const hp = hostPath(t);
    if (base == null && !path.isAbsolute(hp)) {
      fallback(ctx, `今いるフォルダが分からない：${short(w.raw)}`);
      continue;
    }
    const abs = path.resolve(base, hp);
    for (const a of [abs, realish(abs)]) {
      const hit = hitProtected(a, ctx);
      if (hit) {
        const name = hit.rel.endsWith(".json") ? hit.rel : `${hit.rel}/`;
        deny(hit.guard ? WHY_GUARD : WHY_PROTECTED, `シェルのコマンドが ${name} に書き込もうとしています（書き先：${short(w.raw)}）`);
      }
    }
  }
}

function resolveDir(base, w) {
  if (!w || w.dynamic) return null;
  if (w.alt != null) return null; // \ の読み方が2通りある
  const hp = hostPath(w.text);
  if (base == null && !path.isAbsolute(hp)) return null;
  return path.resolve(base ?? "/", hp);
}

function cmdName(t) {
  let s = t.replace(/\\/g, "/");
  s = s.slice(s.lastIndexOf("/") + 1).toLowerCase();
  return s.replace(/\.(exe|cmd|bat|com)$/, "");
}

// ---- 11/6：PowerShell の代入と、値だけの文 ----
// 代入なら、右の語の並びを返す。代入でなければ null
function psAssign(words) {
  const w0 = words[0];
  if (!w0 || w0.quoted && !w0.raw.startsWith("$")) return null;
  const lhs = String.raw`(?:\[[\w.\[\]]+\])*(?:\$\{[^}]+\}|\$[\w:?^]+)(?:\.\w+|\[[^\]]*\])*`;
  if (new RegExp(`^${lhs}$`).test(w0.raw) && words[1] && /^([+\-*/%]|\?\?)?=$/.test(words[1].raw)) return words.slice(2);
  const m = new RegExp(`^${lhs}([+\\-*/%]|\\?\\?)?=([\\s\\S]*)$`).exec(w0.raw);
  if (!m) return null;
  const val = m[2];
  if (val === "") return words.slice(1);
  // $env:FOO=1 のように、右が1語の決まった値なら、値ごと外す
  if (/^([\w.\-+:/\\]*|'[^']*'|"[^"$`]*")$/.test(val)) return words.slice(1);
  return null;
}

// 値を書いた文を返すだけの文で、ファイルを書きうるメソッドを呼んでいなければ true
const PS_SAFE_METHODS = new Set(`
  replace trim trimstart trimend split substring tolower toupper tolowerinvariant toupperinvariant tostring contains
  startswith endswith indexof lastindexof padleft padright join format equals gettype toarray where foreach
  getvalue containskey tochararray normalize isnullorempty isnullorwhitespace round floor ceiling abs max min add
  getfilename getextension getdirectoryname getfilenamewithoutextension match matches compareto getbytes getstring
  tostring tojson insert
`.split(/\s+/).filter(Boolean));
function psValueOnly(words) {
  const f = words[0];
  if (!f || !/^[$'"@]/.test(f.raw)) return false;
  const raw = words.map((w) => w.raw).join(" ");
  if (raw.includes("::")) return false;
  for (const m of raw.matchAll(/\.\s*([A-Za-z_]\w*)\s*\(/g)) if (!PS_SAFE_METHODS.has(m[1].toLowerCase())) return false;
  return true;
}

const projectRootFallback = (ctx) => ctx.projectDir;
const HERE = (dialect) => ({ text: ".", alt: null, raw: "（今いるフォルダ）", dynamic: false, quoted: false, dialect });

// ---- 命令の一覧 ----
const set = (s) => new Set(s.split(/\s+/).filter(Boolean));
// 引数がすべて書き先になりうる命令
const WRITE_ALL = set(`
  rm rmdir mv tee touch mkdir ln chmod chown chgrp truncate dd install rsync shred unlink mkfifo mknod
  ni ri del erase move ren rename md rd sc ac
  remove-item move-item mi rename-item rni clear-content clc set-item si clear-item cli
  set-acl export-csv epcsv export-clixml compress-archive start-bitstransfer
  invoke-webrequest iwr invoke-restmethod irm curl wget
  gzip gunzip bzip2 bunzip2 xz unxz zstd unzstd patch split csplit uniq cpio robocopy xcopy
  attrib icacls takeown cipher compact mklink setfacl chattr subst new-psdrive ndr start-transcript
`);
// PowerShell の、中身を書く命令（-Value などの値は書き先ではない）
const PS_CONTENT = set(`set-content sc add-content ac out-file new-item ni mkdir md tee-object tee set-item si`);
const PS_COPY = set(`copy-item cpi copy cp`);
const READONLY = set(`
  cat less more head tail grep egrep fgrep rg ls dir ll gci get-childitem get-content gc type wc diff cmp file stat
  du df pwd which where whereis test [ [[ true false sleep date echo printf write-output write-host write-error
  select-string sls measure-object select-object where-object foreach-object % ? sort-object group-object
  format-table format-list ft fl out-host out-null out-string convertto-json convertfrom-json get-item gi
  get-itemproperty test-path resolve-path join-path split-path get-filehash get-command gcm get-date
  get-location gl start-sleep md5sum sha1sum sha256sum sha512sum b2sum cksum od xxd hexdump strings jq
  tree realpath readlink basename dirname id whoami uname hostname printenv set export unset declare local
  readonly read shift return exit break continue type hash ulimit trap wait jobs kill ps tasklist history
  column nl fold fmt rev tac paste join comm seq yes expr bc tr cut base64 iconv clip
  set-clipboard cls clear tput : alias set-variable get-variable new-variable
  write-verbose write-debug write-warning write-information
`);
const KEYWORDS_BASH = set(`if then else elif do while until ! time coproc`);
const SKIP_BASH = set(`for case function select fi done esac in`);
const SKIP_PS = set(`if elseif else while until for foreach switch do try catch finally function filter param begin process end trap`);
const SHELLS = set(`bash sh zsh dash ksh fish ash mksh`);
const PSHELLS = set(`pwsh powershell powershell_ise`);
const SCRIPTS = set(`node nodejs bun tsx ts-node python python3 python2 py perl ruby php lua osascript`);
const CD = set(`cd pushd chdir set-location sl push-location pushl`);
const GIT_WRITE = set(`checkout restore rm mv apply stash clean am cherry-pick revert merge pull switch read-tree checkout-index reset update-index clone worktree`);
// 11/6：書く中身を引数で受け取る命令（rm・cp などの引数は、書く中身ではない）
const CONTENT_CMDS = set(`tee tee-object set-content sc add-content ac out-file new-item ni`);
const SCRIPT_LANG = set(`node nodejs bun tsx ts-node python python3 python2 py deno`);
// 11/6：書いても、そのままでは動かない文書・データのファイル
const DATA_EXT = /\.(md|markdown|txt|text|log|json|jsonl|csv|tsv|pdf|html?|xml|ya?ml|png|jpe?g|gif|svg|webp|out|err|diff)$/i;
const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|psm1|py|js|mjs|cjs|ts|mts|cts|rb|pl|php|bat|cmd)$/i;
const PATCH_MAX = 5 * 1024 * 1024;

// パッチの中の、書き換えるファイルの名前を拾う（a/ b/ の前置きは、ついている場合とない場合の両方を返す）
function patchPaths(text) {
  const out = new Set();
  const add = (p) => {
    p = p.trim().replace(/^"|"$/g, "");
    if (!p || p === "/dev/null") return;
    out.add(p);
    const m = /^[^/]+\/(.+)$/.exec(p);
    if (m) out.add(m[1]);
  };
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^(?:\+\+\+|---|\*\*\*) ([^\t]+)/.exec(line))) add(m[1]);
    else if ((m = /^diff --git (\S+) (\S+)/.exec(line))) { add(m[1]); add(m[2]); }
    else if ((m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line))) add(m[1]);
    else if ((m = /^Index: (.+)$/.exec(line))) add(m[1]);
  }
  return [...out];
}
const GIT_VALUE = set(`-m --message -F --file -s --strategy -X --strategy-option -b -B -c -C -S --gpg-sign --source --onto`);

function skipOpts(ws, valueOpts = new Set()) {
  ws = ws.slice();
  while (ws.length && ws[0].text.startsWith("-") && ws[0].text !== "-") {
    const t = ws.shift().text;
    if (t === "--") break;
    if (valueOpts.has(t)) ws.shift();
  }
  return ws;
}

function isCodeFlag(lang, t) {
  if (!/^-[A-Za-z]+$/.test(t)) return false;
  const last = t[t.length - 1];
  if (lang.startsWith("python") || lang === "py") return last === "c";
  if (lang === "perl") return last === "e" || last === "E";
  if (lang === "php") return t === "-r";
  if (["node", "nodejs", "bun", "tsx", "ts-node"].includes(lang)) return t === "-e" || t === "-p" || t === "-pe";
  return last === "e";
}

// ---- 1つのコマンド全体を調べる ----
function checkShell(command, dialect, cwd, ctx) {
  const run = (src, d, base, depth) => {
    if (depth > 8) { legacyCode(src, ctx, base); return; }
    let cmds;
    try {
      cmds = parse(src, d);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      if (depth === 0) legacyTop(src);
      else legacyCode(src, ctx, base);
      return;
    }
    let here = base;
    for (let k = 0; k < cmds.length; k++) {
      const c = cmds[k];
      for (const s of c.subs) run(s.code, s.dialect, here, depth + 1);
      const sameP = cmds.filter((x) => x.pipe === c.pipe);
      const stage = sameP.indexOf(c);
      const upstream = sameP.slice(0, stage).map((x) => x.raw).join("\n");
      // この命令が書くかもしれない中身（同じコマンドの中でスクリプトとして動かされたときに見る）
      c.data = [c.words.slice(1).map((w) => w.raw).join(" "), ...c.stdin.map((h) => h.body), upstream].join("\n");
      const outs = c.redirs.map((r) => r.word).filter((w) => !isSink(w.text) && w.raw !== "$null");
      if (outs.length) ctx.written.push({ data: c.data, targets: outs, base: here, content: true });
      for (const r of c.redirs) target(r.word, here, ctx);
      here = one(c, here, d, depth, { upstream, stage }, run);
    }
  };

  // 命令1つ。戻り値は、このあとの今いるフォルダ（分からなければ null）
  function one(c, cwd0, d, depth, pipe, run) {
    let cwd = cwd0;
    const ps = d !== "bash";
    let words = c.words.slice();
    let xargs = false;
    for (let guard = 0; guard < 30 && words.length; guard++) {
      if (!ps && !words[0].quoted && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(words[0].raw)) { words.shift(); continue; }
      if (ps) {
        // 11/6：PowerShell の代入（$x = …、$env:FOO=1、[int]$x = …）は、右だけを見る
        const rest = psAssign(words);
        if (rest) { words = rest; continue; }
        // 11/6：値だけの文（"$($_.Name)"、$x、$(…).Count など）は命令ではない。中の $(…) は別に見ている。
        // ただし & をつけた呼び出しと、ファイルを書きうるメソッドの呼び出し（$f.Delete() など）は今までどおり
        if (!c.callOp && psValueOnly(words)) return cwd;
      }
      const w0 = words[0];
      if (w0.dynamic) {
        fallback(ctx, `命令の名前が変数などで決まる：${short(w0.raw)}`);
        legacyCode(words.map((w) => w.raw).join(" "), ctx, cwd);
        return cwd;
      }
      const nm = cmdName(w0.text);
      if ((ps ? SKIP_PS : SKIP_BASH).has(nm)) return cwd;
      if (!ps && KEYWORDS_BASH.has(nm)) { words.shift(); continue; }
      if (nm === "sudo" || nm === "doas") { words = skipOpts(words.slice(1), set(`-u -g -C -D -h -p -r -t -U`)); continue; }
      if (["command", "builtin", "exec", "nohup", "time", "stdbuf", "ionice", "busybox", "chronic", "nice", "setsid", "unbuffer"].includes(nm)) {
        words = skipOpts(words.slice(1), set(`-n -c -p -a -o -e -i`));
        continue;
      }
      if (nm === "timeout") { words = skipOpts(words.slice(1), set(`-s -k --signal --kill-after`)).slice(1); continue; }
      if (nm === "npx" || nm === "bunx" || nm === "pnpx") { words = skipOpts(words.slice(1), set(`-p --package`)); continue; }
      if (["npm", "pnpm", "yarn"].includes(nm) && words[1] && ["dlx", "exec", "x"].includes(words[1].text)) {
        words = skipOpts(words.slice(2), set(`-p --package`));
        continue;
      }
      if (nm === "wsl") {
        const rest = words.slice(1);
        while (rest.length && rest[0].text.startsWith("-")) {
          const o = rest.shift().text;
          if (["-d", "--distribution", "-u", "--user", "--cd"].includes(o)) rest.shift();
          if (["--", "-e", "--exec"].includes(o)) break;
        }
        words = rest;
        continue;
      }
      if (nm === "env") {
        const rest = words.slice(1);
        while (rest.length) {
          const t = rest[0].text;
          if (t === "-C" || t === "--chdir") { rest.shift(); cwd = resolveDir(cwd, rest.shift()); continue; }
          if (t === "-S" || t.startsWith("--split-string")) {
            rest.shift();
            const src = rest.map((w) => w.text).join(" ");
            if (rest.some((w) => w.dynamic)) fallback(ctx, "env -S に渡す命令が変数などで決まる");
            run(src, "bash", cwd, depth + 1);
            legacyCode(src, ctx, cwd);
            return cwd0;
          }
          if (t === "-u" || t === "--unset") { rest.shift(); rest.shift(); continue; }
          if (t.startsWith("-")) { rest.shift(); continue; }
          if (/^[A-Za-z_]\w*=/.test(t)) { rest.shift(); continue; }
          break;
        }
        words = rest;
        continue;
      }
      if (nm === "xargs") {
        words = skipOpts(words.slice(1), set(`-I -i -n -P -d -E -e -L -l -s -a --arg-file --delimiter --max-args --max-procs --replace`));
        xargs = true;
        continue;
      }
      break;
    }
    if (!words.length) return cwd;

    const nm = cmdName(words[0].text);
    const args = words.slice(1);
    const T = (w, base = cwd) => {
      if (w && !w.sink) ctx.written.push({ data: c.data ?? "", targets: [w], base, content: CONTENT_CMDS.has(nm) });
      target(w, base, ctx);
    };
    const code = (src, dd, base = cwd) => {
      run(src, dd, base, depth + 1);
      legacyCode(src, ctx, base);
    };
    // 11/6：node・python の中では > を書き出しとみなさない。Perl・Ruby・PHP・awk などは > や `…` でシェルを動かせるので、今までどおり
    const lang = SCRIPT_LANG.has(nm) ? "script" : "shell";
    const scriptCode = (w) => {
      if (!w) return;
      if (w.dynamic) fallback(ctx, `スクリプトに渡す命令が変数などで決まる：${short(w.raw)}`);
      legacyCode(w.text + "\n" + w.raw, ctx, cwd, lang);
    };
    // 標準入力から命令を読むとき：ヒアドキュメント・ヒア文字列・パイプの前の段を命令として見る
    const stdinCode = (dd) => {
      const l = dd ? "shell" : lang;
      // 11/6：bash < x.sh のように、ファイルから命令を読むときも、そのファイルを動かしたものとして扱う（止める側に広げる）
      for (const w of c.inputs) ran(w, l);
      for (const h of c.stdin) {
        if (dd) run(h.body, dd, cwd, depth + 1);
        legacyCode(h.body, ctx, cwd, l);
      }
      if (pipe.upstream) legacyCode(pipe.upstream, ctx, cwd, "shell");
    };
    // 11/6：スクリプトのファイルを動かしたことを、ファイルの名前つきで残す（null は分からない）
    const ran = (w, l = "shell") => {
      ctx.execScript = true;
      ctx.execs.push({ w: w ?? null, base: cwd, lang: l });
    };

    if (xargs && !READONLY.has(nm)) fallback(ctx, "書き先を標準入力から受け取る（xargs）");
    const positional = args.filter((w) => !w.text.startsWith("-"));
    if (ps && pipe.stage > 0 && (WRITE_ALL.has(nm) || PS_CONTENT.has(nm) || PS_COPY.has(nm)) && positional.length === 0 &&
        !args.some((w) => /^-(path|literalpath|lp|pspath|filepath|destination)/i.test(w.text))) {
      fallback(ctx, "書き先をパイプから受け取る");
    }

    // 今いるフォルダを変える
    if (CD.has(nm)) {
      let w = positional[0];
      const pi = args.findIndex((x) => /^-(path|literalpath|lp)$/i.test(x.text));
      if (pi >= 0) w = args[pi + 1];
      if (!w || w.text === "-") return null;
      return resolveDir(cwd, w);
    }
    if (["popd", "pop-location", "popl"].includes(nm)) return null;

    if (nm === "git") {
      let gcwd = cwd;
      let k = 0;
      while (k < args.length) {
        const t = args[k].text;
        if (t === "-C" || t === "--work-tree") { gcwd = resolveDir(gcwd, args[k + 1]); k += 2; continue; }
        if (t.startsWith("--work-tree=")) { gcwd = resolveDir(gcwd, { ...args[k], text: t.slice(12), alt: null }); k++; continue; }
        if (["-c", "--git-dir", "--namespace", "--exec-path", "--config-env"].includes(t)) { k += 2; continue; }
        if (t.startsWith("-")) { k++; continue; }
        break;
      }
      const sub = args[k]?.text;
      if (!sub || !GIT_WRITE.has(sub)) return cwd;
      const rest = args.slice(k + 1);
      // 索引（ステージ）だけを変えるものは、ファイルに書き込まない
      if (sub === "reset" && !rest.some((w) => /^--(hard|merge|keep)$/.test(w.text))) return cwd;
      if (sub === "rm" && rest.some((w) => w.text === "--cached")) return cwd;
      if (rest.some((w) => w.text.startsWith("--pathspec-from-file"))) fallback(ctx, "git の対象をファイルから読む");
      if (sub === "apply" || sub === "am") {
        const checkOnly = sub === "apply" && rest.some((w) => /^--(check|stat|numstat|summary)$/.test(w.text)) && !rest.some((w) => w.text === "--apply");
        if (!checkOnly) patchCheck(rest.filter((w) => !w.text.startsWith("-")), c, gcwd);
      }
      for (let j = 0; j < rest.length; j++) {
        if (GIT_VALUE.has(rest[j].text)) { j++; continue; }
        if (/^--(message|file|strategy|strategy-option|source|onto)=/.test(rest[j].text)) continue;
        T(rest[j], gcwd);
      }
      if (sub === "clean" && !rest.some((w) => !w.text.startsWith("-"))) T(HERE(d), gcwd);
      return cwd;
    }

    if (nm === "find") {
      let k = 0;
      while (k < args.length && /^-(H|L|P|D|O\d*)$/.test(args[k].text)) k += args[k].text === "-D" ? 2 : 1;
      const starts = [];
      while (k < args.length && !/^[-(!]/.test(args[k].text) && args[k].text !== ")") starts.push(args[k++]);
      let writes = false;
      for (; k < args.length; k++) {
        const t = args[k].text;
        if (t === "-delete") writes = true;
        else if (/^-(exec|execdir|ok|okdir)$/.test(t)) {
          const sub = [];
          k++;
          while (k < args.length && args[k].text !== ";" && args[k].text !== "+") {
            sub.push(args[k].text === "{}" ? { ...args[k], sink: true } : args[k]);
            k++;
          }
          if (sub.length) {
            if (!READONLY.has(cmdName(sub[0].text))) writes = true;
            one({ ...c, words: sub, redirs: [], stdin: [], subs: [] }, cwd, d, depth, { upstream: "", stage: 0 }, run);
          }
        } else if (/^-(fprint|fprint0|fprintf|fls)$/.test(t)) {
          T(args[k + 1]);
          k++;
        }
      }
      if (writes) for (const w of starts.length ? starts : [HERE(d)]) T(w);
      return cwd;
    }

    if (nm === "cp" && !ps) {
      // 写す元は読むだけ。書き先は最後の引数か -t の値
      const pos = [];
      let tdir = null;
      let endOpts = false;
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        const t = a.text;
        if (!endOpts && t === "--") { endOpts = true; continue; }
        if (!endOpts && t.startsWith("--")) {
          if (t.startsWith("--target-directory")) tdir = t.includes("=") ? { ...a, text: t.slice(t.indexOf("=") + 1), alt: null } : args[++k];
          continue;
        }
        if (!endOpts && t.startsWith("-") && t !== "-") {
          const m = t.indexOf("t");
          if (m > 0) tdir = m < t.length - 1 ? { ...a, text: t.slice(m + 1), alt: null } : args[++k];
          else if (t.endsWith("S")) k++;
          continue;
        }
        pos.push(a);
      }
      if (tdir) T(tdir);
      else if (pos.length) T(pos[pos.length - 1]);
      return cwd;
    }

    if (ps && PS_COPY.has(nm)) {
      const pos = [];
      let hasDest = false;
      let hasPath = false;
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text.toLowerCase();
        if (t.startsWith("-")) {
          const name = t.split(":")[0];
          const inline = t.includes(":");
          if (/^-(path|literalpath|lp|pspath|filter|include|exclude|credential)$/.test(name)) {
            if (/path|lp/.test(name)) hasPath = true;
            if (!inline) k++;
            continue;
          }
          if (/^-(recurse|force|container|passthru|whatif|confirm|verbose|debug)$/.test(name)) continue;
          if (/^-dest/.test(name)) hasDest = true;
          T(args[k]);
          if (!inline && args[k + 1] && !args[k + 1].text.startsWith("-")) T(args[++k]);
          continue;
        }
        pos.push(args[k]);
      }
      if (!hasPath) pos.shift(); // 1つめは写す元
      pos.forEach((w) => T(w));
      if (!hasDest && pos.length === 0) T(HERE(d));
      return cwd;
    }

    if (ps && PS_CONTENT.has(nm)) {
      let hasPath = false;
      const pos = [];
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text.toLowerCase();
        if (t.startsWith("-")) {
          const name = t.split(":")[0];
          const inline = t.includes(":");
          // -Value は書く中身なので見ない。ただし New-Item の -Value はリンクの行き先にもなるので見る
          const isNew = ["new-item", "ni", "mkdir", "md"].includes(nm);
          if (/^-(inputobject|encoding|delimiter|itemtype|type)$/.test(name) || (!isNew && name === "-value")) { if (!inline) k++; continue; }
          if (/^-(path|literalpath|lp|pspath|filepath|destination|destinationpath|name)$/.test(name)) hasPath = true;
          T(args[k]);
          if (!inline && args[k + 1] && !args[k + 1].text.startsWith("-")) T(args[++k]);
          continue;
        }
        pos.push(args[k]);
      }
      if (!hasPath && pos.length) T(pos[0]); // 2つめ以降は書く中身
      return cwd;
    }

    if (nm === "tar") {
      let mode = "";
      let cdir = false;
      if (args[0] && !args[0].text.startsWith("-")) mode += args[0].text;
      for (const a of args) {
        const t = a.text;
        if (t.startsWith("--")) {
          if (/^--(extract|get)$/.test(t)) mode += "x";
          if (/^--(create|append|update|delete|concatenate|catenate)$/.test(t)) mode += "c";
          if (t.startsWith("--directory")) cdir = true;
        } else if (t.startsWith("-")) {
          if (t === "-C") cdir = true;
          else mode += t.slice(1);
        }
      }
      if (/[xcruA]/.test(mode)) {
        args.forEach((w) => T(w));
        if (/x/.test(mode) && !cdir) T(HERE(d));
      }
      return cwd;
    }

    if (nm === "unzip") {
      if (args.some((w) => /^-[A-Za-z]*[ltvZpc]/.test(w.text))) return cwd;
      args.forEach((w) => T(w));
      if (!args.some((w) => w.text === "-d" || w.text.startsWith("-d"))) T(HERE(d));
      return cwd;
    }

    if (["7z", "7za", "7zr"].includes(nm) || nm === "expand-archive") {
      args.forEach((w) => T(w));
      if (!args.some((w) => /^-(o|destinationpath|d)/i.test(w.text)) && !(nm === "expand-archive" && positional.length >= 2)) T(HERE(d));
      return cwd;
    }

    if (nm === "sed") {
      let inplace = false;
      const scripts = [];
      const files = [];
      let given = false;
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        if (t.startsWith("--in-place") || (/^-[A-Za-z]/.test(t) && !t.startsWith("--") && /^-[A-Za-z]*i/.test(t))) inplace = true;
        if (t === "-e" || t === "--expression") { scripts.push(args[++k]); given = true; continue; }
        if (t === "-f" || t === "--file") { k++; given = true; continue; }
        if (t.startsWith("-") && t !== "-") continue;
        files.push(args[k]);
      }
      if (!given && files.length) scripts.push(files.shift());
      if (inplace) files.forEach((w) => T(w));
      for (const s of scripts) {
        if (!s) continue;
        if (s.dynamic) fallback(ctx, "sed の命令が変数などで決まる");
        // sed の w コマンド（ファイルに書き出す）
        const re = /(?:^|[;\n{}])\s*[wW]\s*([^\n;}]+)|\/[gpiImMe0-9]*w\s*([^\n;}]+)/g;
        let m;
        while ((m = re.exec(s.text))) T({ text: (m[1] ?? m[2]).trim(), alt: null, raw: s.raw, dynamic: false, dialect: d });
        legacyCode(s.text, ctx, cwd);
      }
      return cwd;
    }

    if (nm === "sort") {
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        if (t === "-o" || t === "--output") T(args[++k]);
        else if (t.startsWith("--output=") || /^-o./.test(t)) T({ ...args[k], text: t.replace(/^(--output=|-o)/, ""), alt: null });
      }
      return cwd;
    }

    if (["awk", "gawk", "mawk", "nawk"].includes(nm)) {
      let progGiven = false;
      let inplace = false;
      const files = [];
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        if (t === "-f" || t === "--file") { k++; progGiven = true; continue; }
        if (t === "-i" || t === "--include") { if (args[k + 1]?.text === "inplace") inplace = true; k++; continue; }
        if (t === "-F" || t === "-v" || t === "--assign" || t === "--field-separator") { k++; continue; }
        if (t.startsWith("-") && t !== "-") continue;
        if (!progGiven) { scriptCode(args[k]); progGiven = true; continue; }
        files.push(args[k]);
      }
      if (inplace) files.forEach((w) => T(w));
      return cwd;
    }

    // パッチを当てる命令：パッチの中の、書き換えるファイルの名前を見る
    if (nm === "patch") {
      patchCheck(args.filter((w) => !w.text.startsWith("-")), c, cwd);
      args.forEach((w) => T(w));
      return cwd;
    }

    if (nm === "ln") {
      // リンクの行き先が守る場所なら止める（作ったリンクを通して書けるため）。行き先は、リンクを置く場所からの相対でもある
      args.forEach((w) => T(w));
      const pos = args.filter((w) => !w.text.startsWith("-"));
      const last = pos[pos.length - 1];
      if (last && !last.dynamic && pos.length >= 2) {
        const lp = path.resolve(cwd ?? projectRootFallback(ctx), hostPath(last.text));
        let linkDir = lp;
        try { if (!existsSync(lp)) linkDir = path.dirname(lp); } catch { linkDir = path.dirname(lp); }
        pos.slice(0, -1).forEach((w) => T(w, linkDir));
      }
      return cwd;
    }

    if (WRITE_ALL.has(nm)) {
      args.forEach((w) => T(w));
      return cwd;
    }

    if (nm === "gh") {
      // gh repo clone・gh run download などは、手元にファイルを書く
      if (args.some((w) => ["clone", "download", "checkout"].includes(w.text))) args.forEach((w) => T(w));
      return cwd;
    }

    if (!ps && nm === "trap" && args[0]) {
      code(args[0].text, "bash");
      return cwd;
    }

    if (nm === "source" || nm === ".") {
      ran(args[0]);
      return cwd;
    }

    if (SHELLS.has(nm)) {
      let readsStdin = true;
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        if (t === "--") { readsStdin = k + 1 >= args.length; break; }
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) {
          const cw = args[k + 1];
          if (cw) {
            if (cw.dynamic) fallback(ctx, `シェルに渡す命令が変数などで決まる：${short(cw.raw)}`);
            code(cw.text, "bash");
          }
          readsStdin = false;
          break;
        }
        if (/^-[A-Za-z]*s[A-Za-z]*$/.test(t)) { readsStdin = true; break; }
        if (/^[-+]/.test(t)) {
          if (/^[-+][oO]$/.test(t)) k++;
          continue;
        }
        readsStdin = false; // スクリプトのファイル（中は見えない）
        ran(args[k]);
        break;
      }
      if (readsStdin) stdinCode("bash");
      return cwd;
    }

    if (PSHELLS.has(nm)) {
      let readsStdin = true;
      let dir = cwd;
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        const tl = t.toLowerCase();
        if (/^[-/](c|co|com|comm|comma|comman|command)$/.test(tl)) {
          const rest = args.slice(k + 1);
          if (rest.length === 1 && rest[0].text === "-") break;
          if (rest.some((w) => w.dynamic)) fallback(ctx, "PowerShell に渡す命令が変数などで決まる");
          code(rest.map((w) => w.text).join(" "), "ps", dir);
          readsStdin = false;
          break;
        }
        if (/^[-/]e(c|n\w*)?$/.test(tl)) {
          const w = args[k + 1];
          if (w) {
            if (w.dynamic) fallback(ctx, "PowerShell に渡す命令が変数などで決まる");
            let decoded = "";
            try { decoded = Buffer.from(w.text, "base64").toString("utf16le"); } catch { decoded = ""; }
            code(decoded, "ps", dir);
          }
          readsStdin = false;
          break;
        }
        if (/^[-/](f|fi|fil|file)$/.test(tl)) { readsStdin = false; ran(args[k + 1]); break; }
        if (/^[-/](wd|workingdirectory)$/.test(tl)) { dir = resolveDir(dir, args[k + 1]); k++; continue; }
        if (/^[-/](executionpolicy|ep|ex|exe|exec\w*|inputformat|inf|if|outputformat|of|windowstyle|w|wi|win\w*|version|v|configurationname|config\w*|psconsolefile|settingsfile|settings\w*|custompipename)$/.test(tl)) { k++; continue; }
        if (t.startsWith("-")) continue;
        // 位置の引数：Windows PowerShell は命令として扱う（安全側で、命令として読む）
        code(args.slice(k).map((w) => w.text).join(" "), "ps", dir);
        ran(args[k]); // ファイルの名前のこともある
        readsStdin = false;
        break;
      }
      if (readsStdin) stdinCode("ps");
      return cwd;
    }

    if (nm === "cmd") {
      for (let k = 0; k < args.length; k++) {
        if (/^\/\/?[ckCK]$/.test(args[k].text)) {
          const rest = args.slice(k + 1);
          if (rest.some((w) => w.dynamic)) fallback(ctx, "cmd に渡す命令が変数などで決まる");
          code(rest.map((w) => w.text).join(" "), "cmd");
          return cwd;
        }
      }
      stdinCode("cmd");
      return cwd;
    }

    if (nm === "deno" && args[0]?.text === "eval") { scriptCode(args[1]); return cwd; }
    if (SCRIPTS.has(nm) || nm === "deno") {
      let sawCode = false;
      let sawScript = false;
      let stdin = false;
      let inplace = false;
      let scriptWord = null;
      const pos = [];
      const list = nm === "deno" || nm === "bun" ? (["run", "x"].includes(args[0]?.text) ? args.slice(1) : args) : args;
      for (let k = 0; k < list.length; k++) {
        const a = list[k];
        const t = a.text;
        if (sawScript || (sawCode && !t.startsWith("-"))) { pos.push(a); continue; }
        const eqm = /^(--eval|--print|--command)=([\s\S]*)$/.exec(t);
        if (eqm) { scriptCode({ ...a, text: eqm[2], alt: null }); sawCode = true; continue; }
        if (t === "--eval" || t === "--print" || isCodeFlag(nm, t)) {
          scriptCode(list[++k]);
          sawCode = true;
          continue;
        }
        if (t === "-") { stdin = true; sawScript = true; continue; }
        if (t.startsWith("-")) {
          if ((nm === "perl" || nm === "ruby") && /^-[A-Za-z]*i/.test(t)) inplace = true;
          if (["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "-W", "-X", "-m"].includes(t)) {
            if (t === "-m") sawScript = true; // python -m（中は見えない）
            k++;
          }
          continue;
        }
        sawScript = true; // スクリプトのファイル（中は見えない）
        scriptWord = a;
      }
      if (!sawCode && !sawScript) stdin = true;
      if (stdin) stdinCode(null);
      else if (sawScript) ran(scriptWord, lang);
      if (inplace) pos.forEach((w) => T(w));
      return cwd;
    }

    if ((!ps && nm === "eval") || nm === "iex" || nm === "invoke-expression") {
      let ws = args;
      if (ws[0] && /^-c(ommand)?$/i.test(ws[0].text)) ws = ws.slice(1);
      if (!ws.length) { stdinCode(d); return cwd; }
      if (ws.some((w) => w.dynamic)) fallback(ctx, "評価する命令が変数などで決まる");
      code(ws.map((w) => w.text).join(" "), d);
      return cwd;
    }

    if (READONLY.has(nm)) return cwd;

    // .NET の呼び出し（[IO.File]::WriteAllText など）はスクリプトとして見る
    const rawWords = words.map((w) => w.raw).join(" ");
    if (ps && nm.includes("::")) { legacyCode(rawWords, ctx, cwd); return cwd; }
    // 名前がパスや、スクリプトの拡張子のもの（./x.sh、.\x.ps1 など）は、スクリプトのファイルを動かしている
    if (/[\\/]/.test(words[0].text) || SCRIPT_EXT.test(words[0].text)) ran(words[0], /\.(m?js|cjs|ts|mts|cts|py)$/i.test(words[0].text) ? "script" : "shell");
    // 知らない命令：今の版と同じ目安で見る
    legacyUnknown(rawWords, ctx);
    return cwd;
  }

  function patchCheck(files, c, base) {
    // 中身を読めるパッチ：ファイルの引数、< の入力、ヒアドキュメント
    const texts = [];
    let unseen = false;
    const read = (w) => {
      if (w.dynamic) { unseen = true; return; }
      try {
        const p = path.resolve(base ?? projectRootFallback(ctx), hostPath(w.text));
        if (!existsSync(p)) { unseen = true; return; }
        if (statSync(p).size > PATCH_MAX) { unseen = true; return; }
        texts.push(readFileSync(p, "utf8"));
      } catch {
        unseen = true;
      }
    };
    files.forEach(read);
    (c?.inputs ?? []).forEach(read);
    for (const h of c?.stdin ?? []) texts.push(h.body);
    if (!files.length && !(c?.inputs ?? []).length && !(c?.stdin ?? []).length) unseen = true; // パイプなどから読む
    if (unseen) fallback(ctx, "パッチの中身が読めない");
    const roots = [base, projectRootFallback(ctx)].filter(Boolean);
    for (const t of texts) {
      for (const p of patchPaths(t)) {
        for (const r of roots) target({ text: p, alt: null, raw: `パッチの中の ${p}`, dynamic: false, dialect: "ps" }, r, ctx);
      }
    }
  }

  ctx.written = [];
  ctx.execScript = false;
  ctx.execs = [];
  ctx.codeChecks = [];
  run(command, dialect, cwd, 0);
  // 同じコマンドの中で、ファイルを書き、スクリプトのファイルを動かしている：書いた中身を命令として見る
  // （echo 'rm -rf rubric' > x.sh && bash x.sh など）。
  // 11/6：書いた先が、動かしたファイルと違う、文書・データのファイル（.md・.json など）のときだけは見ない。
  // 動かしたファイルや書いた先が分からないとき・スクリプトの拡張子のとき・名前のないときは、今までどおり見る（安全側）
  if (ctx.execScript) {
    const execLang = ctx.execs.length && ctx.execs.every((e) => e.lang === "script") ? "script" : "shell";
    const bases = [...new Set(ctx.execs.map((e) => e.base))];
    const hitsExec = (wr) => !ctx.execs.length || ctx.execs.some((e) => wr.targets.some((t) => samePath(t, wr.base, e.w, e.base)));
    // 動かしたファイルに1つでも書いていれば（mv・cp で中身を移した場合も含め）、書いたものを全部見る
    const all = ctx.written.some(hitsExec);
    for (const wr of ctx.written) {
      const dataOnly = wr.targets.every((t) => t && !t.dynamic && DATA_EXT.test(t.text) && (t.alt == null || DATA_EXT.test(t.alt)));
      if (dataOnly && !all) continue;
      legacyCode(wr.data, ctx, bases.length === 1 ? bases[0] : null, execLang);
    }
  }
  // 書いた中身（> の書き出し・tee・Set-Content など）に守る場所の名前があれば、スクリプトがそれを読むかもしれないので、
  // コマンド全体の名前も足して見る（rm・cp などの引数は、書く中身ではないので数えない）
  ctx.writtenMentions = ctx.written.some((wr) => {
    if (!wr.content) return false;
    const m = mentionsOld(wr.data);
    return m.dirs.length > 0 || m.guard;
  });
  for (const chk of ctx.codeChecks) legacyCodeNow(chk, ctx);
}

// ===========================================================================

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
  if (typeof ti.command === "string") {
    const roots = [...new Set([path.resolve(projectDir), projectReal])];
    // 11/6：奥の同じ名前のフォルダを見分けるための、作業フォルダの名前とパス
    ROOT_DIR = path.resolve(projectDir);
    ROOT_NAMES = [...new Set(roots.map((r) => path.basename(r).toLowerCase().replace(/[. ]+$/, "")))];
    ROOT_KEYS = roots.map((r) => segsOf(r).join("/"));
    MAKES_LINKS = LINK_WORDS.test(ti.command);
    const protectedSegs = [];
    for (const root of roots) {
      for (const p of SHELL_PROTECTED) protectedSegs.push({ ...p, segs: segsOf(path.join(root, p.rel)) });
    }
    // コマンド全体についての目安は、1回だけ求めて使い回す（大きなコマンドで遅くならないように）
    const ctx = {
      whole: ti.command,
      protectedSegs,
      projectDir: path.resolve(projectDir),
      mentionWhole: mentionsOld(ti.command),
      interpWhole: INTERPRETER.test(ti.command),
    };
    try {
      checkShell(ti.command, tool === "Bash" ? "bash" : "ps", path.resolve(projectDir, cwd), ctx);
    } catch (e) {
      // 思わぬ失敗は止める側に倒す
      failClosed(`シェルのコマンドの判定に失敗しました（${e && e.message}）`);
    }
  }
}

process.exit(0);

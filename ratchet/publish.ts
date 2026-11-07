// SPDX-License-Identifier: AGPL-3.0-only
//
// dry-run で残した PR を、作り直さずに出す（npm run ratchet -- --publish <回の番号>）。
// 人が dry-run の本文（pr-N.md）と差分を見てから出すための道。Claude は呼ばない。束も読まない（ファイル名の一覧を取るだけ）。
//
// 1 本ずつ、次を全部通ったものだけを push して PR にする（どれかで止まったら、その 1 本は出さない）：
//   1. 作業の木とブランチがあり、コミットしていない変更が残っていない
//   2. 本文・題・コミットの文・変えたファイルの名前に、出してはいけない字（手元のパス・束の置き場所・束のファイル名・sha256）が無い
//   3. 今の main を一時的な作業の木に出し、ブランチを重ねる（--no-commit。ブランチ自体は変えない）。ぶつかる所があれば止める
//   4. 重ねた状態で npm test と npm run build が通る
// main が dry-run のあとに進んでいても、きれいに重なり、テストとビルドが通れば出す（2026-11-07 本人の決定）。
// 画面に出すのは、PR の番号と題・止まった理由だけ。手元のパスは出さない。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findLeaks } from "./prbody.ts";
import { LABEL } from "./rejections.ts";

export type Run = (cmd: string, args: string[], cwd: string, opts?: { timeoutMs?: number }) => { status: number | null; stdout: string };

/** 実物の実行（Windows の npm と gh は shell を通す） */
export const realRun: Run = (cmd, args, cwd, opts = {}) => {
  const npm = cmd === "npm";
  const r = spawnSync(npm && process.platform === "win32" ? "npm.cmd" : cmd, args, {
    cwd, encoding: "utf8", windowsHide: true, shell: npm && process.platform === "win32", timeout: opts.timeoutMs ?? 10 * 60_000, maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "" };
};

/** pr-N.md の「何の型か」の行から、dry-run と同じ題を作る（prTitle と同じ形） */
export function titleFromBody(body: string): string | null {
  const m = /^## 何の型か\s*\r?\n\s*\r?\n([^\r\n]+)/m.exec(body);
  if (!m) return null;
  const line = m[1]!;
  const sep = line.indexOf("：");
  const end = line.lastIndexOf("（ルール ");
  if (sep <= 0 || end <= sep) return null;
  return `Ratchet：${line.slice(0, sep)} ${line.slice(sep + 1, end)}`.slice(0, 120);
}

/** summary.json から、出す候補の番号を選ぶ（歯止めを通り、本文を書き、まだ PR にしていないものだけ。前の --publish で出したものも除く） */
export function publishTargets(summary: unknown): number[] {
  const s = summary as { results?: unknown; published?: unknown };
  if (!Array.isArray(s?.results)) return [];
  const done = new Set<number>();
  if (Array.isArray(s.published)) for (const p of s.published) for (const r of p?.results ?? []) if (r?.pr) done.add(r.candidate);
  return s.results
    .filter((r) => r && r.pass === true && typeof r.body === "string" && !r.stop && !r.pr && Number.isInteger(r.candidate) && !done.has(r.candidate))
    .map((r) => r.candidate as number);
}

export type PublishResult = { candidate: number; title: string | null; pr: number | null; stop: string | null };

export function publishOne(p: {
  repo: string; runId: string; runDir: string; n: number; secrets: string[]; files: string[]; run: Run; log: (step: string, data?: Record<string, unknown>) => void;
}): PublishResult {
  const { repo, runId, runDir, n, run } = p;
  const branch = `claude/ratchet-${runId}-${n}`;
  const work = join(repo, ".tmp", "ratchet-work", runId);
  const dir = join(work, `c${n}`);
  const res: PublishResult = { candidate: n, title: null, pr: null, stop: null };
  const stop = (why: string) => ((res.stop = why), res);
  const git = (cwd: string, args: string[]) => run("git", args, cwd);

  // 1. 本文と題
  const bodyFile = join(runDir, `pr-${n}.md`);
  if (!existsSync(bodyFile)) return stop("PR の本文（pr-N.md）が無い");
  const body = readFileSync(bodyFile, "utf8");
  res.title = titleFromBody(body);
  if (!res.title) return stop("本文から題を読めなかった");

  // 2. 作業の木とブランチ
  if (!existsSync(dir)) return stop("作業の木が無い");
  if (git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() !== branch) return stop("作業の木のブランチが違う");
  if (git(dir, ["status", "--porcelain"]).stdout.trim()) return stop("作業の木に、コミットしていない変更が残っている");
  const ahead = Number(git(repo, ["rev-list", "--count", `origin/main..${branch}`]).stdout.trim());
  if (!(ahead >= 1)) return stop("ブランチに、main に無いコミットが無い");

  // 3. 出してはいけない字（本文・題・コミットの文・変えたファイルの名前）
  const msgs = git(repo, ["log", "--format=%B", `origin/main..${branch}`]).stdout;
  const names = git(repo, ["diff", "--name-only", `origin/main...${branch}`]).stdout;
  const leaks = findLeaks(`${res.title}\n${body}\n${msgs}\n${names}`, { secrets: p.secrets, files: p.files });
  if (leaks.length) return stop(`出してはいけない字が混ざった（${leaks.join("、")}）`);

  // 4. 今の main に重ねて、テストとビルド
  const tmp = join(work, `publish-c${n}`);
  if (existsSync(tmp)) return stop("前の確かめの作業の木が残っている（片付けてからやり直す）");
  if (git(repo, ["worktree", "add", "-q", "--detach", tmp, "origin/main"]).status !== 0) return stop("確かめの作業の木を作れなかった");
  const nm = join(tmp, "node_modules");
  try {
    if (process.platform === "win32") run("cmd", ["/c", "mklink", "/J", nm, join(repo, "node_modules")], repo);
    else run("ln", ["-s", join(repo, "node_modules"), nm], repo);
    if (git(tmp, ["merge", "--no-ff", "--no-commit", branch]).status !== 0) return stop("今の main にきれいに重ならない（ぶつかる所がある）");
    p.log("今の main に重ねた", { 候補: n });
    const test = run("npm", ["test"], tmp, { timeoutMs: 20 * 60_000 });
    p.log("重ねた状態でテストを回した", { 候補: n, 通った: test.status === 0 });
    if (test.status !== 0) return stop("今の main に重ねると、npm test が通らない");
    const build = run("npm", ["run", "build"], tmp, { timeoutMs: 20 * 60_000 });
    p.log("重ねた状態でビルドした", { 候補: n, 通った: build.status === 0 });
    if (build.status !== 0) return stop("今の main に重ねると、npm run build が通らない");
  } finally {
    // つなぎ（node_modules）を先に外す。外さずに木を消すと、本体の node_modules まで消えることがある
    if (existsSync(nm)) {
      if (process.platform === "win32") run("cmd", ["/c", "rmdir", nm], repo);
      else run("rm", [nm], repo);
    }
    if (!existsSync(nm)) git(repo, ["worktree", "remove", "--force", tmp]);
  }

  // 5. push と PR（--force は使わない）
  run("gh", ["label", "create", LABEL, "--description", "Ratchet のループが出した PR"], repo);
  if (git(repo, ["push", "-u", "origin", branch]).status !== 0) return stop("push できなかった");
  const pr = run("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", res.title, "--body-file", bodyFile, "--label", LABEL], repo);
  const num = /\/pull\/(\d+)/.exec(pr.stdout);
  if (pr.status !== 0 || !num) return stop("PR を出せなかった");
  res.pr = Number(num[1]);
  return res;
}

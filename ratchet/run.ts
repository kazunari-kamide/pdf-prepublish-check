// SPDX-License-Identifier: AGPL-3.0-only
//
// Ratchet の 1 回分のループ（docs/ratchet.md §3）。人が 1 回起こすと、次を順に進め、PR を出したところで止まる。
//   束を読む → 下読み（Haiku）→ 候補（Opus）→ 反証（Opus）→ ルールと見本を書く（Opus）→ 歯止め → PR → 止まる
// マージはしない。既定は --dry-run（PR の本文を記録のフォルダに書くだけ）。--pr を付けたときだけ push と PR をする。
//
// 使い方（説明は .claude/workflows/ratchet.md）：
//   OMAMORI_RATCHET_CORPUS=<束のフォルダ> OMAMORI_RATCHET_STATE=<記録のフォルダ> [OMAMORI_RATCHET_EXCLUDE=<除く sha256 の一覧>] \
//     npm run ratchet -- [--pr] [--bundle 50] [--max-candidates 3] [--fix-attempts 3] [--run-budget <ドル>] [--call-budget <ドル>]
//     道具の確かめ：--from-candidates <JSON>（ルール書きから）・--refute-only <JSON>（反証の段だけ。束は読まない）
//
// 画面とログに出すのは、件数・時刻・エラーの種類・番号（b01 など）だけ。束のパス・ファイル名・PDF の中身は出さない。

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, markDone, markStarted, readExclude, saveState, selectBundle } from "./bundle.ts";
import { Caller, type CallResult } from "./claude.ts";
import { limitsFrom, MODELS, readEnv } from "./config.ts";
import { checkDiff, compareMetrics, type GateResult, type LineCounts } from "./gate.ts";
import type { Metrics } from "./metrics.ts";
import { findLeaks, prTitle, renderPrBody, type Candidate } from "./prbody.ts";
import { catalogIn, shortCatalog } from "./catalog.ts";
import { caughtByMain } from "./known.ts";
import { runProbe } from "./probe.ts";
import { fixPrompt, JUDGE_PROMPT, REFUTE_PROMPT, SKIM_PROMPT, writePrompt } from "./prompts.ts";
import { LABEL, loadRejections } from "./rejections.ts";
import { CANDIDATES, REFUTE, SKIM, validate, WRITE_REPORT } from "./schema.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Skim = { suspicions: Array<{ pattern: string; signal: string; alreadyReported: boolean }> };
type Refute = { keep: boolean; reason: string; explanation: string };
type WriteReport = { ruleId: string; changedFiles: string[]; summary: string; discarded: string; alreadyCovered: string };

function opts(argv: string[]): Record<string, string | undefined> {
  const o: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) o[k] = "true";
    else (o[k] = v), i++;
  }
  return o;
}

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

/** main から作業の木を作る。node_modules は本体のものをつなぐ（Windows は junction） */
function addWorktree(dir: string, branch: string | null): void {
  mkdirSync(dirname(dir), { recursive: true });
  const args = branch ? ["worktree", "add", "-q", "-b", branch, dir, "origin/main"] : ["worktree", "add", "-q", "--detach", dir, "origin/main"];
  const r = git(REPO, args);
  if (r.status !== 0) throw new Error("作業の木を作れなかった");
  const nm = join(dir, "node_modules");
  if (!existsSync(nm)) {
    if (process.platform === "win32") spawnSync("cmd", ["/c", "mklink", "/J", nm, join(REPO, "node_modules")], { windowsHide: true });
    else spawnSync("ln", ["-s", join(REPO, "node_modules"), nm]);
  }
}

function measureIn(root: string, out: string): Metrics {
  const r = spawnSync(process.execPath, [join(REPO, "ratchet/metrics.ts"), root, out], { encoding: "utf8", windowsHide: true, timeout: 60 * 60_000 });
  const f = join(out, "metrics.json");
  if (r.status !== 0 || !existsSync(f)) return { types: [], blind: null, test: { ok: false, passed: null, failed: null }, build: { ok: false }, errors: ["採点を流せなかった"] };
  return JSON.parse(readFileSync(f, "utf8"));
}

/** 外への要求の数（check:browser）。localhost の vite preview と頭のない Chrome だけ。本番には触らない */
function browserCheck(root: string): { ok: boolean; external: number | null } {
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "-s", "check:browser"], {
    cwd: root, encoding: "utf8", windowsHide: true, shell: process.platform === "win32", timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024,
  });
  const m = /外への要求\s*(\d+)\s*件、CSP/.exec(r.stdout ?? "") ?? /合計：.*外への要求\s*(\d+)\s*件/.exec(r.stdout ?? "");
  return { ok: r.status === 0, external: m ? Number(m[1]) : null };
}

/** 差分のファイル（まだコミットしていない新しいファイルも入れる） */
function diffEntries(root: string) {
  git(root, ["add", "-A"]);
  const ns = git(root, ["diff", "--cached", "--name-status", "origin/main"]).stdout.trim();
  const entries = ns ? ns.split(/\r?\n/).map((l) => {
    const [status, ...rest] = l.split("\t");
    return { status: status ?? "", path: rest[rest.length - 1] ?? "" };
  }) : [];
  // 足した行・消した行の数（registry.ts と、1 行足すだけを許した所を確かめるため）
  const lines: LineCounts = {};
  for (const l of git(root, ["diff", "--cached", "--numstat", "origin/main"]).stdout.trim().split(/\r?\n/)) {
    const [a, r, p] = l.split("\t");
    if (p) lines[p] = { added: Number(a) || 0, removed: Number(r) || 0 };
  }
  return { entries, lines };
}

async function main() {
  const o = opts(process.argv.slice(2));
  const doPr = o.pr === "true";
  const env = readEnv();
  const limits = limitsFrom(o);
  const started = new Date();
  const runId = o["run-id"] ?? started.toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
  const runDir = join(env.state, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const logFile = join(runDir, "log.jsonl");
  const log = (step: string, data: Record<string, unknown> = {}) => {
    const line = { t: new Date().toISOString(), step, ...data };
    appendFileSync(logFile, JSON.stringify(line) + "\n");
    const local = new Date().toLocaleTimeString("ja-JP", { hour12: false });
    console.log(`[${local}] ${step}${Object.keys(data).length ? " " + JSON.stringify(data) : ""}`);
  };
  const caller = new Caller({ skim: limits.skimCalls, judge: limits.judgeCalls, write: limits.writeCalls, runBudgetUsd: limits.runBudgetUsd });
  const emptyDir = join(runDir, "empty");
  mkdirSync(emptyDir, { recursive: true });
  const outcome: Record<string, unknown> = { runId, mode: doPr ? "pr" : "dry-run", limits };
  const finish = (stopReason: string | null) => {
    outcome.stopReason = stopReason;
    outcome.calls = caller.calls;
    outcome.costUsd = Number(caller.costUsd.toFixed(4));
    outcome.minutes = Number(((Date.now() - started.getTime()) / 60_000).toFixed(1));
    writeFileSync(join(runDir, "summary.json"), JSON.stringify(outcome, null, 1));
    log("終わり", { 止まった理由: stopReason ?? "なし", 呼び出し: caller.calls, 費用ドル: outcome.costUsd, 分: outcome.minutes });
  };

  // main を別の作業の木に出す（今あるルールの一覧と、歯止めの「前」の数の両方に使う）。
  // 一覧は、束で当たったルールだけでなく、main にあるものを全部渡す（2026-11-07 の 1 回目の反省）
  git(REPO, ["fetch", "-q", "origin"]);
  const work = join(REPO, ".tmp", "ratchet-work", runId);
  const baseDir = join(work, "base");
  addWorktree(baseDir, null);
  const catalog = catalogIn(baseDir);
  if (!catalog) return finish("今あるルールの一覧を作れなかった");
  writeFileSync(join(runDir, "catalog.json"), JSON.stringify(catalog, null, 1));
  log("今あるルールの一覧を作った", { ルール: catalog.rules.length, 採点の型: catalog.scoredTypes.length });
  const known = { rules: catalog.rules, scoredTypes: catalog.scoredTypes };

  // 反証の段だけを、渡した候補で回す（--refute-only <JSON>）。束は読まない。道具の確かめのため
  if (o["refute-only"]) {
    const j = JSON.parse(readFileSync(o["refute-only"], "utf8"));
    if (validate(CANDIDATES, j).length) return finish("渡された候補の形が合わない");
    const rows: unknown[] = [];
    for (const c of (j as { candidates: Candidate[] }).candidates) {
      const r = await caller.call<Refute>({ role: "refute", model: MODELS.refute, prompt: REFUTE_PROMPT, data: { candidate: c, basis: [], knownRules: known, currentRules: [], rejections: [] }, schema: REFUTE, cwd: emptyDir, budgetUsd: limits.perCallBudgetUsd });
      const row = r.ok ? { pattern: c.pattern, title: c.title, nearestRule: c.nearestRule, keep: r.value.keep, reason: r.value.reason, explanation: r.value.explanation } : { pattern: c.pattern, title: c.title, error: r.error };
      rows.push(row);
      log("反証した", r.ok ? { 型: c.pattern, 残す: r.value.keep, 理由: r.value.reason } : { 型: c.pattern, 止まった: r.error });
    }
    outcome.refuteOnly = rows;
    return finish(null);
  }

  // 候補を人が渡すとき（--from-candidates <JSON>）：束を読む・下読み・候補・反証を省き、ルール書きから始める。
  // 道具の確かめと、撮影のやり直しのため。PR の本文には、省いたことを書く
  const fromFile = o["from-candidates"];
  let files: string[] = [];
  let read = 0;
  let skipped = 0;
  let suspicionCount = 0;
  let candidateCount = 0;
  let refuted = 0;
  let kept: Array<{ c: Candidate; refute: Refute }> = [];
  if (fromFile) {
    const j = JSON.parse(readFileSync(fromFile, "utf8"));
    const errs = validate(CANDIDATES, j);
    if (errs.length) return finish("渡された候補の形が合わない");
    kept = (j as { candidates: Candidate[] }).candidates.slice(0, limits.maxCandidates).map((c) => ({ c, refute: { keep: true, reason: "残す", explanation: "人が渡した候補（束を読む・反証の段は省いた）" } }));
    candidateCount = kept.length;
    outcome.counts = { fromCandidates: kept.length };
    outcome.candidates = kept.map(({ c }) => ({ pattern: c.pattern, title: c.title }));
    log("渡された候補を使う", { 候補: kept.length });
  } else {
    const d = await discover();
    if (typeof d === "string") return finish(d);
    ({ files, read, skipped, suspicionCount, candidateCount, refuted, kept } = d);
  }
  return afterDiscovery();

  async function discover() {
  // 0. 前に却下された候補
  const rej = loadRejections(REPO);
  log("却下の理由を読んだ", { 件数: rej.list.length, ...(rej.note ? { 注意: rej.note } : {}) });

  // 1. 束を選ぶ
  let state = loadState(env.state);
  const sel = selectBundle({ corpus: env.corpus, exclude: readExclude(env.exclude), state, size: limits.bundleSize, runId });
  log("束を選んだ", { 読む: sel.items.length, 束の全体: sel.counts.inCorpus, 除いた: sel.counts.excluded, 読んだことがある: sel.counts.alreadyRead, 続きから: sel.counts.resumed });
  if (!sel.items.length) return "読む PDF が残っていない";
  state = markStarted(state, sel);
  saveState(env.state, state);

  // 2. 下読み（軽いモデルで呼び出しが多いので、一覧は短い形で渡す）
  const shortKnown = shortCatalog(catalog!);
  const suspicions: Array<{ id: string; pattern: string; signal: string }> = [];
  const rulesSeen = new Set<string>();
  let read = 0;
  let skipped = 0;
  let dropped = 0;
  for (const it of sel.items) {
    if (caller.remaining("skim") <= 0 || caller.overBudget()) {
      log("下読みの上限に届いた", { 残り: sel.items.length - read - skipped });
      break;
    }
    const p = await runProbe(it.path);
    if ("failed" in p) {
      skipped++;
      log("調べきれずに省いた", { 番号: it.id, 理由: p.failed });
      state = markDone(state, it.sha256);
      saveState(env.state, state);
      continue;
    }
    for (const r of p.rules.items) rulesSeen.add(`${r.pattern}:${r.ruleId}`);
    const r = await caller.call<Skim>({ role: "skim", model: MODELS.skim, prompt: SKIM_PROMPT, data: { id: it.id, probe: p, knownRules: shortKnown }, schema: SKIM, cwd: emptyDir, budgetUsd: limits.perCallBudgetUsd });
    if (!r.ok) {
      if (r.error === "形が合わない") {
        dropped++;
        log("形が合わない答えを捨てた", { 番号: it.id, 段: "下読み" });
      } else return `下読みで止まった（${r.error}）`;
    } else {
      for (const s of r.value.suspicions) if (!s.alreadyReported) suspicions.push({ id: it.id, pattern: s.pattern, signal: s.signal });
    }
    read++;
    state = markDone(state, it.sha256);
    saveState(env.state, state);
  }
  outcome.counts = { read, skipped, suspicions: suspicions.length, dropped };
  log("下読みが終わった", { 読んだ: read, 省いた: skipped, 疑い: suspicions.length, 捨てた答え: dropped });
  if (!suspicions.length) return "疑いが挙がらなかった";

  // 3. 候補
  const rejections = rej.list.map((x) => ({ pattern: x.pattern, title: x.title, reason: x.reason }));
  const j = await caller.call<{ candidates: Candidate[] }>({
    role: "judge", model: MODELS.judge, prompt: JUDGE_PROMPT, data: { suspicions, knownRules: known, currentRules: [...rulesSeen].sort(), rejections }, schema: CANDIDATES, cwd: emptyDir, budgetUsd: limits.perCallBudgetUsd,
  });
  if (!j.ok) return `候補を出す段で止まった（${j.error}）`;
  const candidates = j.value.candidates;
  log("候補を出した", { 候補: candidates.length });

  // 4. 反証
  const kept: Array<{ c: Candidate; refute: Refute }> = [];
  let refuted = 0;
  const refuteReasons: Record<string, number> = {};
  const judged: unknown[] = [];
  for (const c of candidates) {
    if (kept.length >= limits.maxCandidates) break;
    const basis = suspicions.filter((s) => s.pattern === c.pattern).slice(0, 40);
    const r = await caller.call<Refute>({ role: "refute", model: MODELS.refute, prompt: REFUTE_PROMPT, data: { candidate: c, basis, knownRules: known, currentRules: [...rulesSeen].sort(), rejections }, schema: REFUTE, cwd: emptyDir, budgetUsd: limits.perCallBudgetUsd });
    if (!r.ok) {
      if (r.error === "形が合わない") continue;
      log("反証の段で止まった", { 理由: r.error });
      break;
    }
    // 判断の中身（型・題・反証の理由と説明）を記録に残す。PDF の中身は入れていない（スキーマとプロンプトで、型と構造の言葉だけにしてある）
    judged.push({ pattern: c.pattern, title: c.title, nearestRule: c.nearestRule, whyMissed: c.whyMissed, evidenceCount: c.evidenceCount, keep: r.value.keep, reason: r.value.reason, explanation: r.value.explanation });
    if (r.value.keep) kept.push({ c, refute: r.value });
    else {
      refuted++;
      refuteReasons[r.value.reason] = (refuteReasons[r.value.reason] ?? 0) + 1;
    }
  }
  Object.assign(outcome.counts as object, { candidates: candidates.length, refuted, refuteReasons, kept: kept.length });
  outcome.candidates = judged;
  log("反証が終わった", { 残した: kept.length, 落とした: refuted, 落とした理由: refuteReasons });
  if (!kept.length) return "反証で全部落ちた";
  return { files: sel.items.map((i) => i.path), read, skipped, suspicionCount: suspicions.length, candidateCount: candidates.length, refuted, kept };
  }

  async function afterDiscovery() {

  // 5. main の数（歯止めの「前」。作業の木は、はじめに作ったもの）
  const base = measureIn(baseDir, join(runDir, "metrics-base"));
  log("main を採点した", { 型: base.types.length, test: base.test.ok, build: base.build.ok, エラー: base.errors.length });
  if (!base.test.ok || !base.build.ok || base.errors.length) return finish("main の採点が通らない（前の数を測れない）");

  // 6. ルールと見本 → 歯止め（届かなければ、上限の回数まで直す）
  const results: unknown[] = [];
  let n = 0;
  for (const { c, refute } of kept) {
    n++;
    const branch = `claude/ratchet-${runId}-${n}`;
    const dir = join(work, `c${n}`);
    addWorktree(dir, branch);
    let report: WriteReport | null = null;
    let gate: GateResult | null = null;
    let attempts = 0;
    let stop: string | null = null;
    for (;;) {
      const first: boolean = report === null;
      const data: unknown = first ? { candidate: c, refute, knownRules: known } : { candidate: c, gate: { reasons: gate!.reasons, declined: gate!.declined, table: gate!.table.filter((r) => r.change !== "同じ") } };
      const w: CallResult<WriteReport> = await caller.call<WriteReport>({ role: "write", model: MODELS.write, prompt: first ? writePrompt() : fixPrompt(), data, schema: WRITE_REPORT, cwd: dir, editTools: true, budgetUsd: limits.perCallBudgetUsd, timeoutMs: 40 * 60_000 });
      if (!w.ok) {
        stop = `ルールを書く段で止まった（${w.error}）`;
        break;
      }
      if (w.denials > 0) {
        stop = `書き込みの見張りに止められた（${w.denials} 回）`;
        report = w.value;
        break;
      }
      report = w.value;
      if (report.alreadyCovered.trim()) {
        // 書く段が、今あるルールで足りると判断した（書かずに返す決まり）
        stop = `今あるルール（${report.alreadyCovered.trim()}）ですでに見ている（ルールを書く段の判断）`;
        break;
      }
      const d = diffEntries(dir);
      const bad = checkDiff(d.entries, d.lines);
      const cand = bad.length ? null : measureIn(dir, join(runDir, `metrics-c${n}-${attempts}`));
      const browser = cand && cand.build.ok ? browserCheck(dir) : null;
      // 新しい型の合成 PDF を、main の検査器にかける（すでに捕まるものを「良くなった」に数えないため）
      const newKeys = cand ? cand.types.map((t) => t.key).filter((k) => !base.types.some((b) => b.key === k)) : [];
      const caught = cand && newKeys.length ? caughtByMain({ tool: join(REPO, "ratchet"), baseDir, candDir: dir, outDir: join(runDir, `known-c${n}-${attempts}`), keys: newKeys }) : {};
      if (newKeys.length) log("新しい型を main の検査器にかけた", { 候補: n, 回: attempts, 結果: Object.values(caught).map((k) => (k ? `${k.key} ${k.caught}/${k.leaks}` : "確かめられない")) });
      gate = cand
        ? compareMetrics(base, cand, browser, caught)
        : { pass: false, reasons: [`変えたファイルの確かめで止めた（${bad.length} か所：${bad.slice(0, 5).join("、")}）`], improved: [], declined: [], table: [] };
      log("歯止めにかけた", { 候補: n, 回: attempts, 通った: gate.pass, 理由: gate.reasons.slice(0, 5) });
      if (gate.pass) break;
      if (gate.alreadyCaught) {
        // 直させても、main が捕まえることは変わらない（合成 PDF を main から逃げる形に変えさせない）
        stop = "すでに捕まる（main の検査器が、新しい型の隠しありを全部報告した）";
        break;
      }
      if (attempts >= limits.fixAttempts) {
        stop = "届かなかった（直す回数の上限）";
        break;
      }
      attempts++;
    }
    const res: Record<string, unknown> = { candidate: n, pattern: c.pattern, attempts, pass: gate?.pass ?? false, stop, ruleId: report?.ruleId ?? null, summary: report?.summary ?? null, discarded: report?.discarded ?? null, changedFiles: report?.changedFiles ?? [] };
    if (gate?.pass && report) {
      git(dir, ["add", "-A"]);
      const msg = `Ratchet：${c.pattern} の検出ルール ${report.ruleId} を足す\n\n${report.summary}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
      const body = renderPrBody({
        date: started.toISOString().slice(0, 16).replace("T", " "), runId, candidate: c, refute, write: report, gate, attempts,
        counts: { read, skipped, suspicions: suspicionCount, candidates: candidateCount, refuted }, calls: caller.calls, costUsd: caller.costUsd,
      });
      const title = prTitle({ candidate: c } as any);
      const leaks = findLeaks(`${title}\n${body}\n${msg}`, { secrets: [env.corpus, env.state, env.exclude ?? ""], files });
      const bodyFile = join(runDir, `pr-${n}.md`);
      if (leaks.length) {
        res.stop = `本文に出してはいけない字が混ざった（${leaks.join("、")}）。PR にしない`;
      } else {
        // コミットは、本文の確かめを通ってから（コミットの文も同じ確かめにかけている）
        spawnSync("git", ["commit", "-q", "-F", "-"], { cwd: dir, input: msg, encoding: "utf8", windowsHide: true });
        writeFileSync(bodyFile, body);
        res.body = bodyFile;
        if (doPr) {
          // ラベルが無ければ作る（あれば失敗して何もしない）
          spawnSync("gh", ["label", "create", LABEL, "--description", "Ratchet のループが出した PR"], { cwd: REPO, encoding: "utf8", windowsHide: true });
          const push = git(dir, ["push", "-u", "origin", branch]);
          const pr = push.status === 0
            ? spawnSync("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body-file", bodyFile, "--label", LABEL], { cwd: dir, encoding: "utf8", windowsHide: true })
            : null;
          res.pr = pr?.status === 0 ? pr.stdout.trim() : null;
          if (!res.pr) res.stop = "PR を出せなかった";
        }
      }
    }
    results.push(res);
    log("候補を終えた", { 候補: n, 通った: res.pass, PR: res.pr ?? (doPr ? null : "dry-run"), 止まった理由: res.stop ?? "なし" });
  }
  outcome.results = results;
  finish(null);
  }
}

main().catch((e) => {
  // 例外の文に中身やパスが混ざりうるので、種類だけを出す（こちらで書いた「環境変数がありません」だけは、変数の名前なので出す）
  const own = e instanceof Error && /^(環境変数がありません|作業の木を作れなかった)/.test(e.message);
  console.error(`止まりました（${own ? e.message : e instanceof Error ? e.constructor.name : "不明"}）`);
  process.exitCode = 1;
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// Ratchet の 1 回分のループの道具（ratchet/）の確かめ。Claude は呼ばない（呼ぶ道具を差し替える）。

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { markDone, markStarted, readExclude, selectBundle, sha256File, type State } from "../ratchet/bundle.ts";
import { buildArgs, Caller, wrapData, type Runner } from "../ratchet/claude.ts";
import { limitsFrom, readEnv, viaFrom } from "../ratchet/config.ts";
import Anthropic from "@anthropic-ai/sdk";
import { apiCheck, costOf, errorDetail, keyShape, mask, maxTokensFor, readApiKey, realApiSend, toApiSchema, type ApiRequest, type ApiSend } from "../ratchet/api.ts";
import { scheduleArgs } from "../ratchet/schedule.ts";
import { checkDiff, compareMetrics } from "../ratchet/gate.ts";
import type { Metrics, TypeScore } from "../ratchet/metrics.ts";
import { findLeaks, prTitle, renderPrBody, viaLine } from "../ratchet/prbody.ts";
import { publishOne, publishTargets, titleFromBody, type Run } from "../ratchet/publish.ts";
import { summarizeCli, xmpElementNames } from "../ratchet/probe.ts";
import { parseRejections, reasonOf } from "../ratchet/rejections.ts";
import { CANDIDATES, REFUTE, SKIM, validate, WRITE_REPORT } from "../ratchet/schema.ts";
import { parseReadme, readCatalog, ruleDirOf, shortCatalog } from "../ratchet/catalog.ts";
import { countCaught, patternOfKey, ruleIdOfKey } from "../ratchet/known.ts";
import { candidatesFromRun, docShape, evidenceIdsFor, evidenceReason, forbiddenInDiff, hitsOnEvidence, permissionArgv, readShaList, resolveShas, shapeOf, withEvidenceIds, type RunCheck } from "../ratchet/evidence.ts";
import { JUDGE_PROMPT, KNOWN_GUIDE, REFUTE_PROMPT, SKIM_PROMPT, writePrompt } from "../ratchet/prompts.ts";
import { choosePages, dropChartBars, maskRunsOf, probeRedaction, type RedactionClues } from "../ratchet/redaction.ts";
import { BARS, ccittScanPdf, customerBarcode, decorPdf, realisticScanPdf, ROUGH, sameFormPdf, scannedStatementPdf, statementPdf } from "../ratchet/synthetic-redaction.ts";

const t = (key: string, found: number, expected: number, fp = 0, extra: Partial<TypeScore> = {}): TypeScore => ({
  key, source: key.startsWith("rubric") ? "rubric" : "cases", expected, found, falsePositiveRate: fp ? fp / 10 : 0, falsePositives: fp,
  residual: key.startsWith("rubric") ? 0 : null, ...extra,
});
const metrics = (types: TypeScore[], blindPass = 10): Metrics => ({
  types, blind: { pass: blindPass, total: 10 }, test: { ok: true, passed: 100, failed: 0 }, build: { ok: true }, errors: [],
});
const okBrowser = { ok: true, external: 0 };
/** main の検査器が、新しい型 cases:NEW:x の隠しありを 1 つも捕まえなかった */
const notCaught = { "cases:NEW:x": { key: "cases:NEW:x", leaks: 10, caught: 0, byRules: [] } };

describe("歯止め（どれも下がらず、1 つは良くなる）", () => {
  const base = metrics([t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9)]);

  it("下がった型があれば通さない", () => {
    const g = compareMetrics(base, metrics([t("rubric:P6", 31, 32), t("cases:P8:p8-annot", 9, 9), t("cases:NEW:x", 10, 10)]), okBrowser);
    expect(g.pass).toBe(false);
    expect(g.declined.join()).toContain("rubric:P6");
  });

  it("すべて同じなら「良くなった所がない」で通さない", () => {
    const g = compareMetrics(base, metrics([t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9)]), okBrowser);
    expect(g.pass).toBe(false);
    expect(g.reasons).toContain("良くなった所がない");
  });

  it("新しい型が合格基準を満たし、ほかが下がらなければ通す（main が捕まえない隠しありがあるとき）", () => {
    const g = compareMetrics(base, metrics([t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9), t("cases:NEW:x", 10, 10)]), okBrowser, notCaught);
    expect(g.pass).toBe(true);
    expect(g.improved.join()).toContain("cases:NEW:x");
  });

  it("新しい型の隠しありを、main の検査器がすでに全部捕まえるなら「すでに捕まる」で通さない（直させない）", () => {
    const c = metrics([t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9), t("cases:P9:p9-x", 5, 5)]);
    const g = compareMetrics(base, c, okBrowser, { "cases:P9:p9-x": { key: "cases:P9:p9-x", leaks: 5, caught: 5, byRules: ["p9-attach"] } });
    expect(g.pass).toBe(false);
    expect(g.alreadyCaught).toBe(true);
    expect(g.reasons.join()).toContain("すでに捕まる（main の p9-attach が、隠しありの 5 件中 5 件を報告）");
    expect(g.improved).toEqual([]);
  });

  it("main が一部だけ捕まえるなら通し、捕まえない分だけを「良くなった」に書く。採点表に main の数を出す", () => {
    const c = metrics([t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9), t("cases:P12:p12-x", 5, 5)]);
    const g = compareMetrics(base, c, okBrowser, { "cases:P12:p12-x": { key: "cases:P12:p12-x", leaks: 5, caught: 1, byRules: ["p12-actions"] } });
    expect(g.pass).toBe(true);
    expect(g.alreadyCaught).toBeUndefined();
    expect(g.improved.join()).toContain("main が捕まえない隠しあり 4 件");
    expect(g.table.find((r) => r.key === "cases:P12:p12-x")!.after).toContain("main がすでに捕まえた隠しあり 1/5（p12-actions）");
  });

  it("新しい型を main の検査器で確かめられなかったら通さない", () => {
    const c = metrics([t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9), t("cases:NEW:x", 10, 10)]);
    expect(compareMetrics(base, c, okBrowser).reasons.join()).toContain("main の検査器で確かめられなかった");
    expect(compareMetrics(base, c, okBrowser, { "cases:NEW:x": null }).pass).toBe(false);
  });

  it("新しい型の検出率が 95% に届かなければ通さない", () => {
    const g = compareMetrics(base, metrics([t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9), t("cases:NEW:x", 9, 10)]), okBrowser);
    expect(g.pass).toBe(false);
    expect(g.reasons.join()).toContain("95%");
  });

  it("新しい型に対照が無く誤検知率を測れなければ通さない", () => {
    const g = compareMetrics(base, metrics([t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9), t("cases:NEW:x", 10, 10, 0, { falsePositiveRate: null })]), okBrowser);
    expect(g.pass).toBe(false);
  });

  it("今ある型の隠しの数を変えたら通さない（材料を書き換えて良く見せない）", () => {
    const g = compareMetrics(base, metrics([t("rubric:P6", 30, 30), t("cases:P8:p8-annot", 9, 9), t("cases:NEW:x", 10, 10)]), okBrowser);
    expect(g.pass).toBe(false);
  });

  it("見ないで作るテスト集の「合」が減ったら通さない", () => {
    const g = compareMetrics(base, metrics([t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9), t("cases:NEW:x", 10, 10)], 9), okBrowser);
    expect(g.pass).toBe(false);
  });

  it("外への要求が 0 件でない・確かめていないときは通さない", () => {
    const c = metrics([t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9), t("cases:NEW:x", 10, 10)]);
    expect(compareMetrics(base, c, { ok: false, external: 1 }).pass).toBe(false);
    expect(compareMetrics(base, c, null).pass).toBe(false);
  });

  it("新しい型のルールが画面の一覧（RULES）に入っていなければ通さない（マージしても検査器に入らない）", () => {
    const b = { ...base, ruleIds: ["p6-text", "p8-annot"] };
    const types = [t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9), t("cases:NEW:x", 10, 10)];
    expect(compareMetrics(b, { ...metrics(types), ruleIds: ["p6-text", "p8-annot"] }, okBrowser).reasons.join()).toContain("RULES");
    expect(compareMetrics(b, { ...metrics(types), ruleIds: ["p6-text", "p8-annot", "x"] }, okBrowser, notCaught).pass).toBe(true);
    expect(compareMetrics(b, { ...metrics(types), ruleIds: ["p6-text", "x"] }, okBrowser).pass).toBe(false);
  });

  it("テストかビルドが通らなければ通さない", () => {
    const c = metrics([t("rubric:P6", 32, 32), t("cases:P8:p8-annot", 9, 9), t("cases:NEW:x", 10, 10)]);
    expect(compareMetrics(base, { ...c, test: { ok: false, passed: 99, failed: 1 } }, okBrowser).pass).toBe(false);
    expect(compareMetrics(base, { ...c, build: { ok: false } }, okBrowser).pass).toBe(false);
  });
});

describe("変えてよいファイル", () => {
  it("採点する側・今ある材料・画面を変えたら止める", () => {
    const bad = checkDiff(
      [
        { status: "M", path: "rubric/p6.json" },
        { status: "A", path: "fixtures/x.pdf" },
        { status: "M", path: "verifier/index.ts" },
        { status: "M", path: "eval/cases/p8.ts" },
        { status: "M", path: "eval/p6.ts" },
        { status: "M", path: "tests/p6.test.ts" },
        { status: "M", path: "src/ui/ruleset.ts" },
        { status: "A", path: "proposals/blind/x.pdf" },
        { status: "D", path: "rules/p8-annot/index.ts" },
      ],
      {},
    );
    expect(bad).toHaveLength(9);
  });

  it("札の名前と RULES の一覧のテストは、1 行足すだけなら通し、消す・2 行以上は止める", () => {
    const e = [
      { status: "M", path: "tests/inspect-all.test.ts" },
      { status: "M", path: "src/ui/fuda.ts" },
    ];
    expect(checkDiff(e, { "tests/inspect-all.test.ts": { added: 1, removed: 0 }, "src/ui/fuda.ts": { added: 1, removed: 0 } })).toEqual([]);
    expect(checkDiff(e, { "tests/inspect-all.test.ts": { added: 1, removed: 1 }, "src/ui/fuda.ts": { added: 2, removed: 0 } })).toHaveLength(2);
    // ほかの src/ui のファイル・ほかの今あるテストは、1 行でも止める
    expect(checkDiff([{ status: "M", path: "src/ui/ruleset.ts" }, { status: "M", path: "tests/ui-fuda.test.ts" }], { "src/ui/ruleset.ts": { added: 1, removed: 0 }, "tests/ui-fuda.test.ts": { added: 1, removed: 0 } })).toHaveLength(2);
  });

  it("ルール・新しい合成 PDF・一覧に足すことは通す", () => {
    expect(
      checkDiff(
        [
          { status: "A", path: "rules/new-x/index.ts" },
          { status: "M", path: "rules/p8-annot/index.ts" },
          { status: "M", path: "src/inspect/rules.ts" },
          { status: "A", path: "eval/cases/new-x.ts" },
          { status: "M", path: "eval/cases/registry.ts" },
          { status: "A", path: "tests/new-x.test.ts" },
          { status: "A", path: "proposals/new-x/README.md" },
        ],
        { "eval/cases/registry.ts": { added: 3, removed: 0 } },
      ),
    ).toEqual([]);
  });

  it("新しいルールを画面の一覧に足していなければ止める", () => {
    const bad = checkDiff([{ status: "A", path: "rules/new-x/index.ts" }, { status: "A", path: "eval/cases/new-x.ts" }, { status: "M", path: "eval/cases/registry.ts" }], {});
    expect(bad.join()).toContain("src/inspect/rules.ts");
  });

  it("registry.ts から行を消したら止める", () => {
    expect(checkDiff([{ status: "M", path: "eval/cases/registry.ts" }], { "eval/cases/registry.ts": { added: 2, removed: 1 } })).toHaveLength(1);
  });
});

describe("束を選ぶ", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  function corpus(n: number) {
    dir = mkdtempSync(join(tmpdir(), "ratchet-"));
    const c = join(dir, "corpus", "sub");
    mkdirSync(c, { recursive: true });
    const files = [];
    for (let i = 0; i < n; i++) {
      const p = join(c, `架空の名前-${i}.pdf`);
      writeFileSync(p, `%PDF-1.7\n% ${i}\n%%EOF\n`);
      files.push(p);
    }
    writeFileSync(join(c, "メモ.txt"), "PDF ではない");
    return { root: join(dir, "corpus"), files };
  }

  it("採点用の実データを sha256 で除き、番号は b01 からにする", () => {
    const { root, files } = corpus(5);
    const ex = join(dir, "exclude.txt");
    writeFileSync(ex, `# 除く\n${sha256File(files[0]!)}\n\n`);
    const sel = selectBundle({ corpus: root, exclude: readExclude(ex), state: { done: [], current: null }, size: 3, runId: "r1" });
    expect(sel.counts.excluded).toBe(1);
    expect(sel.items.map((i) => i.id)).toEqual(["b01", "b02", "b03"]);
    expect(sel.items.some((i) => i.sha256 === sha256File(files[0]!))).toBe(false);
  });

  it("読んだものは二度読まず、止まった束は続きから同じ番号で始める", () => {
    const { root } = corpus(5);
    let state: State = { done: [], current: null };
    const s1 = selectBundle({ corpus: root, exclude: new Set(), state, size: 3, runId: "r1" });
    state = markStarted(state, s1);
    state = markDone(state, s1.items[0]!.sha256); // b01 だけ読んで止まった
    const s2 = selectBundle({ corpus: root, exclude: new Set(), state, size: 3, runId: "r2" });
    expect(s2.runId).toBe("r1");
    expect(s2.counts.resumed).toBe(true);
    expect(s2.items.slice(0, 2).map((i) => i.id)).toEqual(["b02", "b03"]);
    expect(s2.items.map((i) => i.sha256)).not.toContain(s1.items[0]!.sha256);
    for (const it of s2.items) state = markDone(state, it.sha256);
    expect(state.current).toBeNull();
  });
});

describe("Claude の答え", () => {
  const ok = (structured: unknown, extra: object = {}) =>
    JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, structured_output: structured, permission_denials: [], ...extra });

  it("形に合わない答えは捨てる", async () => {
    const runner: Runner = async () => ({ code: 0, stdout: ok({ suspicions: [{ pattern: "P99", signal: "x", alreadyReported: false }] }), stderr: "" });
    const c = new Caller({ skim: 5, judge: 5, write: 5, runBudgetUsd: null }, runner, { via: "cli" });
    const r = await c.call({ role: "skim", model: "m", prompt: "p", schema: SKIM, cwd: "." });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("形が合わない");
  });

  it("決めていない欄があっても捨てる", () => {
    expect(validate(REFUTE, { keep: true, reason: "残す", explanation: "x", extra: 1 })).not.toEqual([]);
  });

  it("回数の上限と金額の上限で止める", async () => {
    const runner: Runner = async () => ({ code: 0, stdout: ok({ suspicions: [] }), stderr: "" });
    const c = new Caller({ skim: 2, judge: 1, write: 1, runBudgetUsd: 0.015 }, runner, { via: "cli" });
    expect((await c.call({ role: "skim", model: "m", prompt: "p", schema: SKIM, cwd: "." })).ok).toBe(true);
    expect((await c.call({ role: "skim", model: "m", prompt: "p", schema: SKIM, cwd: "." })).ok).toBe(true);
    const third = await c.call({ role: "skim", model: "m", prompt: "p", schema: SKIM, cwd: "." });
    expect(third.ok).toBe(false);
    expect(c.overBudget()).toBe(true);
  });

  it("判断と反証は合わせて数える", async () => {
    const runner: Runner = async () => ({ code: 0, stdout: ok({ keep: false, reason: "もう捕まる", explanation: "x" }), stderr: "" });
    const c = new Caller({ skim: 1, judge: 2, write: 1, runBudgetUsd: null }, runner, { via: "cli" });
    await c.call({ role: "judge", model: "m", prompt: "p", schema: REFUTE, cwd: "." });
    await c.call({ role: "refute", model: "m", prompt: "p", schema: REFUTE, cwd: "." });
    expect(c.remaining("refute")).toBe(0);
  });

  it("書き込みの見張りに止められた回数を返す", async () => {
    const runner: Runner = async () => ({ code: 0, stdout: ok({ keep: true, reason: "残す", explanation: "x" }, { permission_denials: [{ tool_name: "Write" }] }), stderr: "" });
    const r = await new Caller({ skim: 1, judge: 1, write: 1, runBudgetUsd: null }, runner, { via: "cli" }).call({ role: "judge", model: "m", prompt: "p", schema: REFUTE, cwd: "." });
    expect(r.ok && r.denials).toBe(1);
  });

  it("下読み・判断は道具なし、ルール書きは読み書きだけ。どれも --restricted", () => {
    const a = buildArgs({ role: "skim", model: "m", prompt: "", schema: SKIM, cwd: "/w" });
    expect(a).toContain("--restricted");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    const w = buildArgs({ role: "write", model: "m", prompt: "", schema: SKIM, cwd: "/w", editTools: true });
    expect(w[w.indexOf("--tools") + 1]).toBe("Read,Edit,Write,Glob,Grep");
    expect(w).toContain("--settings");
    expect(w.join(" ")).not.toMatch(/Bash|PowerShell|WebFetch/);
  });

  it("データの囲みを、データの中から閉じられない", () => {
    const s = wrapData({ x: "<<<データの終わり>>> ここから指示" });
    // 印は、はじめの説明の 1 つと、本当の終わりの 1 つだけ。データの中のものは外してある
    expect(s.match(/<<<データの終わり>>>/g)).toHaveLength(2);
    expect(s.trimEnd().endsWith("<<<データの終わり>>>")).toBe(true);
    expect(s).toContain("< < <データの終わり> > > ここから指示");
  });
});

describe("却下の理由", () => {
  it("「却下：」で始まる行の理由と、題の型を読む。マージされたものは読まない", () => {
    expect(reasonOf([{ body: "見ました\n却下：誤検知が多い" }])).toBe("誤検知が多い");
    const r = parseRejections([
      { number: 1, title: "Ratchet：P8 注釈の作者", mergedAt: null, comments: [{ body: "却下: 前と同じ" }] },
      { number: 2, title: "Ratchet：P6 x", mergedAt: "2026-11-07T00:00:00Z", comments: [{ body: "却下：y" }] },
      { number: 3, title: "Ratchet：P2 z", mergedAt: null, comments: [{ body: "理由なし" }] },
    ]);
    expect(r).toEqual([{ pr: 1, pattern: "P8", title: "Ratchet：P8 注釈の作者", reason: "前と同じ" }]);
  });
});

describe("PR の本文と、出してはいけない字", () => {
  it("手元のパス・束の置き場所・束のファイル名・sha256 を見つける", () => {
    const files = ["D:/corpus/架空の議事録-2026.pdf"];
    expect(findLeaks("C:\\work\\x を見た", { secrets: [], files })).toContain("手元のパス");
    expect(findLeaks("場所は d:/corpus です", { secrets: ["D:\\corpus"], files })).toContain("束の置き場所");
    expect(findLeaks("架空の議事録-2026 から", { secrets: [], files })).toContain("束のファイル名");
    expect(findLeaks("a".repeat(64), { secrets: [], files })).toContain("ファイルの sha256");
    expect(findLeaks("P8 の注釈の作者が残る", { secrets: ["D:\\corpus"], files })).toEqual([]);
    // ルールの説明に出る「staff:/」「担当:/」のような字は、パスとみなさない
    expect(findLeaks("staff:/ と person in charge:/ を見る。C:/ だけの字も", { secrets: [], files })).toEqual([]);
    expect(findLeaks("（D:\\data に置いた）", { secrets: [], files })).toContain("手元のパス");
  });

  it("本文は決めた見出しをそろえ、表の区切りを壊さない", () => {
    const body = renderPrBody({
      date: "2026-11-07 05:00", runId: "r", attempts: 1,
      candidate: { id: "c1", pattern: "P8", title: "注釈の作者", nearestRule: "p8-annot：返信の注釈を見ていない", whyMissed: "作者の欄 | を見ていない", evidenceCount: 3, fixturePlan: "架空の注釈" },
      refute: { reason: "残す", explanation: "まだ捕まらない" },
      write: { ruleId: "p8-x", summary: "足した", discarded: "全部の欄を見る案" },
      gate: { pass: true, reasons: [], improved: ["cases:P8:p8-x：新しい型"], declined: [], table: [{ key: "cases:P8:p8-x", before: "—", after: "検出 5/5（100.0%）・誤検知 0 件（0.0%）", change: "新しい" }] },
      counts: { read: 50, skipped: 1, suspicions: 4, candidates: 2, refuted: 1 }, calls: { skim: 50, judge: 1, refute: 2, write: 2 }, costUsd: 1.234,
    });
    for (const h of ["## 何の型か", "## Claude の判断", "## 採点表", "## 歯止めの結果", "## 捨てた案", "## この回の量と費用", "## docs/evolution.md に足す行"]) expect(body).toContain(h);
    expect(body).toContain("作者の欄 ／ を見ていない");
    expect(body).toContain("いちばん近い今のルールと、それでは足りない理由：p8-annot：返信の注釈を見ていない");
    expect(body).toContain("却下：");
  });
});

describe("dry-run の PR を出す（--publish）", () => {
  const prInput = (title: string) => ({
    date: "2026-11-07 05:00", runId: "r", attempts: 1,
    candidate: { id: "c1", pattern: "P7", title, nearestRule: "p7-x：足りない", whyMissed: "見ていない", evidenceCount: 3, fixturePlan: "架空" },
    refute: { reason: "残す", explanation: "まだ捕まらない" },
    write: { ruleId: "p7-y", summary: "足した", discarded: "案" },
    gate: { pass: true, reasons: [], improved: [], declined: [], table: [] },
    counts: { read: 50, skipped: 0, suspicions: 1, candidates: 1, refuted: 0 }, calls: { skim: 1, judge: 1, refute: 1, write: 1 }, costUsd: 1,
  });

  it("本文から、dry-run と同じ題を読む（題に括弧があっても）", () => {
    for (const t of ["フォントの字形", "埋め込みの字形（CFF）に残る字"]) {
      const p = prInput(t);
      expect(titleFromBody(renderPrBody(p as any))).toBe(prTitle(p as any));
    }
    expect(titleFromBody(["## 何の型か", "", "形が違う"].join("\n"))).toBeNull();
  });

  it("歯止めを通り、本文があり、まだ出していないものだけを選ぶ", () => {
    expect(publishTargets({ results: [
      { candidate: 1, pass: true, body: "x" },
      { candidate: 2, pass: false, stop: "届かなかった" },
      { candidate: 3, pass: true, stop: "本文に出してはいけない字が混ざった" },
      { candidate: 4, pass: true, body: "x", pr: "https://example.invalid/pull/1" },
    ] })).toEqual([1]);
    expect(publishTargets({})).toEqual([]);
    // 前の --publish で出したものは選ばない（止まったものは、もう一度選ぶ）
    expect(publishTargets({
      results: [1, 2].map((n) => ({ candidate: n, pass: true, body: "x" })),
      published: [{ results: [{ candidate: 1, pr: 42, stop: null }, { candidate: 2, pr: null, stop: "npm test が通らない" }] }],
    })).toEqual([2]);
  });

  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  /** 架空の作業の木と記録。git・npm・gh は偽物（何も外に出さない） */
  function setup(opts: { body?: string; merge?: number; test?: number } = {}) {
    const repo = mkdtempSync(join(tmpdir(), "ratchet-pub-"));
    dirs.push(repo);
    const runDir = join(repo, "state", "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(repo, ".tmp", "ratchet-work", "r1", "c1"), { recursive: true });
    writeFileSync(join(runDir, "pr-1.md"), opts.body ?? renderPrBody(prInput("架空の型") as any));
    const calls: string[][] = [];
    const run: Run = (cmd, args) => {
      calls.push([cmd, ...args]);
      const a = args.join(" ");
      const out = (s: string) => ({ status: 0, stdout: s + "\n" });
      if (cmd === "git" && a.startsWith("rev-parse")) return out("claude/ratchet-r1-1");
      if (cmd === "git" && a.startsWith("rev-list")) return out("1");
      if (cmd === "git" && a.startsWith("log")) return out("Ratchet：P7 の検出ルール p7-y を足す");
      if (cmd === "git" && a.startsWith("diff")) return out("rules/p7-y/index.ts");
      if (cmd === "git" && a.startsWith("merge")) return { status: opts.merge ?? 0, stdout: "" };
      if (cmd === "npm" && a === "test") return { status: opts.test ?? 0, stdout: "" };
      if (cmd === "gh" && args[0] === "pr") return out("https://example.invalid/o/r/pull/42");
      return { status: 0, stdout: "" };
    };
    const go = () => publishOne({ repo, runId: "r1", runDir, n: 1, secrets: ["D:/corpus"], files:["D:/corpus/架空の束の名前.pdf"], run, log: () => {} });
    return { calls, go };
  }
  const has = (calls: string[][], ...head: string[]) => calls.some((c) => head.every((h, i) => c[i] === h));

  it("全部通れば、main に重ねてテストとビルドを回し、--force なしで push して PR にする", () => {
    const { calls, go } = setup();
    const r = go();
    expect(r).toEqual({ candidate: 1, title: "Ratchet：P7 架空の型", pr: 42, stop: null });
    expect(has(calls, "git", "worktree", "add")).toBe(true);
    expect(has(calls, "git", "merge", "--no-ff", "--no-commit", "claude/ratchet-r1-1")).toBe(true);
    expect(has(calls, "npm", "test") && has(calls, "npm", "run", "build")).toBe(true);
    expect(has(calls, "git", "worktree", "remove")).toBe(true);
    expect(has(calls, "git", "push", "-u", "origin", "claude/ratchet-r1-1")).toBe(true);
    expect(calls.filter((c) => c[1] === "push").flat().some((a) => /^(--force|-f)/.test(a))).toBe(false);
    expect(calls.findIndex((c) => c[1] === "push")).toBeGreaterThan(calls.findIndex((c) => c[0] === "npm" && c[2] === "build"));
  });

  it("本文に束のファイル名があれば、push しない", () => {
    const { calls, go } = setup({ body: renderPrBody(prInput("架空の束の名前 に残る字") as any) });
    expect(go().stop).toMatch(/束のファイル名/);
    expect(has(calls, "git", "push")).toBe(false);
    expect(has(calls, "git", "worktree", "add")).toBe(false);
  });

  it("今の main に重ならないとき・重ねてテストが落ちるときは、push せず、確かめの作業の木を片付ける", () => {
    for (const [o, why] of [[{ merge: 1 }, /きれいに重ならない/], [{ test: 1 }, /npm test が通らない/]] as const) {
      const { calls, go } = setup(o);
      expect(go().stop).toMatch(why);
      expect(has(calls, "git", "push")).toBe(false);
      expect(has(calls, "git", "worktree", "remove")).toBe(true);
    }
  });
});

describe("墨消しの手がかり（下読みに渡す数と形）", () => {
  it("架空のカスタマバーコードは、仕様どおりの 67 本で、チェックデジットで合計が 19 の倍数になる", () => {
    const bars = customerBarcode("9990000", "9-9-9");
    expect(bars).toHaveLength(2 + 20 * 3 + 3 + 2);
    expect(bars.slice(0, 2)).toEqual([1, 3]);
    expect(bars.slice(-2)).toEqual([3, 1]);
    // バーの組み合わせから字に戻し、チェック用の数の合計を確かめる
    const back = Object.fromEntries(Object.entries(BARS).map(([c, b]) => [b, c]));
    const chars = Array.from({ length: 21 }, (_, i) => back[bars.slice(2 + i * 3, 5 + i * 3).join("")]!);
    expect(chars.slice(0, 7).join("")).toBe("9990000");
    expect(chars.slice(7, 12).join("")).toBe("9-9-9");
    expect(chars.slice(12, 20).every((c) => c === "CC4")).toBe(true);
    const v = (c: string) => (/^\d$/.test(c) ? Number(c) : c === "-" ? 10 : 10 + Number(c.slice(2)));
    expect(chars.reduce((a, c) => a + v(c), 0) % 19).toBe(0);
  });

  const clues = async (bytes: Uint8Array) => {
    const r = await probeRedaction(bytes);
    if ("failed" in r) throw new Error(r.failed);
    return r as RedactionClues;
  };

  it("宛名と住所を塗り、その下のバーコードを残した明細：四角の近くに棒の並び（67 本・高さ 4 種類）を見つける", async () => {
    for (const bytes of [await statementPdf("leak"), await scannedStatementPdf("leak")]) {
      const r = await clues(bytes);
      expect(r.boxes).toBeGreaterThanOrEqual(2);
      expect(r.boxesWithBarsNearby).toBeGreaterThanOrEqual(1);
      const near = r.pages.flatMap((p) => p.nearby);
      expect(near.some((n) => n.bars === 67 && n.heightKinds === 4 && n.side === "below")).toBe(true);
    }
  }, 60_000);

  it("対照（バーコードも塗った・バーコードが無い）では、棒の並びは出ない", async () => {
    for (const kind of ["covered", "none"] as const) {
      const r = await clues(await statementPdf(kind));
      expect(r.boxes).toBeGreaterThanOrEqual(2);
      expect(r.boxesWithBarsNearby).toBe(0);
    }
  }, 60_000);

  it("スキャン風だけ、文字の層の「■」の続きを数える（字そのものは返さない）", async () => {
    expect((await clues(await scannedStatementPdf("leak"))).maskRuns.runs).toBeGreaterThanOrEqual(1);
    expect((await clues(await statementPdf("leak"))).maskRuns.runs).toBe(0);
    expect(maskRunsOf("■■ と ■ ■ ■ と ■ だけ")).toEqual({ runs: 2, longest: 3 });
  }, 60_000);

  it("同じ書式の 2 ページで、片方だけ欄を塗ったとき：食い違いを 1 つ数える", async () => {
    const r = await clues(await sameFormPdf());
    expect(r.pagesRendered).toBe(2); // 塗りの無いページも、比べる相手として画像にする
    expect(r.sameLayout).toEqual({ similarPairs: 1, mismatches: 1, examples: [{ withBox: 1, without: 2 }] });
  }, 60_000);

  // 2026-11-07、実物のスキャン 3 件で墨消しを 0 件と数えた反省から足した見本
  it("実物に近いスキャン（傾き・紙の色・灰色の塗り・点・JPEG・罫線と字に触れる塗り）でも、塗りと、その下の棒の並びを見つける", async () => {
    for (const look of [{}, ROUGH]) {
      const r = await clues(await realisticScanPdf("leak", look));
      expect(r.boxes).toBeGreaterThanOrEqual(3); // 住所・宛名・表の中の金額
      expect(r.diag.refined).toBeGreaterThanOrEqual(1); // 罫線を外して見直して見つけた
      const near = r.pages.flatMap((p) => p.nearby);
      expect(near.some((n) => n.bars >= 60 && n.heightKinds === 4 && n.side === "below")).toBe(true); // 傾いていても、高さは 4 種類
    }
    const covered = await clues(await realisticScanPdf("covered"));
    expect(covered.boxes).toBeGreaterThanOrEqual(3);
    expect(covered.boxesWithBarsNearby).toBe(0);
  }, 120_000);

  it("白黒の FAX 形式（CCITT G4）のスキャンも描いて数える（解く部品の場所を PDF.js に渡す）", async () => {
    const r = await clues(await ccittScanPdf());
    expect(r.boxes).toBe(1);
    expect(r.diag.pagesBlank).toBe(0);
  }, 60_000);

  it("落とした理由ごとの数を返す（数だけ）", async () => {
    const r = await clues(await decorPdf());
    expect(r.diag.chart).toBe(5);
    expect(r.diag.candidates).toBeGreaterThan(r.diag.kept);
    expect(Object.values(r.diag).every((v) => v === null || typeof v === "number")).toBe(true);
  }, 60_000);

  it("飾り（幅いっぱいの帯・白い字の載った見出し・グラフの棒）は、墨消しに数えない", async () => {
    expect((await clues(await decorPdf())).boxes).toBe(0);
    const bar = (x: number, h: number) => ({ x0: x, y0: 500 - h, x1: x + 30, y1: 500 });
    expect(dropChartBars([bar(0, 60), bar(50, 120), bar(100, 90)])).toEqual([]);
    expect(dropChartBars([bar(0, 12), bar(50, 12), bar(100, 12)])).toHaveLength(3); // 同じ高さの塗りの並び（名前の列を塗ったものなど）は残す
  }, 60_000);

  it("60 ページを超えたら、塗りの多いページから選ぶ。重いページと塗りの無いページは選ばない", () => {
    const scores = Array.from({ length: 100 }, (_, i) => ({ page: i + 1, score: i % 10 === 0 ? 0 : i, heavy: i === 99 }));
    const chosen = choosePages(scores);
    expect(chosen).toHaveLength(60);
    expect(chosen).not.toContain(100);
    expect(chosen).not.toContain(1);
    expect(Math.min(...chosen)).toBeGreaterThan(30);
  });

  it("下読みの指示に、墨消しの観点を入れる（答えの形は書き込みすぎない）", () => {
    expect(SKIM_PROMPT).toContain("別の形（たとえば機械で読む記号）や別の所（同じ書式のほかのページ）");
    expect(SKIM_PROMPT).not.toMatch(/バーコード|郵便/);
  });
});

describe("今あるルールの一覧（判断・反証に全部渡す）", () => {
  it("README から、地の文の要点と、表の種類（kind）を取る。コードと見出しは取らない", () => {
    const r = parseReadme([
      "# 検出ルール：P12 `p12-x`",
      "",
      "PDF を入れると、動作を返す。",
      "中身は返さない。",
      "",
      "```ts",
      "import { x } from './x.ts';",
      "```",
      "",
      "| 種類（`kind`） | 何か |",
      "|---|---|",
      "| `open_action` | 開いたときの動作 |",
      "| hidden_layer | 表示しない層 |",
    ].join("\r\n"));
    expect(r.summary).toBe("PDF を入れると、動作を返す。 中身は返さない。");
    expect(r.kinds).toEqual([{ kind: "open_action", what: "開いたときの動作" }, { kind: "hidden_layer", what: "表示しない層" }]);
  });

  it("registry の ruleId の添え書きを外して、rules/ のフォルダの名前にする", () => {
    expect(ruleDirOf("p9-attach（inner）")).toBe("p9-attach");
    expect(ruleDirOf("p6-text（図形の層）")).toBe("p6-text");
    expect(ruleDirOf("p8-annot")).toBe("p8-annot");
  });

  it("この木の一覧に、1 回目（2026-11-07）で「無い」とされた 3 つの近いルールが、種類まで入っている", async () => {
    const c = await readCatalog(process.cwd());
    const kinds = (id: string) => c.rules.find((r) => r.id === id)?.kinds.map((k) => k.kind) ?? [];
    expect(kinds("p12-actions")).toEqual(expect.arrayContaining(["open_action", "page_aa", "annotation"]));
    expect(kinds("p7-hidden")).toContain("hidden_layer");
    expect(c.rules.map((r) => r.id)).toContain("p9-attach");
    expect(c.scoredTypes.some((t) => t.ruleId.startsWith("p9-attach") && t.label === "添付ファイルの中身")).toBe(true);
    // 下読みに渡す短い形には、説明の文を入れない（呼び出しが多いので軽くする）
    const s = shortCatalog(c);
    expect(s.length).toBe(c.rules.length);
    expect(Object.keys(s[0]!).sort()).toEqual(["id", "kinds", "label", "pattern"]);
  });

  it("判断・反証・下読みの指示に、一覧の読み方が入っている。反証の「もう捕まる」は一覧で判断する", () => {
    for (const p of [SKIM_PROMPT, JUDGE_PROMPT, REFUTE_PROMPT]) expect(p).toContain(KNOWN_GUIDE);
    expect(REFUTE_PROMPT).toContain("knownRules のどれかのルールが、すでにこの形を見ている");
    expect(JUDGE_PROMPT).toContain("nearestRule");
    expect(writePrompt()).toContain("alreadyCovered");
  });

  it("候補には nearestRule が要り、ルール書きの報告には alreadyCovered が要る", () => {
    const c = { id: "c1", pattern: "P12", title: "t", whyMissed: "w", evidenceCount: 1, evidenceIds: ["b01"], fixturePlan: "f" };
    expect(validate(CANDIDATES, { candidates: [c] }).length).toBeGreaterThan(0);
    expect(validate(CANDIDATES, { candidates: [{ ...c, nearestRule: "p12-actions：しおりの動作を見ていない" }] })).toEqual([]);
    const w = { ruleId: "x", changedFiles: [], summary: "s", discarded: "d" };
    expect(validate(WRITE_REPORT, w).length).toBeGreaterThan(0);
    expect(validate(WRITE_REPORT, { ...w, alreadyCovered: "" })).toEqual([]);
  });

  it("1 回目の 3 件（架空の形にした候補）は、いまの候補の形に合う", () => {
    // 前の形（根拠の番号が無い）なので、人が渡す候補と同じく空の番号を足してから確かめる
    const j = withEvidenceIds(JSON.parse(readFileSync(join(process.cwd(), "ratchet/testdata/known-misses.json"), "utf8")));
    expect(validate(CANDIDATES, j)).toEqual([]);
    expect(j.candidates.map((c: { pattern: string }) => c.pattern)).toEqual(["P12", "P9", "P7"]);
  });
});

describe("main の検査器がすでに捕まえるか（新しい型の合成 PDF）", () => {
  const P = (pattern: string, ruleId: string, title = "見出し") => ({ pattern, ruleId, title });

  it("隠しありに、同じ型の番号の報告があれば捕まえたと数える。対照に同じ報告があっても引かない", () => {
    const k = countCaught("cases:P9:p9-x", [
      { kind: "leak", seen: [P("P9", "p9-attach", "添付ファイルが入っています")] },
      { kind: "leak", seen: [P("P9", "p9-attach", "添付ファイルが入っています")] },
      { kind: "control", seen: [P("P9", "p9-attach", "添付ファイルが入っています")] },
      { kind: "control", seen: [] },
    ]);
    expect(k).toEqual({ key: "cases:P9:p9-x", leaks: 2, caught: 2, byRules: ["p9-attach"] });
  });

  it("ほかの型の番号の報告は数えない（しおりの題の報告は、しおりの JavaScript を捕まえたことにならない）", () => {
    const k = countCaught("cases:P12:p12-x", [
      { kind: "leak", seen: [P("P7", "alt-text")] },
      { kind: "leak", seen: [P("P12", "p12-actions")] },
      { kind: "leak", seen: [] },
      { kind: "control", seen: [P("P7", "alt-text")] },
    ]);
    expect(k).toEqual({ key: "cases:P12:p12-x", leaks: 3, caught: 1, byRules: ["p12-actions"] });
  });

  it("型が NEW のときは、対照のどれにも出ない報告（見出しの数字はそろえる）があれば捕まえたと数える", () => {
    const k = countCaught("cases:NEW:x", [
      { kind: "leak", seen: [P("P1", "p1-info", "作成者の欄（3 字）")] },
      { kind: "leak", seen: [P("P5", "p5-revisions")] },
      { kind: "control", seen: [P("P1", "p1-info", "作成者の欄（5 字）")] },
    ]);
    expect(k).toEqual({ key: "cases:NEW:x", leaks: 2, caught: 1, byRules: ["p5-revisions"] });
  });

  it("鍵から ruleId と型の番号を取る", () => {
    expect(ruleIdOfKey("cases:P12:p12-outline-js")).toBe("p12-outline-js");
    expect(patternOfKey("cases:P12:p12-outline-js")).toBe("P12");
    expect(ruleIdOfKey("rubric:P6")).toBeNull();
  });
});

describe("構造の要約（値は伏せる）", () => {
  it("XMP は要素の名前だけを取り、値は取らない", () => {
    const n = xmpElementNames('<x:xmpmeta><dc:creator><rdf:Seq><rdf:li>架空の人</rdf:li></rdf:Seq></dc:creator><xmp:CreatorTool>T</xmp:CreatorTool></x:xmpmeta>');
    expect(n).toEqual(["dc:creator", "rdf:Seq", "rdf:li", "x:xmpmeta", "xmp:CreatorTool"].sort());
    expect(n.join()).not.toContain("架空の人");
  });

  it("今のルールの報告から、位置の細かさと detail を落とす", () => {
    const s = summarizeCli({ files: [{ stage: "high", items: [{ pattern: "P1", ruleId: "p1-info", severity: "high", title: "作成者の欄", detail: "架空の人", rect: [1, 2, 3, 4], page: 1 }] }] });
    expect(s.items[0]).toEqual({ pattern: "P1", ruleId: "p1-info", severity: "high", title: "作成者の欄", page: 1 });
  });
});

describe("node でそのまま動く", () => {
  // npm run ratchet は node の型の取り除き（strip-only）で動く。vitest では通っても、node では読めない書き方がある
  it.each(["api", "bundle", "schedule", "catalog", "claude", "config", "evidence", "gate", "known", "metrics", "prbody", "probe", "prompts", "publish", "redaction", "rejections", "schema", "synthetic", "synthetic-redaction"])("ratchet/%s.ts", (name) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "ratchet", `${name}.ts`)).href)})`], { encoding: "utf8" });
    expect(r.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError/);
    expect(r.status).toBe(0);
  });
});

describe("設定", () => {
  it("環境変数が足りなければ、名前だけを出して止める", () => {
    expect(() => readEnv({})).toThrow(/OMAMORI_RATCHET_CORPUS/);
    expect(readEnv({ OMAMORI_RATCHET_CORPUS: "a", OMAMORI_RATCHET_STATE: "b" }).exclude).toBeNull();
  });
  it("既定の上限は本人の決定の値", () => {
    const l = limitsFrom({});
    expect([l.bundleSize, l.fixAttempts, l.maxCandidates, l.skimCalls, l.judgeCalls, l.writeCalls]).toEqual([50, 3, 3, 50, 10, 9]);
  });
});

describe("根拠の実物で当たるか（歯止め。2026-11-07 本人の承認）", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "ratchet-ev-"));
    dirs.push(d);
    return d;
  };

  it("根拠の番号は、その回に下読みした番号だけ。空なら、同じ型の疑いを出した番号を使う", () => {
    const read = new Set(["b01", "b02", "b03"]);
    const sus = [{ id: "b02", pattern: "NEW" }, { id: "b03", pattern: "NEW" }, { id: "b01", pattern: "P2" }, { id: "b99", pattern: "NEW" }];
    expect(evidenceIdsFor({ pattern: "NEW", evidenceIds: ["b03", "b77", "b03"] }, read, sus)).toEqual(["b03"]);
    expect(evidenceIdsFor({ pattern: "NEW", evidenceIds: ["b77"] }, read, sus)).toEqual(["b02", "b03"]);
    expect(evidenceIdsFor({ pattern: "P9" }, read, sus)).toEqual([]);
  });

  it("候補の形に根拠の番号が要る。前の形の JSON には空の番号を足して受け付ける", () => {
    const c = { id: "c1", pattern: "NEW", title: "t", nearestRule: "なし", whyMissed: "w", evidenceCount: 1, fixturePlan: "f" };
    expect(validate(CANDIDATES, { candidates: [c] }).length).toBeGreaterThan(0);
    expect(validate(CANDIDATES, withEvidenceIds({ candidates: [{ ...c }] }))).toEqual([]);
  });

  it("かける前に、変えたファイルの通信・子のプロセスなどの字で止める。注・テスト・合成 PDF の道具は見ない", () => {
    const files: Record<string, string> = {
      "rules/x/index.ts": `export const a = 1;\nconst r = await fetch("https://example.invalid");`,
      "rules/y/index.ts": `// fetch や node:fs のことを書いた注\n/* WebSocket */\nexport const b = 2;`,
      "rules/z/index.ts": `import { readFileSync } from "node:fs";`,
      "rules/w/index.ts": `import { make } from "../../eval/cases/p8.ts";`,
      "rules/v/index.ts": `const m = await import(name);`,
      "src/inspect/rules.ts": `import { X } from "../../rules/x/index.ts";`,
      "tests/x.test.ts": `import { spawnSync } from "node:child_process";`,
      "eval/cases/x.ts": `import { readFileSync } from "node:fs";`,
    };
    const got = forbiddenInDiff("R", Object.keys(files).map((path) => ({ status: "A", path })), (p) => files[p.replaceAll("\\", "/").replace(/^R\//, "")]!);
    expect(got).toEqual(["rules/x/index.ts（fetch）", "rules/z/index.ts（node: の読み込み）", "rules/w/index.ts（検査器の外のフォルダの読み込み）", "rules/v/index.ts（形の決まらない import()）"]);
  });

  it("検査器は権限の仕組みで動かす。読めるのは作業の木・node_modules・その 1 件だけで、書き込みと子のプロセスは許さない", () => {
    const a = permissionArgv(join("C:", "cand"), join("C:", "corpus", "x.pdf"), 60);
    expect(a[0]).toBe("--permission");
    expect(a).toContain(`--allow-fs-read=${join("C:", "corpus", "x.pdf")}`);
    expect(a.some((x) => x.startsWith("--allow-fs-write") || x === "--allow-child-process" || x === "--allow-addons" || x === "--allow-wasi")).toBe(false);
    expect(a.filter((x) => x.startsWith("--allow-fs-read=")).some((x) => x.endsWith(join("C:", "corpus")))).toBe(false);
  });

  it("数えるのは書いたルールの報告だけ。0 件なら通さず、1 件でも当たれば通す。理由は件数だけ", () => {
    const out: Record<string, string[]> = { a: ["p6-text"], b: ["new-rule", "p1-info"], c: [] };
    const run: RunCheck = ({ argv }) => {
      const f = argv[argv.length - 1]!;
      return { status: 0, stdout: f === "broken" ? "{" : JSON.stringify({ files: [{ items: (out[f] ?? []).map((ruleId) => ({ ruleId })) }] }) };
    };
    const one = hitsOnEvidence({ candDir: "cand", files: ["a", "b", "c"], ruleIds: ["new-rule"], run });
    expect(one).toEqual({ total: 3, hit: 1, failed: 0 });
    expect(evidenceReason(one)).toBeNull();
    const none = hitsOnEvidence({ candDir: "cand", files: ["a", "c", "broken"], ruleIds: ["new-rule"], run });
    expect(none).toEqual({ total: 3, hit: 0, failed: 1 });
    expect(evidenceReason(none)).toBe("根拠の実物で当たらない（根拠 3 件のうち 0 件。検査器が止まった 1 件を含む）");
    expect(evidenceReason({ total: 2, hit: 0, failed: 2 })).toMatch(/^根拠の実物で確かめられなかった/);
    expect(evidenceReason({ total: 0, hit: 0, failed: 0 })).toMatch(/^根拠の実物が見つからない/);
  });

  /** 偽物の検査器（cli/omamori.ts）を置いた作業の木。中身は渡した字 */
  const fakeCand = (cli: string) => {
    const d = tmp();
    mkdirSync(join(d, "cli"), { recursive: true });
    mkdirSync(join(d, "node_modules"), { recursive: true });
    writeFileSync(join(d, "cli", "omamori.ts"), cli);
    return d;
  };

  it("権限の仕組みの中では、検査器は書き込み・子のプロセス・ほかのファイルの読み込みができない（本物の node で）", () => {
    const outside = join(tmp(), "outside.txt");
    writeFileSync(outside, "x");
    const cand = fakeCand([
      `import { readFileSync, writeFileSync } from "node:fs";`,
      `import { spawnSync } from "node:child_process";`,
      `const items = [];`,
      `const tryIt = (id, f) => { try { f(); items.push({ ruleId: id + "-ok" }); } catch { items.push({ ruleId: id + "-blocked" }); } };`,
      `const file = process.argv[process.argv.length - 1];`,
      `tryIt("read-pdf", () => readFileSync(file));`,
      `tryIt("write", () => writeFileSync(file + ".out", "x"));`,
      `tryIt("child", () => { const r = spawnSync(process.execPath, ["-e", "1"]); if (r.error) throw r.error; });`,
      `tryIt("read-other", () => readFileSync(${JSON.stringify(outside)}));`,
      `process.stdout.write(JSON.stringify({ files: [{ items }] }));`,
    ].join("\n"));
    const pdf = join(tmp(), "e.pdf");
    writeFileSync(pdf, "%PDF-1.4");
    const count = (id: string) => hitsOnEvidence({ candDir: cand, files: [pdf], ruleIds: [id] }).hit;
    expect(count("read-pdf-ok")).toBe(1);
    expect(count("write-blocked")).toBe(1);
    expect(count("child-blocked")).toBe(1);
    expect(count("read-other-blocked")).toBe(1);
  });

  it("3 回目と同じ形：図形の棒だけを見るルールは、線の見本では当たり、スキャン風の見本（s26）では 0 件で止まる", async () => {
    // 図形の塗りの命令が 60 を超えたら報告する、偽物のルール（3 回目の barcode-redact と同じ見方）
    const cand = fakeCand([
      `import { readFileSync } from "node:fs";`,
      `import { inflateSync } from "node:zlib";`,
      `const buf = readFileSync(process.argv[process.argv.length - 1]);`,
      `const s = buf.toString("latin1");`,
      `let fills = 0;`,
      `for (const m of s.matchAll(/stream\\r?\\n/g)) {`,
      `  const start = m.index + m[0].length;`,
      `  const end = s.indexOf("endstream", start);`,
      `  let text;`,
      `  try { text = inflateSync(buf.subarray(start, end)).toString("latin1"); } catch { text = s.slice(start, end); }`,
      `  fills += text.match(/(?:^|\\s)(?:f\\*?|F|[bB]\\*?)(?=\\s|$)/g)?.length ?? 0;`,
      `}`,
      `process.stdout.write(JSON.stringify({ files: [{ items: fills > 60 ? [{ ruleId: "barcode-vector" }] : [] }] }));`,
    ].join("\n"));
    const d = tmp();
    const vec = join(d, "vec.pdf");
    const scan = join(d, "scan.pdf");
    writeFileSync(vec, await statementPdf("leak"));
    writeFileSync(scan, await realisticScanPdf("leak"));
    expect(hitsOnEvidence({ candDir: cand, files: [vec], ruleIds: ["barcode-vector"] }).hit).toBe(1);
    const h = hitsOnEvidence({ candDir: cand, files: [scan], ruleIds: ["barcode-vector"] });
    expect(evidenceReason(h)).toBe("根拠の実物で当たらない（根拠 1 件のうち 0 件）");
  }, 60_000);

  it("根拠の形：スキャン風の見本は画像のページ、線の見本は図形のページとして数える（数だけ）", async () => {
    const scan = await probeRedaction(await realisticScanPdf("leak"));
    const vec = await probeRedaction(await statementPdf("leak"));
    const s1 = docShape({ redaction: scan as RedactionClues });
    const s2 = docShape({ redaction: vec as RedactionClues });
    expect(s1).toMatchObject({ image: true, boxesOnDrawn: 0, barsOnDrawn: 0 });
    expect(s1!.barsOnImage).toBeGreaterThan(0);
    expect(s2).toMatchObject({ image: false, boxesOnImage: 0, barsOnImage: 0 });
    expect(s2!.barsOnDrawn).toBeGreaterThan(0);
    const shape = shapeOf([s1, s2, null]);
    expect(shape).toMatchObject({ total: 3, unknown: 1, imageDocs: 1, drawnDocs: 1 });
    expect(JSON.stringify(shape)).not.toMatch(/[A-Za-z]:[\\/]|\.pdf/);
  }, 60_000);

  it("sha256 の一覧から、束のフォルダの PDF を探す。採点用の実データは除く", () => {
    const d = tmp();
    const shas: string[] = [];
    for (const n of ["a", "b", "c"]) {
      writeFileSync(join(d, `${n}.pdf`), `%PDF-1.4 ${n}`);
      shas.push(sha256File(join(d, `${n}.pdf`)));
    }
    const list = join(tmp(), "list.txt");
    writeFileSync(list, `# 根拠\n${shas[0]}\n${shas[1]!.toUpperCase()}  # 大文字も\nnot-a-sha\n${shas[2]}\n${"0".repeat(64)}\n`);
    const { shas: got, bad } = readShaList(list);
    expect(got.length).toBe(4);
    expect(bad).toBe(1);
    const r = resolveShas(got, [d], new Set([shas[2]!]));
    expect(r.files.length).toBe(2);
    expect(r).toMatchObject({ missing: 1, excluded: 1 });
  });

  it("前の回の記録から、反証を通った候補を作り直す（古い回は id・作る見本の案を補う）", () => {
    const summary = {
      candidates: [
        { pattern: "P2", title: "落とした候補", nearestRule: "p2-xmp", whyMissed: "w", evidenceCount: 5, keep: false },
        { pattern: "NEW", title: "墨消しの近くに残る機械で読む記号", nearestRule: "なし", whyMissed: "見ていない", evidenceCount: 19, keep: true },
      ],
    };
    const got = candidatesFromRun(summary, (n) => (n === 1 ? "## x\n- 作った合成 PDF：架空の明細と、塗った欄の下の棒の並び\n" : null));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: "c1", pattern: "NEW", evidenceCount: 19, evidenceIds: [], fixturePlan: "架空の明細と、塗った欄の下の棒の並び" });
    expect(validate(CANDIDATES, { candidates: got })).toEqual([]);
  });

  it("PR の本文と採点表に「根拠 N 件のうち M 件」を書く。ゆるい一覧のときはそう書く", () => {
    const base = {
      date: "2026-11-07 05:00", runId: "r", attempts: 1,
      candidate: { id: "c1", pattern: "NEW", title: "t", nearestRule: "なし", whyMissed: "w", evidenceCount: 3, fixturePlan: "f" },
      refute: { reason: "残す", explanation: "e" },
      write: { ruleId: "new-rule", summary: "s", discarded: "d" },
      gate: { pass: true, reasons: [], improved: [], declined: [], table: [] },
      counts: { read: 49, skipped: 0, suspicions: 4, candidates: 2, refuted: 1 }, calls: {}, costUsd: 1,
    };
    const strict = renderPrBody({ ...base, evidence: { total: 19, hit: 4, loose: false } });
    expect(strict).toContain("- 根拠の実物：根拠 19 件のうち 4 件で当たった");
    expect(strict).toContain("| 根拠の実物（新しいルール `new-rule`） | — | 19 件のうち 4 件で当たった | 新しい |");
    expect(renderPrBody({ ...base, evidence: { total: 53, hit: 1, loose: true } })).toContain("人が渡した 53 件の一覧で確かめた");
    expect(renderPrBody({ ...base, evidence: null })).toContain("- 根拠の実物：確かめていない");
    expect(renderPrBody(base)).not.toContain("根拠の実物");
  });

  it("判断の段には根拠の番号を、ルール書きの段には「根拠の実物で当たること」と画素で見ることを指示する", () => {
    expect(JUDGE_PROMPT).toContain("evidenceIds");
    const w = writePrompt();
    expect(w).toContain("根拠の実物で当たること");
    expect(w).toContain("evidenceShape");
    expect(w).toContain("画素を見るルール");
  });
});

describe("Claude API（Messages API）で呼ぶ", () => {
  const limits = { skim: 5, judge: 5, write: 5, runBudgetUsd: null };
  const usage = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const reply = (value: unknown, stopReason = "end_turn"): ApiSend => async () => ({ ok: true, text: JSON.stringify(value), stopReason, usage });
  const noCli: Runner = async () => {
    throw new Error("claude -p を呼んではいけない");
  };

  it("API に渡すスキーマは、構造化出力が受け付けない制約を外す（決めた欄・enum・additionalProperties は残す）", () => {
    const s = JSON.stringify(toApiSchema(CANDIDATES));
    expect(s).not.toMatch(/maxLength|maxItems|minimum|maximum/);
    expect(s).toContain('"additionalProperties":false');
    expect(s).toContain('"enum":["P1"');
    expect((toApiSchema(REFUTE) as { required: string[] }).required).toEqual(["keep", "reason", "explanation"]);
  });

  it("費用は使った量から数える（Haiku 5.5 は入力が 10 万トークンを超えると上の段）", () => {
    expect(costOf("claude-opus-5-5", usage)).toBeCloseTo(0.014, 10);
    expect(costOf("claude-haiku-5-5", usage)).toBeCloseTo(0.00035, 10);
    expect(costOf("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 1000 })).toBeCloseTo(0.1025, 10);
    expect(costOf("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(5.4, 10);
    expect(costOf("知らないモデル", usage)).toBeNull();
    expect(maxTokensFor("claude-opus-5-5", null)).toBe(32_000);
    expect(maxTokensFor("claude-opus-5-5", 0.1)).toBe(5000);
  });

  it("下読み・判断・反証は API、ルール書きは claude -p。役ごとの呼び方・モデル・回数・費用を残す", async () => {
    const sent: ApiRequest[] = [];
    const api: ApiSend = async (r) => (sent.push(r), { ok: true, text: JSON.stringify({ keep: true, reason: "残す", explanation: "x" }), stopReason: "end_turn", usage });
    let cli = 0;
    const runner: Runner = async () => (cli++, { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.5, structured_output: { ruleId: "r", changedFiles: [], summary: "s", discarded: "d", alreadyCovered: "" }, permission_denials: [] }), stderr: "" });
    const c = new Caller(limits, runner, { api });
    expect(c.via).toBe("api");
    const r = await c.call({ role: "refute", model: "claude-opus-5-5", prompt: "指示", data: { a: 1 }, schema: REFUTE, cwd: "." });
    expect(r.ok).toBe(true);
    expect(sent[0]!.model).toBe("claude-opus-5-5");
    expect(sent[0]!.text).toContain("<<<データ>>>");
    await c.call({ role: "write", model: "claude-opus-5-5", prompt: "書く", schema: WRITE_REPORT, cwd: ".", editTools: true });
    expect(cli).toBe(1);
    expect(sent).toHaveLength(1);
    expect(c.used).toEqual({ refute: { via: "api", model: "claude-opus-5-5" }, write: { via: "cli", model: "claude-opus-5-5" } });
    expect(c.calls.refute).toBe(1);
    expect(c.costUsd).toBeCloseTo(0.514, 10);
    expect(c.usage).toEqual({ input: 1000, output: 500, cacheWrite: 0, cacheRead: 0 });
  });

  it("--via cli なら、どの段も claude -p", () => {
    const c = new Caller(limits, noCli, { via: "cli", api: reply({}) });
    expect(c.viaFor({})).toBe("cli");
    expect(c.viaFor({ editTools: true })).toBe("cli");
  });

  it("形に合わない・JSON でない・断った・長さで切れた答えは捨てる", async () => {
    const run = async (api: ApiSend) => new Caller(limits, noCli, { api }).call({ role: "skim", model: "claude-haiku-5-5", prompt: "p", schema: SKIM, cwd: "." });
    const bad = await run(reply({ suspicions: [{ pattern: "P99", signal: "x", alreadyReported: false }] }));
    expect(!bad.ok && bad.error).toBe("形が合わない");
    const long = await run(reply({ suspicions: [{ pattern: "P1", signal: "あ".repeat(500), alreadyReported: false }] }));
    expect(!long.ok && long.error).toBe("形が合わない");
    const notJson = await run(async () => ({ ok: true, text: "はい", stopReason: "end_turn", usage }));
    expect(!notJson.ok && notJson.error).toBe("形が合わない");
    const refusal = await run(reply({ suspicions: [] }, "refusal"));
    expect(!refusal.ok && refusal.detail).toMatch(/refusal/);
    const cut = await run(reply({ suspicions: [] }, "max_tokens"));
    expect(!cut.ok && cut.detail).toMatch(/max_tokens/);
    const down = await run(async () => ({ ok: false, detail: "API 529 overloaded_error", usage: null }));
    expect(!down.ok && down.error).toBe("呼べなかった");
  });

  it("1 回のループの金額の上限に届いたら、それ以上は呼ばない", async () => {
    let n = 0;
    const api: ApiSend = async () => (n++, { ok: true, text: JSON.stringify({ suspicions: [] }), stopReason: "end_turn", usage });
    const c = new Caller({ ...limits, runBudgetUsd: 0.02 }, noCli, { api });
    for (let i = 0; i < 3; i++) await c.call({ role: "judge", model: "claude-opus-5-5", prompt: "p", schema: SKIM, cwd: "." });
    expect(n).toBe(2);
    expect(c.overBudget()).toBe(true);
  });

  it("キーは ANTHROPIC_API_KEY からだけ読み、無ければ名前だけを出して止める。エラーの文にキーを出さない", async () => {
    expect(() => readApiKey({})).toThrow(/環境変数がありません：ANTHROPIC_API_KEY/);
    expect(() => readApiKey({ ANTHROPIC_AUTH_TOKEN: "t" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(readApiKey({ ANTHROPIC_API_KEY: "sk-ant-kasou" })).toBe("sk-ant-kasou");
    await expect(realApiSend({})({ model: "m", text: "t", schema: SKIM, maxTokens: 10, timeoutMs: 10 })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    const e = new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key sk-ant-架空" } }, "invalid x-api-key sk-ant-架空", new Headers());
    expect(errorDetail(e)).toMatch(/^API 401/);
    expect(errorDetail(e)).not.toContain("sk-ant");
    expect(errorDetail(new Error("sk-ant-架空"))).not.toContain("sk-ant");
  });

  it("呼び方の既定は api。api と cli のほかは止める", () => {
    expect(viaFrom(undefined)).toBe("api");
    expect(viaFrom("cli")).toBe("cli");
    expect(() => viaFrom("web")).toThrow(/api か cli/);
  });

  it("PR の本文に、段ごとの呼び方とモデル、費用の数え方を書く", () => {
    expect(viaLine({ skim: { via: "api", model: "claude-haiku-5-5" }, write: { via: "cli", model: "claude-opus-5-5" } })).toBe("下読みは Claude API（Messages API）・claude-haiku-5-5、ルール書きは claude -p・claude-opus-5-5");
    expect(viaLine(undefined)).toBe("claude -p");
  });

  it("定時に回す設定は、手元の束だけ・dry-run・上限 5 ドル・api で、キーと束の場所を持たない", () => {
    const raw = readFileSync(join(process.cwd(), "ratchet", "schedule.json"), "utf8");
    const s = JSON.parse(raw);
    expect(s.via).toBe("api");
    expect(s.dryRun).toBe(true);
    expect(s.runBudgetUsd).toBe(5);
    expect(s.times).toEqual(["05:00", "20:00"]);
    expect(raw).not.toMatch(/sk-ant|ANTHROPIC_API_KEY=|[A-Za-z]:\\|https?:\/\//);
    expect(scheduleArgs(s)).toEqual(["--via", "api", "--run-budget", "5", "--bundle", String(s.bundle)]);
  });
});

describe("Claude API で呼べなかった理由を残す（2026-11-07 夜、手動の 1 回が下読みの最初で止まった件）", () => {
  const KEY = "sk-ant-api03-KASOU0123456789";
  const env = { ANTHROPIC_API_KEY: KEY };
  const req: ApiRequest = { model: "claude-haiku-5-5", text: "t", schema: SKIM, maxTokens: 100, timeoutMs: 5000 };
  const json = (status: number, type: string, message: string) => async () =>
    new Response(JSON.stringify({ type: "error", error: { type, message } }), { status, headers: { "content-type": "application/json", "request-id": "req_kasou" } });

  it("API の答えが 4xx なら、状態番号・エラーの型・API の説明・request-id を返す（キーは伏せる）", async () => {
    const r = await realApiSend(env, { fetch: json(401, "authentication_error", `invalid x-api-key ${KEY}`), maxRetries: 0 })(req);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toMatch(/^API 401 authentication_error 「invalid x-api-key 〈キーを伏せた〉」 request-id req_kasou$/);
    expect(r.detail).not.toContain(KEY);
    const b = await realApiSend(env, { fetch: json(400, "invalid_request_error", "Your credit balance is too low"), maxRetries: 0 })(req);
    expect(!b.ok && b.detail).toMatch(/API 400 invalid_request_error 「Your credit balance is too low」/);
  });

  it("送る前に落ちた・つながらないときは、原因の種類を返す", async () => {
    const r = await realApiSend(env, { fetch: async () => { throw new TypeError("fetch failed"); }, maxRetries: 0 })(req);
    expect(!r.ok && r.detail).toMatch(/^API につながらない（TypeError/);
  });

  it("うまくいかなかった呼び出しの理由を、呼び出しの記録（summary.json の callErrors）に残す", async () => {
    const c = new Caller({ skim: 2, judge: 1, write: 1, runBudgetUsd: null }, async () => ({ code: 0, stdout: "", stderr: "" }), { api: realApiSend(env, { fetch: json(404, "not_found_error", "model: claude-haiku-5-5"), maxRetries: 0 }) });
    const r = await c.call({ role: "skim", model: "claude-haiku-5-5", prompt: "p", schema: SKIM, cwd: "." });
    expect(!r.ok && r.error).toBe("呼べなかった");
    expect(c.errors).toEqual([{ role: "skim", via: "api", error: "呼べなかった", detail: "API 404 not_found_error 「model: claude-haiku-5-5」 request-id req_kasou" }]);
  });

  it("キーの前後の空白は落とし、見出しに入れられない字があれば呼ぶ前に何字目かだけを出して止める", () => {
    expect(readApiKey({ ANTHROPIC_API_KEY: ` ${KEY}\r\n` })).toBe(KEY);
    expect(() => readApiKey({ ANTHROPIC_API_KEY: `“${KEY}”` })).toThrow(/キーに使えない字があります（1 字目/);
    expect(() => readApiKey({ ANTHROPIC_API_KEY: "sk-ant-ａ" })).toThrow(/8 字目/);
    expect(() => readApiKey({ ANTHROPIC_API_KEY: "  " })).toThrow(/環境変数がありません/);
  });

  it("キーの様子は、値を出さずに長さと形だけを出す", () => {
    const s = keyShape({ ANTHROPIC_API_KEY: `${KEY}\n` });
    expect(s).toBe(`ANTHROPIC_API_KEY：${KEY.length} 字、sk-ant- で始まる：はい、前後の空白：あった（落とす）、使えない字：0 個`);
    expect(s).not.toContain("KASOU");
    expect(keyShape({})).toBe("ANTHROPIC_API_KEY：ない");
    expect(mask(`x ${KEY} y sk-ant-other`, [KEY])).toBe("x 〈キーを伏せた〉 y 〈キーを伏せた〉");
  });

  it("API の確かめ（npm run ratchet:api-check）は、モデルの情報を読むだけで、使えるか・なぜ使えないかを出す", async () => {
    const seen: string[] = [];
    const fetch = async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      if (u.endsWith("/claude-opus-5-5")) return new Response(JSON.stringify({ type: "model", id: "claude-opus-5-5", display_name: "x", created_at: "2026-01-01T00:00:00Z" }), { status: 200, headers: { "content-type": "application/json" } });
      return json(403, "permission_error", "not allowed")();
    };
    const lines = await apiCheck(["claude-haiku-5-5", "claude-opus-5-5", "claude-opus-5-5"], env, { fetch: fetch as typeof globalThis.fetch });
    expect(lines[0]).toMatch(/^ANTHROPIC_API_KEY：\d+ 字/);
    expect(lines.slice(1)).toEqual(["claude-haiku-5-5：API 403 permission_error 「not allowed」 request-id req_kasou", "claude-opus-5-5：使える（claude-opus-5-5）"]);
    expect(seen.every((u) => u.startsWith("https://api.anthropic.com/v1/models/"))).toBe(true);
    expect(await apiCheck(["m"], {})).toEqual(["ANTHROPIC_API_KEY：ない", "環境変数がありません：ANTHROPIC_API_KEY"]);
  });
});

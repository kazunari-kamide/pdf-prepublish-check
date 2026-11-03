// SPDX-License-Identifier: AGPL-3.0-only
//
// 採点：P5（旧版の残存）。npm run eval:p5 で動く（npm run eval は、ほかの型と一緒に回す。eval/all.ts）。
//
//   npm run eval:p5                          この検査器の検出ルール（rules/p5-revisions）を採点する
//   npm run eval:p5 -- --reports <フォルダ>   別の版の報告を採点する。<合成PDFの名前>.json を、検証器の出力と同じ形で置く
//   npm run eval:p5 -- --sanitized <フォルダ> 片付けたあとの PDF（<合成PDFの名前>.pdf）を検証器にかけ、残っている件数も数える
//   npm run eval:p5 -- --json <ファイル>      結果を JSON でも書き出す
//
// 決まり：合格基準と照らし合わせ方は rubric/p5.json（値はここに書かない）。正解は fixtures/p5/*.expected.json。
// 正解データに expected_error があるもの（開けないことが正しい入力）は、同じエラーを返せば「合っている」と数える（eval/expected-error.ts）。
// 検証器（verifier/）はコマンドとして呼ぶだけで、import しない。検出ルールの報告をそろえる変換は eval/adapters に置く。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectP5Revisions } from "../rules/p5-revisions/index.ts";
import { adaptP5Revisions, type P5Item, type P5VerifierShapedReport } from "./adapters/p5-revisions.ts";
import { checkExpectedError, describeExpectedErrors, type ExpectedErrorResult } from "./expected-error.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "fixtures", "p5");
const RUBRIC = path.join(ROOT, "rubric", "p5.json");
const VERIFIER_CLI = path.join(ROOT, "verifier", "p5-cli.mjs");
const VERIFIER_SELFCHECK = path.join(ROOT, "verifier", "p5-selfcheck.mjs");

type Rubric = {
  pass: { recall_min: number; false_positive_rate_max: number; residual_after_sanitize_max: number };
  breakdown: { where: string[]; kind: string[] };
  match: { same_file: boolean; same_object: boolean; same_kind: boolean; same_where: boolean; one_to_one: boolean };
};

type Leak = { id: string; pattern: "P5"; object: number; kind: string; where: string };
type Negative = { id: string; object: number; kind: string; where: string };
/** 正解データ。expected_error があるものは、開けないことが正しい入力（fixtures/p5/README.md） */
export type Expected = { file: string; description?: string; leaks: Leak[]; negatives: Negative[]; expected_error?: string };

type FileResult = {
  file: string;
  expected: Expected;
  status: string;
  matched: Array<{ leak: Leak; item: P5Item }>;
  missed: Leak[];
  falseOnNegative: Array<{ item: P5Item; negative: Negative }>;
  falseNowhere: P5Item[];
  duplicates: P5Item[];
  /** 漏れでないもののうち、報告の not_counted に同じ番号・種類・場所で出たもの（参考） */
  negativesInNotCounted: number;
};

/** 報告と正解を1対1に結ぶ（rubric/p5.md §4）。同じ番号・同じ種類・同じ場所。同じ組が2つあれば数を合わせる */
function matchFile(expected: Expected, report: P5VerifierShapedReport, rule: Rubric["match"]): FileResult {
  const r: FileResult = {
    file: expected.file,
    expected,
    status: report.status,
    matched: [],
    missed: [],
    falseOnNegative: [],
    falseNowhere: [],
    duplicates: [],
    negativesInNotCounted: 0,
  };
  const usedLeak = new Set<string>();
  const usedNeg = new Set<string>();
  const same = (l: { object: number; kind: string; where: string }, x: { object: number; kind: string; where: string }) =>
    (!rule.same_object || l.object === x.object) && (!rule.same_kind || l.kind === x.kind) && (!rule.same_where || l.where === x.where);
  for (const item of report.items) {
    const leak = expected.leaks.find((l) => !usedLeak.has(l.id) && same(l, item));
    if (leak) {
      usedLeak.add(leak.id);
      r.matched.push({ leak, item });
      continue;
    }
    if (expected.leaks.some((l) => same(l, item))) {
      r.duplicates.push(item); // 同じ組への余分な報告（誤検知に数えない。PR #14 の返事の 2 にならう）
      continue;
    }
    // 漏れでないものへの報告：同じ番号・同じ場所（種類は、報告では数える種類、正解では数えない種類なので比べない）
    const neg = expected.negatives.find((n) => !usedNeg.has(n.id) && n.object === item.object && n.where === item.where);
    if (neg) {
      usedNeg.add(neg.id);
      r.falseOnNegative.push({ item, negative: neg });
      continue;
    }
    r.falseNowhere.push(item);
  }
  r.missed = expected.leaks.filter((l) => !usedLeak.has(l.id));
  const nc = [...report.not_counted];
  for (const n of expected.negatives) {
    const i = nc.findIndex((x) => x.object === n.object && x.kind === n.kind && x.where === n.where);
    if (i >= 0) {
      nc.splice(i, 1);
      r.negativesInNotCounted++;
    }
  }
  return r;
}

export type P5FixtureScore =
  | { kind: "expected_error"; result: ExpectedErrorResult }
  | { kind: "match"; result: FileResult };

/** 合成 PDF 1つを採点する。expected_error があれば、エラーが同じかだけを見る（照らし合わせはしない） */
export function scoreP5Fixture(expected: Expected, report: P5VerifierShapedReport, rule: Rubric["match"]): P5FixtureScore {
  if (expected.expected_error !== undefined) {
    return { kind: "expected_error", result: checkExpectedError(expected.file, expected.expected_error, report) };
  }
  return { kind: "match", result: matchFile(expected, report, rule) };
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;
}

async function main() {
  const reportsDir = argValue("--reports");
  const sanitizedDir = argValue("--sanitized");
  const jsonOut = argValue("--json");
  const rubric = JSON.parse(readFileSync(RUBRIC, "utf8")) as Rubric;
  if (!rubric.match.same_file || !rubric.match.one_to_one) {
    throw new Error("rubric/p5.json の照らし合わせ方に、この eval は対応していません");
  }
  const started = Date.now();

  // 1. 検証器そのものの確かめ
  const self = spawnSync(process.execPath, [VERIFIER_SELFCHECK], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const selfOk = self.status === 0;
  const selfLast = (self.stdout || "").trim().split(/\r?\n/).slice(-1)[0] ?? "";

  // 2. 合成 PDF ごとに採点する
  const names = readdirSync(FIXTURES).filter((f) => f.endsWith(".expected.json")).sort();
  const results: FileResult[] = [];
  const expectedErrors: ExpectedErrorResult[] = [];
  const residual: Array<{ file: string; items: number | null; status: string }> = [];
  let chainFallback = 0;
  const subject = reportsDir ? `別の版の報告（${path.basename(reportsDir)}）` : "検出ルール rules/p5-revisions";

  for (const name of names) {
    const expected = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Expected;
    const base = expected.file.replace(/\.pdf$/, "");
    let report: P5VerifierShapedReport;
    if (reportsDir) {
      const p = path.join(reportsDir, `${base}.json`);
      report = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as P5VerifierShapedReport) : { status: "error", items: [], not_counted: [] };
    } else {
      const raw = await detectP5Revisions(new Uint8Array(readFileSync(path.join(FIXTURES, expected.file))));
      if (raw.chainFallback) chainFallback++;
      report = adaptP5Revisions(raw);
    }
    const score = scoreP5Fixture(expected, report, rubric.match);
    if (score.kind === "expected_error") {
      // 開けないことが正しい入力：片付けることもできないので、片付けたあとの確かめもしない
      expectedErrors.push(score.result);
      continue;
    }
    results.push(score.result);

    if (sanitizedDir) {
      const p = path.join(sanitizedDir, expected.file);
      if (!existsSync(p)) {
        residual.push({ file: expected.file, items: null, status: "片付けた PDF がない" });
      } else {
        const r = spawnSync(process.execPath, [VERIFIER_CLI, p], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        try {
          const out = JSON.parse(r.stdout) as { status: string; items: unknown[] };
          residual.push({ file: expected.file, items: out.items.length, status: out.status });
        } catch {
          residual.push({ file: expected.file, items: null, status: "検証器の出力を読めない" });
        }
      }
    }
  }

  // 3. 集計
  const allLeaks = results.flatMap((r) => r.expected.leaks);
  const leaks = allLeaks.length;
  const negatives = results.reduce((s, r) => s + r.expected.negatives.length, 0);
  const found = results.reduce((s, r) => s + r.matched.length, 0);
  const fpOnNegative = results.reduce((s, r) => s + r.falseOnNegative.length, 0);
  const fpNowhere = results.reduce((s, r) => s + r.falseNowhere.length, 0);
  const duplicates = results.reduce((s, r) => s + r.duplicates.length, 0);
  const fp = fpOnNegative + fpNowhere;
  const recall = leaks ? found / leaks : 0;
  const fpr = negatives ? fp / negatives : fp > 0 ? Infinity : 0;
  const errors = results.filter((r) => r.status !== "ok").map((r) => r.file);
  const negInNc = results.reduce((s, r) => s + r.negativesInNotCounted, 0);

  const matched = results.flatMap((r) => r.matched);
  const byWhere = rubric.breakdown.where.map((w) => ({
    type: w,
    total: allLeaks.filter((l) => l.where === w).length,
    found: matched.filter((m) => m.leak.where === w).length,
  }));
  const byKind = rubric.breakdown.kind.map((k) => ({
    type: k,
    total: allLeaks.filter((l) => l.kind === k).length,
    found: matched.filter((m) => m.leak.kind === k).length,
  }));
  const negKinds = [...new Set(results.flatMap((r) => r.expected.negatives.map((n) => n.kind)))].sort();
  const negBreakdown = negKinds.map((k) => ({
    kind: k,
    total: results.flatMap((r) => r.expected.negatives).filter((n) => n.kind === k).length,
    reported: results.flatMap((r) => r.falseOnNegative).filter((x) => x.negative.kind === k).length,
  }));

  const residualTotal = residual.reduce((s, r) => s + (r.items ?? 0), 0);
  const residualBad = residual.filter((r) => r.items === null || r.status !== "ok");
  const residualMeasured = sanitizedDir !== undefined;

  const passRecall = recall >= rubric.pass.recall_min;
  const passFpr = fpr <= rubric.pass.false_positive_rate_max;
  const passResidual = residualMeasured && residualBad.length === 0 && residualTotal <= rubric.pass.residual_after_sanitize_max;
  const passExpectedErrors = expectedErrors.every((r) => r.ok);
  const pass = passRecall && passFpr && passResidual && errors.length === 0 && passExpectedErrors;

  const lines: string[] = [];
  const say = (s = "") => lines.push(s);
  say(`採点：P5（旧版の残存）　対象：${subject}`);
  say(`検証器そのものの確かめ（verifier/p5-selfcheck.mjs）：${selfOk ? "合格" : "不合格"}　${selfLast}`);
  say(`合成 PDF：${results.length + expectedErrors.length} 個（うち開けないことが正しいもの ${expectedErrors.length} 個）　漏れ：${leaks} 件　漏れでないもの：${negatives} 件`);
  say();
  say(`検出率　　　　　：${found} / ${leaks} = ${pct(found, leaks)}　（基準 ${rubric.pass.recall_min * 100}% 以上）→ ${passRecall ? "満たす" : "満たさない"}`);
  say(`誤検知率　　　　：${fp} / ${negatives} = ${pct(fp, negatives)}　（基準 ${rubric.pass.false_positive_rate_max * 100}% 以下）→ ${passFpr ? "満たす" : "満たさない"}`);
  say(`　うち漏れでないものへの報告：${fpOnNegative} 件、正解のどれにも当たらない報告：${fpNowhere} 件`);
  say(`同じ組への余分な報告（1対1のため結べない）：${duplicates} 件（誤検知には数えない）`);
  say(
    residualMeasured
      ? `片付けたあとに残る情報：${residualTotal} 件（読めない PDF：${residualBad.length} 個）　（基準 ${rubric.pass.residual_after_sanitize_max} 件）→ ${passResidual ? "満たす" : "満たさない"}`
      : "片付けたあとに残る情報：未測定（片付けた PDF が渡されていない。--sanitized で測る）→ 満たさない",
  );
  for (const l of describeExpectedErrors(expectedErrors)) say(l);
  if (errors.length) say(`読めなかった合成 PDF：${errors.join("、")}`);
  say();
  say("場所ごとの内訳（見つけた / 漏れ）：");
  for (const b of byWhere) say(`  ${b.type.padEnd(13)} ${b.total} 件中 ${b.found} 件`);
  say("種類ごとの内訳（見つけた / 漏れ）：");
  for (const b of byKind) say(`  ${b.type.padEnd(13)} ${b.total} 件中 ${b.found} 件`);
  say("漏れでないものの種類ごとの誤検知（参考）：");
  for (const b of negBreakdown) say(`  ${b.kind.padEnd(13)} ${b.total} 件中 ${b.reported} 件に反応`);
  if (!reportsDir) {
    say(`（参考）漏れでないもののうち、検出ルールの not_counted に同じ番号・種類・場所で出たもの：${negatives} 件中 ${negInNc} 件`);
    say(`（参考）版の鎖をたどれず、ファイルの中の順で版を決めた PDF：${chainFallback} 個`);
  }
  say();
  say("見逃した漏れ：");
  const missed = results.flatMap((r) => r.missed);
  if (missed.length === 0) say("  なし");
  for (const m of missed) say(`  ${m.id}（オブジェクト ${m.object}、${m.kind}・${m.where}）`);
  say();
  say("誤検知：");
  if (fp === 0) say("  なし");
  for (const r of results) {
    for (const x of r.falseOnNegative) say(`  ${r.file}：漏れでないもの ${x.negative.id}（${x.negative.kind}・${x.negative.where}）に、${x.item.kind} として反応した`);
    for (const x of r.falseNowhere) say(`  ${r.file}：正解のどれにも当たらない報告（オブジェクト ${x.object}、${x.kind}・${x.where}）`);
  }
  say();
  say(`判定：${pass ? "合格" : "不合格"}　（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
  console.log(lines.join("\n"));

  if (jsonOut) {
    const out = {
      subject,
      verifier_selfcheck: selfOk,
      fixtures: results.length + expectedErrors.length,
      leaks,
      negatives,
      found,
      false_positives: { on_negative: fpOnNegative, nowhere: fpNowhere, duplicates_not_counted: duplicates },
      recall,
      false_positive_rate: fpr,
      residual: residualMeasured ? { total: residualTotal, bad_files: residualBad.map((r) => r.file) } : null,
      breakdown: { where: byWhere, kind: byKind },
      negatives_breakdown: negBreakdown,
      negatives_in_not_counted: negInNc,
      expected_errors: { total: expectedErrors.length, matched: expectedErrors.filter((r) => r.ok).length, mismatched: expectedErrors.filter((r) => !r.ok).map((r) => r.file) },
      missed: missed.map((m) => m.id),
      pass,
    };
    writeFileSync(jsonOut, JSON.stringify(out, null, 2) + "\n");
  }
  process.exitCode = pass ? 0 : 1;
}

if (import.meta.main) await main();

// SPDX-License-Identifier: AGPL-3.0-only
//
// 採点：P1（文書情報）。npm run eval:p1 で動く。
//
//   npm run eval:p1                          この検査器の検出ルール（rules/p1-info）を採点する
//   npm run eval:p1 -- --reports <フォルダ>   別の版の報告を採点する。<合成PDFの名前>.json を、検証器の出力と同じ形で置く
//   npm run eval:p1 -- --sanitized <フォルダ> 片付けたあとの PDF（<合成PDFの名前>.pdf）を検証器にかけ、残っている件数も数える
//   npm run eval:p1 -- --json <ファイル>      結果を JSON でも書き出す
//
// 決まり：合格基準と照らし合わせ方は rubric/p1.json（値はここに書かない）。正解は fixtures/p1/*.expected.json。
// 検証器（verifier/）はコマンドとして呼ぶだけで、import しない。検出ルールの報告をそろえる変換は eval/adapters に置く。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectP1Info } from "../rules/p1-info/index.ts";
import { adaptP1Info, type P1VerifierShapedReport } from "./adapters/p1-info.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "fixtures", "p1");
const RUBRIC = path.join(ROOT, "rubric", "p1.json");
const VERIFIER_CLI = path.join(ROOT, "verifier", "p1-cli.mjs");
const VERIFIER_SELFCHECK = path.join(ROOT, "verifier", "p1-selfcheck.mjs");

type Rubric = {
  pass: { recall_min: number; false_positive_rate_max: number; residual_after_sanitize_max: number };
  breakdown: { standard: string[]; custom: string };
  match: { same_file: boolean; same_key: boolean; one_to_one: boolean };
};

type Leak = { id: string; pattern: "P1"; key: string; where: string };
type Negative = { id: string; kind: string; key: string };
type Expected = { file: string; description?: string; leaks: Leak[]; negatives: Negative[]; previous_info?: boolean };

type Item = P1VerifierShapedReport["items"][number];
type FileResult = {
  file: string;
  expected: Expected;
  status: string;
  matched: Array<{ leak: Leak; item: Item }>;
  missed: Leak[];
  falseOnNegative: Array<{ item: Item; negative: Negative }>;
  falseNowhere: Item[];
  duplicates: Item[];
  previousInfo: number;
};

/** 鍵の #xx を解く（rubric/p1.md §3 の2）。正解データ・報告のどちらに #xx が残っていても同じに比べる */
export function normalizeKey(key: string): string {
  if (!/#[0-9A-Fa-f]{2}/.test(key)) return key;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < key.length; i++) {
    const m = /^#([0-9A-Fa-f]{2})/.exec(key.slice(i));
    if (m) {
      bytes.push(parseInt(m[1]!, 16));
      i += 2;
    } else {
      for (const b of enc.encode(key[i]!)) bytes.push(b);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** 報告と正解を1対1に結ぶ（rubric/p1.md §3）。同じファイルの中で、同じ鍵どうしを結ぶ */
function matchFile(expected: Expected, report: P1VerifierShapedReport): FileResult {
  const r: FileResult = {
    file: expected.file,
    expected,
    status: report.status,
    matched: [],
    missed: [],
    falseOnNegative: [],
    falseNowhere: [],
    duplicates: [],
    previousInfo: report.previous_info ?? 0,
  };
  const leaks = expected.leaks.filter((l) => l.where === "current");
  const usedLeak = new Set<string>();
  const usedNeg = new Set<string>();
  for (const item of report.items) {
    const key = normalizeKey(item.key);
    const leak = leaks.find((l) => normalizeKey(l.key) === key && !usedLeak.has(l.id));
    if (leak) {
      usedLeak.add(leak.id);
      r.matched.push({ leak, item });
      continue;
    }
    if (leaks.some((l) => normalizeKey(l.key) === key)) {
      r.duplicates.push(item); // 同じ欄への2つ目の報告（1対1のため結べない）
      continue;
    }
    const neg = expected.negatives.find((n) => normalizeKey(n.key) === key && !usedNeg.has(n.id));
    if (neg) {
      usedNeg.add(neg.id);
      r.falseOnNegative.push({ item, negative: neg });
      continue;
    }
    r.falseNowhere.push(item);
  }
  r.missed = leaks.filter((l) => !usedLeak.has(l.id));
  return r;
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
  if (!rubric.match.same_file || !rubric.match.same_key || !rubric.match.one_to_one) {
    throw new Error("rubric/p1.json の照らし合わせ方に、この eval は対応していません");
  }
  const standard = new Set(rubric.breakdown.standard);
  const started = Date.now();

  // 1. 検証器そのものの確かめ
  const self = spawnSync(process.execPath, [VERIFIER_SELFCHECK], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const selfOk = self.status === 0;
  const selfLast = (self.stdout || "").trim().split(/\r?\n/).slice(-1)[0] ?? "";

  // 2. 合成 PDF ごとに採点する
  const names = readdirSync(FIXTURES).filter((f) => f.endsWith(".expected.json")).sort();
  const results: FileResult[] = [];
  const residual: Array<{ file: string; items: number | null; status: string }> = [];
  const subject = reportsDir ? `別の版の報告（${path.basename(reportsDir)}）` : "検出ルール rules/p1-info";

  for (const name of names) {
    const expected = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Expected;
    const base = expected.file.replace(/\.pdf$/, "");
    let report: P1VerifierShapedReport;
    if (reportsDir) {
      const p = path.join(reportsDir, `${base}.json`);
      report = existsSync(p)
        ? (JSON.parse(readFileSync(p, "utf8")) as P1VerifierShapedReport)
        : { status: "error", items: [], not_counted: [], previous_info: 0 };
    } else {
      const bytes = new Uint8Array(readFileSync(path.join(FIXTURES, expected.file)));
      report = adaptP1Info(await detectP1Info(bytes));
    }
    results.push(matchFile(expected, report));

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

  // 3. 集計（前の版の文書情報は分母に入れない。rubric/p1.md §2）
  const allLeaks = results.flatMap((r) => r.expected.leaks.filter((l) => l.where === "current"));
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

  const groupOf = (key: string) => (standard.has(normalizeKey(key)) ? "standard" : "custom");
  const breakdown = (["standard", "custom"] as const).map((g) => ({
    type: g,
    total: allLeaks.filter((l) => groupOf(l.key) === g).length,
    found: results.flatMap((r) => r.matched).filter((m) => groupOf(m.leak.key) === g).length,
  }));
  // 漏れでない欄の種類ごとの、誤検知の件数（参考）
  const negKinds = [...new Set(results.flatMap((r) => r.expected.negatives.map((n) => n.kind)))].sort();
  const negBreakdown = negKinds.map((k) => ({
    kind: k,
    total: results.flatMap((r) => r.expected.negatives).filter((n) => n.kind === k).length,
    reported: results.flatMap((r) => r.falseOnNegative).filter((x) => x.negative.kind === k).length,
  }));
  // 前の版の文書情報（P5 の範囲。合否には使わない）
  const prevExpected = results.filter((r) => r.expected.previous_info === true).length;
  const prevAgree = results.filter((r) => (r.expected.previous_info === true) === r.previousInfo > 0).length;
  const prevKeys = results.reduce((s, r) => s + r.previousInfo, 0);

  const residualTotal = residual.reduce((s, r) => s + (r.items ?? 0), 0);
  const residualBad = residual.filter((r) => r.items === null || r.status !== "ok");
  const residualMeasured = sanitizedDir !== undefined;

  const passRecall = recall >= rubric.pass.recall_min;
  const passFpr = fpr <= rubric.pass.false_positive_rate_max;
  const passResidual = residualMeasured && residualBad.length === 0 && residualTotal <= rubric.pass.residual_after_sanitize_max;
  const pass = passRecall && passFpr && passResidual && errors.length === 0;

  const lines: string[] = [];
  const say = (s = "") => lines.push(s);
  say(`採点：P1（文書情報）　対象：${subject}`);
  say(`検証器そのものの確かめ（verifier/p1-selfcheck.mjs）：${selfOk ? "合格" : "不合格"}　${selfLast}`);
  say(`合成 PDF：${results.length} 個　漏れ：${leaks} 件　漏れでない欄：${negatives} 件`);
  say();
  say(`検出率　　　　　：${found} / ${leaks} = ${pct(found, leaks)}　（基準 ${rubric.pass.recall_min * 100}% 以上）→ ${passRecall ? "満たす" : "満たさない"}`);
  say(`誤検知率　　　　：${fp} / ${negatives} = ${pct(fp, negatives)}　（基準 ${rubric.pass.false_positive_rate_max * 100}% 以下）→ ${passFpr ? "満たす" : "満たさない"}`);
  say(`　うち漏れでない欄への報告：${fpOnNegative} 件、正解のどれにも当たらない欄への報告：${fpNowhere} 件`);
  say(`同じ欄への2つ目の報告（1対1のため結べない）：${duplicates} 件（誤検知には数えない）`);
  say(
    residualMeasured
      ? `片付けたあとに残る情報：${residualTotal} 件（読めない PDF：${residualBad.length} 個）　（基準 ${rubric.pass.residual_after_sanitize_max} 件）→ ${passResidual ? "満たす" : "満たさない"}`
      : "片付けたあとに残る情報：未測定（片付けた PDF が渡されていない。--sanitized で測る）→ 満たさない",
  );
  if (errors.length) say(`読めなかった合成 PDF：${errors.join("、")}`);
  say();
  say("欄の種類ごとの内訳（見つけた / 漏れ）：");
  for (const b of breakdown) say(`  ${b.type.padEnd(9)} ${b.total} 件中 ${b.found} 件`);
  say("漏れでない欄の種類ごとの誤検知（参考）：");
  for (const b of negBreakdown) say(`  ${b.kind.padEnd(9)} ${b.total} 件中 ${b.reported} 件に反応`);
  say(
    `（参考）前の版の文書情報：正解で「ある」とした PDF ${prevExpected} 個。報告の有無が正解と合った PDF ${results.length} 個中 ${prevAgree} 個。報告した欄の数の合計 ${prevKeys}（合否には使わない）`,
  );
  say();
  say("見逃した漏れ：");
  const missed = results.flatMap((r) => r.missed);
  if (missed.length === 0) say("  なし");
  for (const m of missed) say(`  ${m.id}（${m.key}）`);
  say();
  say("誤検知：");
  if (fp === 0) say("  なし");
  for (const r of results) {
    for (const x of r.falseOnNegative) say(`  ${r.file}：漏れでない欄 ${x.negative.id}（${x.negative.kind}、${x.negative.key}）に反応した`);
    for (const x of r.falseNowhere) say(`  ${r.file}：正解のどれにも当たらない欄（${x.key}）`);
  }
  say();
  say(`判定：${pass ? "合格" : "不合格"}　（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
  console.log(lines.join("\n"));

  if (jsonOut) {
    const out = {
      subject,
      verifier_selfcheck: selfOk,
      fixtures: results.length,
      leaks,
      negatives,
      found,
      false_positives: { on_negative: fpOnNegative, nowhere: fpNowhere, duplicates_not_counted: duplicates },
      recall,
      false_positive_rate: fpr,
      residual: residualMeasured ? { total: residualTotal, bad_files: residualBad.map((r) => r.file) } : null,
      breakdown,
      negatives_breakdown: negBreakdown,
      previous_info: { expected_files: prevExpected, agree_files: prevAgree, reported_keys: prevKeys },
      missed: missed.map((m) => m.id),
      pass,
    };
    writeFileSync(jsonOut, JSON.stringify(out, null, 2) + "\n");
  }
  process.exitCode = pass ? 0 : 1;
}

if (import.meta.main) await main();

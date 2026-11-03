// SPDX-License-Identifier: AGPL-3.0-only
//
// 採点：P7（隠れたテキスト）。npm run eval:p7 で動く（npm run eval は、ほかの型と一緒に回す。eval/all.ts）。
//
//   npm run eval:p7                          この検査器の検出ルール（rules/p7-hidden）を採点する
//   npm run eval:p7 -- --reports <フォルダ>   別の版の報告を採点する。<合成PDFの名前>.json を、検証器の出力と同じ形で置く
//   npm run eval:p7 -- --sanitized <フォルダ> 片付けたあとの PDF（<合成PDFの名前>.pdf）を検証器にかけ、残っている件数も数える
//   npm run eval:p7 -- --json <ファイル>      結果を JSON でも書き出す
//
// 決まり：合格基準と照らし合わせ方は rubric/p7.json（値はここに書かない）。正解は fixtures/p7/*.expected.json。
// 検証器（verifier/）はコマンドとして呼ぶだけで、import しない。検出ルールの報告をそろえる変換は eval/adapters に置く。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectP7Hidden } from "../rules/p7-hidden/index.ts";
import { adaptP7Hidden, type P7Item, type P7VerifierShapedReport } from "./adapters/p7-hidden.ts";
import { overlap, type Rect } from "./match.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "fixtures", "p7");
const RUBRIC = path.join(ROOT, "rubric", "p7.json");
const VERIFIER_CLI = path.join(ROOT, "verifier", "p7-cli.mjs");
const VERIFIER_SELFCHECK = path.join(ROOT, "verifier", "p7-selfcheck.mjs");

type Rubric = {
  pass: { recall_min: number; false_positive_rate_max: number; residual_after_sanitize_max: number };
  breakdown: string[];
  match: { same_page: boolean; same_reason: boolean; overlap: string; min_overlap: number; one_to_one: boolean };
};

type Leak = { id: string; pattern: "P7"; reason: string; page: number; rect: Rect; chars?: number };
type Negative = { id: string; kind: string; page: number; rect: Rect };
type Expected = { file: string; description?: string; pages?: number; leaks: Leak[]; negatives: Negative[] };

type FileResult = {
  file: string;
  expected: Expected;
  status: string;
  matched: Array<{ leak: Leak; item: P7Item; overlap: number }>;
  missed: Leak[];
  falseOnNegative: Array<{ item: P7Item; negative: Negative }>;
  falseNowhere: P7Item[];
  duplicates: P7Item[];
  skippedPages: number;
};

/** 報告と正解を1対1に結ぶ（rubric/p7.md §3）。1つの正解には、重なりがいちばん大きい報告を1つだけ結ぶ */
function matchFile(expected: Expected, report: P7VerifierShapedReport, rule: Rubric["match"]): FileResult {
  const r: FileResult = {
    file: expected.file,
    expected,
    status: report.status,
    matched: [],
    missed: [],
    falseOnNegative: [],
    falseNowhere: [],
    duplicates: [],
    skippedPages: report.skipped_pages.length,
  };
  // 正解ごとに、条件を満たす報告のうち重なりの大きい順に結ぶ
  const pairs: Array<{ li: number; ii: number; ov: number }> = [];
  expected.leaks.forEach((l, li) =>
    report.items.forEach((it, ii) => {
      if (rule.same_page && it.page !== l.page) return;
      if (rule.same_reason && it.reason !== l.reason) return;
      const ov = overlap(l.rect, it.rect);
      if (ov >= rule.min_overlap) pairs.push({ li, ii, ov });
    }),
  );
  pairs.sort((a, b) => b.ov - a.ov);
  const usedL = new Set<number>();
  const usedI = new Set<number>();
  for (const p of pairs) {
    if (usedL.has(p.li) || usedI.has(p.ii)) continue;
    usedL.add(p.li);
    usedI.add(p.ii);
    r.matched.push({ leak: expected.leaks[p.li]!, item: report.items[p.ii]!, overlap: p.ov });
  }
  report.items.forEach((it, ii) => {
    if (usedI.has(ii)) return;
    // 結べなかったが、漏れに重なる報告（1対1のため）：誤検知に数えない（P6 と同じ。PR #14 の返事の 2）
    if (pairs.some((p) => p.ii === ii)) {
      r.duplicates.push(it);
      return;
    }
    const neg = expected.negatives.find((n) => (!rule.same_page || n.page === it.page) && overlap(n.rect, it.rect) >= rule.min_overlap);
    if (neg) r.falseOnNegative.push({ item: it, negative: neg });
    else r.falseNowhere.push(it);
  });
  r.missed = expected.leaks.filter((_, i) => !usedL.has(i));
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
  if (rubric.match.overlap !== "intersection_over_smaller" || !rubric.match.one_to_one) {
    throw new Error(`rubric/p7.json の照らし合わせ方（${rubric.match.overlap}）に、この eval は対応していません`);
  }
  const started = Date.now();

  // 1. 検証器そのものの確かめ
  const self = spawnSync(process.execPath, [VERIFIER_SELFCHECK], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const selfOk = self.status === 0;
  const selfLast = (self.stdout || "").trim().split(/\r?\n/).slice(-1)[0] ?? "";

  // 2. 合成 PDF ごとに採点する
  const names = readdirSync(FIXTURES).filter((f) => f.endsWith(".expected.json")).sort();
  const results: FileResult[] = [];
  const residual: Array<{ file: string; items: number | null; status: string; skipped: number }> = [];
  const excluded = { p6: 0, ocr_layer: 0 };
  const subject = reportsDir ? `別の版の報告（${path.basename(reportsDir)}）` : "検出ルール rules/p7-hidden";

  for (const name of names) {
    const expected = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Expected;
    const base = expected.file.replace(/\.pdf$/, "");
    let report: P7VerifierShapedReport;
    if (reportsDir) {
      const p = path.join(reportsDir, `${base}.json`);
      report = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as P7VerifierShapedReport) : { status: "error", items: [], skipped_pages: [] };
    } else {
      const raw = await detectP7Hidden(new Uint8Array(readFileSync(path.join(FIXTURES, expected.file))));
      excluded.p6 += raw.excluded.p6;
      excluded.ocr_layer += raw.excluded.ocrLayer;
      report = adaptP7Hidden(raw);
    }
    results.push(matchFile(expected, report, rubric.match));

    if (sanitizedDir) {
      const p = path.join(sanitizedDir, expected.file);
      if (!existsSync(p)) {
        residual.push({ file: expected.file, items: null, status: "片付けた PDF がない", skipped: 0 });
      } else {
        const r = spawnSync(process.execPath, [VERIFIER_CLI, p], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        try {
          const out = JSON.parse(r.stdout) as { status: string; items: unknown[]; skipped_pages: unknown[] };
          residual.push({ file: expected.file, items: out.items.length, status: out.status, skipped: out.skipped_pages.length });
        } catch {
          residual.push({ file: expected.file, items: null, status: "検証器の出力を読めない", skipped: 0 });
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
  const skipped = results.reduce((s, r) => s + r.skippedPages, 0);

  const matched = results.flatMap((r) => r.matched);
  const breakdown = rubric.breakdown.map((reason) => ({
    type: reason,
    total: allLeaks.filter((l) => l.reason === reason).length,
    found: matched.filter((m) => m.leak.reason === reason).length,
  }));
  const negKinds = [...new Set(results.flatMap((r) => r.expected.negatives.map((n) => n.kind)))].sort();
  const negBreakdown = negKinds.map((k) => ({
    kind: k,
    total: results.flatMap((r) => r.expected.negatives).filter((n) => n.kind === k).length,
    reported: results.flatMap((r) => r.falseOnNegative).filter((x) => x.negative.kind === k).length,
  }));
  const charDiffs = matched
    .filter((m) => m.leak.chars !== undefined && m.leak.chars !== m.item.chars)
    .map((m) => `${m.leak.id}：正解 ${m.leak.chars} 字、報告 ${m.item.chars} 字`);

  const residualTotal = residual.reduce((s, r) => s + (r.items ?? 0), 0);
  const residualBad = residual.filter((r) => r.items === null || r.status !== "ok" || r.skipped > 0);
  const residualMeasured = sanitizedDir !== undefined;

  const passRecall = recall >= rubric.pass.recall_min;
  const passFpr = fpr <= rubric.pass.false_positive_rate_max;
  const passResidual = residualMeasured && residualBad.length === 0 && residualTotal <= rubric.pass.residual_after_sanitize_max;
  const pass = passRecall && passFpr && passResidual && errors.length === 0;

  const lines: string[] = [];
  const say = (s = "") => lines.push(s);
  say(`採点：P7（隠れたテキスト）　対象：${subject}`);
  say(`検証器そのものの確かめ（verifier/p7-selfcheck.mjs）：${selfOk ? "合格" : "不合格"}　${selfLast}`);
  say(`合成 PDF：${results.length} 個　漏れ：${leaks} 件　漏れでないもの：${negatives} 件`);
  say();
  say(`検出率　　　　　：${found} / ${leaks} = ${pct(found, leaks)}　（基準 ${rubric.pass.recall_min * 100}% 以上）→ ${passRecall ? "満たす" : "満たさない"}`);
  say(`誤検知率　　　　：${fp} / ${negatives} = ${pct(fp, negatives)}　（基準 ${rubric.pass.false_positive_rate_max * 100}% 以下）→ ${passFpr ? "満たす" : "満たさない"}`);
  say(`　うち漏れでないものに重なった報告：${fpOnNegative} 件、正解のどれにも重ならなかった報告：${fpNowhere} 件`);
  say(`結べなかった報告（漏れに重なったが、その漏れには、もっと重なる報告が結ばれていた）：${duplicates} 件（誤検知には数えない）`);
  say(
    residualMeasured
      ? `片付けたあとに残る情報：${residualTotal} 件（読めない・省いたページあり：${residualBad.length} 個）　（基準 ${rubric.pass.residual_after_sanitize_max} 件）→ ${passResidual ? "満たす" : "満たさない"}`
      : "片付けたあとに残る情報：未測定（片付けた PDF が渡されていない。--sanitized で測る）→ 満たさない",
  );
  if (errors.length) say(`読めなかった合成 PDF：${errors.join("、")}`);
  if (skipped) say(`省いたページ：${skipped} ページ`);
  say();
  say("理由ごとの内訳（見つけた / 漏れ）：");
  for (const b of breakdown) say(`  ${b.type.padEnd(13)} ${b.total} 件中 ${b.found} 件`);
  say("漏れでないものの種類ごとの誤検知（参考）：");
  for (const b of negBreakdown) say(`  ${b.kind.padEnd(22)} ${b.total} 件中 ${b.reported} 件に反応`);
  if (!reportsDir) say(`（参考）P7 では数えなかった見えない字：濃い覆いの下（P6）${excluded.p6} 字、文字認識の層 ${excluded.ocr_layer} 字`);
  say();
  say("見逃した漏れ：");
  const missed = results.flatMap((r) => r.missed);
  if (missed.length === 0) say("  なし");
  for (const m of missed) say(`  ${m.id}（${m.reason}、${m.page} ページ）`);
  say();
  say("誤検知：");
  if (fp === 0) say("  なし");
  for (const r of results) {
    for (const x of r.falseOnNegative) say(`  ${r.file} ${x.item.page} ページ：漏れでないもの ${x.negative.id}（${x.negative.kind}）に、${x.item.reason} として重なった`);
    for (const x of r.falseNowhere) say(`  ${r.file} ${x.page} ページ [${x.rect.map((v) => v.toFixed(0)).join(", ")}]：${x.reason}、正解のどれにも重ならない`);
  }
  if (charDiffs.length) {
    say();
    say("（参考）字数の食い違い（合否には使わない）：");
    for (const d of charDiffs) say(`  ${d}`);
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
      excluded: reportsDir ? null : excluded,
      char_diffs: charDiffs.length,
      missed: missed.map((m) => m.id),
      pass,
    };
    writeFileSync(jsonOut, JSON.stringify(out, null, 2) + "\n");
  }
  process.exitCode = pass ? 0 : 1;
}

if (import.meta.main) await main();

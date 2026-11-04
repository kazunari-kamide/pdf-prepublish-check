// SPDX-License-Identifier: AGPL-3.0-only
//
// 採点：見える文字の個人情報（rules/pii）。npm run eval:pii で動く（npm run eval は、ほかの型と一緒に回す。eval/all.ts）。
//
//   npm run eval:pii                       検出ルール rules/pii を、合成 PDF で採点する
//   npm run eval:pii -- --json <ファイル>   結果を JSON でも書き出す
//
// 合成 PDF と正解データ：fixtures/pii/（人が移す前は、案の proposals/pii/fixtures/pii/ を読む）。
// 合格基準：rubric/pii.json があれば、その pass と match を使う。まだないので、いまは CLAUDE.md §4 の値
//   （検出率 95% 以上、誤検知率 5% 以下。照らし合わせは同じページ・同じ型・重なり 0.5 以上・1対1）を【仮】として使う。
// この型は「片付け」をしない（黒塗りにするかは利用者が決める）ので、片付けたあとに残る情報は測らない。
// 確からしさ（高・確認）は合否に使わず、正解データの確からしさとの一致の数だけを出す。

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PII_TYPES, detectPii, type PiiFinding } from "../rules/pii/index.ts";
import { overlap, type Rect } from "./match.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES_FINAL = path.join(ROOT, "fixtures", "pii");
const FIXTURES_PROPOSAL = path.join(ROOT, "proposals", "pii", "fixtures", "pii");
const RUBRIC = path.join(ROOT, "rubric", "pii.json");

type Rubric = {
  pass: { recall_min: number; false_positive_rate_max: number };
  match: { same_page: boolean; same_type: boolean; min_overlap: number; one_to_one: boolean };
};
/** rubric/pii.json がないときの【仮】の基準（CLAUDE.md §4） */
const PROVISIONAL: Rubric = {
  pass: { recall_min: 0.95, false_positive_rate_max: 0.05 },
  match: { same_page: true, same_type: true, min_overlap: 0.5, one_to_one: true },
};

type Leak = { id: string; type: string; page: number; rect: Rect; confidence?: "high" | "check"; chars?: number };
type Negative = { id: string; kind: string; page: number; rect: Rect };
type Expected = { file: string; description?: string; pages?: number; leaks: Leak[]; negatives: Negative[] };

type FileResult = {
  file: string;
  expected: Expected;
  status: string;
  matched: Array<{ leak: Leak; item: PiiFinding; overlap: number }>;
  missed: Leak[];
  falseOnNegative: Array<{ item: PiiFinding; negative: Negative }>;
  falseNowhere: PiiFinding[];
  duplicates: PiiFinding[];
  skippedPages: number;
};

function matchFile(expected: Expected, status: string, items: PiiFinding[], skipped: number, rule: Rubric["match"]): FileResult {
  const r: FileResult = { file: expected.file, expected, status, matched: [], missed: [], falseOnNegative: [], falseNowhere: [], duplicates: [], skippedPages: skipped };
  const pairs: Array<{ li: number; ii: number; ov: number }> = [];
  expected.leaks.forEach((l, li) =>
    items.forEach((it, ii) => {
      if (rule.same_page && it.page !== l.page) return;
      if (rule.same_type && it.type !== l.type) return;
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
    r.matched.push({ leak: expected.leaks[p.li]!, item: items[p.ii]!, overlap: p.ov });
  }
  items.forEach((it, ii) => {
    if (usedI.has(ii)) return;
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
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);

async function main() {
  const jsonOut = argValue("--json");
  const fixturesDir = existsSync(FIXTURES_FINAL) ? FIXTURES_FINAL : FIXTURES_PROPOSAL;
  const rubricFound = existsSync(RUBRIC);
  const rubric = rubricFound ? (JSON.parse(readFileSync(RUBRIC, "utf8")) as Rubric) : PROVISIONAL;
  const started = Date.now();

  const names = readdirSync(fixturesDir).filter((f) => f.endsWith(".expected.json")).sort();
  const results: FileResult[] = [];
  const excludedTotal: Record<string, number> = {};
  for (const name of names) {
    const expected = JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as Expected;
    const report = await detectPii(new Uint8Array(readFileSync(path.join(fixturesDir, expected.file))));
    for (const [k, v] of Object.entries(report.excluded)) excludedTotal[k] = (excludedTotal[k] ?? 0) + v;
    results.push(matchFile(expected, report.status, report.findings, report.skippedPages.length, rubric.match));
  }

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
  const breakdown = PII_TYPES.map((t) => ({ type: t, total: allLeaks.filter((l) => l.type === t).length, found: matched.filter((m) => m.leak.type === t).length }));
  const negKinds = [...new Set(results.flatMap((r) => r.expected.negatives.map((n) => n.kind)))].sort();
  const negBreakdown = negKinds.map((k) => ({
    kind: k,
    total: results.flatMap((r) => r.expected.negatives).filter((n) => n.kind === k).length,
    reported: results.flatMap((r) => r.falseOnNegative).filter((x) => x.negative.kind === k).length,
  }));
  const withConf = matched.filter((m) => m.leak.confidence);
  const confAgree = withConf.filter((m) => m.leak.confidence === m.item.confidence).length;
  const confDiffs = withConf.filter((m) => m.leak.confidence !== m.item.confidence).map((m) => `${m.leak.id}：正解 ${m.leak.confidence}、報告 ${m.item.confidence}`);

  const passRecall = recall >= rubric.pass.recall_min;
  const passFpr = fpr <= rubric.pass.false_positive_rate_max;
  const pass = passRecall && passFpr && errors.length === 0;

  const lines: string[] = [];
  const say = (s = "") => lines.push(s);
  say("採点：見える文字の個人情報（rules/pii）");
  say(`合成 PDF：${path.relative(ROOT, fixturesDir).replace(/\\/g, "/")}/ の ${results.length} 個　漏れ：${leaks} 件　漏れでないもの：${negatives} 件`);
  say(rubricFound ? "合格基準：rubric/pii.json" : "合格基準：rubric/pii.json がまだないため、CLAUDE.md §4 の値を【仮】に使う");
  say();
  say(`検出率　：${found} / ${leaks} = ${pct(found, leaks)}　（基準 ${rubric.pass.recall_min * 100}% 以上）→ ${passRecall ? "満たす" : "満たさない"}`);
  say(`誤検知率：${fp} / ${negatives} = ${pct(fp, negatives)}　（基準 ${rubric.pass.false_positive_rate_max * 100}% 以下）→ ${passFpr ? "満たす" : "満たさない"}`);
  say(`　うち漏れでないものに重なった報告：${fpOnNegative} 件、正解のどれにも重ならなかった報告：${fpNowhere} 件`);
  say(`結べなかった報告（漏れに重なったが、その漏れには、もっと重なる報告が結ばれていた）：${duplicates} 件（誤検知には数えない）`);
  say("片付けたあとに残る情報：この型は片付けをしない（黒塗りにするかは利用者が決める）ので測らない");
  if (errors.length) say(`読めなかった合成 PDF：${errors.join("、")}`);
  if (skipped) say(`省いたページ：${skipped} ページ`);
  say();
  say("型ごとの内訳（見つけた / 漏れ）：");
  for (const b of breakdown) say(`  ${b.type.padEnd(13)} ${b.total} 件中 ${b.found} 件`);
  say("漏れでないものの種類ごとの誤検知（参考）：");
  for (const b of negBreakdown) say(`  ${b.kind.padEnd(20)} ${b.total} 件中 ${b.reported} 件に反応`);
  say(`（参考）確からしさの一致：${withConf.length} 件中 ${confAgree} 件（合否には使わない）`);
  for (const d of confDiffs) say(`  ${d}`);
  say(`（参考）形は合ったが除いたもの：${Object.entries(excludedTotal).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join("、") || "なし"}`);
  say();
  say("見逃した漏れ：");
  const missed = results.flatMap((r) => r.missed);
  if (missed.length === 0) say("  なし");
  for (const m of missed) say(`  ${m.id}（${m.type}、${m.page} ページ）`);
  say();
  say("誤検知：");
  if (fp === 0) say("  なし");
  for (const r of results) {
    for (const x of r.falseOnNegative) say(`  ${r.file} ${x.item.page} ページ：漏れでないもの ${x.negative.id}（${x.negative.kind}）に、${x.item.type} として重なった`);
    for (const x of r.falseNowhere) say(`  ${r.file} ${x.page} ページ [${x.rect.map((v) => v.toFixed(0)).join(", ")}]：${x.type}、正解のどれにも重ならない`);
  }
  say();
  say(`判定：${pass ? "合格" : "不合格"}${rubricFound ? "" : "（【仮】の基準）"}　（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
  console.log(lines.join("\n"));

  if (jsonOut) {
    const out = {
      fixtures: results.length,
      fixtures_dir: path.relative(ROOT, fixturesDir).replace(/\\/g, "/"),
      rubric: rubricFound ? "rubric/pii.json" : "provisional",
      leaks,
      negatives,
      found,
      false_positives: { on_negative: fpOnNegative, nowhere: fpNowhere, duplicates_not_counted: duplicates },
      recall,
      false_positive_rate: fpr,
      breakdown,
      negatives_breakdown: negBreakdown,
      confidence_agreement: { total: withConf.length, agree: confAgree },
      excluded: excludedTotal,
      missed: missed.map((m) => m.id),
      pass,
    };
    writeFileSync(jsonOut, JSON.stringify(out, null, 2) + "\n");
  }
  process.exitCode = pass ? 0 : 1;
}

if (import.meta.main) await main();

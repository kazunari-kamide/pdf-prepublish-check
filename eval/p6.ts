// SPDX-License-Identifier: AGPL-3.0-only
//
// 採点：P6（見せかけの黒塗り）。npm run eval で動く。
//
//   npm run eval                          この検査器の検出ルール（rules/p6-text）を採点する
//   npm run eval -- --reports <フォルダ>   別の版の報告を採点する。<合成PDFの名前>.json を、検証器の出力と同じ形で置く
//   npm run eval -- --sanitized <フォルダ> 片付けたあとの PDF（<合成PDFの名前>.pdf）を検証器にかけ、残っている件数も数える
//   npm run eval -- --json <ファイル>      結果を JSON でも書き出す
//
// 決まり：合格基準と照らし合わせ方は rubric/p6.json（値はここに書かない）。正解は fixtures/p6/*.expected.json。
// 検証器（verifier/）はコマンドとして呼ぶだけで、import しない。検出ルールの報告をそろえる変換は eval/adapters に置く。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectP6Text } from "../rules/p6-text/index.ts";
import { adaptP6Text } from "./adapters/p6-text.ts";
import { matchFile, type Expected, type FileMatch, type MatchRule, type VerifierShapedReport } from "./match.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "fixtures", "p6");
const RUBRIC = path.join(ROOT, "rubric", "p6.json");
const VERIFIER_CLI = path.join(ROOT, "verifier", "cli.mjs");
const VERIFIER_SELFCHECK = path.join(ROOT, "verifier", "selfcheck.mjs");

type Rubric = {
  pass: { recall_min: number; false_positive_rate_max: number; residual_after_sanitize_max: number };
  breakdown: string[];
  match: MatchRule & { overlap: string };
};

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
  if (rubric.match.overlap !== "intersection_over_smaller") {
    throw new Error(`rubric/p6.json の重なりの測り方（${rubric.match.overlap}）に、この eval は対応していません`);
  }
  const started = Date.now();

  // 1. 検証器そのものの確かめ
  const self = spawnSync(process.execPath, [VERIFIER_SELFCHECK], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const selfOk = self.status === 0;
  const selfLast = (self.stdout || "").trim().split(/\r?\n/).slice(-1)[0] ?? "";

  // 2. 合成 PDF ごとに採点する
  const names = readdirSync(FIXTURES).filter((f) => f.endsWith(".expected.json")).sort();
  const results: Array<FileMatch & { expected: Expected }> = [];
  const residual: Array<{ file: string; items: number | null; status: string; skipped: number }> = [];
  let uncheckedImages = 0; // 検出ルールが濃いかどうかを調べられなかった画像（参考）
  const subject = reportsDir ? `別の版の報告（${path.basename(reportsDir)}）` : "検出ルール rules/p6-text";

  for (const name of names) {
    const expected = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Expected;
    const base = expected.file.replace(/\.pdf$/, "");
    let report: VerifierShapedReport;
    if (reportsDir) {
      const p = path.join(reportsDir, `${base}.json`);
      report = existsSync(p)
        ? (JSON.parse(readFileSync(p, "utf8")) as VerifierShapedReport)
        : { status: "error", items: [], skipped_pages: [] };
    } else {
      const bytes = new Uint8Array(readFileSync(path.join(FIXTURES, expected.file)));
      const raw = await detectP6Text(bytes);
      uncheckedImages += raw.uncheckedImages.length;
      report = adaptP6Text(raw);
    }
    results.push({ ...matchFile(expected, report, rubric.match), expected });

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
  const leaks = results.reduce((s, r) => s + r.expected.leaks.length, 0);
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

  const breakdown = rubric.breakdown.map((type) => {
    const [layer, cover] = type.split("/");
    const all = results.flatMap((r) => r.expected.leaks).filter((l) => l.layer === layer && l.cover === cover);
    const hit = results.flatMap((r) => r.matched).filter((m) => m.leak.layer === layer && m.leak.cover === cover);
    return { type, found: hit.length, total: all.length };
  });

  const residualTotal = residual.reduce((s, r) => s + (r.items ?? 0), 0);
  const residualBad = residual.filter((r) => r.items === null || r.status !== "ok" || r.skipped > 0);
  const residualMeasured = sanitizedDir !== undefined;

  const passRecall = recall >= rubric.pass.recall_min;
  const passFpr = fpr <= rubric.pass.false_positive_rate_max;
  const passResidual =
    residualMeasured && residualBad.length === 0 && residualTotal <= rubric.pass.residual_after_sanitize_max;
  const pass = passRecall && passFpr && passResidual && errors.length === 0;

  // 字数の食い違い（合否には使わない。rubric/p6.md §3）
  const charDiffs = results.flatMap((r) =>
    r.matched
      .filter((m) => m.leak.remaining?.chars !== undefined && m.item.remaining?.chars !== undefined && m.leak.remaining.chars !== m.item.remaining.chars)
      .map((m) => `${m.leak.id}：正解 ${m.leak.remaining!.chars} 字、報告 ${m.item.remaining!.chars} 字`),
  );

  const lines: string[] = [];
  const say = (s = "") => lines.push(s);
  say(`採点：P6（見せかけの黒塗り）　対象：${subject}`);
  say(`検証器そのものの確かめ（verifier/selfcheck.mjs）：${selfOk ? "合格" : "不合格"}　${selfLast}`);
  say(`合成 PDF：${results.length} 個　漏れ：${leaks} 件　漏れでないもの：${negatives} 件`);
  say();
  say(`検出率　　　　　：${found} / ${leaks} = ${pct(found, leaks)}　（基準 ${rubric.pass.recall_min * 100}% 以上）→ ${passRecall ? "満たす" : "満たさない"}`);
  say(`誤検知率　　　　：${fp} / ${negatives} = ${pct(fp, negatives)}　（基準 ${rubric.pass.false_positive_rate_max * 100}% 以下）→ ${passFpr ? "満たす" : "満たさない"}`);
  say(`　うち漏れでないものに重なった報告：${fpOnNegative} 件、正解のどれにも重ならなかった報告：${fpNowhere} 件`);
  // 1対1のため結べなかった報告は、誤検知に数えず、件数を別に出す（2026-11-03、人が決めた。0 件でも出す）
  say(`結べなかった報告（漏れに重なったが、その漏れには、もっと重なる報告が結ばれていた）：${duplicates} 件（誤検知には数えない）`);
  say(
    residualMeasured
      ? `片付けたあとに残る情報：${residualTotal} 件（読めない・省いたページあり：${residualBad.length} 個）　（基準 ${rubric.pass.residual_after_sanitize_max} 件）→ ${passResidual ? "満たす" : "満たさない"}`
      : "片付けたあとに残る情報：未測定（片付けた PDF が渡されていない。--sanitized で測る）→ 満たさない",
  );
  if (errors.length) say(`読めなかった合成 PDF：${errors.join("、")}`);
  if (skipped) say(`省いたページ：${skipped} ページ`);
  if (!reportsDir) say(`（参考）濃いかどうかを調べられなかった画像（JPEG など）：${uncheckedImages} 個`);
  say();
  say("型ごとの内訳（見つけた / 漏れ）：");
  for (const b of breakdown) say(`  ${b.type.padEnd(17)} ${b.total} 件中 ${b.found} 件`);
  // 層ごとの小計（参考。合否は全体の数字で決める。rubric/p6.md §1）
  for (const layer of ["text", "image"]) {
    const rows = breakdown.filter((b) => b.type.startsWith(`${layer}/`));
    const t = rows.reduce((s, b) => s + b.total, 0);
    const f = rows.reduce((s, b) => s + b.found, 0);
    say(`  （参考）${layer}/* の小計    ${t} 件中 ${f} 件（${pct(f, t)}）`);
  }
  say();
  say("見逃した漏れ：");
  const missed = results.flatMap((r) => r.missed);
  if (missed.length === 0) say("  なし");
  for (const m of missed) say(`  ${m.id}（${m.layer}/${m.cover}、${m.page} ページ）`);
  say();
  say("誤検知：");
  if (fp === 0) say("  なし");
  for (const r of results) {
    for (const x of r.falseOnNegative) say(`  ${r.file} ${x.item.page} ページ：漏れでないもの ${x.negative.id}（${x.negative.kind}）に重なった`);
    for (const x of r.falseNowhere) say(`  ${r.file} ${x.page} ページ [${x.rect.map((v) => v.toFixed(0)).join(", ")}]：正解のどれにも重ならない`);
  }
  if (charDiffs.length) {
    say();
    say("（参考）覆われた字数の食い違い（合否には使わない）：");
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
      missed: missed.map((m) => m.id),
      pass,
    };
    writeFileSync(jsonOut, JSON.stringify(out, null, 2) + "\n");
  }
  process.exitCode = pass ? 0 : 1;
}

await main();

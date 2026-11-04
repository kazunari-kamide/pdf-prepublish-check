// SPDX-License-Identifier: AGPL-3.0-only
//
// コマンドの道具の compare：2つの PDF を比べた結果（compare/index.ts）を、人が読む形か JSON で出す。
// 終了コード：0 消したはずの字が残っていない／2 残っている／3 比べられなかった所がある（2 と両方なら 3）／64 使い方の誤り。
// 2 と 3 は check の「高い危険」「調べられなかった所がある」とそろえた。

import { readFileSync, statSync } from "node:fs";
import { compareOutcome, type CompareReport, type FieldChange } from "../compare/index.ts";
import { MAX_FILE_BYTES } from "../src/inspect/limits.ts";
import { TOOL_NAME, TOOL_VERSION } from "./output.ts";
import { compareInWorker, isFailure } from "./run.ts";

const CHANGE: Record<FieldChange, string> = { added: "足された", removed: "消えた", changed: "変わった", same: "同じ" };
const INFO_KEY: Record<string, string> = { Title: "タイトル", Author: "作成者", Subject: "件名", Keywords: "キーワード", Creator: "作成したソフト" };
const COVER: Record<string, string> = { fill: "塗りつぶした図形", image: "黒い画像", annotation: "注釈" };

const fmtCount = (n: number | null) => (n === null ? "読めない" : `${n}`);

export function formatCompareText(r: CompareReport): string {
  const L: string[] = [];
  if (r.status !== "ok") {
    L.push(`比べられませんでした（${r.error?.side === "before" ? "元のファイル" : "公開するファイル"}）：${r.error?.message ?? ""}`);
    return L.join("\n");
  }
  L.push(`ページの数：元 ${r.pages.before}　公開 ${r.pages.after}`);
  L.push("");
  L.push("① 消したはずの字（公開するファイルの黒い覆いの下に、元の字が残っているか）");
  const spots = r.text.pages.flatMap((p) => p.remaining.map((s) => ({ page: p.page, ...s })));
  if (r.text.remainingChars > 0) {
    L.push(`    × 残っています：${r.text.remainingChars} 字（${spots.length} か所）`);
    for (const s of spots) {
      L.push(`        ${s.page}ページ　覆っているもの：${COVER[s.cover] ?? "図形"}　残っている字：${s.chars}字　場所：[${s.rect.join(", ")}]`);
    }
    L.push("        なぜ：上から重ねただけなので、下の字を選んでコピーできます。");
  } else {
    L.push("    ○ 覆いの下に残っている元の字は、見つかりませんでした（比べたページについて）");
  }
  L.push(`    元にあって、公開するファイルから取り出せなくなった字：${r.text.goneChars} 字（消した・書き換えた字）`);
  for (const s of r.text.skippedPages) {
    L.push(`    ？ ${s.page}ページは比べていません（${s.side === "before" ? "元" : "公開"}のファイルの${s.reason === "heavy" ? "図形が多すぎるため" : "ページを読めなかったため"}）`);
  }
  if (r.text.unmatchedPages) L.push(`    ？ ページの数が違うので、後ろの ${r.text.unmatchedPages} ページは比べていません`);

  L.push("");
  L.push("② 文書情報と XMP（欄の名前と、違いだけ。値は出しません）");
  if (r.info.error.length) L.push(`    ？ 文書情報を読めませんでした（${r.info.error.map((s) => (s === "before" ? "元" : "公開")).join("・")}）`);
  const changedInfo = r.info.fields.filter((f) => f.change !== "same");
  if (!r.info.fields.length) L.push("    文書情報：どちらにも、値の入った欄はありません");
  for (const f of r.info.fields) {
    const name = f.key ? `「${INFO_KEY[f.key] ?? f.key}」` : "独自の欄";
    L.push(`    文書情報 ${name}：${CHANGE[f.change]}（元 ${f.beforeChars ?? "なし"}字 → 公開 ${f.afterChars ?? "なし"}字）`);
  }
  if (changedInfo.length === 0 && r.info.fields.length) L.push("    文書情報：違いはありません");
  L.push(`    XMP の項目の数：元 ${r.xmp.before ?? "なし"}　公開 ${r.xmp.after ?? "なし"}`);
  const xmpChanged = r.xmp.fields.filter((f) => f.change !== "same");
  for (const f of xmpChanged) L.push(`    XMP ${f.name ?? "独自の項目"}：${CHANGE[f.change]}`);
  if (r.xmp.fields.length && !xmpChanged.length) L.push("    XMP：違いはありません");

  L.push("");
  L.push("③ 数の違い");
  L.push(`    版（前の版の残り）：元 ${fmtCount(r.counts.revisions.before)}　公開 ${fmtCount(r.counts.revisions.after)}`);
  L.push(`    添付ファイル：元 ${fmtCount(r.counts.attachments.before)}　公開 ${fmtCount(r.counts.attachments.after)}`);
  L.push(`    注釈：元 ${fmtCount(r.counts.annotations.before)}　公開 ${fmtCount(r.counts.annotations.after)}`);
  L.push("");
  L.push("比べたのは、上に挙げた項目だけです。ほかの残り方は、check で調べてください。");
  return L.join("\n");
}

export function compareExitCode(r: CompareReport): number {
  const o = compareOutcome(r);
  return o.incomplete ? 3 : o.remaining ? 2 : 0;
}

export async function runCompare(beforePath: string, afterPath: string, format: "text" | "json"): Promise<{ text: string; code: number; usage?: string }> {
  const read = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES) return "too_large" as const;
    return new Uint8Array(readFileSync(p));
  };
  const a = read(beforePath);
  const b = read(afterPath);
  if (a === null || b === null) return { text: "", code: 64, usage: `見つからないファイルがあります：${[a === null ? beforePath : "", b === null ? afterPath : ""].filter(Boolean).join("、")}` };
  if (a === "too_large" || b === "too_large") {
    const mb = Math.floor(MAX_FILE_BYTES / (1024 * 1024));
    const msg = `ファイルが大きすぎるため、比べられません（上限は ${mb}MB です）。`;
    return { text: format === "json" ? JSON.stringify({ tool: { name: TOOL_NAME, version: TOOL_VERSION }, exitCode: 3, failed: "too_large", message: msg }, null, 2) : msg, code: 3 };
  }
  const r = await compareInWorker(a, b);
  if (isFailure(r)) {
    return { text: format === "json" ? JSON.stringify({ tool: { name: TOOL_NAME, version: TOOL_VERSION }, exitCode: 3, ...r }, null, 2) : r.message, code: 3 };
  }
  const code = compareExitCode(r);
  const text = format === "json" ? JSON.stringify({ tool: { name: TOOL_NAME, version: TOOL_VERSION }, exitCode: code, before: beforePath, after: afterPath, ...r }, null, 2) : formatCompareText(r);
  return { text, code };
}

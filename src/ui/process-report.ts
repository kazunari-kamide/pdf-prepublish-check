// SPDX-License-Identifier: AGPL-3.0-only
//
// 処理の報告書（11/5 B の 3）。片付けの前後の SHA-256、消した所と字数、調べた範囲を、文字だけの報告にする。
// - 字の中身・欄の値・ファイル名は載せない（片付けの報告の label は、もともと中身を入れない決まり。sanitize/types.ts）。
// - 画面から保存する（Blob の URL を a[download] で開く。通信ではない）。
// 画面の部品に頼らない計算だけを置き、テストで確かめる。

import type { NotDoneItem, RemovedItem } from "../../sanitize/types.ts";
import type { CoverageRow } from "./coverage";
import { patternWithName } from "./clean-model.ts";
import { fullContent } from "./reveal.ts";

export type ProcessReportInput = {
  /** 報告を作った日（YYYY-MM-DD）。時刻は載せない */
  date: string;
  before: { sha256: string; bytes: number; coverage: CoverageRow[] };
  /** 片付けた PDF。読み直せなかったときは coverage が null */
  after: { sha256: string; bytes: number; pages: number; coverage: CoverageRow[] | null };
  removed: RemovedItem[];
  notDone: NotDoneItem[];
  /** 読み直しの結論の文（CleanView.headline） */
  verdict: string;
  /** 使った検出ルールと版（ruleId@version） */
  rules: string[];
  /** プロパティを項目ごとにどうしたか（tidy-model.ts の changeLines。値は入れない） */
  properties?: string[];
  /**
   * 見つけた字の中身（保存の前に「中身も入れる」を選んだときだけ渡す。初めは渡さない）。
   * 渡さなければ、報告書には中身を一切入れない
   */
  contents?: Array<{ pattern: string; page: number | null; title: string; content: string }>;
};

/** 片付けたときに数えた数の単位（字数として数えるもの） */
const CHAR_KINDS: ReadonlySet<RemovedItem["kind"]> = new Set(["covered_text", "hidden_text", "actual_text"]);

/** バイト列の SHA-256 を、16進の小文字で返す（ブラウザ・Node の WebCrypto） */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function coverageLine(c: CoverageRow): string {
  const state = { checked: "調べた", partial: "一部だけ調べた", failed: "調べられなかった", not_in_version: "この版では調べていない" }[c.state];
  const counts = c.state === "checked" || c.state === "partial" ? `（見つかった ${c.found} 件・確かめる ${c.check} 件）` : "";
  const why = c.reasons.length ? `　理由：${c.reasons.join(" ")}` : "";
  return `- ${c.name}（${c.key}）：${state}${counts}${why}`;
}

/** 型ごとの、片付けの前と読み直したあとの数（見つかった所＋確かめる所） */
export function beforeAfterCounts(before: CoverageRow[], after: CoverageRow[] | null): Array<{ key: string; name: string; before: number; after: number | null }> {
  return before
    .map((b) => {
      const a = after?.find((x) => x.key === b.key);
      const counted = (c: CoverageRow | undefined) => (c && (c.state === "checked" || c.state === "partial") ? c.found + c.check : null);
      return { key: b.key, name: b.name, before: counted(b) ?? 0, after: after ? counted(a) : null };
    })
    .filter((r) => r.before > 0 || (r.after ?? 0) > 0);
}

export function buildProcessReport(input: ProcessReportInput): string {
  const { before, after } = input;
  const lines: string[] = [];
  lines.push("お守りPDF 処理の報告書");
  lines.push("");
  lines.push(`作った日：${input.date}`);
  lines.push(
    input.contents?.length
      ? "この報告書には、保存の前に選んだため、見つけた字の中身を入れています（下の「見つけた字の中身」）。ファイル名は載せていません。"
      : "この報告書には、PDF の字の中身・欄の値・ファイル名を載せていません。数と場所だけです。",
  );
  lines.push("");
  lines.push("■ ファイルの確かめ（SHA-256）");
  lines.push(`整える前：${before.sha256}（${before.bytes} バイト）`);
  lines.push(`整えた後：${after.sha256}（${after.bytes} バイト・${after.pages} ページ）`);
  lines.push("保存したファイルの SHA-256 が「整えた後」と同じなら、この報告書のファイルです。");
  lines.push("");
  lines.push("■ 結論");
  lines.push(input.verdict);
  lines.push("");
  lines.push("■ 型ごとの数（整える前 → 読み直したあと）");
  const counts = beforeAfterCounts(before.coverage, after.coverage);
  if (!counts.length) lines.push("- 見つかった所はありませんでした。");
  for (const c of counts) lines.push(`- ${c.name}（${c.key}）：${c.before} → ${c.after === null ? "読み直せなかった" : c.after}`);
  lines.push("");
  lines.push("■ 整えた内容（見えない情報を消した所）");
  if (!input.removed.length) lines.push("- ありません。");
  const chars = input.removed.filter((r) => CHAR_KINDS.has(r.kind)).reduce((n, r) => n + r.count, 0);
  if (chars) lines.push(`消した字の数：合わせて ${chars} 字`);
  for (const r of input.removed) {
    const where = r.page !== undefined ? `ページ ${r.page}` : "ファイル全体";
    const unit = CHAR_KINDS.has(r.kind) ? `${r.count} 字` : `${r.count}`;
    lines.push(`- ${patternWithName(r.pattern)}／${where}／${r.label}／数：${unit}`);
  }
  lines.push("");
  if (input.properties?.length) {
    lines.push("■ プロパティ（本人が選んだこと。値は載せていません）");
    for (const t of input.properties) lines.push(`- ${t}`);
    lines.push("");
  }
  lines.push("■ 消せなかった所");
  if (!input.notDone.length) lines.push("- ありません。");
  for (const n of input.notDone) lines.push(`- ${patternWithName(n.pattern)}／${n.page !== undefined ? `ページ ${n.page}` : "ファイル全体"}／${n.label}`);
  lines.push("");
  if (input.contents?.length) {
    lines.push("■ 見つけた字の中身（保存の前に「中身も入れる」を選んだため、入れています。取り扱いに気をつけてください）");
    for (const c of input.contents) {
      lines.push(`- ${patternWithName(c.pattern)}／${c.page !== null ? `ページ ${c.page}` : "ファイル全体"}／${c.title}／中身：${fullContent(c.content)}`);
    }
    lines.push("");
  }
  lines.push("■ 調べた範囲（整える前）");
  for (const c of before.coverage) lines.push(coverageLine(c));
  lines.push("");
  lines.push("■ 調べた範囲（読み直したあと）");
  if (!after.coverage) lines.push("- 読み直せませんでした。");
  else for (const c of after.coverage) lines.push(coverageLine(c));
  lines.push("");
  lines.push("■ 使った検出ルールの版");
  lines.push(input.rules.join("、"));
  lines.push("");
  lines.push("見つけられるのは、ここに並べた型だけです。すべての漏れを見つけられるわけではありません。");
  return lines.join("\n") + "\n";
}

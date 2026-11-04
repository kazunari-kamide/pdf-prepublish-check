// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面で使う検出ルールの一覧。ルールを足すときは、この下の RULES に1つ足すだけでよい（Worker・画面は変えない）。
//
// 各ルールの報告を、画面の形（report.ts）にそろえる。
// - 字の中身・欄の値・ファイル名を返させる設定（includeText など）は使わない。数と場所だけを画面に出す。
// - 一覧の文は、PDF に詳しくない人が読んでわかる言葉にする（用語集 §6）。断定しない。
// - 深刻度は【仮】。P6 の「高」だけが docs/prd.md §3-5 で決まっている。ほかは PR の「決めてほしいこと」に書く。

import { detectP1Info, type P1InfoReport } from "../../rules/p1-info/index.ts";
import { detectP5Revisions, type P5Kind, type P5Report } from "../../rules/p5-revisions/index.ts";
import { detectP6Text, type P6TextReport } from "../../rules/p6-text/index.ts";
import { DEFAULT_SETTINGS as P6_SETTINGS } from "../../rules/p6-text/settings.ts";
import { detectP7Hidden, type P7Reason, type P7Report } from "../../rules/p7-hidden/index.ts";
import { detectP9Attach, type P9AttachReport, type P9Where } from "../../rules/p9-attach/index.ts";
import { detectPii, type Basis as PiiBasis, type PiiReport, type PiiType } from "../../rules/pii/index.ts";
import type { Item, Notice, Pattern, RuleResult } from "./report";

export type RuleEntry = {
  id: string;
  label: string;
  pattern: Pattern;
  run(bytes: Uint8Array): Promise<RuleResult>;
};

/** どのルールの報告にもある部分 */
type BaseReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: { message: string };
  decrypted?: unknown;
};

/** ルール1つを、画面の形にそろえる入口を作る */
function defineRule<R extends BaseReport>(meta: {
  id: string;
  label: string;
  pattern: Pattern;
  detect(bytes: Uint8Array): Promise<R>;
  items(report: R): Item[];
  notices?(report: R): Notice[];
}): RuleEntry {
  return {
    id: meta.id,
    label: meta.label,
    pattern: meta.pattern,
    async run(bytes) {
      const report = await meta.detect(bytes);
      const base = { ruleId: report.rule.id, ruleVersion: report.rule.version, label: meta.label, pattern: meta.pattern };
      if (report.status === "error") {
        return { ...base, status: "error", message: report.error?.message ?? "調べられませんでした。", items: [], notices: [] };
      }
      const notices = meta.notices?.(report) ?? [];
      if (report.decrypted) notices.unshift(DECRYPTED);
      return { ...base, status: "ok", items: meta.items(report), notices };
    },
  };
}

const DECRYPTED: Notice = {
  kind: "decrypted",
  message: "パスワードなしで開ける暗号化がかかっていたので、ほどいて調べました。",
  pages: [],
};

const SKIPPED_HEAVY = "このページは図形が多すぎるため、検査を省きました。";
const SKIPPED_UNREADABLE = "このページは読めなかったため、検査を省きました。";

function skippedNotices(skipped: Array<{ page: number; reason: string }>): Notice[] {
  const heavy = skipped.filter((s) => s.reason !== "unreadable_page").map((s) => s.page);
  const broken = skipped.filter((s) => s.reason === "unreadable_page").map((s) => s.page);
  const out: Notice[] = [];
  if (heavy.length) out.push({ kind: "skipped_pages", message: SKIPPED_HEAVY, pages: heavy, reason: "heavy" });
  if (broken.length) out.push({ kind: "skipped_pages", message: SKIPPED_UNREADABLE, pages: broken, reason: "unreadable" });
  return out;
}

// ---------------------------------------------------------------- P6 見せかけの黒塗り

const P6_COVER: Record<string, string> = { fill: "塗りつぶした図形", image: "黒い画像", annotation: "注釈" };

const p6 = defineRule<P6TextReport>({
  id: "p6-text",
  label: "見せかけの黒塗り",
  pattern: "P6",
  detect: (b) => detectP6Text(b),
  items: (r) =>
    r.findings.map((f) =>
      f.layer === "text"
        ? {
            pattern: "P6",
            severity: "high",
            title: "黒い四角の下に、字が残っています",
            why: "上から重ねただけなので、下の字を選んでコピーできます。",
            detail: `覆っているもの：${P6_COVER[f.cover] ?? "図形"}／残っている字：${f.chars}字`,
            page: f.page,
            rect: f.rect,
          }
        : {
            // 画像の層（検出ルール 1.5.0 から）。文言は仮。画面の担当が見直す
            pattern: "P6",
            severity: "high",
            title: f.tone === "light" ? "白い四角の下に、画像の中身が残っています" : "黒い四角の下に、画像の中身が残っています",
            why: "画像の上に重ねただけなので、四角を外したり画像を取り出したりすると、下に写っているものが見えます。",
            detail: `覆っているもの：${P6_COVER[f.cover] ?? "図形"}`,
            page: f.page,
            rect: f.rect,
          },
    ),
  notices: (r) => {
    const out = skippedNotices(r.skippedPages);
    const pages = [...new Set(r.uncheckedImages.map((u) => u.page))];
    if (pages.length) {
      out.push({
        kind: "unchecked_images",
        message: "このページの画像は調べていません（画像の形式を読めなかったため）。黒く塗った画像があっても、ここでは見つけられません。",
        pages,
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------- P7 隠れたテキスト

const P7_REASON: Record<P7Reason, string> = {
  hidden_layer: "表示しない設定の層にある字",
  off_page: "ページの見える範囲の外にある字",
  clipped: "切り取られて見えない字",
  invisible: "透明で見えない字",
  tiny: "小さすぎて見えない字",
  same_color: "背景と同じ色の字",
  covered_light: "白っぽい図形の下に隠れた字",
};

const p7 = defineRule<P7Report>({
  id: "p7-hidden",
  label: "隠れたテキスト",
  pattern: "P7",
  // 1ページの命令の数の上限は、P6 とそろえる（2026-11-03 本人が決定。PR #31 の返事 5）。
  // P7 の既定の値（rules/p7-hidden）は検出ルールの担当の範囲なので変えず、画面から呼ぶときだけ上書きする。
  detect: (b) => detectP7Hidden(b, { settings: { maxOperations: P6_SETTINGS.maxOperationsPerPage } }),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P7",
      severity: "high", // 【仮】
      title: "見えない字が残っています",
      why: "画面では見えませんが、検索やコピーで取り出せます。",
      detail: `${P7_REASON[f.reason] ?? "見えない字"}／${f.chars}字`,
      page: f.page,
      rect: f.rect,
    })),
  notices: (r) => skippedNotices(r.skippedPages),
});

// ---------------------------------------------------------------- P1 文書情報

const P1_KEY: Record<string, string> = {
  Title: "タイトル",
  Author: "作成者",
  Subject: "件名",
  Keywords: "キーワード",
  Creator: "作成したソフト",
};

const p1 = defineRule<P1InfoReport>({
  id: "p1-info",
  label: "文書情報",
  pattern: "P1",
  detect: (b) => detectP1Info(b),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P1",
      severity: "medium", // 【仮】
      // 独自の欄の名前は、名前そのものが団体や人をたどる手がかりになりうるので出さない
      title: f.group === "standard" ? `文書情報の「${P1_KEY[f.key] ?? "欄"}」に値が入っています` : "文書情報の独自の欄に値が入っています",
      why: "ファイルのプロパティを開くと、誰でも見られます。意図したものでなければ消してください。",
      detail: `${f.chars}字`,
      page: null,
      rect: null,
    })),
});

// ---------------------------------------------------------------- P5 旧版の残存

const P5_KIND: Record<P5Kind, string> = {
  info: "文書情報",
  content: "ページの中身",
  annotation: "注釈",
  form_value: "フォームの入力値",
  metadata: "埋め込まれた作成の記録",
  image: "画像",
  embedded_file: "添付ファイル",
};

const p5 = defineRule<P5Report>({
  id: "p5-revisions",
  label: "旧版の残存",
  pattern: "P5",
  detect: (b) => detectP5Revisions(b),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P5",
      severity: "high", // 【仮】
      title: `修正する前の版の「${P5_KIND[f.kind] ?? "中身"}」が、ファイルの中に残っています`,
      why: "見た目は新しい版でも、修正する前の内容を取り出せます。",
      detail: [f.revision !== null ? `${f.revision}番目の版` : "どの版か分からない部分", f.chars !== undefined ? `${f.chars}字` : ""]
        .filter(Boolean)
        .join("／"),
      page: null,
      rect: null,
    })),
});

// ---------------------------------------------------------------- P9 添付ファイル

const P9_WHERE: Record<P9Where, string> = {
  names: "文書の添付ファイルの一覧",
  annotation: "ページの上の添付の印",
  af: "関連ファイルの欄",
  unreferenced: "どこからも指されていない所",
};

function formatSize(n: number | null): string {
  if (n === null) return "大きさ不明";
  if (n < 1024) return `${n} バイト`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const p9 = defineRule<P9AttachReport>({
  id: "p9-attach",
  label: "添付ファイル",
  pattern: "P9",
  detect: (b) => detectP9Attach(b),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P9",
      severity: "medium", // 【仮】
      title: "添付ファイルが入っています",
      why: "PDF を受け取った人が、元のファイルをそのまま取り出せます。",
      // ファイル名は出さない。拡張子は英数字だけのときに限り出す（種類の目安）
      detail: [f.ext && /^[a-z0-9]{1,8}$/.test(f.ext) ? `種類：.${f.ext}` : "種類：不明", formatSize(f.size), `場所：${P9_WHERE[f.where]}`].join("／"),
      page: f.page ?? null,
      rect: null,
    })),
  notices: (r) =>
    r.limits.length
      ? [{ kind: "partial", message: "添付ファイルの入れ物が多すぎるため、途中までしか調べていません。", pages: [] }]
      : [],
});

// ---------------------------------------------------------------- P13【仮】 見える文字の個人情報らしい字

const PII_TYPE: Record<PiiType, string> = {
  name: "氏名",
  address: "住所",
  phone: "電話番号",
  my_number: "マイナンバー",
  bank_account: "口座番号",
  birth_date: "生年月日",
  email: "メールアドレス",
  card_number: "カード番号",
};
const PII_BASIS: Record<PiiBasis, string> = {
  label: "前後の語から",
  column_header: "表の見出しから",
  honorific: "「様」などの呼び方から",
  pattern: "字の形から",
  check_digit: "番号の検査用の数字が合うことから",
};

const pii = defineRule<PiiReport>({
  id: "pii",
  label: "個人情報らしい字",
  pattern: "P13", // 【仮】の番号
  detect: (b) => detectPii(b, { settings: { maxOperations: P6_SETTINGS.maxOperationsPerPage } }),
  // 黒塗りの候補として示すだけ（決めるのは利用者）。字の中身は出さず、型・場所・確からしさだけを出す
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P13",
      severity: f.confidence === "high" ? "medium" : "low", // 【仮】
      title: `${PII_TYPE[f.type] ?? "個人情報"}らしい字があります（黒塗りの候補）`,
      why: "公開すると、本人が分かってしまうおそれがあります。黒塗りが要るかを確かめてください。",
      detail: `確からしさ：${f.confidence === "high" ? "高" : "確認"}（${PII_BASIS[f.basis] ?? "字の形から"}）／${f.chars}字${f.vertical ? "／縦書き" : ""}`,
      page: f.page,
      rect: f.rect,
    })),
  notices: (r) => {
    const out = skippedNotices(r.skippedPages.map((s) => ({ page: s.page, reason: s.reason === "unreadable_page" ? "unreadable_page" : "heavy" })));
    if (r.unreadable.pages.length) {
      out.push({
        kind: "partial",
        message: "このページには、中身を読み取れない字があります。その字の中の個人情報らしい字は探せていません。",
        pages: r.unreadable.pages,
      });
    }
    if (r.truncatedPages.length) {
      out.push({ kind: "partial", message: "このページは字が多すぎるため、個人情報らしい字を途中までしか探していません。", pages: r.truncatedPages });
    }
    return out;
  },
});

/** 画面で使う検出ルール。一覧には、この並びで出す */
export const RULES: RuleEntry[] = [p6, p7, p5, p1, p9, pii];

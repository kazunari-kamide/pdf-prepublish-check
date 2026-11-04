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
import { inspectAttachments, type InnerDetector, type P9Inner } from "../../rules/p9-attach/inner.ts";
import { detectP8Annot, type P8Field, type P8Report } from "../../rules/p8-annot/index.ts";
import { detectP2Xmp, type P2XmpKind, type P2XmpReport } from "../../rules/p2-xmp/index.ts";
import { detectP10Exif, type P10Kind, type P10Report } from "../../rules/p10-exif/index.ts";
import { detectP11Forms, type P11Report } from "../../rules/p11-forms/index.ts";
import { detectP12Actions, type P12Kind, type P12Report, type P12Where } from "../../rules/p12-actions/index.ts";
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

/** 添付の中身の説明（中の PDF で見つけた数・文字のファイルの字数）。中身の字・ファイル名は出さない */
function innerNote(i: P9Inner | undefined): string {
  if (!i) return "";
  switch (i.kind) {
    case "pdf": {
      const entries = Object.entries(i.counts ?? {}).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
      const total = entries.reduce((s, [, n]) => s + n, 0);
      const head = total ? `中身：PDF（中で ${total} 件。${entries.map(([p, n]) => `${p} ${n}件`).join("・")}）` : "中身：PDF（中では見つかりませんでした）";
      return i.errors ? `${head}・調べられなかった検査 ${i.errors} 個` : head;
    }
    case "text":
      return `中身：文字のファイル（${(i.chars ?? 0).toLocaleString("ja-JP")}字）`;
    case "too_large":
      return "中身：大きすぎるため調べていません";
    case "too_deep":
      return "中身：PDF（入れ子が深すぎるため調べていません）";
    case "not_checked":
      return "中身：添付が多すぎるため調べていません";
    default:
      return "";
  }
}

type P9WithInner = P9AttachReport & { inner: P9Inner[] };

const p9 = defineRule<P9WithInner>({
  id: "p9-attach",
  label: "添付ファイル",
  pattern: "P9",
  async detect(b) {
    const report = await detectP9Attach(b);
    if (report.status !== "ok" || report.findings.length === 0) return { ...report, inner: [] };
    // 添付が PDF なら、ほかの検出ルール（この一覧の P9 以外）で中も調べる。中の添付は inspectAttachments が入れ子でたどる
    const detectors: InnerDetector[] = RULES.filter((r) => r.id !== "p9-attach").map((r) => async (bytes) => {
      const res = await r.run(bytes);
      if (res.status === "error") throw new Error("inner rule error");
      return res.items;
    });
    return { ...report, inner: await inspectAttachments(b, detectors) };
  },
  items: (r) =>
    r.findings.map((f): Item => {
      const inner = r.inner.find((i) => i.object === f.object);
      const foundInside = inner?.kind === "pdf" && Object.values(inner.counts ?? {}).some((n) => n > 0);
      return {
        pattern: "P9",
        severity: foundInside ? "high" : "medium", // 【仮】
        title: foundInside ? "添付ファイルの PDF の中にも、見えない情報が残っています" : "添付ファイルが入っています",
        why: "PDF を受け取った人が、元のファイルをそのまま取り出せます。",
        // ファイル名は出さない。拡張子は英数字だけのときに限り出す（種類の目安）
        detail: [
          f.ext && /^[a-z0-9]{1,8}$/.test(f.ext) ? `種類：.${f.ext}` : "種類：不明",
          formatSize(f.size),
          `場所：${P9_WHERE[f.where]}`,
          innerNote(inner),
        ]
          .filter(Boolean)
          .join("／"),
        page: f.page ?? null,
        rect: null,
      };
    }),
  notices: (r) =>
    r.limits.length
      ? [{ kind: "partial", message: "添付ファイルの入れ物が多すぎるため、途中までしか調べていません。", pages: [] }]
      : [],
});

// ---------------------------------------------------------------- P8 注釈・コメント

const P8_FIELD: Record<P8Field, string> = {
  T: "作成者",
  Contents: "内容",
  Subj: "件名",
  RC: "書式つきの内容",
  AP: "見た目の中の字",
};

/** 注釈のあるページ。2ページ以上なら、補足に並べる（先の5つまで） */
function pagesNote(pages: number[]): string {
  if (pages.length <= 1) return "";
  const head = pages.slice(0, 5).join("・");
  return `ページ ${head}${pages.length > 5 ? ` ほか ${pages.length - 5} ページ` : ""}`;
}

const p8 = defineRule<P8Report>({
  id: "p8-annot",
  label: "注釈・コメント",
  pattern: "P8",
  detect: (b) => detectP8Annot(b),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P8",
      severity: f.hidden ? "high" : "medium", // 【仮】
      title: f.hidden
        ? "隠した注釈に、字が残っています"
        : f.field === "T"
          ? "注釈の作成者欄に、名前が残っています"
          : "注釈に、コメントの字が入っています",
      why: f.hidden
        ? "画面には出ませんが、注釈の一覧やファイルの中を見ると読めます。"
        : f.field === "T"
          ? "注釈のプロパティを開くと、付けた人の名前（ログイン名など）を誰でも見られます。"
          : "注釈の一覧を開くと、誰でも読めます。意図したものでなければ消してください。",
      detail: [`欄：${P8_FIELD[f.field] ?? "欄"}`, `${f.chars}字`, `注釈 ${f.annotations} 個`, pagesNote(f.pages)].filter(Boolean).join("／"),
      page: f.pages[0] ?? null,
      rect: null,
    })),
  notices: (r) =>
    r.limits.length
      ? [{ kind: "partial", message: "注釈が多すぎる・読めないページがあるため、途中までしか調べていません。", pages: [...new Set(r.limits.map((l) => l.page))] }]
      : [],
});

// ---------------------------------------------------------------- P2 文書全体の XMP

const P2_KIND: Record<P2XmpKind, { title: string; why: string; severity: Item["severity"] }> = {
  person: { title: "埋め込まれた作成の記録（XMP）に、名前が残っています", why: "文書のプロパティの詳しい欄を開くと、作った人の名前を誰でも見られます。", severity: "medium" },
  text: { title: "埋め込まれた作成の記録（XMP）に、題や説明が入っています", why: "文書情報を消しても、ここに同じ値が残ることがあります。意図したものでなければ消してください。", severity: "medium" },
  path: { title: "埋め込まれた作成の記録（XMP）に、パソコンのフォルダの名前が残っています", why: "元のファイルの置き場所から、使った人のログイン名などが分かります。", severity: "medium" },
  history: { title: "埋め込まれた作成の記録（XMP）に、編集の履歴が残っています", why: "いつ・どのソフトで保存や変換をしたかが分かります。確認してください。", severity: "low" },
  gps: { title: "埋め込まれた作成の記録（XMP）に、位置情報（GPS）が残っています", why: "写真を撮った場所などが分かります。", severity: "high" },
};

const p2 = defineRule<P2XmpReport>({
  id: "p2-xmp",
  label: "XMP メタデータ",
  pattern: "P2",
  detect: (b) => detectP2Xmp(b),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: f.pattern,
      severity: P2_KIND[f.kind].severity, // 【仮】
      title: P2_KIND[f.kind].title,
      why: P2_KIND[f.kind].why,
      detail: f.kind === "history" ? `出来事 ${f.events ?? 0} 件` : f.kind === "gps" ? "緯度・経度" : `${f.chars}字`,
      page: null,
      rect: null,
    })),
  notices: (r) => (r.limits.length ? [{ kind: "partial", message: "埋め込まれた作成の記録が大きすぎる・読めないため、調べていません。", pages: [] }] : []),
});

// ---------------------------------------------------------------- P10 画像の Exif

const P10_KIND: Record<P10Kind, { title: string; severity: Item["severity"] }> = {
  gps: { title: "写真に、撮った場所（GPS）が残っています", severity: "high" },
  person: { title: "写真に、撮った人・持ち主の名前が残っています", severity: "medium" },
  serial: { title: "写真に、カメラの製造番号が残っています", severity: "medium" },
  thumbnail: { title: "写真の中に、縮小画像が残っています", severity: "medium" },
  description: { title: "写真に、説明の字が入っています", severity: "low" },
  copyright: { title: "写真に、著作権者の名前が入っています", severity: "low" },
  camera: { title: "写真に、カメラの機種が残っています", severity: "low" },
  software: { title: "写真に、使ったソフトの名前が残っています", severity: "low" },
};

const p10 = defineRule<P10Report>({
  id: "p10-exif",
  label: "画像の位置情報など",
  pattern: "P10",
  detect: (b) => detectP10Exif(b),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P10",
      severity: P10_KIND[f.kind].severity, // 【仮】
      title: P10_KIND[f.kind].title,
      why:
        f.kind === "thumbnail"
          ? "切り抜く前の写真が、縮小画像として残っていることがあります。画像を取り出すと見られます。"
          : "写真のファイルの中の情報で、画像を取り出すと誰でも見られます。",
      detail: f.kind === "thumbnail" ? formatSize(f.bytes ?? null) : f.kind === "gps" ? "緯度・経度" : `${f.chars}字`,
      page: f.pages[0] ?? null,
      rect: null,
    })),
  notices: (r) => (r.limits.length ? [{ kind: "partial", message: "読めない・大きすぎる写真があったため、一部の写真は調べていません。", pages: [] }] : []),
});

// ---------------------------------------------------------------- P11 フォームの値

const p11 = defineRule<P11Report>({
  id: "p11-forms",
  label: "フォームの入力値",
  pattern: "P11",
  detect: (b) => detectP11Forms(b),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P11",
      severity: f.visibility === "visible" ? "low" : "medium", // 【仮】
      title:
        f.visibility === "visible"
          ? "フォームの欄に、入力した値が入っています"
          : f.visibility === "hidden"
            ? "隠したフォームの欄に、値が残っています"
            : "ページに出ていないフォームの欄に、値が残っています",
      why:
        f.visibility === "visible"
          ? "提出・公開する前に、入れたままでよい値か確かめてください。"
          : "画面には出ませんが、フォームの値を読み出すと見られます。",
      detail: f.fieldType === "button" ? "チェックの印" : `${f.chars}字`,
      page: f.page,
      rect: null,
    })),
  notices: (r) => (r.limits.length ? [{ kind: "partial", message: "フォームの欄が多すぎるため、途中までしか調べていません。", pages: [] }] : []),
});

// ---------------------------------------------------------------- P12 JavaScript・開いたときの動作

const P12_KIND: Record<P12Kind, string> = {
  javascript: "JavaScript（プログラム）",
  launch: "ほかのファイルやプログラムを開く動作",
  submit_form: "入力した値を送る動作",
  import_data: "外のデータを読み込む動作",
  remote_goto: "別のファイルへ移る動作",
  uri: "ウェブのページを開く動作",
  other_action: "自動で動く動作",
};
const P12_WHERE: Record<P12Where, string> = {
  names: "文書のプログラムの一覧",
  open_action: "開いたとき",
  document_aa: "閉じる・保存・印刷のとき",
  page_aa: "ページを開いた・閉じたとき",
  annotation: "注釈を押したとき",
  field: "フォームの欄",
  other: "どこからも使われていない所",
};

const p12 = defineRule<P12Report>({
  id: "p12-actions",
  label: "スクリプト・外部動作",
  pattern: "P12",
  detect: (b) => detectP12Actions(b),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P12",
      severity: "low", // 安全上の注意は「低」（用語集 §3 の深刻度）
      title: `${P12_KIND[f.kind]}が入っています`,
      why: "漏れではありませんが、開いた人のパソコンで動くことがあります。意図したものでなければ消してください。",
      detail: [`場所：${P12_WHERE[f.where]}`, f.count > 1 ? `${f.count} 個` : "", f.kind === "javascript" ? `${f.chars}字` : ""].filter(Boolean).join("／"),
      page: f.page,
      rect: null,
    })),
  notices: (r) => (r.limits.length ? [{ kind: "partial", message: "動作が多すぎるため、途中までしか調べていません。", pages: [] }] : []),
});

/** 画面で使う検出ルール。一覧には、この並びで出す */
export const RULES: RuleEntry[] = [p6, p7, p5, p1, p2, p9, p8, p11, p12, p10];

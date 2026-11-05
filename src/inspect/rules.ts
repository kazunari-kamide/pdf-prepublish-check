// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面で使う検出ルールの一覧。ルールを足すときは、この下の RULES に1つ足すだけでよい（Worker・画面は変えない）。
//
// 各ルールの報告を、画面の形（report.ts）にそろえる。
// - 字の中身・欄の値・ファイル名は、呼ぶ側が頼んだとき（RunContext の withContents）だけ、各ルールの設定（includeText・
//   includeValues・includeNames）で返させ、Item の content に入れる（2026-11-05 本人が決めた）。画面は頭の数文字だけを出して伏せ、
//   「中身を見る」で全部を出す。報告書・ログ・ファイル名には入れない。コマンドの道具・スキルは頼まない（数と場所だけ）。
// - 一覧の文は、PDF に詳しくない人が読んでわかる言葉にする（用語集 §6）。断定しない。
// - 深刻度は【仮】。P6 の「高」だけが docs/prd.md §3-5 で決まっている。ほかは PR の「決めてほしいこと」に書く。

import { detectP1Info, type P1InfoReport } from "../../rules/p1-info/index.ts";
import { INFO_LABEL } from "../../sanitize/field-labels.ts";
import { detectP5Revisions, type P5Compare, type P5Kind, type P5Part, type P5Report } from "../../rules/p5-revisions/index.ts";
import { detectP6Text, type P6TextReport } from "../../rules/p6-text/index.ts";
import { DEFAULT_SETTINGS as P6_SETTINGS } from "../../rules/p6-text/settings.ts";
import { detectP7Hidden, type P7Reason, type P7Report } from "../../rules/p7-hidden/index.ts";
import { detectP9Attach, type P9AttachReport, type P9Where } from "../../rules/p9-attach/index.ts";
import { detectPii, type Basis as PiiBasis, type PiiReport, type PiiType } from "../../rules/pii/index.ts";
import { inspectAttachments, type InnerDetector, type P9Inner } from "../../rules/p9-attach/inner.ts";
import { detectP8Annot, type P8Field, type P8Report } from "../../rules/p8-annot/index.ts";
import { detectP2Xmp, type P2XmpKind, type P2XmpReport } from "../../rules/p2-xmp/index.ts";
import { detectP10Exif, type P10Kind, type P10Report } from "../../rules/p10-exif/index.ts";
import { detectP11Forms, type P11Report } from "../../rules/p11-forms/index.ts";
import { detectP12Actions, type P12Kind, type P12Report, type P12Where } from "../../rules/p12-actions/index.ts";
import { detectP4Paths, type P4Kind, type P4Report, type P4Where } from "../../rules/p4-paths/index.ts";
import { detectAltText, type AltKind, type AltReport } from "../../rules/alt-text/index.ts";
import { detectInfoXmpDiff, type DiffReport } from "../../rules/props/index.ts";
import { detectExtras, type ExtrasReport } from "../../rules/extras/index.ts";
import { detectFontGlyphs, type FontGlyphReport } from "../../rules/font-glyphs/index.ts";
import { detectUnusedImages, type UnusedImageReport } from "../../rules/unused-images/index.ts";
import { detectP2Parts, type P2PartsFinding, type P2PartsReport } from "../../rules/p2-parts/index.ts";
import { detectP3Orgs, type P3Report } from "../../rules/p3-orgs/index.ts";
import type { ExternalImageDecoder } from "../../rules/shared/pdfjs-images.ts";
import { INFLATE_LIMIT_MESSAGE, isInflateLimitError } from "../../rules/shared/inflate-limit.ts";
import type { Item, Notice, Pattern, RuleResult } from "./report.ts";

/** ルールに渡す道具。imageDecoder＝pdf-lib で解けない画像（JPEG など）を解く道具（Worker が PDF.js で作る） */
export type RunContext = {
  imageDecoder?: ExternalImageDecoder;
  /** true のときだけ、見つけた字の中身を Item の content に入れる（画面の検査の Worker だけが頼む。画面の中だけで使う） */
  withContents?: boolean;
};

/** 中身を頼まれたときに、ルールに渡す設定 */
const values = (ctx: RunContext) => (ctx.withContents ? { includeValues: true } : {});

/** 中身があるときだけ content を足す（空の字は足さない） */
function contentOf(v: string | undefined): { content?: string } {
  return typeof v === "string" && v.length > 0 ? { content: v } : {};
}

export type RuleEntry = {
  id: string;
  label: string;
  pattern: Pattern;
  run(bytes: Uint8Array, ctx?: RunContext): Promise<RuleResult>;
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
  detect(bytes: Uint8Array, ctx: RunContext): Promise<R>;
  items(report: R): Item[];
  notices?(report: R): Notice[];
}): RuleEntry {
  return {
    id: meta.id,
    label: meta.label,
    pattern: meta.pattern,
    async run(bytes, ctx = {}) {
      let report: R;
      try {
        report = await meta.detect(bytes, ctx);
      } catch (e) {
        // 解くと大きすぎる所で止めた（圧縮の爆弾など）：「見つかりませんでした」にせず、調べられなかった項目にする
        if (!isInflateLimitError(e)) throw e;
        return { ruleId: meta.id, ruleVersion: "", label: meta.label, pattern: meta.pattern, status: "error", message: INFLATE_LIMIT_MESSAGE, items: [], notices: [] };
      }
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
  message: "パスワードなしで開ける暗号化がかかっていたので、外して調べました。",
  pages: [],
};

const SKIPPED_HEAVY = "このページは図形が多すぎるため、検査を省きました。";
const SKIPPED_UNREADABLE = "このページは読めなかったため、検査を省きました。";
const SKIPPED_TOO_LARGE = "このページは、解くと大きすぎる中身があるため、検査を省きました。";

function skippedNotices(skipped: Array<{ page: number; reason: string }>): Notice[] {
  const tooLarge = skipped.filter((s) => s.reason === "stream_too_large").map((s) => s.page);
  const broken = skipped.filter((s) => s.reason === "unreadable_page").map((s) => s.page);
  const heavy = skipped.filter((s) => s.reason !== "unreadable_page" && s.reason !== "stream_too_large").map((s) => s.page);
  const out: Notice[] = [];
  if (heavy.length) out.push({ kind: "skipped_pages", message: SKIPPED_HEAVY, pages: heavy, reason: "heavy" });
  if (broken.length) out.push({ kind: "skipped_pages", message: SKIPPED_UNREADABLE, pages: broken, reason: "unreadable" });
  if (tooLarge.length) out.push({ kind: "skipped_pages", message: SKIPPED_TOO_LARGE, pages: tooLarge, reason: "too_large" });
  return out;
}

// ---------------------------------------------------------------- P6 見せかけの黒塗り

const P6_COVER: Record<string, string> = { fill: "塗りつぶした図形", image: "黒い画像", annotation: "注釈" };
const P6_OPAQUE_COVER: Record<string, string> = { fill: "図形", image: "画像", annotation: "注釈" };

const p6 = defineRule<P6TextReport>({
  id: "p6-text",
  label: "見せかけの黒塗り",
  pattern: "P6",
  detect: (b, ctx) => detectP6Text(b, { ...(ctx.imageDecoder ? { imageDecoder: ctx.imageDecoder } : {}), ...(ctx.withContents ? { includeText: true } : {}) }),
  items: (r) => r.findings.map(p6Item),
  notices: (r) => {
    const out = skippedNotices(r.skippedPages);
    // 画像を解けなかった理由ごとに分けて知らせる（大きすぎる・読めない形式）
    const large = [...new Set(r.uncheckedImages.filter((u) => u.reason === "too_large").map((u) => u.page))];
    const other = [...new Set(r.uncheckedImages.filter((u) => u.reason !== "too_large").map((u) => u.page))];
    if (large.length) {
      out.push({
        kind: "unchecked_images",
        message: "このページの画像は、大きすぎるため調べていません。黒く塗った画像や、画像の上の黒い四角があっても、ここでは見つけられません。",
        pages: large,
        reason: "too_large",
      });
    }
    if (other.length) {
      out.push({
        kind: "unchecked_images",
        message: "このページの画像は、この版では読み解けない形式のため調べていません。黒く塗った画像や、画像の上の黒い四角があっても、ここでは見つけられません。",
        pages: other,
      });
    }
    return out;
  },
});

/** P6 の1件を画面の形にする。confidence: check は、断定しない言葉で出す（「確かめてください」） */
export function p6Item(f: P6TextReport["findings"][number]): Item {
  const cover = `覆っているもの：${P6_COVER[f.cover] ?? "図形"}`;
  // 「高」は、覆いの下に拾えるもの（字、または取り出せる画像の中身）があると言い切れるときだけ。
  // 例外：読み解けない画像の上に濃い四角を重ねたもの（スキャン画像の上の黒塗りの型）は、確かめが要っても「高」。
  // 図形の層とそのほかの「確かめてください」は「中」（実物の公開 PDF で、注釈の四角や塗りの誤検知が「高」で多く出たため。2026-11-05 本人が決定）【仮】
  const darkOverUnreadable = f.layer === "image" && f.reason === "under_unreadable" && f.tone === "dark";
  const severity = (f.layer !== "vector" && f.confidence !== "check") || darkOverUnreadable ? ("high" as const) : ("medium" as const);
  const base = { pattern: "P6" as const, severity, kind: f.layer, page: f.page, rect: f.rect, ...contentOf("text" in f ? f.text : undefined) };
  const check = f.confidence === "check" ? { confidence: "check" as const } : {};
  if (f.layer === "text" && f.coverTone === "opaque") {
    // 白・灰・色の不透明な覆い（検出ルール 1.11.0 から）。覆いの下の字は、色によらず見せかけの黒塗りとして出す【文言は仮】
    const what = P6_OPAQUE_COVER[f.cover] ?? "図形";
    return f.confidence === "check"
      ? {
          ...base,
          ...check,
          title: `上に重ねた${what}の下に、字が残っているかもしれません`,
          why: "上に別の字や形が重なっているため、言い切れません。白や色で覆っただけなら、下の字を選んでコピーできてしまいます。確かめてください。",
          detail: `覆っているもの：${what}（黒以外の色）／重なっている字：${f.chars}字`,
        }
      : {
          ...base,
          title: `上に重ねた${what}の下に、字が残っています`,
          why: "白や色で覆っても、下の字は消えていません。選んでコピーできます。",
          detail: `覆っているもの：${what}（黒以外の色）／残っている字：${f.chars}字`,
        };
  }
  if (f.layer === "text") {
    return f.confidence === "check"
      ? {
          ...base,
          ...check,
          title: "黒い四角の下に、字が残っているかもしれません",
          why: "見出しの帯や番号の札のような形にも見えるため、言い切れません。黒塗りのつもりなら、下の字を選んでコピーできてしまいます。確かめてください。",
          detail: `${cover}／重なっている字：${f.chars}字`,
        }
      : {
          ...base,
          title: "黒い四角の下に、字が残っています",
          why: "上から重ねただけなので、下の字を選んでコピーできます。",
          detail: `${cover}／残っている字：${f.chars}字`,
        };
  }
  if (f.layer === "vector") {
    // 図形の層（検出ルール 1.13.0 から）：白い四角の注釈の下に、線や形で描いた字が残っているかもしれない。いつも「確かめてください」【文言は仮】
    return {
      ...base,
      ...check,
      title: "白い四角の注釈の下に、線や形で描いた字が残っているかもしれません",
      why: "字を図形として描いた上に、白い四角を重ねただけなら、注釈を消すと下の字が見えます。罫線や図の場合もあるため、言い切れません。確かめてください。",
      detail: `覆っているもの：注釈（白）／下にある図形：${f.paths}個`,
    };
  }
  const box = f.tone === "light" ? "白い四角" : "黒い四角";
  if (f.reason === "under_unreadable") {
    return {
      ...base,
      ...check,
      title: `${box}の下の画像を、読み解けませんでした`,
      why: "画像の上に重ねただけなら、下に写っているものが残っています。この版では画像の形式を読めないため、言い切れません。確かめてください。",
      detail: cover,
    };
  }
  if (f.reason === "under_later_paint") {
    return {
      ...base,
      ...check,
      title: `${box}の下に、画像の中身が残っているかもしれません`,
      why: "四角の上に細い線などが重なっていて、下を十分に測れませんでした。確かめてください。",
      detail: cover,
    };
  }
  return f.confidence === "check"
    ? {
        ...base,
        ...check,
        title: `${box}の下に、画像の中身が残っているかもしれません`,
        why: "下の画像が写真のように色や濃淡の多いものなので、言い切れません。上に重ねただけなら、四角を外すと見えます。確かめてください。",
        detail: cover,
      }
    : {
        ...base,
        title: `${box}の下に、画像の中身が残っています`,
        why: "画像の上に重ねただけなので、四角を外したり画像を取り出したりすると、下に写っているものが見えます。",
        detail: cover,
      };
}

// ---------------------------------------------------------------- P7 隠れたテキスト

const P7_REASON: Record<P7Reason, string> = {
  hidden_layer: "表示しない設定の層にある字",
  off_page: "ページの見える範囲の外にある字",
  clipped: "切り取られて見えない字",
  invisible: "透明で見えない字",
  tiny: "小さすぎて見えない字",
  same_color: "背景と同じ色の字",
  covered_light: "白っぽい図形の下に隠れた字",
  squashed: "横につぶれて見えない字",
  same_color_image: "画像と同じ色の字",
  covered_image: "あとから重ねた画像の下に隠れた字",
  hidden_codepoint: "見えない文字コード",
  remapped: "見た目と取り出される字が違う字",
  overdrawn: "同じ所に重ねて描いた、違う字",
  image_off_page: "ページの外に置いた画像",
  image_clipped: "切り抜きで大部分を隠した画像",
};

/** 見える字の中の隠し（検出ルール 1.1.0 から）は、見出しと理由を分ける。文言・深刻度は【仮】 */
const P7_VISIBLE_KIND: Partial<Record<P7Reason, { title: string; why: string; severity: "high" | "medium" }>> = {
  hidden_codepoint: {
    title: "見えない文字コードが入っています",
    why: "画面には出ませんが、コピーや検索、AI に読ませたときに、見えない印や指示として取り出されます。",
    severity: "medium",
  },
  remapped: {
    title: "見た目と、コピーで取り出される字が違います",
    why: "画面で読める字とは別の字が、検索やコピーで取り出されます。",
    severity: "high",
  },
  overdrawn: {
    title: "同じ所に、違う字が重ねて描かれています",
    why: "上に重なった字しか読めませんが、下の字も検索やコピーで取り出せます。",
    severity: "high",
  },
  // 見えない所に置いた画像（検出ルール 1.2.0 から）。字ではないので、字の数は出さない
  image_off_page: {
    // 検出ルール 1.4.0 から、大部分（見える所が半分以下）がページの外にはみ出した画像も含む
    title: "ページの外に、画像の全部か大部分が置かれています",
    why: "ページの外の部分は画面や印刷には出ませんが、画像を取り出すと見えます。消し忘れの画像でないか、確かめてください。",
    severity: "medium",
  },
  image_clipped: {
    title: "画像の大部分が、切り抜きで隠されています",
    why: "見えているのは画像のごく一部ですが、画像を取り出すと隠れた所も見えます。確かめてください。",
    severity: "medium",
  },
};

const P7_SHOWN_AS_P6 = new Set<P7Reason>(["covered_light", "covered_image"]);

const p7 = defineRule<P7Report>({
  id: "p7-hidden",
  label: "隠れたテキスト",
  pattern: "P7",
  // 1ページの命令の数の上限は、P6 とそろえる（2026-11-03 本人が決定。PR #31 の返事 5）。
  // P7 の既定の値（rules/p7-hidden）は検出ルールの担当の範囲なので変えず、画面から呼ぶときだけ上書きする。
  detect: (b, ctx) => detectP7Hidden(b, { settings: { maxOperations: P6_SETTINGS.maxOperationsPerPage }, ...(ctx.withContents ? { includeText: true } : {}) }),
  // 覆いの下の字（白っぽい図形・あとから重ねた画像）は、色によらず見せかけの黒塗り（P6）で出すので、画面では P7 に出さない（2026-11-05）。
  // 検出ルールの報告には残す（P7 の正解データと検証器は、これらを P7 として数える）
  items: (r) =>
    r.findings.filter((f) => !P7_SHOWN_AS_P6.has(f.reason)).map((f) => {
      const v = P7_VISIBLE_KIND[f.reason];
      return {
        pattern: "P7",
        // 字の報告は、読める本文が隠れているとき（検出ルール 1.5.0 の readable）だけ「高」。
        // 表の体裁・罫線・飾りのような、まとまって出る型は「中」（実物の公開 PDF で「高」の誤検知が多かったため。2026-11-05）【仮】
        severity: f.readable === false ? "medium" : (v?.severity ?? "high"),
        title: v?.title ?? "見えない字が残っています",
        why: v?.why ?? "画面では見えませんが、検索やコピーで取り出せます。",
        detail: f.reason === "image_off_page" || f.reason === "image_clipped" ? P7_REASON[f.reason] : `${P7_REASON[f.reason] ?? "見えない字"}／${f.chars}字`,
        page: f.page,
        rect: f.rect,
        ...contentOf(f.text),
      };
    }),
  // 文字認識の層のあるページ（検出ルール 1.1.0 の ocrLayerPages）は、漏れとは言い切れないので、お知らせ（info）として出す（2026-11-05）
  notices: (r) => [
    ...skippedNotices(r.skippedPages),
    ...(r.ocrLayerPages.length
      ? [
          {
            kind: "info" as const,
            message: "このページには、文字認識で読み取った字の層があります（検索やコピーのため）。見た目と違う字が入っていないか、必要なら確かめてください。",
            pages: r.ocrLayerPages,
          },
        ]
      : []),
  ],
});

// ---------------------------------------------------------------- P1 文書情報

// 欄の名前は、段ごとにそろえて 1 つの表から引く（sanitize/field-labels.ts）
const P1_KEY: Record<string, string> = {
  Title: INFO_LABEL.Title,
  Author: INFO_LABEL.Author,
  Subject: INFO_LABEL.Subject,
  Keywords: INFO_LABEL.Keywords,
  Creator: INFO_LABEL.Creator,
};

const p1 = defineRule<P1InfoReport>({
  id: "p1-info",
  label: "文書情報",
  pattern: "P1",
  detect: (b, ctx) => detectP1Info(b, values(ctx)),
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
      ...contentOf(f.value),
      field: f.key,
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
  dict_text: "字の入った情報",
  unused_form: "描かれない部品",
};

/** 字の中身を持たない構造の部品の呼び名（検出ルール 1.2.0 の cleanupOnly.parts） */
const P5_PART: Record<P5Part, string> = {
  font: "フォントの設定",
  font_file: "フォントの本体",
  cmap: "文字の対応表",
  color_profile: "色の設定",
  other: "そのほかの部品",
};

const P5_SEVERITY: Record<P5Compare, "high" | "medium" | "low"> = { differs: "high", uncompared: "medium", same: "low" };
const P5_WHY: Record<P5Compare, string> = {
  differs: "見た目は新しい版でも、修正する前の内容を取り出せます。今の版にない内容が入っています。",
  uncompared: "見た目は新しい版でも、修正する前の内容を取り出せます。今の版と同じ内容かは、比べられませんでした。",
  same: "今の版と同じ内容ですが、修正する前の版としてファイルの中に残っています。気になるときは「整える」で消せます。",
};

const p5 = defineRule<P5Report>({
  id: "p5-revisions",
  label: "旧版の残存",
  pattern: "P5",
  detect: (b) => detectP5Revisions(b),
  items: (r) => {
    const items: Item[] = r.findings.map((f) =>
      f.kind === "unused_form"
        ? {
            // 資源にあるが描かれない部品（検出ルール 1.3.0 から）【文言は仮】。前の版との違いを比べられないので「中」（2026-11-05 本人が決定）
            pattern: "P5" as const,
            severity: "medium" as const,
            title: "ページに描かれない部品に、字が入っています",
            why: "ページの部品として登録されていますが画面には出ないため、気づかないまま、中の字を取り出せます。",
            detail: P5_KIND.unused_form,
            page: null,
            rect: null,
          }
        : {
      pattern: "P5" as const,
      // 今の版にない字が残っているときだけ「高」。今の版と同じ中身なら「低」、比べられなければ「中」（検出ルール 1.4.0 の compare。2026-11-05）【仮】
      severity: P5_SEVERITY[f.compare ?? "uncompared"],
      title: `修正する前の版の「${P5_KIND[f.kind] ?? "中身"}」が、ファイルの中に残っています`,
      why: P5_WHY[f.compare ?? "uncompared"],
      detail: [f.revision !== null ? `${f.revision}番目の版` : "どの版か分からない部分", f.chars !== undefined ? `${f.chars}字` : ""]
        .filter(Boolean)
        .join("／"),
      page: null,
      rect: null,
    });
    // 字の中身を持たない構造の部品だけの残り（1.2.0）。漏れとは分けて「低」で1行だけ出し、片付けへ案内する。
    // フォント・対応表・色の設定のような、作った道具や使った字の手がかりになる部品があるときだけ出す。
    // ページの並び・目次の辞書・中身のない null のような「そのほかの部品」だけなら出さない（2026-11-05。増分更新でページを足しただけの PDF など）
    const c = r.cleanupOnly;
    if (c && c.count > 0 && (Object.keys(P5_PART) as P5Part[]).some((p) => p !== "other" && c.parts[p] > 0)) {
      const parts = (Object.keys(P5_PART) as P5Part[]).filter((p) => c.parts[p] > 0).map((p) => `${P5_PART[p]} ${c.parts[p]}個`);
      items.push({
        pattern: "P5",
        severity: "low", // 【仮】
        title: "使われていない部品が、ファイルの中に残っています（消せる残り）",
        why: "調べた範囲では字の中身は見つかりませんでしたが、作った道具や使った字の手がかりになることがあるので、「整える」で消せます。",
        detail: parts.join("／"),
        page: null,
        rect: null,
      });
    }
    return items;
  },
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

/** 添付の中で見つけた型の呼び名（用語集の言葉） */
const PATTERN_NAME: Record<string, string> = {
  P1: "文書情報（作成者など）",
  P2: "XMP メタデータ",
  P3: "ほかの団体の名前",
  P4: "ファイルパス",
  P5: "前の版の残り",
  P6: "見せかけの黒塗りの下の字",
  P7: "見えない文字",
  P8: "注釈・コメント",
  P10: "画像の位置情報など",
  P11: "フォームの入力値",
  P12: "スクリプト・外部動作",
  P13: "個人情報らしい字",
};

const p9 = defineRule<P9WithInner>({
  id: "p9-attach",
  label: "添付ファイル",
  pattern: "P9",
  async detect(b, ctx) {
    const report = await detectP9Attach(b, ctx.withContents ? { includeNames: true } : {});
    if (report.status !== "ok" || report.findings.length === 0) return { ...report, inner: [] };
    // 添付が PDF なら、ほかの検出ルール（この一覧の P9 以外）で中も調べる。中の添付は inspectAttachments が入れ子でたどる
    const detectors: InnerDetector[] = RULES.filter((r) => r.id !== "p9-attach").map((r) => async (bytes) => {
      const res = await r.run(bytes, ctx);
      if (res.status === "error") throw new Error("inner rule error");
      return res.items;
    });
    return { ...report, inner: await inspectAttachments(b, detectors) };
  },
  items: (r) =>
    r.findings.flatMap((f): Item[] => {
      const inner = r.inner.find((i) => i.object === f.object);
      const foundInside = inner?.kind === "pdf" && Object.values(inner.counts ?? {}).some((n) => n > 0);
      // 中の PDF で見つけた型ごとに、1 件ずつ足す（どの型が中にあるかを、型の番号で示す）
      const insideItems: Item[] =
        inner?.kind === "pdf"
          ? Object.entries(inner.counts ?? {})
              .filter(([p, n]) => n > 0 && p !== "P9")
              .map(([p, n]) => ({
                pattern: p as Pattern,
                severity: "medium" as const, // 【仮】
                title: `添付ファイルの PDF の中に、${PATTERN_NAME[p] ?? "見えない情報"}が残っています`,
                why: "添付を取り出して開くと、中の情報を読めます。",
                detail: [`${n} 件`, "場所：添付ファイルの中"].join("／"),
                page: f.page ?? null,
                rect: null,
              }))
          : [];
      return [{
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
        ...contentOf(f.name),
      }, ...insideItems];
    }),
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
  // 中身は、頼まれたときだけ includeText（rules/pii 0.1.3）で受ける（ほかの型と同じ出し方。2026-11-05）
  detect: (b, ctx) => detectPii(b, { settings: { maxOperations: P6_SETTINGS.maxOperationsPerPage }, ...(ctx.withContents ? { includeText: true } : {}) }),
  // 黒塗りの候補として示すだけ（決めるのは利用者）。型・場所・確からしさを出す（中身は、頼まれたときだけ content に）
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P13",
      severity: f.confidence === "high" ? "medium" : "low", // 【仮】
      title: `${PII_TYPE[f.type] ?? "個人情報"}らしい字があります（黒塗りの候補）`,
      why: "公開すると、本人が分かってしまうおそれがあります。黒塗りが要るかを確かめてください。",
      detail: `確からしさ：${f.confidence === "high" ? "高" : "確認"}（${PII_BASIS[f.basis] ?? "字の形から"}）／${f.chars}字${f.vertical ? "／縦書き" : ""}`,
      page: f.page,
      rect: f.rect,
      ...contentOf(f.text),
    })),
  notices: (r) => {
    const out = skippedNotices(
      r.skippedPages.map((s) => ({ page: s.page, reason: s.reason === "unreadable_page" || s.reason === "stream_too_large" ? s.reason : "heavy" })),
    );
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

// ---------------------------------------------------------------- P2 部品の XMP・アプリの私的データ

const P2_PARTS_KIND: Record<P2PartsFinding["kind"], { title: string; why: string; severity: Item["severity"] }> = {
  person: { title: "画像や部品に付いた作成の記録（XMP）に、名前が残っています", why: "画像や部品を取り出すと、作った人の名前を誰でも見られます。", severity: "medium" },
  path: { title: "画像や部品に付いた作成の記録に、パソコンのフォルダの名前が残っています", why: "元のファイルの置き場所から、使った人のログイン名などが分かります。", severity: "medium" },
  gps: { title: "画像や部品に付いた作成の記録に、位置情報（GPS）が残っています", why: "写真を撮った場所などが分かります。", severity: "high" },
  serial: { title: "画像に付いた作成の記録に、カメラの製造番号が残っています", why: "画像を取り出すと、撮った機械を特定できる番号を誰でも見られます。", severity: "medium" },
  camera: { title: "画像に付いた作成の記録に、カメラの機種が残っています", why: "画像を取り出すと、撮った機械の機種を誰でも見られます。", severity: "low" },
  private_data: { title: "作ったアプリの私的なデータ（編集用のデータ）が残っています", why: "見た目には出ませんが、元の編集用のデータに、作った人の名前や消した部分が入っていることがあります。", severity: "low" },
};
const P2_OWNER: Record<P2PartsFinding["owner"], string> = {
  image: "画像",
  form: "部品",
  properties: "レイヤーなど",
  page: "ページ",
  document: "文書",
  other: "そのほか",
  unreferenced: "どこからも使われていない所",
};

const p2Parts = defineRule<P2PartsReport>({
  id: "p2-parts",
  label: "部品の XMP・アプリのデータ",
  pattern: "P2",
  detect: (b, ctx) => detectP2Parts(b, values(ctx)),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: f.pattern,
      kind: f.kind,
      severity: P2_PARTS_KIND[f.kind].severity, // 【仮】
      title: f.source === "illustrator" && f.kind !== "private_data" ? (f.kind === "person" ? "作ったアプリの編集用のデータに、名前が残っています" : "作ったアプリの編集用のデータに、パソコンのフォルダの名前が残っています") : P2_PARTS_KIND[f.kind].title,
      why: P2_PARTS_KIND[f.kind].why,
      detail: [
        `場所：${P2_OWNER[f.owner]}`,
        f.kind === "private_data" ? (f.checked === false ? "中身は調べていません" : "") : f.kind === "gps" ? "緯度・経度" : `${f.chars}字`,
        f.parts > 1 ? `${f.parts} か所` : "",
      ]
        .filter(Boolean)
        .join("／"),
      page: null,
      rect: null,
      ...contentOf(f.value),
    })),
  notices: (r) => (r.limits.length ? [{ kind: "partial", message: "部品の作成の記録が大きすぎる・読めないため、一部は調べていません。", pages: [] }] : []),
});

// ---------------------------------------------------------------- P3 他組織名の混入

const p3 = defineRule<P3Report>({
  id: "p3-orgs",
  label: "他組織名の混入",
  pattern: "P3",
  detect: (b, ctx) => detectP3Orgs(b, values(ctx)),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P3",
      severity: "medium", // 【仮】
      title: "文書の題などに、本文と違う団体の名前が入っています",
      why: "ほかの団体の書類をひな形にしたとき、元の団体の名前が残ることがあります。確かめてください。",
      detail: [`場所：${f.source === "info" ? "文書情報" : "XMP メタデータ"}`, `${f.chars}字`].join("／"),
      page: null,
      rect: null,
      ...contentOf(f.value),
      field: f.field,
    })),
});

// ---------------------------------------------------------------- 描かれていない資源に残る画像

const unusedImages = defineRule<UnusedImageReport>({
  id: "unused-images",
  label: "描かれていない画像",
  pattern: "P5",
  detect: (b, ctx) => detectUnusedImages(b, ctx.imageDecoder ? { imageDecoder: ctx.imageDecoder } : {}),
  items: (r) =>
    r.findings.map((f): Item => ({
      pattern: "P5",
      // 【仮】ほとんど同じ＝墨消し前の元の画像のおそれ。比べられなかった同じ大きさのものは中
      severity: f.match === "similar" ? "high" : f.match === "uncompared" ? "medium" : "low",
      title:
        f.match === "similar"
          ? "描かれていない画像が残っています。墨消しする前の元の画像のおそれがあります"
          : "ページの資源に、描かれていない画像が残っています",
      why:
        f.match === "similar"
          ? "ページに描かれた画像とほとんど同じで、一部だけ違います。画像を取り出すと、塗る前の元の画像を見られることがあります。"
          : "画面には出ませんが、画像を取り出すと見られます。意図したものでなければ消してください。",
      detail: [
        `${f.width}×${f.height} 画素`,
        f.diffRatio !== undefined && f.match !== "no_same_size" ? `描かれた画像との違い：${(f.diffRatio * 100).toFixed(2)}%` : "",
        f.match === "uncompared" ? "描かれた画像と同じ大きさ（中身は比べられませんでした）" : "",
      ]
        .filter(Boolean)
        .join("／"),
      page: f.page,
      rect: null,
    })),
  notices: (r) => (r.limits.length ? [{ kind: "partial", message: "中身が多すぎる・読めない所があったため、一部の描く命令は調べていません。", pages: [] }] : []),
});

/** 画面で使う検出ルール。一覧には、この並びで出す */
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
  detect: (b, ctx) => detectP8Annot(b, values(ctx)),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P8",
      kind: f.hidden ? "hidden" : f.field,
      severity: f.hidden ? "high" : f.field === "AP" ? "low" : "medium", // 【仮】
      title: f.hidden
        ? "隠した注釈に、字が残っています"
        : f.field === "AP"
          ? "注釈の見た目の中だけに、字が入っています"
          : f.field === "T"
          ? "注釈の作成者欄に、名前が残っています"
          : "注釈に、コメントの字が入っています",
      why: f.hidden
        ? "画面には出ませんが、注釈の一覧やファイルの中を見ると読めます。"
        : f.field === "AP"
          ? "注釈の一覧には出ませんが、注釈を消さないかぎり、字として取り出せます。中身を確かめてください。"
          : f.field === "T"
          ? "注釈のプロパティを開くと、付けた人の名前（ログイン名など）を誰でも見られます。"
          : "注釈の一覧を開くと、誰でも読めます。意図したものでなければ消してください。",
      detail: [`欄：${P8_FIELD[f.field] ?? "欄"}`, `${f.chars}字`, `注釈 ${f.annotations} 個`, pagesNote(f.pages)].filter(Boolean).join("／"),
      page: f.pages[0] ?? null,
      rect: null,
      ...contentOf(f.value),
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
  detect: (b, ctx) => detectP2Xmp(b, values(ctx)),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: f.pattern,
      severity: P2_KIND[f.kind].severity, // 【仮】
      title: P2_KIND[f.kind].title,
      why: P2_KIND[f.kind].why,
      detail: f.kind === "history" ? `出来事 ${f.events ?? 0} 件` : f.kind === "gps" ? "緯度・経度" : `${f.chars}字`,
      page: null,
      rect: null,
      ...contentOf(f.value),
      field: f.field,
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
  detect: (b, ctx) => detectP10Exif(b, values(ctx)),
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
      ...contentOf(f.value),
    })),
  notices: (r) => (r.limits.length ? [{ kind: "partial", message: "読めない・大きすぎる写真があったため、一部の写真は調べていません。", pages: [] }] : []),
});

// ---------------------------------------------------------------- P11 フォームの値

const p11 = defineRule<P11Report>({
  id: "p11-forms",
  label: "フォームの入力値",
  pattern: "P11",
  detect: (b, ctx) => detectP11Forms(b, values(ctx)),
  items: (r) =>
    r.findings.map((f): Item => ({
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
      ...contentOf(f.value),
    })).concat(
      r.tooltips.map((t): Item => ({
        pattern: "P11",
        severity: "low", // 【仮】
        title: "フォームの欄の説明に、連絡先らしい字が入っています",
        why: "欄に指を当てたときに出る説明です。担当の人の名前や内線などが入っていないか確かめてください。",
        detail: [`欄：${t.key === "TU" ? "説明" : "書き出し用の名前"}`, `${t.chars}字`].join("／"),
        page: t.page,
        rect: null,
      })),
    ),
  notices: (r) => {
    const out: Notice[] = [];
    if (r.signatures.length) {
      const chars = r.signatures.filter((s) => s.key === "Name").reduce((a, s) => a + s.chars, 0);
      out.push({
        kind: "info",
        message: chars
          ? `電子署名に、署名した人の名前（${chars}字）が入っています。署名の情報は、署名を消さないかぎり残ります。`
          : "電子署名に、署名した人の連絡先が入っています。署名の情報は、署名を消さないかぎり残ります。",
        pages: [...new Set(r.signatures.map((s) => s.page).filter((p): p is number => p !== null))],
      });
    }
    if (r.limits.length) out.push({ kind: "partial", message: "フォームの欄が多すぎるため、途中までしか調べていません。", pages: [] });
    return out;
  },
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
      title: f.kind === "uri" && f.where === "annotation" ? "気をつける行き先のリンクが入っています" : `${P12_KIND[f.kind]}が入っています`,
      why:
        f.kind === "uri" && f.where === "annotation"
          ? "暗号化されない http・庁内のサーバー・ファイルなど、押すと気をつける場所が開くリンクです。行き先を確かめてください。"
          : "漏れではありませんが、開いた人のパソコンで動くことがあります。意図したものでなければ消してください。",
      detail: [`場所：${P12_WHERE[f.where]}`, f.count > 1 ? `${f.count} 個` : "", f.kind === "javascript" ? `${f.chars}字` : ""].filter(Boolean).join("／"),
      page: f.page,
      rect: null,
    })),
  notices: (r) => (r.limits.length ? [{ kind: "partial", message: "動作が多すぎるため、途中までしか調べていません。", pages: [] }] : []),
});

// ---------------------------------------------------------------- P4 ファイルパス・内部ホスト名

const P4_KIND: Record<P4Kind, { title: string; severity: Item["severity"]; unit: string }> = {
  user_path: { title: "パソコンのユーザーのフォルダの名前が残っています", severity: "medium", unit: "ユーザーの名前" },
  server: { title: "庁内のサーバーの名前が残っています", severity: "medium", unit: "サーバーの名前" },
  drive_path: { title: "パソコンのフォルダの場所が残っています", severity: "low", unit: "場所" },
};
const P4_WHERE: Record<P4Where, string> = { info: "文書情報", xmp: "XMP メタデータ", annotation: "注釈", link: "リンクの行き先", filespec: "ファイルの名前", body: "ページの字" };

const p4 = defineRule<P4Report>({
  id: "p4-paths",
  label: "ファイルパス・内部ホスト名",
  pattern: "P4",
  detect: (b, ctx) => detectP4Paths(b, values(ctx)),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P4",
      severity: P4_KIND[f.kind].severity, // 【仮】
      title: P4_KIND[f.kind].title,
      why: "作ったパソコンや、庁内のサーバーの場所が分かります。意図したものでなければ消してください。",
      detail: [`場所：${P4_WHERE[f.where]}`, `${P4_KIND[f.kind].unit}：${f.chars}字`, f.places > 1 ? `${f.places} か所` : ""].filter(Boolean).join("／"),
      page: f.page,
      rect: null,
      ...contentOf(f.value),
    })),
  notices: (r) => (r.skippedPages.length ? [{ kind: "skipped_pages", message: "このページは字を読めなかった・重すぎるため、ページの字の中のパスは調べていません。", pages: r.skippedPages, reason: "heavy" }] : []),
});

// ---------------------------------------------------------------- しおりの題・代わりの文字

const ALT_KIND: Record<AltKind, { title: string; why: string; severity: Item["severity"] }> = {
  actual_text_diff: {
    title: "描かれた字と違う「代わりの字」が入っています",
    why: "コピーや検索をすると、ページに見えている字ではなく、代わりの字が出てきます。",
    severity: "medium",
  },
  outline: {
    title: "しおりに、題が入っています",
    why: "画面の横のしおりの欄に見えます。中身が公開してよいものか確かめてください。",
    severity: "low",
  },
  alt: {
    title: "読み上げ用の説明が入っています",
    why: "読み上げのための大切な情報です。中身が公開してよいものか確かめてください。",
    severity: "low",
  },
};

const altText = defineRule<AltReport>({
  id: "alt-text",
  label: "しおりの題・代わりの文字",
  pattern: "P7",
  detect: (b) => detectAltText(b),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P7",
      severity: ALT_KIND[f.kind].severity, // 【仮】
      title: ALT_KIND[f.kind].title,
      why: ALT_KIND[f.kind].why,
      detail: [`${f.count} か所`, `${f.chars}字`, pagesNote(f.pages)].filter(Boolean).join("／"),
      page: f.pages[0] ?? null,
      rect: null,
    })),
  notices: (r) => (r.limits.length ? [{ kind: "partial", message: "しおり・構造・ページの中身が多すぎる・読めないため、途中までしか調べていません。", pages: [] }] : []),
});

// ---------------------------------------------------------------- 文書情報と XMP の食い違い

const DIFF_FIELD: Record<string, string> = { ...P1_KEY, Producer: INFO_LABEL.Producer };

const infoXmpDiff = defineRule<DiffReport>({
  id: "props-diff",
  label: "文書情報と XMP の食い違い",
  pattern: "P2",
  detect: (b) => detectInfoXmpDiff(b),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P2",
      severity: "medium", // 【仮】
      title: `「${DIFF_FIELD[f.field] ?? "欄"}」が、文書情報と XMP メタデータで違います`,
      why: "片方だけを直して、古い値がもう片方に残っているかもしれません。",
      detail: `文書情報：${f.infoChars}字／XMP：${f.xmpChars}字`,
      page: null,
      rect: null,
    })),
});

// ---------------------------------------------------------------- ページの縮小画像・XFA・C2PA

const extras = defineRule<ExtrasReport>({
  id: "extras",
  label: "ページの縮小画像",
  pattern: "P5",
  detect: (b) => detectExtras(b),
  // 縮小画像が、いまのページとほぼ同じ（same）なら出さない。違う（differs）なら「高」、比べられなかったら（unknown）これまでどおり「低」（検出ルール 1.1.0 から）
  items: (r) =>
    r.thumbnails.filter((t) => t.compare !== "same").map((t) => ({
      pattern: "P5",
      severity: t.compare === "differs" ? ("high" as const) : ("low" as const), // 【仮】
      title: t.compare === "differs" ? "ページの縮小画像が、いまのページの見た目と違います" : "ページの縮小画像が付いています",
      why:
        t.compare === "differs"
          ? "縮小画像に、いまのページにない見た目が残っています。差し替える前や、黒塗りする前のページかもしれません。"
          : "ページを差し替えたり黒塗りしたりしても、縮小画像は前の見た目のまま残ることがあります。確かめてください。",
      detail: [t.width && t.height ? `${t.width}×${t.height} 画素` : "", formatSize(t.bytes)].filter(Boolean).join("／"),
      page: t.page,
      rect: null,
    })),
  notices: (r) =>
    r.notices.map((n): Notice =>
      n.kind === "xfa"
        ? {
            kind: "info",
            message: n.dataChars
              ? `この PDF には、XFA という形のフォームがあり、入力した値（${n.dataChars}字）が入っています。中身が公開してよいものか、作ったソフトで確かめてください。`
              : "この PDF には、XFA という形のフォームがあります。入力した値が入っていないか、作ったソフトで確かめてください。",
            pages: [],
          }
        : {
            kind: "info",
            message: "この PDF には、画像などの来歴の情報（C2PA）が入っています。作った人や編集の記録が含まれることがあります。",
            pages: [],
          },
    ),
});

// ---------------------------------------------------------------- 書体に残った字形

const fontGlyphs = defineRule<FontGlyphReport>({
  id: "font-glyphs",
  label: "書体に残った字形",
  pattern: "P7",
  detect: (b) => detectFontGlyphs(b),
  items: (r) =>
    r.findings.map((f) => ({
      pattern: "P7",
      severity: "medium", // 【仮】
      title: "埋め込んだ書体に、どこにも描かれていない字の形が残っています",
      why: "前に書いてあって消した字（黒塗りの下だけにあった字など）の手がかりになることがあります。",
      detail: `余った字の形：${f.leftover} 個（書体の字の形 ${f.glyphs} 個のうち）${f.fontType === "type3" ? "／書体：Type3" : ""}`,
      page: null,
      rect: null,
    })),
});

/** 画面で使う検出ルール。一覧には、この並びで出す */
export const RULES: RuleEntry[] = [p6, p7, altText, fontGlyphs, p5, unusedImages, extras, p1, p3, p2, infoXmpDiff, p2Parts, p4, p9, p8, p11, p12, p10, pii];

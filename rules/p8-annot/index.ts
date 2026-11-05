// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P8（注釈・コメント）1.2.0：注釈に残った作成者欄（/T）と、内容（/Contents・/Subj・/RC）を見つける。
// Acrobat などで注釈を付けると、作成者欄に付けた人のログイン名（姓のローマ字など）が入る。
// 文書情報（P1 の /Info）を消しても、注釈の作成者欄は残る。
//
// 1件 ＝ 欄（T・Contents・Subj・RC）と値の組み1つ。同じ欄に同じ値を持つ注釈は、何個あっても1件にまとめ、
// 注釈の数とページを添える（全注釈で同じ作成者なら1件）。値そのものは返さない（字数だけ。includeValues のときだけ値も返す）。
// フォームの欄（/Widget）の /T は欄の名前なので見ない。吹き出し（/Popup）は親の注釈の欄を写したものなので見ない。
//
// 1.1.0：隠しの印（/F の Hidden・NoView）のある注釈は、hidden: true として別の件にする（画面に見えないため、より危ない）。
// 隠しの印のある注釈は、見た目のストリーム（/AP の /N）の中に描かれた字も数える（field: "AP"）。
// スタンプ注釈などで、字が /Contents になく、見た目の中だけにある型（隠したまま残ると、取り出せる）。
// 隠しでない注釈の見た目は、画面に見えている字なので、ふつうは数えない。読み取り専用・ロックの印は隠しではない。
// 1.2.0：隠しでない注釈でも、/Contents が無く（空で）、字が見た目の中だけにあるもの（スタンプなど）は、field: "AP"・hidden: false で数える。
// 注釈の一覧には何も出ないのに、注釈を消さないかぎり字が残り、取り出せるため（低い「確認してほしい所」）。リンクは見ない。
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString, decodePDFRawStream, type PDFContext, type PDFObject } from "pdf-lib";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { loadPdf } from "../shared/load.ts";
import { decodeTextBytes } from "../p1-info/index.ts";
import { appearanceStreams, countShownGlyphs, dictOf, hiddenFlagOf, streamData } from "../common/index.ts";

export const RULE_ID = "p8-annot";
export const RULE_VERSION = "1.2.0";

export const FIELDS = ["T", "Contents", "Subj", "RC", "AP"] as const;
export type P8Field = (typeof FIELDS)[number];

/** 1ページの注釈の数の上限。超えたページは、そこから先を見ずに limits に出す【仮の値】 */
export const MAX_ANNOTS_PER_PAGE = 10_000;
/** 1つの欄の値として読む長さの上限（字）。超えた分は数えない【仮の値】 */
const MAX_VALUE_CHARS = 100_000;

/**
 * 作成者欄（/T）に入っていても、人をたどれない決まり文句（見つける段の誤検知の型）。数えずに notCounted に回す。
 * 大文字と小文字は区別しない。数字だけの値（共通の ID）も数えない。
 */
export const GENERIC_AUTHORS = ["author", "user", "administrator", "admin", "ユーザー", "ユーザ"] as const;

export type P8Finding = {
  pattern: "P8";
  field: P8Field;
  /** 隠しの印（Hidden・NoView）のある注釈か。AP が false のときは、/Contents の無い注釈の見た目の字 */
  hidden: boolean;
  /** 値の字数（前後の空白を除く。AP は描かれる字の数） */
  chars: number;
  /** この値を持つ注釈の数 */
  annotations: number;
  /** この値を持つ注釈のあるページ（小さい順） */
  pages: number[];
  /** includeValues のときだけ。値そのもの。記録やログには使わない */
  value?: string;
};

export type P8NotCounted = { field: P8Field; reason: "generic_author" | "digits_only"; annotations: number };

/** 見た目のストリームとして読む大きさの上限（バイト）【仮の値】 */
const MAX_AP_BYTES = 4 * 1024 * 1024;

export type P8Report = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: { code: "empty" | "unreadable" | "encrypted"; message: string };
  pages: number | null;
  /** 見た注釈の数（Widget・Popup を除く） */
  annotations: number;
  /** そのうち、隠しの印のある注釈の数 */
  hiddenAnnotations: number;
  findings: P8Finding[];
  /** 値はあったが、決まり文句として数えなかったもの */
  notCounted: P8NotCounted[];
  /** 上限を超えて、見なかったページ */
  limits: Array<{ page: number; reason: "too_many_annotations" | "unreadable_page" }>;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { includeValues?: boolean };

function visible(text: string): string {
  return text.replace(/\u0000/g, "").trim();
}

/** リッチテキスト（/RC。XHTML）から字だけを取り出す。タグを外し、よく使う文字参照を戻す */
function richText(xml: string): string {
  return xml
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Math.min(0x10ffff, Number(d))))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Math.min(0x10ffff, parseInt(h, 16))))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function fieldText(ctx: PDFContext, field: P8Field, raw: PDFObject | undefined): string | null {
  const v = raw ? ctx.lookup(raw) : undefined;
  let text: string | null = null;
  if (v instanceof PDFString || v instanceof PDFHexString) text = decodeTextBytes(v.asBytes()).text;
  else if (field === "RC" && v instanceof PDFStream) {
    try {
      const bytes = v instanceof PDFRawStream ? decodePDFRawStream(v).decode() : v.getContents();
      text = decodeTextBytes(bytes.subarray(0, MAX_VALUE_CHARS * 4)).text;
    } catch {
      return null;
    }
  }
  if (text === null) return null;
  if (field === "RC") text = richText(text);
  const t = visible(text.slice(0, MAX_VALUE_CHARS));
  return t.length ? t : null;
}

/** 見た目のストリームに描かれた字（空白を除く）。なければ null */
function appearanceText(ctx: PDFContext, annot: PDFDict): string | null {
  let text = "";
  let glyphs = 0;
  for (const s of appearanceStreams(ctx, annot)) {
    const data = streamData(s, MAX_AP_BYTES);
    if (!data) continue;
    const c = countShownGlyphs(ctx, data, dictOf(ctx, s.dict.get(PDFName.of("Resources"))), { includeText: true });
    glyphs += c.glyphs;
    text += c.text;
  }
  if (glyphs === 0) return null;
  // 字の中身が分からない書体（ToUnicode なし）でも、字の数は数える。まとめる鍵には字の数を使う
  return text.length >= glyphs ? text : text + "0000".repeat(glyphs - [...text].length);
}

function genericReason(field: P8Field, value: string): P8NotCounted["reason"] | null {
  if (field !== "T") return null;
  if (/^[0-9０-９]+$/.test(value)) return "digits_only";
  const lower = value.toLowerCase();
  return (GENERIC_AUTHORS as readonly string[]).includes(lower) ? "generic_author" : null;
}

export async function detectP8Annot(bytes: Uint8Array, options: DetectOptions = {}): Promise<P8Report> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, annotations: 0, hiddenAnnotations: 0, findings: [], notCounted: [], limits: [] };
  if (bytes.length === 0) return { ...base, status: "error", pages: null, error: { code: "empty", message: "ファイルが空です。" } };
  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") {
    if (loaded.code === "encrypted") {
      const message = loaded.reason === "password_required" ? "パスワードが要る PDF は、調べられません。" : "この形の暗号化は、いまは調べられません。";
      return { ...base, status: "error", pages: null, error: { code: "encrypted", message } };
    }
    return { ...base, status: "error", pages: null, error: { code: "unreadable", message: "PDF として読めませんでした。" } };
  }
  const doc = loaded.doc;
  const ctx = doc.context;
  let pages;
  try {
    pages = doc.getPages();
  } catch {
    return { ...base, status: "error", pages: null, error: { code: "unreadable", message: "ページの並びを読めませんでした。" } };
  }

  const report: P8Report = { ...base, status: "ok", pages: pages.length, findings: [], notCounted: [], limits: [] };
  if (loaded.decrypted) report.decrypted = loaded.decrypted;
  const groups = new Map<string, { field: P8Field; hidden: boolean; value: string; annotations: number; pages: Set<number> }>();
  const skipped = new Map<string, P8NotCounted>();
  const seen = new Set<PDFObject>();

  pages.forEach((page, index) => {
    const pageNo = index + 1;
    try {
      const annots = page.node.lookup(PDFName.of("Annots"));
      if (!(annots instanceof PDFArray)) return;
      const list = annots.asArray();
      if (list.length > MAX_ANNOTS_PER_PAGE) report.limits.push({ page: pageNo, reason: "too_many_annotations" });
      for (const ref of list.slice(0, MAX_ANNOTS_PER_PAGE)) {
        if (seen.has(ref)) continue; // 同じ注釈を2つのページが指していても、1回だけ数える
        seen.add(ref);
        const annot = ctx.lookup(ref);
        if (!(annot instanceof PDFDict)) continue;
        const st = annot.lookup(PDFName.of("Subtype"));
        const subtype = st instanceof PDFName ? st.decodeText() : "";
        if (subtype === "Widget" || subtype === "Popup") continue;
        report.annotations++;
        const hidden = hiddenFlagOf(ctx, annot) !== null;
        if (hidden) report.hiddenAnnotations++;
        for (const field of FIELDS) {
          const value =
            field === "AP"
              ? hidden || (subtype !== "Link" && !fieldText(ctx, "Contents", annot.get(PDFName.of("Contents")))?.trim())
                ? appearanceText(ctx, annot)
                : null
              : fieldText(ctx, field, annot.get(PDFName.of(field)));
          if (value === null) continue;
          const reason = genericReason(field, value);
          if (reason) {
            const k = `${field}\u0000${reason}`;
            const s = skipped.get(k) ?? { field, reason, annotations: 0 };
            s.annotations++;
            skipped.set(k, s);
            continue;
          }
          const k = `${field}\u0000${hidden}\u0000${value}`;
          const g = groups.get(k) ?? { field, hidden, value, annotations: 0, pages: new Set<number>() };
          g.annotations++;
          g.pages.add(pageNo);
          groups.set(k, g);
        }
      }
    } catch {
      report.limits.push({ page: pageNo, reason: "unreadable_page" });
    }
  });

  for (const g of groups.values()) {
    const f: P8Finding = { pattern: "P8", field: g.field, hidden: g.hidden, chars: [...g.value].length, annotations: g.annotations, pages: [...g.pages].sort((a, b) => a - b) };
    if (options.includeValues) f.value = g.value;
    report.findings.push(f);
  }
  report.findings.sort(
    (a, b) => Number(b.hidden) - Number(a.hidden) || FIELDS.indexOf(a.field) - FIELDS.indexOf(b.field) || (a.pages[0] ?? 0) - (b.pages[0] ?? 0),
  );
  report.notCounted = [...skipped.values()];
  return report;
}

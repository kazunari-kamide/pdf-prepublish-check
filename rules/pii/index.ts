// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：見える文字の中の、日本語の個人情報らしい字（rules/pii）。
// 公開の前に、黒塗りが要りそうな所を「候補」として示す。決めるのは利用者（目視の確認の見落としを防ぐ補助）。
// 決まったルールだけで動く（AI・送信なし）。字の中身は返さない（型・ページ・箱・確からしさ・件数だけ）。
//
// 探す型：氏名らしい並び、住所、電話番号、マイナンバー（検査用の数字まで確かめる）、口座番号、生年月日（和暦も）、メールアドレス、カード番号。
// 法人番号（13 けた）は公表されている番号なので、候補にせず「除いたもの」として数える。
// 前の版（増分更新の前の中身）にも同じルールをかけられるよう、findPiiInContent を P5 の側から呼べる形で出す。

import { PDFDict, PDFName, type PDFContext } from "pdf-lib";
import { loadPdf } from "../shared/load.ts";
import { DEFAULT_LINE_SETTINGS, buildLines, rectOfRange, type Line, type LineSettings } from "./lines.ts";
import {
  PII_TYPES,
  columnKindOf,
  scanCell,
  scanLine,
  type Basis,
  type ColumnKind,
  type Confidence,
  type ExcludeReason,
  type Hit,
  type PiiType,
} from "./patterns.ts";
import { TooManyOperations, extractText, pageContent, type ExtractSettings, type Glyph, type Rect } from "./text.ts";

export const RULE_ID = "pii";
export const RULE_VERSION = "0.1.0";

export { PII_TYPES, type PiiType, type Confidence, type Basis, type ExcludeReason };
export type { Rect };

export const DEFAULT_SETTINGS = {
  /** 1ページの命令の数の上限。超えたページは省く（P6・P7 の画面での上限と同じ 300 万） */
  maxOperations: 3_000_000,
  maxFormDepth: 12,
  /** 1ページから読む字の数の上限 */
  maxGlyphs: 200_000,
  /** 調べるページの数の上限。超えた分は省いたページとして返す */
  maxPages: 3_000,
  /** 表の見出しを探す、上への距離の上限（ポイント） */
  columnHeaderMaxDistance: 800,
  line: DEFAULT_LINE_SETTINGS as LineSettings,
};
export type PiiSettings = typeof DEFAULT_SETTINGS;

export type PiiFinding = {
  type: PiiType;
  page: number;
  /** 候補の字の箱。ページの既定の座標（ポイント、左下が原点、/Rotate はかけない）。黒塗りの候補の枠に使える */
  rect: Rect;
  /** high＝前後の語・表の見出しが型を指している、check＝形は合うが手がかりが弱い（確かめてもらう） */
  confidence: Confidence;
  basis: Basis;
  /** 字数（空白を除く）。中身は返さない */
  chars: number;
  /** 縦書きか */
  vertical: boolean;
};

export type PiiSkipReason = "too_many_operations" | "unreadable_page" | "page_limit";

export type PiiCounts = {
  total: number;
  high: number;
  check: number;
  byType: Record<PiiType, { high: number; check: number }>;
};

export type PiiReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: { code: "unreadable" | "encrypted"; message: string };
  decrypted?: unknown;
  pages: number;
  findings: PiiFinding[];
  counts: PiiCounts;
  /** 形は合ったが、候補から除いたもの（理由ごとの数） */
  excluded: Record<ExcludeReason, number>;
  skippedPages: Array<{ page: number; reason: PiiSkipReason }>;
  /** 中身を引けない字（ToUnicode のない書体など）があったページと字数。ここは探せていない */
  unreadable: { pages: number[]; glyphs: number };
  /** 字が多すぎて途中までしか読まなかったページ */
  truncatedPages: number[];
};

export type DetectOptions = { settings?: Partial<PiiSettings> };

const emptyCounts = (): PiiCounts => ({
  total: 0,
  high: 0,
  check: 0,
  byType: Object.fromEntries(PII_TYPES.map((t) => [t, { high: 0, check: 0 }])) as PiiCounts["byType"],
});
const emptyExcluded = (): Record<ExcludeReason, number> => ({
  sample: 0,
  role: 0,
  organization: 0,
  heading: 0,
  office_contact: 0,
  free_dial: 0,
  corporate_number: 0,
  date_like: 0,
  placeholder: 0,
});

function countOf(findings: Array<{ type: PiiType; confidence: Confidence }>): PiiCounts {
  const c = emptyCounts();
  for (const f of findings) {
    c.total++;
    c[f.confidence]++;
    c.byType[f.type][f.confidence]++;
  }
  return c;
}

const overlapRatio = (a: Rect, b: Rect) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const small = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  return small > 0 ? (w * h) / small : 0;
};

type Segment = { line: Line; start: number; end: number; rect: Rect; text: string };

/** 行を、区切り（\t。表の別の欄）で欄に分ける */
function segmentsOf(lines: Line[]): Segment[] {
  const out: Segment[] = [];
  for (const line of lines) {
    let s = 0;
    for (let k = 0; k <= line.text.length; k++) {
      if (k === line.text.length || line.text[k] === "\t") {
        if (k > s) {
          const rect = rectOfRange(line, s, k);
          if (rect) out.push({ line, start: s, end: k, rect, text: line.text.slice(s, k) });
        }
        s = k + 1;
      }
    }
  }
  return out;
}

type PageResult = { findings: Omit<PiiFinding, "page">[]; excluded: Array<{ reason: ExcludeReason }> };

/** 集めた字（1ページぶん）から探す */
export function scanGlyphs(glyphs: Glyph[], settings: PiiSettings = DEFAULT_SETTINGS): PageResult {
  const lines = buildLines(glyphs, settings.line);
  const findings: PageResult["findings"] = [];
  const excluded: PageResult["excluded"] = [];
  const push = (line: Line, h: Hit, offset = 0) => {
    const rect = rectOfRange(line, offset + h.start, offset + h.end);
    if (!rect) return;
    const same = findings.find((f) => f.type === h.type && overlapRatio(f.rect, rect) >= 0.5);
    if (same) {
      // 行で「確認」とした所に、表の見出しが型を指していれば「高」に上げる
      if (same.confidence === "check" && h.confidence === "high") {
        same.confidence = "high";
        same.basis = h.basis;
      }
      return;
    }
    const chars = [...line.text.slice(offset + h.start, offset + h.end)].filter((c) => c.trim() !== "").length;
    findings.push({ type: h.type, rect, confidence: h.confidence, basis: h.basis, chars, vertical: line.dir === "v" || line.dir === "vu" });
  };

  // 1. 行ごと（前後の語を手がかりにする）
  for (const line of lines) {
    const r = scanLine(line.text);
    for (const h of r.hits) push(line, h);
    for (const e of r.excluded) excluded.push({ reason: e.reason });
  }

  // 2. 表の列（横書きだけ）：上に「氏名」「住所」などの見出しがある欄を、その型の値として確かめる
  const segs = segmentsOf(lines.filter((l) => l.dir === "h"));
  const headers = segs.map((s) => ({ s, kind: columnKindOf(s.text) })).filter((x): x is { s: Segment; kind: ColumnKind } => x.kind !== null);
  if (headers.length) {
    for (const seg of segs) {
      if (columnKindOf(seg.text) !== null) continue;
      let best: { kind: ColumnKind; dist: number } | null = null;
      for (const h of headers) {
        const dist = h.s.rect[1] - seg.rect[3];
        if (dist < -seg.line.size * 0.2 || dist > settings.columnHeaderMaxDistance) continue; // 見出しは上にある
        const ox = Math.min(h.s.rect[2], seg.rect[2]) - Math.max(h.s.rect[0], seg.rect[0]);
        const minW = Math.min(h.s.rect[2] - h.s.rect[0], seg.rect[2] - seg.rect[0]);
        if (ox <= 0 || ox < minW * 0.5) continue;
        if (!best || dist < best.dist) best = { kind: h.kind, dist };
      }
      if (!best) continue;
      const r = scanCell(seg.text, best.kind, seg.line.text);
      for (const hit of r.hits) push(seg.line, hit, seg.start);
      for (const e of r.excluded) excluded.push({ reason: e.reason });
    }
  }
  return { findings, excluded };
}

function extractSettings(s: PiiSettings): ExtractSettings {
  return { maxOperations: s.maxOperations, maxFormDepth: s.maxFormDepth, maxGlyphs: s.maxGlyphs };
}

/** PDF を読み、すべてのページから探す */
export async function detectPii(bytes: Uint8Array, options: DetectOptions = {}): Promise<PiiReport> {
  const settings: PiiSettings = { ...DEFAULT_SETTINGS, ...options.settings, line: { ...DEFAULT_SETTINGS.line, ...options.settings?.line } };
  const report: PiiReport = {
    rule: { id: RULE_ID, version: RULE_VERSION },
    status: "ok",
    pages: 0,
    findings: [],
    counts: emptyCounts(),
    excluded: emptyExcluded(),
    skippedPages: [],
    unreadable: { pages: [], glyphs: 0 },
    truncatedPages: [],
  };
  const loaded = await loadPdf(bytes);
  if (loaded.status !== "ok") {
    report.status = "error";
    report.error =
      loaded.code === "encrypted"
        ? { code: "encrypted", message: "パスワードがかかっているため、調べられませんでした。" }
        : { code: "unreadable", message: "PDF として読めなかったため、調べられませんでした。" };
    return report;
  }
  if (loaded.decrypted) report.decrypted = loaded.decrypted;
  const doc = loaded.doc;
  const ctx = doc.context;
  let pages;
  try {
    pages = doc.getPages();
  } catch {
    report.status = "error";
    report.error = { code: "unreadable", message: "ページの並びを読めなかったため、調べられませんでした。" };
    return report;
  }
  report.pages = pages.length;
  for (let i = 0; i < pages.length; i++) {
    const pageNo = i + 1;
    if (i >= settings.maxPages) {
      report.skippedPages.push({ page: pageNo, reason: "page_limit" });
      continue;
    }
    try {
      const node = pages[i]!.node;
      const res = node.Resources();
      const content = pageContent(ctx, node.get(PDFName.of("Contents")));
      const text = extractText(ctx, content, res instanceof PDFDict ? res : undefined, extractSettings(settings));
      if (text.unreadable > 0) {
        report.unreadable.pages.push(pageNo);
        report.unreadable.glyphs += text.unreadable;
      }
      if (text.truncated) report.truncatedPages.push(pageNo);
      const r = scanGlyphs(text.glyphs, settings);
      for (const f of r.findings) report.findings.push({ ...f, page: pageNo });
      for (const e of r.excluded) report.excluded[e.reason]++;
    } catch (e) {
      report.skippedPages.push({ page: pageNo, reason: e instanceof TooManyOperations ? "too_many_operations" : "unreadable_page" });
    }
  }
  report.counts = countOf(report.findings);
  return report;
}

/**
 * 前の版（増分更新の前の中身）など、ページ1つぶんの描く命令の列から探す。P5 の側から呼ぶための入口（26 項目の 21）。
 * 返すのは型ごとの件数だけ（場所は、前の版のページの上の場所で、今の版の画面には描けないため）。
 *   ctx       … その中身を読んだ PDF の文脈（pdf-lib の PDFContext）
 *   content   … ほどいた描く命令の列（/Contents をつないだもの）
 *   resources … その版のページの資源の辞書（/Font・/XObject を引く）。なければ字の中身を引けず、0 件になる
 */
export function findPiiInContent(
  ctx: PDFContext,
  content: Uint8Array,
  resources: PDFDict | undefined,
  options: DetectOptions = {},
): { status: "ok" | "skipped"; counts: PiiCounts; excluded: Record<ExcludeReason, number>; unreadableGlyphs: number } {
  const settings: PiiSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const excluded = emptyExcluded();
  try {
    const text = extractText(ctx, content, resources, extractSettings(settings));
    const r = scanGlyphs(text.glyphs, settings);
    for (const e of r.excluded) excluded[e.reason]++;
    return { status: "ok", counts: countOf(r.findings), excluded, unreadableGlyphs: text.unreadable };
  } catch {
    return { status: "skipped", counts: emptyCounts(), excluded, unreadableGlyphs: 0 };
  }
}

/** 字の並び（改行で行に分ける）から探す。文書情報の欄・注釈の中身など、場所のない字に使う。件数だけを返す */
export function findPiiInText(text: string): { counts: PiiCounts; excluded: Record<ExcludeReason, number> } {
  const excluded = emptyExcluded();
  const hits: Array<{ type: PiiType; confidence: Confidence }> = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const r = scanLine(line);
    hits.push(...r.hits);
    for (const e of r.excluded) excluded[e.reason]++;
  }
  return { counts: countOf(hits), excluded };
}

/** 件数だけの形（実物の PDF で測るときに使う。場所・字の中身は入れない） */
export function countsOnly(report: PiiReport) {
  return {
    rule: report.rule,
    status: report.status,
    pages: report.pages,
    counts: report.counts,
    excluded: report.excluded,
    skippedPages: report.skippedPages.length,
    unreadablePages: report.unreadable.pages.length,
  };
}

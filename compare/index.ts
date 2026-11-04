// SPDX-License-Identifier: AGPL-3.0-only
//
// 2つの PDF（元の PDF と公開する PDF、または片付けの前と後）を比べる。画面からも、コマンドの道具からも呼べる
// （Node の API を使わない）。返すのは数と場所と欄の名前だけで、字の中身・欄の値は返さない。
//
// ① 消したはずの字：公開する PDF の濃い覆い（黒い四角・黒い画像・墨消しの注釈など）の下にある、元の PDF の字が、
//    公開する PDF でも、覆いより先に描いた字として、ほぼ同じ所に残っているか。
//    覆いのあとに同じ字を描き直したもの（上に見えている字）は数えない。
// ② 文書情報（P1）と XMP の、欄ごとの違い（足された・消えた・変わった・同じ）
// ③ 前の版の数（P5）・添付ファイルの数（P9）・注釈の数の違い
//
// ページは番号で対応させる（元の n ページ目と、公開する PDF の n ページ目）。

import { PDFArray, PDFName, PDFRawStream, PDFStream, decodePDFRawStream, type PDFDocument } from "pdf-lib";
import { detectP1Info } from "../rules/p1-info/index.ts";
import { detectP5Revisions } from "../rules/p5-revisions/index.ts";
import { scanAnnotations } from "../rules/p6-text/annotations.ts";
import { glyphKey } from "../rules/p6-text/filters.ts";
import { IDENTITY, area, intersectionArea, type Rect } from "../rules/p6-text/geometry.ts";
import { TooManyCovers, TooManyOperations, contentBytes, coverageOf, createPageScanner, type Cover, type GlyphBox } from "../rules/p6-text/page.ts";
import { DEFAULT_SETTINGS, type P6TextSettings } from "../rules/p6-text/settings.ts";
import { detectP9Attach } from "../rules/p9-attach/index.ts";
import { loadPdf } from "../rules/shared/load.ts";

export const COMPARE_VERSION = "0.1.0";

/** 覆いに、字の箱のこの割合以上が隠れていれば「覆いの下」とみなす（P6 の coveredFractionMin とそろえる） */
const COVERED_MIN = DEFAULT_SETTINGS.coveredFractionMin;
/** 同じ字が「ほぼ同じ所」にあるとみなす、真ん中どうしのずれの上限（字の高さに対する割合と、ポイントの下限） */
const SAME_PLACE_RATIO = 0.5;
const SAME_PLACE_MIN_PT = 2;
/** 注釈の数を数えるページあたりの上限 */
const MAX_ANNOTS_PER_PAGE = 10_000;
/** XMP の大きさの上限（バイト） */
const MAX_XMP_BYTES = 4 * 1024 * 1024;

export type Side = "before" | "after";

export type RemainingSpot = {
  /** 公開する PDF の覆いの箱（ページの既定の座標） */
  rect: Rect;
  /** 覆いの種類（P6 と同じ。fill＝塗り、image＝濃い画像、annotation＝注釈） */
  cover: Cover["kind"];
  /** 覆いの下に残っている、元の PDF の字の数（空白は数えない） */
  chars: number;
};

export type PageCompare = {
  page: number;
  /** 取り出せる字の数（空白は数えない） */
  beforeChars: number;
  afterChars: number;
  /**
   * 公開する PDF の濃い覆いの下に、覆いより先に描いた字として残っている、元の PDF の字の数（消したはずの字が残っている）。
   * 覆いの下に字がない覆いは、P6 の読み取りがその場で捨てるので、正しく消した所は覆いとしても数えない
   */
  remainingChars: number;
  /** 覆いと関係なく、元にあって公開する PDF にない字の数（書き換え・削除も含む。字の中身ごとに数を比べる） */
  goneChars: number;
  /** 残っている所（覆いごと） */
  remaining: RemainingSpot[];
};

export type FieldChange = "added" | "removed" | "changed" | "same";

export type InfoFieldCompare = {
  /** 決まった欄（Title・Author・Subject・Keywords・Creator）の名前。独自の欄は名前が手がかりになりうるので null */
  key: string | null;
  change: FieldChange;
  beforeChars: number | null;
  afterChars: number | null;
};

export type XmpFieldCompare = {
  /** よく使う名前空間（dc・xmp・pdf など）の項目の名前。それ以外は null */
  name: string | null;
  change: FieldChange;
};

export type CountCompare = { before: number | null; after: number | null };

export type CompareReport = {
  version: string;
  status: "ok" | "error";
  /** どちらかを読めなかったとき */
  error?: { side: Side; code: "empty" | "unreadable" | "encrypted"; message: string };
  pages: { before: number; after: number };
  text: {
    pages: PageCompare[];
    remainingChars: number;
    goneChars: number;
    /** 比べなかったページ（図形が多すぎる・読めない）。「残っていない」ではない */
    skippedPages: Array<{ page: number; side: Side; reason: "heavy" | "unreadable" }>;
    /** ページの数が違うとき、比べなかった後ろのページの数 */
    unmatchedPages: number;
  };
  info: { fields: InfoFieldCompare[]; error: Side[] };
  xmp: { before: number | null; after: number | null; fields: XmpFieldCompare[] };
  counts: { revisions: CountCompare; attachments: CountCompare; annotations: CountCompare };
};

// ---------------------------------------------------------------- ① 消したはずの字

type PageRead = { glyphs: GlyphBox[]; covers: Cover[] } | { skipped: "heavy" | "unreadable" };

function readPage(doc: PDFDocument, index: number, settings: P6TextSettings): PageRead {
  try {
    const node = doc.getPage(index).node;
    const scanner = createPageScanner(doc.context, settings);
    scanner.run(contentBytes(doc.context, node.Contents()), node.Resources(), IDENTITY, "fill");
    scanAnnotations(doc.context, node.Annots(), scanner, settings);
    const scan = scanner.result();
    return {
      glyphs: scan.glyphs.filter((g) => !g.isSpace && glyphKey(g) !== ""),
      covers: scan.covers.filter((c) => c.tone === "dark"),
    };
  } catch (e) {
    return { skipped: e instanceof TooManyOperations || e instanceof TooManyCovers ? "heavy" : "unreadable" };
  }
}

const center = (r: Rect): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];

function samePlace(a: GlyphBox, b: GlyphBox): boolean {
  const [ax, ay] = center(a.rect);
  const [bx, by] = center(b.rect);
  const h = Math.max(a.rect[3] - a.rect[1], b.rect[3] - b.rect[1]);
  const tol = Math.max(SAME_PLACE_MIN_PT, h * SAME_PLACE_RATIO);
  return Math.abs(ax - bx) <= tol && Math.abs(ay - by) <= tol;
}

function isUnder(cover: Cover, g: GlyphBox): boolean {
  const a = area(g.rect);
  if (a <= 0 || intersectionArea(g.rect, cover.rect) <= 0) return false;
  return coverageOf(cover, g.rect) / a >= COVERED_MIN;
}

/** 元にあって公開する PDF にない字の数（字の中身ごとに数を比べる） */
function gone(before: GlyphBox[], after: GlyphBox[]): number {
  const m = new Map<string, number>();
  for (const g of after) m.set(glyphKey(g), (m.get(glyphKey(g)) ?? 0) + 1);
  let n = 0;
  for (const g of before) {
    const k = glyphKey(g);
    const c = m.get(k) ?? 0;
    if (c > 0) m.set(k, c - 1);
    else n++;
  }
  return n;
}

/** 1ページ分を比べる。元の字を1つずつ、最初に重なった覆いに割り当てる（重なった覆いで二重に数えない） */
export function comparePage(page: number, before: GlyphBox[], after: { glyphs: GlyphBox[]; covers: Cover[] }): PageCompare {
  const afterByKey = new Map<string, GlyphBox[]>();
  for (const g of after.glyphs) {
    const k = glyphKey(g);
    const list = afterByKey.get(k);
    if (list) list.push(g);
    else afterByKey.set(k, [g]);
  }
  const used = new Set<GlyphBox>();
  const spots = new Map<Cover, number>();
  let remaining = 0;
  const covers = [...after.covers].sort((a, b) => a.seq - b.seq);
  for (const g of before) {
    const cover = covers.find((c) => isUnder(c, g));
    if (!cover) continue;
    const candidates = (afterByKey.get(glyphKey(g)) ?? []).filter((h) => !used.has(h) && samePlace(g, h));
    // 覆いのあとに同じ字を描き直したもの（上に見えている字）があれば、下の写しは「消したはずの字」ではない（P6 の same_text_on_top とそろえる）
    const onTop = candidates.find((h) => h.seq > cover.seq);
    const under = candidates.find((h) => h.seq < cover.seq && isUnder(cover, h));
    if (onTop) {
      used.add(onTop);
      if (under) used.add(under);
      continue;
    }
    // 覆いより先に描いた、覆いの下の字（上に見えていない字）
    if (under) {
      used.add(under);
      remaining++;
      spots.set(cover, (spots.get(cover) ?? 0) + 1);
    }
  }
  // 同じ所を重ねて覆っている覆い（四角と縁の線など）は1つにまとめる
  const merged: RemainingSpot[] = [];
  for (const [cover, chars] of spots) {
    const same = merged.find((m) => {
      const small = Math.min(area(m.rect), area(cover.rect));
      return small > 0 && intersectionArea(m.rect, cover.rect) / small >= 0.9;
    });
    if (same) same.chars += chars;
    else merged.push({ rect: cover.rect.map((v) => Math.round(v * 100) / 100) as Rect, cover: cover.kind, chars });
  }
  return {
    page,
    beforeChars: before.length,
    afterChars: after.glyphs.length,
    remainingChars: remaining,
    goneChars: gone(before, after.glyphs),
    remaining: merged,
  };
}

// ---------------------------------------------------------------- ② 文書情報と XMP

const STANDARD_INFO = new Set(["Title", "Author", "Subject", "Keywords", "Creator"]);

async function infoFields(bytes: Uint8Array): Promise<Map<string, string> | null> {
  const r = await detectP1Info(bytes, { includeValues: true });
  if (r.status !== "ok") return null;
  return new Map(r.findings.map((f) => [f.key, f.value ?? ""]));
}

function diffFields<T>(before: Map<string, T>, after: Map<string, T>, same: (a: T, b: T) => boolean): Array<{ key: string; change: FieldChange; a?: T; b?: T }> {
  const out: Array<{ key: string; change: FieldChange; a?: T; b?: T }> = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(key);
    const b = after.get(key);
    const change: FieldChange = a === undefined ? "added" : b === undefined ? "removed" : same(a, b) ? "same" : "changed";
    out.push({ key, change, ...(a !== undefined ? { a } : {}), ...(b !== undefined ? { b } : {}) });
  }
  return out;
}

const XMP_KNOWN = new Set([
  "dc", "xmp", "xap", "pdf", "pdfx", "pdfaid", "xmpMM", "xapMM", "xmpRights", "xapRights", "photoshop", "tiff", "exif", "exifEX",
  "aux", "crs", "stRef", "stEvt", "xmpTPg", "xmpGImg", "illustrator", "iptc4xmpCore", "Iptc4xmpCore", "Iptc4xmpExt", "plus", "lr",
]);
const XMP_SKIP = new Set(["rdf", "x", "xml", "xmlns"]);

function readXmp(doc: PDFDocument): string | null {
  const meta = doc.catalog.lookup(PDFName.of("Metadata"));
  if (!(meta instanceof PDFStream)) return null;
  let data: Uint8Array;
  try {
    data = meta instanceof PDFRawStream ? decodePDFRawStream(meta).decode() : meta.getContents();
  } catch {
    return null;
  }
  if (data.length > MAX_XMP_BYTES) data = data.subarray(0, MAX_XMP_BYTES);
  return new TextDecoder("utf-8").decode(data);
}

/**
 * XMP の項目（rdf:Description の直下の要素と属性）の名前と、比べるための中身。
 * 中身は比べるためだけに使い、返さない
 */
export function xmpProperties(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const tag = /<(\/?)([A-Za-z_][\w.-]*:[\w.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const attr = /([A-Za-z_][\w.-]*:[\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  // 深さ：rdf:Description の中にいる間は、その直下の要素を1つの項目として、閉じるまでの字をまとめる
  let inDesc = 0;
  let current: { name: string; start: number; depth: number } | null = null;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    const [, close, name, rest, self] = m;
    if (!name) continue;
    if (name === "rdf:Description") {
      if (close) inDesc = Math.max(0, inDesc - 1);
      else {
        for (const a of rest!.matchAll(attr)) {
          const n = a[1]!;
          if (!XMP_SKIP.has(n.split(":")[0]!)) out.set(n, a[3] ?? a[4] ?? "");
        }
        if (!self) inDesc++;
      }
      continue;
    }
    if (!inDesc) continue;
    if (close) {
      depth--;
      if (current && depth === current.depth) {
        out.set(current.name, (out.get(current.name) ?? "") + xml.slice(current.start, m.index));
        current = null;
      }
      continue;
    }
    if (!current && !XMP_SKIP.has(name.split(":")[0]!)) {
      if (self) {
        out.set(name, (out.get(name) ?? "") + rest);
        continue;
      }
      current = { name, start: m.index + m[0].length, depth };
    }
    if (!self) depth++;
  }
  return out;
}

// ---------------------------------------------------------------- ③ 数

function countAnnotations(doc: PDFDocument): number {
  let n = 0;
  for (const p of doc.getPages()) {
    const annots = p.node.lookup(PDFName.of("Annots"));
    if (annots instanceof PDFArray) n += Math.min(annots.size(), MAX_ANNOTS_PER_PAGE);
  }
  return n;
}

async function safely<T>(f: () => Promise<T> | T): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 入口

const LOAD_MESSAGE = {
  empty: "ファイルが空です。",
  unreadable: "PDF として読めませんでした。",
  encrypted: "パスワードが要る PDF か、いまは調べられない形の暗号化です。",
} as const;

export async function comparePdfs(before: Uint8Array, after: Uint8Array, options: { settings?: Partial<P6TextSettings> } = {}): Promise<CompareReport> {
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const empty: CompareReport = {
    version: COMPARE_VERSION,
    status: "error",
    pages: { before: 0, after: 0 },
    text: { pages: [], remainingChars: 0, goneChars: 0, skippedPages: [], unmatchedPages: 0 },
    info: { fields: [], error: [] },
    xmp: { before: null, after: null, fields: [] },
    counts: { revisions: { before: null, after: null }, attachments: { before: null, after: null }, annotations: { before: null, after: null } },
  };
  const docs: Partial<Record<Side, PDFDocument>> = {};
  for (const [side, bytes] of [["before", before], ["after", after]] as const) {
    if (bytes.length === 0) return { ...empty, error: { side, code: "empty", message: LOAD_MESSAGE.empty } };
    const loaded = await loadPdf(bytes.slice());
    if (loaded.status !== "ok") return { ...empty, error: { side, code: loaded.code, message: LOAD_MESSAGE[loaded.code] } };
    docs[side] = loaded.doc;
  }
  const a = docs.before!;
  const b = docs.after!;
  const report: CompareReport = { ...empty, status: "ok", pages: { before: a.getPageCount(), after: b.getPageCount() } };

  // ① 消したはずの字
  const n = Math.min(report.pages.before, report.pages.after);
  report.text.unmatchedPages = Math.max(report.pages.before, report.pages.after) - n;
  for (let i = 0; i < n; i++) {
    const ra = readPage(a, i, settings);
    const rb = readPage(b, i, settings);
    if ("skipped" in ra) report.text.skippedPages.push({ page: i + 1, side: "before", reason: ra.skipped });
    if ("skipped" in rb) report.text.skippedPages.push({ page: i + 1, side: "after", reason: rb.skipped });
    if ("skipped" in ra || "skipped" in rb) continue;
    const pc = comparePage(i + 1, ra.glyphs, rb);
    report.text.pages.push(pc);
    report.text.remainingChars += pc.remainingChars;
    report.text.goneChars += pc.goneChars;
  }

  // ② 文書情報
  const [ia, ib] = await Promise.all([safely(() => infoFields(before.slice())), safely(() => infoFields(after.slice()))]);
  if (ia === null) report.info.error.push("before");
  if (ib === null) report.info.error.push("after");
  if (ia && ib) {
    report.info.fields = diffFields(ia, ib, (x, y) => x === y).map((d) => ({
      key: STANDARD_INFO.has(d.key) ? d.key : null,
      change: d.change,
      beforeChars: d.a !== undefined ? [...d.a].length : null,
      afterChars: d.b !== undefined ? [...d.b].length : null,
    }));
  }
  // XMP
  const xa = readXmp(a);
  const xb = readXmp(b);
  const pa = xa !== null ? xmpProperties(xa) : new Map<string, string>();
  const pb = xb !== null ? xmpProperties(xb) : new Map<string, string>();
  report.xmp.before = xa !== null ? pa.size : null;
  report.xmp.after = xb !== null ? pb.size : null;
  report.xmp.fields = diffFields(pa, pb, (x, y) => x.replace(/\s+/g, " ").trim() === y.replace(/\s+/g, " ").trim()).map((d) => ({
    name: XMP_KNOWN.has(d.key.split(":")[0]!) ? d.key : null,
    change: d.change,
  }));

  // ③ 数
  const [p5a, p5b, p9a, p9b] = await Promise.all([
    safely(() => detectP5Revisions(before.slice())),
    safely(() => detectP5Revisions(after.slice())),
    safely(() => detectP9Attach(before.slice())),
    safely(() => detectP9Attach(after.slice())),
  ]);
  report.counts.revisions = { before: p5a?.status === "ok" ? p5a.revisions : null, after: p5b?.status === "ok" ? p5b.revisions : null };
  report.counts.attachments = { before: p9a?.status === "ok" ? p9a.findings.length : null, after: p9b?.status === "ok" ? p9b.findings.length : null };
  report.counts.annotations = { before: await safely(() => countAnnotations(a)), after: await safely(() => countAnnotations(b)) };
  return report;
}

/** 比べた結果の要約。remaining＝消したはずの字が残っている、incomplete＝比べられなかった所がある（両方のこともある） */
export function compareOutcome(r: CompareReport): { remaining: boolean; incomplete: boolean } {
  if (r.status !== "ok") return { remaining: false, incomplete: true };
  const incomplete =
    r.text.skippedPages.length > 0 ||
    r.text.unmatchedPages > 0 ||
    r.info.error.length > 0 ||
    Object.values(r.counts).some((c) => c.before === null || c.after === null);
  return { remaining: r.text.remainingChars > 0, incomplete };
}

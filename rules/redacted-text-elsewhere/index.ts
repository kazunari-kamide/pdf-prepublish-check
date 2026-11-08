// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：塗った下の字が、ほかの所に出ている（`redacted-text-elsewhere`）1.0.0。型は P6（見せかけの黒塗り）の仲間【仮】。
//
// 黒い四角の下に字が残っている（p6-text の文字の層。または p7-hidden の same_color で、濃い塗りの上に同じ濃い色で置いた字）とき、その字と同じ並びが、同じ書類の塗られていない所
// （どれかのページの見える字・文書情報・XMP・しおり・注釈・フォームの値）にも出ている所を返す。
// 「整える」で四角の下の字を消しても、ほかの所に出ている同じ字は残るので、整えたあとも情報は読めてしまう。
//
// 決まり（決定的。字の意味は読まない）：
//   1. 塗った下の字を集める。p6-text の文字の層（四角の前に描いた字）と、p7-hidden の same_color で under が dark のもの
//      （黒い四角の上に黒い字を置いた形。見た目は黒塗りだが、p6-text は「上の字」として数えない）。1 件ごとに正規化する
//      （NFKC・空白を外す・黒四角や黒丸などの塗りの記号を外す。STRIP）。
//   2. 塗られていない所の字も同じく正規化する。ページの字は、1 で使った塗りの箱と、p6-text が見つけた覆い（画像の層など）の
//      箱の中に中心がある字を外して読む。
//   3. 覆われた字の中の、minChars 字以上の並びで、字（漢字・かな・ローマ字。\p{L}）を letterMin 字以上ふくむものが、
//      塗られていない所にそのまま出ていれば、1 件にする。
// 返すのは、塗った所のページ・箱・字の数・いちばん長く一致した字の数と、出ている所の種類とページ番号だけ。
// 字そのものは、呼ぶ側が includeText を頼んだときだけ返す（画面の中だけで使う）。
//
// 「整える」のあと（probes を渡したとき）：整える前に取り出した、覆われた字（probes）を、整えたあとの PDF の
// 塗られていない所で探す。整えたあとの PDF には、もう四角の下の字が無いので、整える前の字を使う。
// probes は検査の Worker の中だけに置き、画面・ネットワークには出さない（src/worker/inspect.worker.ts）。

import { PDFArray, PDFDict, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { detectP6Text, type P6Finding, type P6TextReport } from "../p6-text/index.ts";
import { detectP7Hidden, type P7Finding, type P7Report } from "../p7-hidden/index.ts";
import type { ExternalImageDecoder } from "../shared/pdfjs-images.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { extractText, pageContent } from "../pii/text.ts";
import { PAGE_TEXT_LIMITS, MAX_TEXT_PAGES } from "../common/page-text.ts";
import { arrayItems, bytesToText, catalogOf, dictOf, lookup, N, openPdf, streamData, textOf, type RuleError } from "../common/index.ts";
import type { Rect } from "../p6-text/geometry.ts";

export const RULE_ID = "redacted-text-elsewhere";
export const RULE_VERSION = "1.0.0";

/** しきい【仮の値。実物の当たりと誤検知を測って決める】 */
export const SETTINGS = {
  /**
   * 一致とみなす並びの、いちばん短い字の数【仮】。実物の A1（17 書類・19 か所）は、3 字で 19 か所すべて、4 字で 7 か所だった
   * （地名・名字は 2〜3 字が多い）。誤検知は、3 字で 700 件中 1 件・4 字で 0 件（PR の採点表）。どちらにするかは人が決める
   */
  minChars: 3,
  /** 並びの中に、字（\p{L}）がこの数以上あること（数字・記号だけの並びは数えない） */
  letterMin: 1,
  /** 覆われた字を見る長さの上限（1 件あたり） */
  maxProbeChars: 400,
  /** 塗られていない所の字の合計の上限（超えた分は読まない。limits に入れる） */
  maxCorpusChars: 3_000_000,
  /** しおり・注釈・フォームの欄をたどる数の上限 */
  maxNodes: 20_000,
  /** XMP を読む大きさの上限（バイト） */
  maxXmpBytes: 4_000_000,
  /**
   * 黒い四角の上に黒い字を置いた形（p7-hidden の same_color・dark）は、下の塗りが字を囲む程度の大きさのときだけ使う。
   * 塗りの箱の高さが字の箱の高さのこの倍まで、面積がこの倍まで（1.0.0。実物の A1 は高さ・面積とも約 1.3 倍、
   * 誤検知の形〈濃い帯・背景の上の字〉は高さ 2〜8 倍だった。面積は、字より広めに塗る形のために、ゆるめにしてある）
   */
  tightHeight: 1.6,
  tightArea: 4,
} as const;

export type Settings = { [K in keyof typeof SETTINGS]: number };

/** 出ている所の種類 */
export type Where = "page" | "info" | "xmp" | "outline" | "annotation" | "form";

/** 整える前に取り出した、覆われた字（Worker の中だけで持つ） */
export type UnderProbe = { page: number; rect: Rect; text: string };

export type ElsewhereFinding = {
  pattern: "P6";
  /** 塗った所のページと箱（p6-text と同じ座標） */
  page: number;
  rect: Rect;
  /** 覆われた字の数（正規化したあと） */
  chars: number;
  /** いちばん長く一致した並びの字の数 */
  matchedChars: number;
  /** 出ている所。page のときは pages にページ番号 */
  where: Where[];
  pages: number[];
  /** after＝整える前に取り出した字で探した（整えたあとの読み直し） */
  source: "now" | "before";
  /** includeText のときだけ。いちばん長く一致した並び。記録・ログには使わない */
  text?: string;
};

export type ElsewhereReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  pages: number | null;
  findings: ElsewhereFinding[];
  /** 字を読めなかったページ（命令が多すぎる・読めない）。ここで出ている同じ字は見ていない */
  skippedPages: number[];
  /** 上限に当たった所 */
  limits: Array<"pages" | "corpus" | "nodes">;
  /** p6-text が字を読めずに省いたページ（覆いの下の字を取り出していない） */
  coverSkippedPages: number[];
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = {
  settings?: Partial<Settings>;
  includeText?: boolean;
  imageDecoder?: ExternalImageDecoder;
  /** 整える前に取り出した覆われた字（整えたあとの読み直しのときだけ） */
  probes?: UnderProbe[];
  /** 取り出した覆われた字を受け取る（整える前の検査のときだけ。Worker が覚えておく） */
  onProbes?: (probes: UnderProbe[]) => void;
  /**
   * 呼ぶ側が先に作った p6-text・p7-hidden の報告（includeText で作ったもの）。渡せば、ルールの中でもう一度読まない
   * （画面の検査で、同じ PDF を 2 回読まないため。src/inspect/rules.ts）
   */
  p6Report?: P6TextReport;
  p7Report?: P7Report;
};

// 塗りの記号（黒四角・白四角・小さな四角・黒丸・ひし形）は、番号から作る。ビルドの出力に字のまま入れると、
// 画面の書体の字の確かめ（scripts/check-dist.mjs）に掛かるため（画面には出さない字）
const MARKS = [0x25a0, 0x25a1, 0x25aa, 0x25ab, 0x25cf, 0x25c6, 0x25c7].map((c) => String.fromCodePoint(c)).join("");
const STRIP = new RegExp("[\\s\\u3000\\u00a0\\u200b-\\u200d\\ufeff" + MARKS + "]", "gu");

/** 比べるための正規化（NFKC・空白と塗りの記号を外す） */
export function normalize(s: string): string {
  return s.normalize("NFKC").replace(STRIP, "");
}

const LETTER = /\p{L}/u;

/** 並びが、数字・記号だけでないか（字が letterMin 以上） */
function hasLetters(chars: string[], letterMin: number): boolean {
  let n = 0;
  for (const c of chars) if (LETTER.test(c) && ++n >= letterMin) return true;
  return false;
}

const inRect = (x: number, y: number, r: Rect) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

type Place = { where: Where; page?: number; text: string };

const height = (r: Rect) => r[3] - r[1];
const areaOf = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);

/** 黒い四角が字をぴったり囲んでいるか（濃い帯・背景の上の字ではないか） */
function tight(f: P7Finding, s: Settings): boolean {
  const b = f.underBox;
  if (!b || !(height(f.rect) > 0) || !(areaOf(f.rect) > 0)) return false;
  return height(b) <= height(f.rect) * s.tightHeight && areaOf(b) <= areaOf(f.rect) * s.tightArea;
}

/** 塗った下の字を probe にする（p6-text の文字の層と、p7-hidden の濃い塗りの上の同じ色の字） */
function probesOf(p6: P6Finding[], p7: P7Finding[], s: Settings): UnderProbe[] {
  const max = s.maxProbeChars;
  const out: UnderProbe[] = [];
  const src = [
    // 濃い覆い（黒塗り）で、確からしさが high のものだけ。濃くない不透明な覆い（coverTone: opaque。スライドの地・白や色の帯など）と、
    // check（見出しの帯・番号札の形など）の下の字は、実物の束で、見出しや表の欄の名前がほかのページにも出る形の当たりばかりだった
    ...p6
      .filter((f) => f.layer === "text" && f.coverTone !== "opaque" && f.confidence === "high")
      .map((f) => ({ page: f.page, rect: f.rect, text: (f as { text?: string }).text })),
    ...p7.filter((f) => f.reason === "same_color" && f.under === "dark" && tight(f, s)).map((f) => ({ page: f.page, rect: f.rect, text: f.text })),
  ];
  for (const f of src) {
    if (typeof f.text !== "string") continue;
    const t = [...normalize(f.text)].slice(0, max).join("");
    if (t) out.push({ page: f.page, rect: f.rect, text: t });
  }
  return out;
}

/** 文書情報・XMP・しおり・注釈・フォームの値の字を集める */
function sidePlaces(ctx: PDFContext, settings: Settings, limits: Set<ElsewhereReport["limits"][number]>): Place[] {
  const out: Place[] = [];
  const push = (where: Where, s: string | null) => {
    if (s) {
      const t = normalize(s);
      if (t) out.push({ where, text: t });
    }
  };
  let nodes = 0;
  const budget = () => {
    if (++nodes > settings.maxNodes) {
      limits.add("nodes");
      return false;
    }
    return true;
  };

  // 文書情報（/Info）
  const info = dictOf(ctx, ctx.trailerInfo.Info);
  if (info) for (const [, v] of info.entries()) push("info", textOf(ctx, v));

  const cat = catalogOf(ctx);
  // XMP：タグを外した字
  const meta = lookup(ctx, cat?.get(N("Metadata")));
  if (meta instanceof PDFStream) {
    const data = streamData(meta, settings.maxXmpBytes);
    if (data) push("xmp", bytesToText(data).text.replace(/<[^>]*>/g, " "));
  }

  // しおり（/Outlines）：/First・/Next をたどる
  const seen = new Set<PDFObject>();
  const walkOutline = (o: PDFObject | undefined, depth: number) => {
    let cur = o;
    while (cur && !seen.has(cur) && depth < 64) {
      seen.add(cur);
      if (!budget()) return;
      const d = dictOf(ctx, cur);
      if (!d) return;
      push("outline", textOf(ctx, d.get(N("Title"))));
      walkOutline(d.get(N("First")), depth + 1);
      cur = d.get(N("Next"));
    }
  };
  const outlines = dictOf(ctx, cat?.get(N("Outlines")));
  if (outlines) walkOutline(outlines.get(N("First")), 0);

  // フォームの欄（/AcroForm の /Fields と /Kids）：値と名前
  const walkField = (o: PDFObject | undefined, depth: number) => {
    if (!o || seen.has(o) || depth > 32 || !budget()) return;
    seen.add(o);
    const d = dictOf(ctx, o);
    if (!d) return;
    push("form", textOf(ctx, d.get(N("V"))));
    push("form", textOf(ctx, d.get(N("TU"))));
    for (const k of arrayItems(ctx, d.get(N("Kids")))) walkField(k, depth + 1);
  };
  const acro = dictOf(ctx, cat?.get(N("AcroForm")));
  if (acro) for (const f of arrayItems(ctx, acro.get(N("Fields")))) walkField(f, 0);
  return out;
}

/** 注釈の字（/Contents・/T・/Subj）。ページごと */
function annotPlaces(ctx: PDFContext, annots: PDFObject | undefined, page: number, budget: () => boolean): Place[] {
  const out: Place[] = [];
  const arr = lookup(ctx, annots);
  if (!(arr instanceof PDFArray)) return out;
  for (const a of arr.asArray()) {
    if (!budget()) break;
    const d = dictOf(ctx, a);
    if (!(d instanceof PDFDict)) continue;
    for (const k of ["Contents", "T", "Subj"]) {
      const s = textOf(ctx, d.get(N(k)));
      if (s) {
        const t = normalize(s);
        if (t) out.push({ where: "annotation", page, text: t });
      }
    }
  }
  return out;
}

/** 長さ L の並びの索引（並び → 出ている所の番号） */
function buildIndex(places: Place[], L: number): Map<string, Set<number>> {
  const idx = new Map<string, Set<number>>();
  places.forEach((p, i) => {
    const cs = [...p.text];
    for (let s = 0; s + L <= cs.length; s++) {
      const k = cs.slice(s, s + L).join("");
      let set = idx.get(k);
      if (!set) idx.set(k, (set = new Set()));
      set.add(i);
    }
  });
  return idx;
}

/** probe 1 つを、塗られていない所で探す */
function matchProbe(probe: UnderProbe, places: Place[], idx: Map<string, Set<number>>, settings: Settings): { len: number; text: string; hit: Set<number> } | null {
  const cs = [...probe.text];
  const L = settings.minChars;
  let best: { len: number; text: string; hit: Set<number> } | null = null;
  for (let s = 0; s + L <= cs.length; s++) {
    const win = cs.slice(s, s + L);
    if (!hasLetters(win, settings.letterMin)) continue;
    const at = idx.get(win.join(""));
    if (!at) continue;
    const hit: Set<number> = best?.hit ?? new Set<number>();
    for (const i of at) hit.add(i);
    // 伸ばせるだけ伸ばす（出ている所の字の中に、そのまま含まれる間）
    let len = L;
    while (s + len < cs.length) {
      const longer = cs.slice(s, s + len + 1).join("");
      if (![...at].some((i) => places[i]!.text.includes(longer))) break;
      len++;
    }
    if (!best || len > best.len) best = { len, text: cs.slice(s, s + len).join(""), hit };
    else best.hit = hit;
  }
  return best;
}

export async function detectRedactedTextElsewhere(bytes: Uint8Array, options: DetectOptions = {}): Promise<ElsewhereReport> {
  const settings: Settings = { ...SETTINGS, ...options.settings };
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], skippedPages: [], limits: [], coverSkippedPages: [] };

  // 1. 覆われた字（p6-text の文字の層）。字はこのルールの中だけで使う
  const p6 = options.p6Report ?? (await detectP6Text(bytes, { includeText: true, ...(options.imageDecoder ? { imageDecoder: options.imageDecoder } : {}) }));
  if (p6.status === "error") {
    const e = p6.error ?? { code: "unreadable" as const, message: "PDF として読めませんでした。" };
    return { ...base, status: "error", pages: null, error: e };
  }
  const p7 = options.p7Report ?? (await detectP7Hidden(bytes, { includeText: true }));
  const p7Findings = p7.status === "ok" ? p7.findings : [];
  const nowProbes = probesOf(p6.findings, p7Findings, settings);
  options.onProbes?.(nowProbes);
  const beforeProbes = options.probes ?? [];
  const report: ElsewhereReport = { ...base, status: "ok", pages: p6.pages, findings: [], skippedPages: [], limits: [], coverSkippedPages: p6.skippedPages.map((s) => s.page) };
  if (p6.decrypted) report.decrypted = p6.decrypted;
  if (nowProbes.length === 0 && beforeProbes.length === 0) return report;

  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", pages: null, error: opened.error };
  const { doc, ctx } = opened;
  const limits = new Set<ElsewhereReport["limits"][number]>();

  // 2. 塗られていない所の字
  const coversByPage = new Map<number, Rect[]>();
  for (const f of p6.findings) coversByPage.set(f.page, [...(coversByPage.get(f.page) ?? []), f.rect]);
  for (const p of nowProbes) coversByPage.set(p.page, [...(coversByPage.get(p.page) ?? []), p.rect]);
  const places: Place[] = [];
  let corpus = 0;
  let nodes = 0;
  const budget = () => {
    if (++nodes > settings.maxNodes) {
      limits.add("nodes");
      return false;
    }
    return true;
  };
  let pages;
  try {
    pages = doc.getPages();
  } catch {
    return { ...base, status: "error", pages: null, error: { code: "unreadable", message: "ページの並びを読めませんでした。" } };
  }
  for (let i = 0; i < pages.length; i++) {
    const pageNo = i + 1;
    if (i >= MAX_TEXT_PAGES) {
      limits.add("pages");
      report.skippedPages.push(pageNo);
      continue;
    }
    const node = pages[i]!.node;
    try {
      const t = extractText(ctx, pageContent(ctx, node.Contents()), node.Resources(), PAGE_TEXT_LIMITS);
      const covers = coversByPage.get(pageNo) ?? [];
      let s = "";
      for (const g of t.glyphs) {
        const cx = (g.rect[0] + g.rect[2]) / 2;
        const cy = (g.rect[1] + g.rect[3]) / 2;
        if (covers.some((r) => inRect(cx, cy, r))) continue; // 黒い四角の下の字は、塗られていない所に数えない
        s += g.text;
      }
      const text = normalize(s);
      if (corpus + text.length > settings.maxCorpusChars) {
        limits.add("corpus");
        report.skippedPages.push(pageNo);
        continue;
      }
      corpus += text.length;
      if (text) places.push({ where: "page", page: pageNo, text });
    } catch {
      report.skippedPages.push(pageNo);
    }
    places.push(...annotPlaces(ctx, node.get(N("Annots")), pageNo, budget));
  }
  places.push(...sidePlaces(ctx, settings, limits));
  report.limits = [...limits];

  // 3. 照らし合わせ
  const idx = buildIndex(places, settings.minChars);
  const add = (probe: UnderProbe, source: ElsewhereFinding["source"]) => {
    const m = matchProbe(probe, places, idx, settings);
    if (!m) return;
    const hitPlaces = [...m.hit].map((i) => places[i]!);
    const where = [...new Set(hitPlaces.map((p) => p.where))];
    const pagesHit = [...new Set(hitPlaces.filter((p) => p.where === "page" && p.page !== undefined).map((p) => p.page!))].sort((a, b) => a - b);
    // 同じ所（同じページ・ほぼ同じ箱）は 1 件にまとめる
    const same = report.findings.find((f) => f.page === probe.page && f.rect.every((v, k) => Math.abs(v - probe.rect[k]!) < 1));
    if (same) {
      same.matchedChars = Math.max(same.matchedChars, m.len);
      return;
    }
    report.findings.push({
      pattern: "P6",
      page: probe.page,
      rect: probe.rect,
      chars: [...probe.text].length,
      matchedChars: m.len,
      where,
      pages: pagesHit,
      source,
      ...(options.includeText ? { text: m.text } : {}),
    });
  };
  for (const p of nowProbes) add(p, "now");
  for (const p of beforeProbes) add(p, "before");
  return report;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// プロパティの一覧（26 項目の 20）と、文書情報と XMP の食い違い（26 項目の 25）1.0.0。
//
// listProperties：文書情報（Info）と XMP（文書全体）のすべての欄を、**中身ごと**返す入口。
//   プロパティについては「値を画面に出さない」決まりを外す（26 項目の 20。値は利用者の画面にだけ出て、外には出ない）。
//   画面（B）が一覧を作り、その場で「消す」へ案内する。ここは「欄の名前・値・どこにあったか・印」を返す関数まで。
//   値の中の団体名らしい語（〇〇市・〇〇町・〇〇県・〇〇課・株式会社 など）に印（marks）を付ける。
//   団体名の一覧は持たず、比べもしない。字の並びの形だけで印を付ける（orgMarks）。
// detectInfoXmpDiff：作成者・タイトルなどが Info と XMP で違うものを返す（片方だけ直して、古い値が残った疑い）。値は返さない。

import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString, type PDFContext, type PDFObject } from "pdf-lib";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { decodeTextBytes } from "../p1-info/index.ts";
import { catalogXmp } from "../p2-xmp/index.ts";
import { xmpValues } from "../p2-parts/index.ts";
import { dictOf, lookup, openPdf, visibleText, type RuleError } from "../common/index.ts";

export const RULE_ID = "props";
export const RULE_VERSION = "1.0.0";

// ---------------------------------------------------------------- 団体名らしい語の印

export type Mark = { start: number; end: number; kind: "org" };

/** 後ろに付くと団体名らしい字 */
const SUFFIX = new Set(["市", "町", "村", "区", "県", "都", "府", "道", "課", "室", "係", "局", "部", "庁"]);
/** 後ろの字と次の字で、ふつうの言葉になるもの（市場・町内など）。この並びなら印を付けない */
const NEXT_WORDS = new Set([
  "市場", "市民", "市販", "市街", "市況", "町内", "町会", "町並", "都合", "都度", "都市", "区分", "区別", "区域", "区間", "区切",
  "課題", "課程", "課金", "課税", "室内", "室温", "係数", "係争", "局面", "局所", "局地", "部分", "部品", "部屋", "部数", "部材",
  "部位", "県内", "村落", "道路", "道具", "道筋", "府内", "庁舎",
]);
/** 言葉そのものがふつうの言葉で、団体名でないもの（地区・全部など）。前の字と後ろの字の組み */
const WORDS = new Set([
  "都市", "地区", "全部", "一部", "内部", "外部", "上部", "下部", "細部", "幹部", "日課", "教室", "和室", "寝室", "浴室", "会議室",
  "関係", "大部", "頭部", "胸部", "腹部", "全国都", "首都", "古都", "都道府県", "道府県", "府県", "水道", "歩道", "報道", "書道",
  "柔道", "剣道", "茶道", "華道", "鉄道", "国道", "県道", "市道", "片道", "近道", "坂道", "北海", "結局", "薬局", "郵便局", "当局",
  "支局", "事務局", "放送局",
]);
const RUN = /[\p{Script=Han}\p{Script=Katakana}ー々]/u;
const COMPANY = ["株式会社", "有限会社", "合同会社", "一般社団法人", "公益社団法人", "一般財団法人", "公益財団法人", "社会福祉法人", "特定非営利活動法人"];
/** 前の字の並びを見る長さ */
const MAX_RUN = 8;

/**
 * 字の並びの形だけで、団体名らしい語に印を付ける。団体名の一覧は持たない。
 * - 〇〇市・〇〇町・〇〇村・〇〇区・〇〇県・〇〇都・〇〇府・〇〇課・〇〇室・〇〇係・〇〇局・〇〇部・〇〇庁（前に漢字・カタカナが 1 字以上）
 * - 〇〇道は「北海道」だけ（水道・報道などが多いため）
 * - 株式会社などの会社・法人の言葉と、その前後の漢字・カタカナ
 * - 市場・町内・都合・地区・全部など、ふつうの言葉は除く（NEXT_WORDS・WORDS）
 */
export function orgMarks(text: string): Mark[] {
  const chars = [...text];
  const marks: Mark[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (!SUFFIX.has(c)) continue;
    const next = chars[i + 1] ?? "";
    if (NEXT_WORDS.has(c + next)) continue;
    let s = i;
    while (s > 0 && i - s < MAX_RUN && RUN.test(chars[s - 1]!) && !SUFFIX.has(chars[s - 1]!)) s--;
    if (s === i) continue; // 前に字が無い（「市」だけ）
    const word = chars.slice(s, i + 1).join("");
    if (c === "道" && !word.endsWith("北海道")) continue;
    if ([...WORDS].some((w) => word.endsWith(w))) continue; // 「地区」「大阪地区」「教室」など、ふつうの言葉で終わるもの
    marks.push({ start: s, end: i + 1, kind: "org" });
  }
  for (const co of COMPANY) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(co, from);
      if (at < 0) break;
      const start = [...text.slice(0, at)].length;
      let s = start;
      while (s > 0 && start - s < 12 && RUN.test(chars[s - 1]!)) s--;
      let e = start + [...co].length;
      while (e < chars.length && e - start - [...co].length < 12 && RUN.test(chars[e]!)) e++;
      marks.push({ start: s, end: e, kind: "org" });
      from = at + co.length;
    }
  }
  // 重なった印をまとめる
  marks.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Mark[] = [];
  for (const m of marks) {
    const last = out[out.length - 1];
    if (last && m.start <= last.end) last.end = Math.max(last.end, m.end);
    else out.push({ ...m });
  }
  return out;
}

// ---------------------------------------------------------------- プロパティの一覧

export type Property = {
  /** info＝文書情報（/Info）、xmp＝文書全体の XMP */
  source: "info" | "xmp";
  /** 欄の名前（Info は Author など、XMP は dc:creator など） */
  name: string;
  /** 値そのもの（画面にだけ出す。記録やログには使わない） */
  value: string;
  /** 団体名らしい語の印（value の中の字の位置。サロゲートペアも 1 字と数える） */
  marks: Mark[];
};

export type PropertiesResult =
  | { status: "ok"; properties: Property[]; decrypted: (EncryptionSummary & { failedObjects: number }) | null }
  | { status: "error"; error: RuleError };

function infoValue(ctx: PDFContext, raw: PDFObject | undefined): string | null {
  const v = lookup(ctx, raw);
  if (v instanceof PDFString || v instanceof PDFHexString) return decodeTextBytes(v.asBytes()).text;
  if (v instanceof PDFName) return v.decodeText();
  if (v instanceof PDFNumber || v instanceof PDFBool) return v.toString();
  if (v instanceof PDFArray) return v.asArray().map((x) => infoValue(ctx, x) ?? "").filter(Boolean).join(" ");
  return null;
}

/** XMP のすべての欄（属性の値と、字だけを持つ要素。rdf:li は親の欄の名前で）。名前空間の宣言と rdf: の欄は除く */
export function xmpFields(xml: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  const decode = (s: string) =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
  const skip = (n: string) => n.startsWith("xmlns") || n.startsWith("rdf:") || n.startsWith("x:") || n === "xml:lang";
  const body = xml.replace(/<\?[\s\S]*?\?>/g, "");
  for (const m of body.matchAll(/\s([A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (skip(m[1]!)) continue;
    const v = decode(m[2] ?? m[3] ?? "").trim();
    if (v) out.push({ name: m[1]!, value: v });
  }
  // 外側の要素（rdf:Description など）が中を飲み込まないよう、欄の名前ごとに探す
  const names = new Set([...body.matchAll(/<([A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*)[\s>/]/g)].map((m) => m[1]!).filter((n) => !skip(n)));
  for (const name of names) for (const m of body.matchAll(new RegExp(`<${name.replace(/\./g, "\\.")}\\b[^>]*>([\\s\\S]*?)</${name.replace(/\./g, "\\.")}>`, "g"))) {
    const inner = m[1]!;
    const lis = [...inner.matchAll(/<rdf:li\b[^>]*>([^<]*)<\/rdf:li>/g)].map((x) => x[1]!);
    if (lis.length) for (const li of lis) {
      const v = decode(li).trim();
      if (v) out.push({ name, value: v });
    }
    else if (!inner.includes("<")) {
      const v = decode(inner).trim();
      if (v) out.push({ name, value: v });
    }
  }
  return out;
}

/** 文書情報と XMP のすべての欄を、中身ごと返す */
export async function listProperties(bytes: Uint8Array): Promise<PropertiesResult> {
  const opened = await openPdf(bytes);
  if (!opened.ok) return { status: "error", error: opened.error };
  const { ctx } = opened;
  const properties: Property[] = [];
  const info = dictOf(ctx, ctx.trailerInfo.Info);
  if (info) {
    for (const [k, raw] of info.entries()) {
      const value = visibleText(infoValue(ctx, raw) ?? "");
      if (value) properties.push({ source: "info", name: k.decodeText(), value, marks: orgMarks(value) });
    }
  }
  const x = catalogXmp(ctx);
  if (x && typeof x !== "string") for (const f of xmpFields(x.xml)) properties.push({ source: "xmp", ...f, marks: orgMarks(f.value) });
  return { status: "ok", properties, decrypted: opened.decrypted };
}

// ---------------------------------------------------------------- 文書情報と XMP の食い違い

/** 同じ意味の欄の組み（Info の欄、XMP の欄） */
export const PAIRS: Array<{ info: string; xmp: string }> = [
  { info: "Title", xmp: "dc:title" },
  { info: "Author", xmp: "dc:creator" },
  { info: "Subject", xmp: "dc:description" },
  { info: "Keywords", xmp: "pdf:Keywords" },
  { info: "Creator", xmp: "xmp:CreatorTool" },
  { info: "Producer", xmp: "pdf:Producer" },
];

export type DiffFinding = {
  pattern: "P1";
  /** Info の欄の名前 */
  field: string;
  xmpField: string;
  /** Info と XMP の値の字数 */
  infoChars: number;
  xmpChars: number;
};

export type DiffReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  findings: DiffFinding[];
  decrypted?: EncryptionSummary & { failedObjects: number };
};

const same = (a: string, b: string) => a.normalize("NFKC").replace(/\s+/g, " ").trim() === b.normalize("NFKC").replace(/\s+/g, " ").trim();

/** 作成者・タイトルなどが、Info と XMP の両方にあって、値が違うもの */
export async function detectInfoXmpDiff(bytes: Uint8Array): Promise<DiffReport> {
  const base = { rule: { id: `${RULE_ID}-diff`, version: RULE_VERSION }, findings: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { ctx } = opened;
  const report: DiffReport = { ...base, status: "ok", findings: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;
  const info = dictOf(ctx, ctx.trailerInfo.Info) as PDFDict | undefined;
  const x = catalogXmp(ctx);
  if (!info || !x || typeof x === "string") return report;
  for (const p of PAIRS) {
    const iv = visibleText(infoValue(ctx, info.get(PDFName.of(p.info))) ?? "");
    // dc:creator・dc:subject は複数の値を持てる。Info の側は「; 」「, 」でつないだものとして比べる
    const xs = xmpValues(x.xml, p.xmp);
    if (!iv || !xs.length) continue;
    const xv = xs.join("; ");
    if (same(iv, xv) || same(iv, xs.join(", ")) || same(iv, xs.join(" ")) || xs.some((v) => same(iv, v))) continue;
    report.findings.push({ pattern: "P1", field: p.info, xmpField: p.xmp, infoChars: [...iv].length, xmpChars: [...xv].length });
  }
  return report;
}

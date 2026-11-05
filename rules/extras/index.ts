// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：ページの縮小画像と、知らせるだけのもの（`extras`）1.0.0。
//
// thumbnails（26 項目の 24）：ページに縮小画像（/Thumb）が付いているページ。型は P5（旧版の残存）の仲間として扱う【仮】。
//   縮小画像は、ページを差し替えたり黒塗りしたりしても、作り直されずに前の見た目のまま残ることがある。
//   1.1.0 から、いまのページの見た目とおおまかに比べる（thumb-compare.ts。ページの画像を縮めて描き、字や図形の所は比べない）。
//   same（ほぼ同じ）・differs（違う）・unknown（比べられなかった）を返す。
// notices（26 項目の 26）：漏れとは言い切れないので「お知らせ」として出すもの。
//   xfa：XFA のフォーム（XML のフォーム）。中の値（datasets）の字数も数える（値は返さない）
//   c2pa：C2PA（画像の来歴の情報）。JPEG の APP11 の JUMBF、来歴の添付（/AFRelationship /C2PA_Manifest・種類 application/c2pa）

import { PDFArray, PDFDict, PDFRawStream, PDFStream, type PDFContext } from "pdf-lib";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { compareThumbnail, type ThumbCompare } from "./thumb-compare.ts";
import { arrayItems, catalogOf, dictOf, lookup, N, nameOf, numOf, openPdf, streamData, type RuleError } from "../common/index.ts";

export const RULE_ID = "extras";
export const RULE_VERSION = "1.1.0";

export type Thumbnail = { pattern: "P5"; page: number; width: number | null; height: number | null; bytes: number | null; compare: ThumbCompare };
export type ExtraNotice = { kind: "xfa"; dataChars: number; checked: boolean } | { kind: "c2pa"; places: number };

export type ExtrasReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  thumbnails: Thumbnail[];
  notices: ExtraNotice[];
  limits: Array<"too_many_objects" | "xfa_too_large">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export const MAX_OBJECTS = 1_000_000;
const MAX_XFA_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** XFA の datasets（入力した値）の字数。タグを外した字（空白を除く） */
export function xfaDataChars(xml: string): number {
  const m = xml.match(/<xfa:datasets\b[\s\S]*?<\/xfa:datasets>/);
  if (!m) return 0;
  const text = m[0]
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, "x");
  return [...text.replace(/\s+/g, "")].length;
}

function xfaXml(ctx: PDFContext, raw: unknown): { xml: string; ok: boolean } {
  const v = lookup(ctx, raw as never);
  const streams: PDFStream[] = [];
  if (v instanceof PDFStream) streams.push(v);
  else if (v instanceof PDFArray) for (const x of v.asArray()) {
    const s = lookup(ctx, x);
    if (s instanceof PDFStream) streams.push(s);
  }
  let xml = "";
  let ok = true;
  for (const s of streams) {
    const d = streamData(s, MAX_XFA_BYTES);
    if (!d) ok = false;
    else xml += new TextDecoder("utf-8").decode(d);
  }
  return { xml, ok };
}

const C2PA = new TextEncoder().encode("c2pa");
function hasBytes(hay: Uint8Array, needle: Uint8Array, from = 0, to = hay.length): boolean {
  outer: for (let i = from; i + needle.length <= to; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** JPEG の APP11（JUMBF）に C2PA があるか */
export function jpegHasC2pa(jpeg: Uint8Array): boolean {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return false;
  let i = 2;
  while (i + 4 <= jpeg.length) {
    if (jpeg[i] !== 0xff) return false;
    const marker = jpeg[i + 1]!;
    if (marker === 0xda || marker === 0xd9) return false;
    const len = (jpeg[i + 2]! << 8) | jpeg[i + 3]!;
    if (len < 2) return false;
    if (marker === 0xeb && hasBytes(jpeg, C2PA, i + 4, Math.min(jpeg.length, i + 2 + len))) return true;
    i += 2 + len;
  }
  return false;
}

export async function detectExtras(bytes: Uint8Array): Promise<ExtrasReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, thumbnails: [], notices: [], limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { doc, ctx } = opened;
  const report: ExtrasReport = { ...base, status: "ok", thumbnails: [], notices: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;

  // ページの縮小画像
  try {
    doc.getPages().forEach((p, i) => {
      const t = lookup(ctx, p.node.get(N("Thumb")));
      if (!(t instanceof PDFStream)) return;
      let compare: ThumbCompare = "unknown";
      try {
        const mb = p.getMediaBox();
        const cb = p.getCropBox();
        const box: [number, number, number, number] = [Math.max(mb.x, cb.x), Math.max(mb.y, cb.y), Math.min(mb.x + mb.width, cb.x + cb.width), Math.min(mb.y + mb.height, cb.y + cb.height)];
        compare = compareThumbnail(ctx, t, p.node, p.node.Resources(), box);
      } catch {
        compare = "unknown";
      }
      report.thumbnails.push({
        compare,
        pattern: "P5",
        page: i + 1,
        width: numOf(ctx, t.dict.get(N("Width"))) ?? null,
        height: numOf(ctx, t.dict.get(N("Height"))) ?? null,
        bytes: t instanceof PDFRawStream ? t.contents.length : null,
      });
    });
  } catch {
    /* ページが読めなくても、ほかは見る */
  }

  // XFA
  const acro = dictOf(ctx, catalogOf(ctx)?.get(N("AcroForm")));
  if (acro?.has(N("XFA"))) {
    const { xml, ok } = xfaXml(ctx, acro.get(N("XFA")));
    if (!ok) report.limits.push("xfa_too_large");
    report.notices.push({ kind: "xfa", dataChars: xfaDataChars(xml), checked: ok });
  }

  // C2PA
  let c2pa = 0;
  let count = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (++count > MAX_OBJECTS) {
      report.limits.push("too_many_objects");
      break;
    }
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    if (nameOf(ctx, dict.get(N("AFRelationship"))) === "C2PA_Manifest") {
      c2pa++;
      continue;
    }
    if (!(obj instanceof PDFStream)) continue;
    const sub = nameOf(ctx, dict.get(N("Subtype")));
    if (sub === "application/c2pa" || sub === "application/x-c2pa-manifest-store") {
      c2pa++;
      continue;
    }
    if (sub === "Image" && obj instanceof PDFRawStream) {
      const f = lookup(ctx, dict.get(N("Filter")));
      const last = f instanceof PDFArray ? nameOf(ctx, arrayItems(ctx, f).at(-1)) : nameOf(ctx, f);
      if (last === "DCTDecode" && arrayItems(ctx, f).length <= 1 && obj.contents.length <= MAX_IMAGE_BYTES && jpegHasC2pa(obj.contents)) c2pa++;
    }
  }
  if (c2pa) report.notices.push({ kind: "c2pa", places: c2pa });
  return report;
}


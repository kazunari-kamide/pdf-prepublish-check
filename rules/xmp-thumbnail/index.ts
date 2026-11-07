// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：文書全体の XMP に埋め込まれた縮小画像（`xmp-thumbnail`）0.1.0。型は P2（XMP メタデータ）の仲間【仮】。
//
// カタログの /Metadata（文書全体の XMP）の xmp:Thumbnails には、縮小画像（base64 の JPEG）を入れられる。
// 作ったときの 1 ページ目の見た目が入り、ページを直したり黒塗りしたりしても、作り直されずに前の見た目のまま残ることがある。
// - extras はページの /Thumb だけ、p2-xmp は字の欄だけ、p10-exif は画像の Exif の中だけを見るので、ここで見る。
// - 1件 ＝ 縮小画像 1 つ（xmpGImg の名前空間の image 欄。要素と属性の両方）。中身は返さない（形・大きさ・画素の数だけ）。
// - 数えない（notCounted）：中身が空のもの（empty）、base64 を解いても画像の頭（JPEG・PNG）でないもの（not_image）。
// - いまのページの見た目とは比べない（JPEG を解く道具を持たないため）。いつも「確かめてください」として出す。

import type { EncryptionSummary } from "../shared/decrypt.ts";
import { openPdf, type RuleError } from "../common/index.ts";
import { catalogXmp } from "../p2-xmp/index.ts";

export const RULE_ID = "xmp-thumbnail";
export const RULE_VERSION = "0.1.0";

/**
 * xmpGImg の名前空間（比べるための字だけで、通信には使わない）。
 * 通信しないことを確かめるテスト（tests/no-network.test.ts）は URL の形の字を止めるので、仕組みの名前と残りを分けて書く。
 */
const GIMG_NS = "http:" + "//ns.adobe.com/xap/1.0/g/img/";
/** 見る縮小画像の数の上限【仮の値】 */
export const MAX_THUMBNAILS = 64;

export type XmpThumbnail = {
  pattern: "P2";
  kind: "thumbnail";
  /** 画像の形（解いた頭のバイトで見分ける） */
  format: "jpeg" | "png";
  /** 書いてある幅・高さ（無ければ null） */
  width: number | null;
  height: number | null;
  /** 解いた画像のバイト数 */
  bytes: number;
};

export type XmpThumbnailReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  findings: XmpThumbnail[];
  notCounted: Array<{ reason: "empty" | "not_image"; count: number }>;
  limits: Array<"too_large" | "unreadable" | "too_many">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** xmpGImg の名前空間に結んだ接頭辞（ふつうは xmpGImg） */
export function gimgPrefixes(xml: string): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"']*)["']/g)) if (m[2] === GIMG_NS) out.add(m[1]!);
  return [...out];
}

/** base64 を解く。XML の数値の参照（&#xA; など）と空白は外す。解けなければ null */
export function decodeBase64(text: string): Uint8Array | null {
  const s = text.replace(/&#x[0-9a-f]+;|&#\d+;/gi, "").replace(/\s+/g, "");
  if (!s) return new Uint8Array(0);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function formatOf(b: Uint8Array): "jpeg" | "png" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  return null;
}

/** 縮小画像 1 つ分の、幅・高さ・中身の字。要素の形（parseType="Resource" など）と属性の形の両方を拾う */
export function thumbnailsIn(xml: string): Array<{ image: string; width: number | null; height: number | null }> {
  const out: Array<{ image: string; width: number | null; height: number | null }> = [];
  for (const p of gimgPrefixes(xml)) {
    const q = escapeRe(p);
    const valueIn = (scope: string, name: string): string | null => {
      const el = scope.match(new RegExp(`<${q}:${name}\\b[^>]*>([\\s\\S]*?)</${q}:${name}>`));
      if (el) return el[1]!;
      const at = scope.match(new RegExp(`[\\s<]${q}:${name}\\s*=\\s*"([^"]*)"`)) ?? scope.match(new RegExp(`[\\s<]${q}:${name}\\s*=\\s*'([^']*)'`));
      return at ? at[1]! : null;
    };
    const num = (v: string | null) => {
      const n = v === null ? NaN : Number(v.trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    // 中身の欄（要素と属性）の場所を集め、それぞれの近く（同じ rdf:li の中）から幅・高さを読む
    const hits: Array<{ at: number; image: string }> = [];
    for (const m of xml.matchAll(new RegExp(`<${q}:image\\b[^>]*>([\\s\\S]*?)</${q}:image>`, "g"))) hits.push({ at: m.index!, image: m[1]! });
    for (const m of xml.matchAll(new RegExp(`\\s${q}:image\\s*=\\s*("([^"]*)"|'([^']*)')`, "g"))) hits.push({ at: m.index!, image: m[2] ?? m[3] ?? "" });
    for (const h of hits) {
      const start = Math.max(xml.lastIndexOf("<rdf:li", h.at), xml.lastIndexOf("<rdf:Description", h.at), 0);
      const endAt = xml.indexOf("</rdf:li>", h.at);
      const scope = xml.slice(start, endAt >= 0 ? endAt : Math.min(xml.length, h.at + h.image.length + 2000));
      out.push({ image: h.image, width: num(valueIn(scope, "width")), height: num(valueIn(scope, "height")) });
    }
  }
  return out;
}

export async function detectXmpThumbnail(bytes: Uint8Array): Promise<XmpThumbnailReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], notCounted: [], limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const report: XmpThumbnailReport = { ...base, status: "ok", findings: [], notCounted: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;

  const x = catalogXmp(opened.ctx);
  if (x === null) return report;
  if (typeof x === "string") {
    report.limits.push(x);
    return report;
  }
  const skipped = new Map<"empty" | "not_image", number>();
  const list = thumbnailsIn(x.xml);
  if (list.length > MAX_THUMBNAILS) report.limits.push("too_many");
  for (const t of list.slice(0, MAX_THUMBNAILS)) {
    const data = decodeBase64(t.image);
    if (data && data.length === 0) {
      skipped.set("empty", (skipped.get("empty") ?? 0) + 1);
      continue;
    }
    const format = data ? formatOf(data) : null;
    if (!data || !format) {
      skipped.set("not_image", (skipped.get("not_image") ?? 0) + 1);
      continue;
    }
    report.findings.push({ pattern: "P2", kind: "thumbnail", format, width: t.width, height: t.height, bytes: data.length });
  }
  report.notCounted = [...skipped].map(([reason, count]) => ({ reason, count }));
  return report;
}

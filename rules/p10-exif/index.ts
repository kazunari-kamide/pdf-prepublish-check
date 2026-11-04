// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P10（画像の Exif）1.0.0。PDF の中の JPEG の画像（/DCTDecode）の Exif（APP1）を読む。
// 写真をそのまま貼ると、撮った場所（GPS）・カメラの機種・ソフト・撮った人の名前・縮小画像が、PDF の中に残る。
// 縮小画像（IFD1）は、トリミングする前の写真がそのまま残っていることがある。有る・無いと大きさで返す。
// 値そのものは返さない（字数・大きさだけ）。画素は読まない（Exif の欄だけ）。
//
// 1件 ＝ 画像1つ（同じ中身のストリームは1つ）× 種類1つ（kind）。
//   gps：GPS の緯度・経度（高い）
//   person：撮った人・持ち主（Artist・XPAuthor・CameraOwnerName）
//   serial：カメラの製造番号（BodySerialNumber）
//   camera：機種（Make・Model）
//   software：ソフト（Software）
//   description：画像の説明（ImageDescription・XPComment・UserComment）
//   copyright：著作権者（Copyright）
//   thumbnail：Exif の中の縮小画像（bytes に大きさ）
// 数えないもの：向き・解像度・撮影の日時・露出などの撮影の条件（人や場所をたどれない、またはたどりにくいもの）。

import { PDFArray, PDFDict, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { arrayItems, dictOf, lookup, N, nameOf, openPdf, streamData, type RuleError } from "../common/index.ts";

export const RULE_ID = "p10-exif";
export const RULE_VERSION = "1.0.0";

export type P10Kind = "gps" | "person" | "serial" | "camera" | "software" | "description" | "copyright" | "thumbnail";

export type P10Finding = {
  pattern: "P10";
  kind: P10Kind;
  /** 欄の名前（Artist・Make/Model・GPSLatitude/GPSLongitude・IFD1 など） */
  field: string;
  /** 画像の中身のストリームのオブジェクト番号 */
  object: number;
  /** この画像を置いたページ（分からなければ空） */
  pages: number[];
  /** 字数（gps・thumbnail は 0） */
  chars: number;
  /** thumbnail のとき：縮小画像の大きさ（バイト） */
  bytes?: number;
  /** includeValues のときだけ。値そのもの（gps は「緯度 経度」の数）。記録やログには使わない */
  value?: string;
};

export type P10Report = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  /** 見た JPEG の画像の数と、そのうち Exif があった数 */
  jpegImages: number;
  withExif: number;
  findings: P10Finding[];
  limits: Array<"too_many_objects" | "image_too_large" | "broken_exif">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { includeValues?: boolean };

/** 1つの画像として読む大きさの上限（バイト）【仮の値】 */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_OBJECTS = 1_000_000;
const MAX_IFD_ENTRIES = 1000;

// ---------------------------------------------------------------- JPEG と Exif

/** JPEG の APP1 の Exif の中身（"Exif\0\0" のあとの TIFF）。なければ null */
export function exifOf(jpeg: Uint8Array): Uint8Array | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // 画像の符号が始まった（Exif は、その前にある）
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const len = (jpeg[i + 2]! << 8) | jpeg[i + 3]!;
    if (len < 2 || i + 2 + len > jpeg.length) return null;
    if (marker === 0xe1 && len >= 8) {
      const body = jpeg.subarray(i + 4, i + 2 + len);
      if (body[0] === 0x45 && body[1] === 0x78 && body[2] === 0x69 && body[3] === 0x66 && body[4] === 0 && body[5] === 0) return body.subarray(6);
    }
    i += 2 + len;
  }
  return null;
}

type Entry = { tag: number; type: number; count: number; valueAt: number };

class Tiff {
  readonly le: boolean;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b; // Node の型を外すだけの実行で動くように、引数のプロパティの書き方は使わない
    if (b.length < 8) throw new Error("short");
    if (b[0] === 0x49 && b[1] === 0x49) this.le = true;
    else if (b[0] === 0x4d && b[1] === 0x4d) this.le = false;
    else throw new Error("bad byte order");
    if (this.u16(2) !== 42) throw new Error("bad magic");
  }
  u16(at: number): number {
    if (at < 0 || at + 2 > this.b.length) throw new Error("out of range");
    return this.le ? this.b[at]! | (this.b[at + 1]! << 8) : (this.b[at]! << 8) | this.b[at + 1]!;
  }
  u32(at: number): number {
    if (at < 0 || at + 4 > this.b.length) throw new Error("out of range");
    const v = this.le
      ? this.b[at]! | (this.b[at + 1]! << 8) | (this.b[at + 2]! << 16) | (this.b[at + 3]! << 24)
      : (this.b[at]! << 24) | (this.b[at + 1]! << 16) | (this.b[at + 2]! << 8) | this.b[at + 3]!;
    return v >>> 0;
  }
  /** IFD の欄と、次の IFD の位置 */
  ifd(at: number): { entries: Entry[]; next: number } {
    const n = this.u16(at);
    if (n > MAX_IFD_ENTRIES) throw new Error("too many entries");
    const entries: Entry[] = [];
    for (let k = 0; k < n; k++) {
      const e = at + 2 + k * 12;
      const tag = this.u16(e);
      const type = this.u16(e + 2);
      const count = this.u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      entries.push({ tag, type, count, valueAt: size <= 4 ? e + 8 : this.u32(e + 8) });
    }
    return { entries, next: this.u32(at + 2 + n * 12) };
  }
  bytes(e: Entry): Uint8Array {
    const size = (TYPE_SIZE[e.type] ?? 1) * e.count;
    if (e.valueAt < 0 || e.valueAt + size > this.b.length) throw new Error("out of range");
    return this.b.subarray(e.valueAt, e.valueAt + size);
  }
  num(e: Entry): number {
    return e.type === 3 ? this.u16(e.valueAt) : this.u32(e.valueAt);
  }
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** ASCII（type 2）・UNDEFINED（type 7。UserComment の先頭 8 バイトは文字の種類）・XP 系（UTF-16LE の BYTE）を字にする */
function entryText(t: Tiff, e: Entry, kind: "ascii" | "xp" | "comment"): string {
  const b = t.bytes(e);
  let s: string;
  if (kind === "xp") s = new TextDecoder("utf-16le").decode(b);
  else if (kind === "comment") {
    const head = new TextDecoder("latin1").decode(b.subarray(0, 8));
    const body = b.subarray(8);
    if (head.startsWith("UNICODE")) s = new TextDecoder(t.le ? "utf-16le" : "utf-16be").decode(body);
    else if (head.startsWith("JIS")) s = new TextDecoder("latin1").decode(body); // JIS の符号は読まない（字数の目安だけ）
    else s = new TextDecoder("utf-8").decode(body);
  } else {
    try {
      s = new TextDecoder("utf-8", { fatal: true }).decode(b);
    } catch {
      s = new TextDecoder("shift_jis").decode(b);
    }
  }
  return s.replace(/\u0000/g, "").trim();
}

export type ExifSummary = Array<{ kind: P10Kind; field: string; chars: number; bytes?: number; value: string }>;

const IFD0_TEXT: Array<{ tag: number; kind: P10Kind; field: string; enc: "ascii" | "xp" }> = [
  { tag: 0x013b, kind: "person", field: "Artist", enc: "ascii" },
  { tag: 0x9c9d, kind: "person", field: "XPAuthor", enc: "xp" },
  { tag: 0x0131, kind: "software", field: "Software", enc: "ascii" },
  { tag: 0x8298, kind: "copyright", field: "Copyright", enc: "ascii" },
  { tag: 0x010e, kind: "description", field: "ImageDescription", enc: "ascii" },
  { tag: 0x9c9c, kind: "description", field: "XPComment", enc: "xp" },
];

/** Exif（TIFF）から、数える欄を取り出す。壊れていれば例外 */
export function readExif(tiffBytes: Uint8Array): ExifSummary {
  const t = new Tiff(tiffBytes);
  const out: ExifSummary = [];
  const ifd0 = t.ifd(t.u32(4));
  const find = (entries: Entry[], tag: number) => entries.find((e) => e.tag === tag);
  for (const d of IFD0_TEXT) {
    const e = find(ifd0.entries, d.tag);
    if (!e) continue;
    const v = entryText(t, e, d.enc);
    if (v) out.push({ kind: d.kind, field: d.field, chars: [...v].length, value: v });
  }
  const make = find(ifd0.entries, 0x010f);
  const model = find(ifd0.entries, 0x0110);
  const camera = [make ? entryText(t, make, "ascii") : "", model ? entryText(t, model, "ascii") : ""].filter(Boolean).join(" ");
  if (camera) out.push({ kind: "camera", field: "Make/Model", chars: [...camera].length, value: camera });

  const exifPtr = find(ifd0.entries, 0x8769);
  if (exifPtr) {
    const ex = t.ifd(t.num(exifPtr));
    for (const d of [
      { tag: 0xa430, kind: "person" as const, field: "CameraOwnerName" },
      { tag: 0xa431, kind: "serial" as const, field: "BodySerialNumber" },
    ]) {
      const e = find(ex.entries, d.tag);
      const v = e ? entryText(t, e, "ascii") : "";
      if (v) out.push({ kind: d.kind, field: d.field, chars: [...v].length, value: v });
    }
    const uc = find(ex.entries, 0x9286);
    const v = uc ? entryText(t, uc, "comment") : "";
    if (v) out.push({ kind: "description", field: "UserComment", chars: [...v].length, value: v });
  }
  const gpsPtr = find(ifd0.entries, 0x8825);
  if (gpsPtr) {
    const g = t.ifd(t.num(gpsPtr));
    const lat = find(g.entries, 0x0002);
    const lon = find(g.entries, 0x0004);
    if (lat || lon) out.push({ kind: "gps", field: "GPSLatitude/GPSLongitude", chars: 0, value: `${lat ? "lat" : ""} ${lon ? "lon" : ""}`.trim() });
  }
  // IFD1（縮小画像）
  if (ifd0.next) {
    const ifd1 = t.ifd(ifd0.next);
    const off = find(ifd1.entries, 0x0201);
    const len = find(ifd1.entries, 0x0202);
    if (off && len) {
      const size = t.num(len);
      const at = t.num(off);
      if (size > 0 && at + size <= tiffBytes.length) out.push({ kind: "thumbnail", field: "IFD1", chars: 0, bytes: size, value: String(size) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 本体

function isJpegStream(ctx: PDFContext, s: PDFStream): boolean {
  if (nameOf(ctx, s.dict.get(N("Subtype"))) !== "Image") return false;
  const f = lookup(ctx, s.dict.get(N("Filter")));
  const names = f instanceof PDFArray ? f.asArray().map((x) => nameOf(ctx, x)) : [nameOf(ctx, f)];
  return names[names.length - 1] === "DCTDecode";
}

/** 画像の中身（JPEG のバイト列）。DCTDecode だけなら、そのまま。前に Flate などがあれば、それをほどく（pdf-lib は DCT をほどかない） */
function jpegBytes(ctx: PDFContext, s: PDFStream): Uint8Array | null {
  if (!(s instanceof PDFRawStream)) return null;
  if (s.contents.length > MAX_IMAGE_BYTES) return null;
  const f = lookup(ctx, s.dict.get(N("Filter")));
  const filters = f instanceof PDFArray ? f.asArray() : [];
  if (filters.length <= 1) return s.contents; // DCTDecode だけ
  // 前の段（FlateDecode など）だけをほどく写しを作る
  const dict = s.dict.clone(ctx);
  dict.set(N("Filter"), ctx.obj(filters.slice(0, -1)));
  dict.delete(N("DecodeParms"));
  return streamData(PDFRawStream.of(dict, s.contents), MAX_IMAGE_BYTES);
}

/** 画像のオブジェクト → 置いたページ。ページの /Resources /XObject と、その中の部品（フォーム XObject）をたどる */
function imagePages(ctx: PDFContext, pages: Array<{ node: PDFDict }>): Map<PDFRef, Set<number>> {
  const out = new Map<PDFRef, Set<number>>();
  pages.forEach((p, i) => {
    const seen = new Set<PDFObject>();
    const walk = (res: PDFDict | undefined, depth: number) => {
      const xo = dictOf(ctx, res?.get(N("XObject")));
      if (!xo || depth > 8) return;
      for (const [, v] of xo.entries()) {
        if (!(v instanceof PDFRef) || seen.has(v)) continue;
        seen.add(v);
        const s = lookup(ctx, v);
        if (!(s instanceof PDFStream)) continue;
        const sub = nameOf(ctx, s.dict.get(N("Subtype")));
        if (sub === "Image") {
          const set = out.get(v) ?? new Set<number>();
          set.add(i + 1);
          out.set(v, set);
        } else if (sub === "Form") walk(dictOf(ctx, s.dict.get(N("Resources"))), depth + 1);
      }
    };
    walk(dictOf(ctx, p.node.get(N("Resources"))), 0);
  });
  return out;
}

export async function detectP10Exif(bytes: Uint8Array, options: DetectOptions = {}): Promise<P10Report> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, jpegImages: 0, withExif: 0, findings: [], limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { doc, ctx } = opened;
  const report: P10Report = { ...base, status: "ok", findings: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;
  const limit = (l: P10Report["limits"][number]) => {
    if (!report.limits.includes(l)) report.limits.push(l);
  };

  let pageMap = new Map<PDFRef, Set<number>>();
  try {
    pageMap = imagePages(ctx, doc.getPages());
  } catch {
    /* ページが読めなくても、画像は見る */
  }

  let count = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (++count > MAX_OBJECTS) {
      limit("too_many_objects");
      break;
    }
    if (!(obj instanceof PDFStream) || !isJpegStream(ctx, obj)) continue;
    report.jpegImages++;
    const jpeg = jpegBytes(ctx, obj);
    if (!jpeg) {
      limit("image_too_large");
      continue;
    }
    const tiff = exifOf(jpeg);
    if (!tiff) continue;
    report.withExif++;
    let fields: ExifSummary;
    try {
      fields = readExif(tiff);
    } catch {
      limit("broken_exif");
      continue;
    }
    const pages = [...(pageMap.get(ref) ?? [])].sort((a, b) => a - b);
    for (const f of fields) {
      const finding: P10Finding = { pattern: "P10", kind: f.kind, field: f.field, object: ref.objectNumber, pages, chars: f.chars };
      if (f.bytes !== undefined) finding.bytes = f.bytes;
      if (options.includeValues) finding.value = f.value;
      report.findings.push(finding);
    }
  }
  const order: P10Kind[] = ["gps", "person", "serial", "thumbnail", "description", "copyright", "camera", "software"];
  report.findings.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.object - b.object);
  return report;
}

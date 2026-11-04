// SPDX-License-Identifier: AGPL-3.0-only
//
// EXIF（TIFF の形）を読む。値は返さず、どの種類の欄に値があるか・縮小画像があるかだけを返す。
// IFD のたどりは、回り道（同じ所を指し返す）と数の上限で止める。

import { Reader, hasAscii } from "./bytes.ts";

const MAX_ENTRIES = 1000;
const MAX_IFDS = 16;

/** 撮った人・持ち主・カメラの番号など（人や持ち物をたどれる欄） */
const PERSON_TAGS = new Map<number, string>([
  [0x013b, "撮った人"], // Artist
  [0x8298, "著作権者"], // Copyright
  [0x9c9d, "作成者"], // XPAuthor
  [0xa430, "カメラの持ち主"], // CameraOwnerName
  [0xa431, "カメラの番号"], // BodySerialNumber
  [0xa435, "レンズの番号"], // LensSerialNumber
  [0xa420, "写真の番号"], // ImageUniqueID
]);
/** 説明・コメント（自由に書ける欄） */
const TEXT_TAGS = new Map<number, string>([
  [0x010e, "説明"], // ImageDescription
  [0x9286, "コメント"], // UserComment
  [0x9c9b, "タイトル"], // XPTitle
  [0x9c9c, "コメント"], // XPComment
  [0x9c9e, "キーワード"], // XPKeywords
  [0x9c9f, "件名"], // XPSubject
]);
/** 機種・日時・ソフト（人を直接は指さないが、手がかりになる欄） */
const DEVICE_TAGS = new Map<number, string>([
  [0x010f, "メーカー"], // Make
  [0x0110, "機種"], // Model
  [0x0131, "ソフト"], // Software
  [0x0132, "日時"], // DateTime
  [0x9003, "撮った日時"], // DateTimeOriginal
  [0x9004, "取り込んだ日時"], // DateTimeDigitized
  [0xa434, "レンズ"], // LensModel
]);

export type ExifSummary = {
  /** 位置（緯度・経度）があるか */
  gps: boolean;
  /** GPS の欄の数（位置のほか、日時・高さ・向きなど） */
  gpsTags: number;
  person: string[];
  text: string[];
  device: string[];
  /** 縮小画像（IFD1） */
  thumbnail: { bytes: number; jpeg: Uint8Array | null } | null;
  /** 読めなかった（壊れている・上限） */
  broken: boolean;
};

/** TIFF の形のバイト列（"Exif\0\0" のあと）を読む */
export function readExif(tiff: Uint8Array): ExifSummary {
  const out: ExifSummary = { gps: false, gpsTags: 0, person: [], text: [], device: [], thumbnail: null, broken: false };
  let r: Reader;
  if (hasAscii(tiff, 0, "II")) r = new Reader(tiff, true);
  else if (hasAscii(tiff, 0, "MM")) r = new Reader(tiff, false);
  else {
    out.broken = true;
    return out;
  }
  if (r.u16(2) !== 42) {
    out.broken = true;
    return out;
  }
  const seen = new Set<number>();
  let ifds = 0;

  type Entry = { tag: number; type: number; count: number; valueAt: number };
  const SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  const readIfd = (at: number): { entries: Entry[]; next: number } | null => {
    if (seen.has(at) || ifds >= MAX_IFDS) return null;
    seen.add(at);
    ifds++;
    const n = r.u16(at);
    if (n === undefined || n > MAX_ENTRIES) {
      out.broken = true;
      return null;
    }
    const entries: Entry[] = [];
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      const tag = r.u16(e);
      const type = r.u16(e + 2);
      const count = r.u32(e + 4);
      if (tag === undefined || type === undefined || count === undefined) {
        out.broken = true;
        break;
      }
      const size = (SIZE[type] ?? 1) * count;
      const valueAt = size <= 4 ? e + 8 : (r.u32(e + 8) ?? -1);
      entries.push({ tag, type, count, valueAt });
    }
    return { entries, next: r.u32(at + 2 + n * 12) ?? 0 };
  };

  /** 値が空でないか（字の欄は、空白と 0 だけなら空とみなす） */
  const hasValue = (e: Entry): boolean => {
    if (e.count === 0 || e.valueAt < 0) return false;
    const size = Math.min((SIZE[e.type] ?? 1) * e.count, 4096);
    if (e.valueAt + size > tiff.length) return false;
    if (e.type === 2 || e.type === 7 || e.type === 1) {
      let start = e.valueAt;
      // UserComment は先頭 8 バイトが文字の種類
      if (e.tag === 0x9286) start += 8;
      for (let i = start; i < e.valueAt + size; i++) {
        const c = tiff[i]!;
        if (c !== 0 && c !== 0x20) return true;
      }
      return false;
    }
    return true;
  };

  const mark = (e: Entry) => {
    if (!hasValue(e)) return;
    const p = PERSON_TAGS.get(e.tag);
    if (p && !out.person.includes(p)) out.person.push(p);
    const t = TEXT_TAGS.get(e.tag);
    if (t && !out.text.includes(t)) out.text.push(t);
    const d = DEVICE_TAGS.get(e.tag);
    if (d && !out.device.includes(d)) out.device.push(d);
  };

  const first = r.u32(4);
  if (first === undefined) {
    out.broken = true;
    return out;
  }
  const ifd0 = readIfd(first);
  if (!ifd0) {
    out.broken = true;
    return out;
  }
  const sub: number[] = [];
  let gpsAt: number | null = null;
  for (const e of ifd0.entries) {
    mark(e);
    if (e.tag === 0x8769) sub.push(r.u32(e.valueAt) ?? -1);
    if (e.tag === 0x8825) gpsAt = r.u32(e.valueAt) ?? null;
  }
  for (const at of sub) {
    const ifd = at > 0 ? readIfd(at) : null;
    for (const e of ifd?.entries ?? []) mark(e);
  }
  if (gpsAt) {
    const gps = readIfd(gpsAt);
    for (const e of gps?.entries ?? []) {
      if (e.tag === 0x0000) continue; // GPSVersionID だけでは、何も入っていない
      if (!hasValue(e)) continue;
      out.gpsTags++;
      if (e.tag === 0x0002 || e.tag === 0x0004) out.gps = true;
    }
  }
  // IFD1（縮小画像）
  if (ifd0.next > 0) {
    const ifd1 = readIfd(ifd0.next);
    if (ifd1) {
      let off: number | undefined;
      let len: number | undefined;
      let stripBytes = 0;
      for (const e of ifd1.entries) {
        if (e.tag === 0x0201) off = r.u32(e.valueAt);
        if (e.tag === 0x0202) len = r.u32(e.valueAt);
        if (e.tag === 0x0117) stripBytes += (e.type === 3 ? r.u16(e.valueAt) : r.u32(e.valueAt)) ?? 0;
      }
      if (off !== undefined && len && off + len <= tiff.length) out.thumbnail = { bytes: len, jpeg: tiff.subarray(off, off + len) };
      else if (stripBytes > 0) out.thumbnail = { bytes: stripBytes, jpeg: null };
    }
  }
  return out;
}

/** JPEG の幅と高さ（SOF の印から）。読めなければ null */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const r = new Reader(bytes, false);
  if (r.u16(0) !== 0xffd8) return null;
  let at = 2;
  for (let guard = 0; guard < 10_000 && at + 4 <= bytes.length; guard++) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const len = r.u16(at + 2);
    if (len === undefined || len < 2) return null;
    // SOF0〜SOF15（DHT=C4・JPG=C8・DAC=CC を除く）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = r.u16(at + 5);
      const w = r.u16(at + 7);
      return h && w ? { width: w, height: h } : null;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    at += 2 + len;
  }
  return null;
}

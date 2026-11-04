// SPDX-License-Identifier: AGPL-3.0-only
//
// 写真（JPEG・PNG・WebP）に残った情報を見つける：EXIF（撮った場所・人・機種・説明）、EXIF の中の縮小画像、XMP、IPTC、
// PNG の文字の欄。HEIC・HEIF は「記録が有る」と知らせるだけで、中までは調べない。
// 値・ファイル名は返さない（どの種類の欄に値があるか・数だけ）。

import { Reader, ascii, be, formatSize, hasAscii, indexOfAscii, inflate, nulAt } from "./bytes.ts";
import { jpegSize, readExif, type ExifSummary } from "./exif.ts";
import type { FormatFinding, FormatKind, FormatNotice, FormatReport } from "./types.ts";
import { XMP_GPS, XMP_HISTORY, XMP_PERSON, nonEmptyXmp, xmpProperties } from "./xmp.ts";

/** XMP・文字の欄を解くときの上限（バイト） */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
/** 走査するかたまり（JPEG の印・PNG の chunk・WebP の chunk）の数の上限 */
const MAX_SEGMENTS = 100_000;
/** 縮小画像の縦横の比が、本体とこの割合より違えば「切り取る前の写真かもしれない」とする */
const ASPECT_DIFF = 0.05;

/** PNG の文字の欄の決まった名前（名前は出してよい）。それ以外は独自の欄（名前を出さない） */
const PNG_KEYWORDS = new Set(["Title", "Author", "Description", "Copyright", "Creation Time", "Software", "Disclaimer", "Warning", "Source", "Comment"]);

type Meta = {
  size: { width: number; height: number } | null;
  exif: ExifSummary[];
  xmp: string[];
  iptc: { datasets: number; person: boolean } | null;
  pngText: { names: string[]; custom: number };
  broken: boolean;
  /** 解けなかった・大きすぎた部分 */
  partial: boolean;
};

const emptyMeta = (): Meta => ({ size: null, exif: [], xmp: [], iptc: null, pngText: { names: [], custom: 0 }, broken: false, partial: false });

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return s;
};
const utf8 = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);

// ---------------------------------------------------------------- JPEG

/** IPTC（APP13 の Photoshop の資源 0x0404）の項目を数える */
function readIptc(data: Uint8Array): { datasets: number; person: boolean } | null {
  const r = be(data);
  let at = "Photoshop 3.0\0".length;
  let datasets = 0;
  let person = false;
  let found = false;
  for (let guard = 0; guard < MAX_SEGMENTS && at + 12 <= data.length; guard++) {
    if (!hasAscii(data, at, "8BIM")) break;
    const id = r.u16(at + 4) ?? 0;
    const nameLen = data[at + 6] ?? 0;
    let p = at + 6 + 1 + nameLen;
    if ((1 + nameLen) % 2) p++; // 名前の長さは偶数にそろえる
    const size = r.u32(p);
    if (size === undefined) break;
    const body = p + 4;
    if (id === 0x0404) {
      found = true;
      let q = body;
      while (q + 5 <= Math.min(body + size, data.length) && data[q] === 0x1c) {
        const rec = data[q + 1]!;
        const ds = data[q + 2]!;
        const len = r.u16(q + 3) ?? 0;
        if (rec === 2 && ds !== 0 && len > 0) {
          datasets++;
          if (ds === 80 || ds === 85 || ds === 116 || ds === 118 || ds === 122) person = true; // 撮った人・肩書き・著作権・連絡先・書いた人
        }
        q += 5 + len;
      }
    }
    at = body + size + (size % 2);
  }
  return found ? { datasets, person } : null;
}

function readJpeg(bytes: Uint8Array): Meta {
  const m = emptyMeta();
  const r = be(bytes);
  let at = 2;
  for (let guard = 0; guard < MAX_SEGMENTS && at + 4 <= bytes.length; guard++) {
    if (bytes[at] !== 0xff) {
      m.broken = true;
      break;
    }
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // 画像の本体（ここから先に記録の印はない）
    const len = r.u16(at + 2);
    if (len === undefined || len < 2 || at + 2 + len > bytes.length) {
      m.broken = true;
      break;
    }
    const data = bytes.subarray(at + 4, at + 2 + len);
    if (marker === 0xe1 && hasAscii(data, 0, "Exif\0")) m.exif.push(readExif(data.subarray(6)));
    else if (marker === 0xe1 && indexOfAscii(data, "ns.adobe.com/xap/1.0/\0", 0, 64) >= 0) {
      const z = nulAt(data, 0, 64);
      m.xmp.push(utf8(data.subarray(z + 1)));
    } else if (marker === 0xe1 && indexOfAscii(data, "ns.adobe.com/xmp/extension/\0", 0, 64) >= 0) {
      // 拡張の XMP（大きな XMP の続き）。中身は本体の XMP と同じ扱い。並べ直さずに字として足す
      const z = nulAt(data, 0, 64);
      if (z >= 0 && z + 41 <= data.length) m.xmp.push(utf8(data.subarray(z + 41)));
    } else if (marker === 0xed && hasAscii(data, 0, "Photoshop 3.0\0")) {
      const iptc = readIptc(data);
      if (iptc) m.iptc = { datasets: (m.iptc?.datasets ?? 0) + iptc.datasets, person: (m.iptc?.person ?? false) || iptc.person };
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && !m.size) {
      const h = r.u16(at + 5);
      const w = r.u16(at + 7);
      if (h && w) m.size = { width: w, height: h };
    }
    at += 2 + len;
  }
  return m;
}

// ---------------------------------------------------------------- PNG

/** ImageMagick などが書く「Raw profile type exif」（16進の字で書いた EXIF）を解く */
function rawProfileExif(text: string): Uint8Array | null {
  const parts = text.trim().split(/\s+/);
  // 形：<名前> <長さ> <16進の字…>
  if (parts.length < 3) return null;
  const hex = parts.slice(2).join("");
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return hasAscii(out, 0, "Exif\0") ? out.subarray(6) : out;
}

async function readPng(bytes: Uint8Array): Promise<Meta> {
  const m = emptyMeta();
  const r = be(bytes);
  let at = 8;
  for (let guard = 0; guard < MAX_SEGMENTS && at + 12 <= bytes.length; guard++) {
    const len = r.u32(at)!;
    const type = ascii(bytes, at + 4, 4);
    if (at + 12 + len > bytes.length) {
      m.broken = true;
      break;
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR" && len >= 8) m.size = { width: r.u32(at + 8)!, height: r.u32(at + 12)! };
    else if (type === "eXIf") m.exif.push(readExif(data));
    else if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const z = nulAt(data, 0, 80);
      if (z < 0) {
        m.broken = true;
      } else {
        const keyword = latin1(data.subarray(0, z));
        let text: string | null = null;
        if (type === "tEXt") text = latin1(data.subarray(z + 1));
        else if (type === "zTXt") {
          const raw = await inflate(data.subarray(z + 2), "deflate", MAX_TEXT_BYTES);
          if (raw) text = latin1(raw);
          else m.partial = true;
        } else {
          const compressed = data[z + 1] === 1;
          const lang = nulAt(data, z + 3);
          const trans = lang >= 0 ? nulAt(data, lang + 1) : -1;
          if (trans < 0) m.broken = true;
          else if (compressed) {
            const raw = await inflate(data.subarray(trans + 1), "deflate", MAX_TEXT_BYTES);
            if (raw) text = utf8(raw);
            else m.partial = true;
          } else text = utf8(data.subarray(trans + 1));
        }
        if (keyword === "XML:com.adobe.xmp") {
          if (text !== null) m.xmp.push(text);
        } else if (/^Raw profile type (exif|APP1)$/i.test(keyword)) {
          const exif = text !== null ? rawProfileExif(text) : null;
          if (exif) m.exif.push(readExif(exif));
        } else if (text !== null && text.trim() !== "") {
          if (PNG_KEYWORDS.has(keyword)) {
            if (!m.pngText.names.includes(keyword)) m.pngText.names.push(keyword);
          } else m.pngText.custom++;
        }
      }
    } else if (type === "IEND") break;
    at += 12 + len;
  }
  return m;
}

// ---------------------------------------------------------------- WebP

function readWebp(bytes: Uint8Array): Meta {
  const m = emptyMeta();
  const r = new Reader(bytes, true);
  const end = Math.min(bytes.length, (r.u32(4) ?? 0) + 8);
  let at = 12;
  for (let guard = 0; guard < MAX_SEGMENTS && at + 8 <= end; guard++) {
    const type = ascii(bytes, at, 4);
    const len = r.u32(at + 4)!;
    if (at + 8 + len > bytes.length) {
      m.broken = true;
      break;
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === "VP8X" && len >= 10) m.size = { width: ((r.u32(at + 12)! & 0xffffff) + 1), height: ((r.u32(at + 15)! & 0xffffff) + 1) };
    else if (type === "VP8 " && len >= 10 && !m.size) {
      const w = (r.u16(at + 8 + 6) ?? 0) & 0x3fff;
      const h = (r.u16(at + 8 + 8) ?? 0) & 0x3fff;
      if (w && h) m.size = { width: w, height: h };
    } else if (type === "VP8L" && len >= 5 && !m.size) {
      const b = r.u32(at + 8 + 1) ?? 0;
      m.size = { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 };
    } else if (type === "EXIF") m.exif.push(readExif(hasAscii(data, 0, "Exif\0") ? data.subarray(6) : data));
    else if (type === "XMP ") m.xmp.push(utf8(data));
    at += 8 + len + (len % 2);
  }
  return m;
}

// ---------------------------------------------------------------- HEIC（有ると知らせるだけ）

/** HEIC・HEIF の項目の一覧（iinf の infe）に、Exif の項目・XMP（mime）の項目があるか */
function heicItems(bytes: Uint8Array): { exif: boolean; xmp: boolean } {
  const head = bytes.subarray(0, Math.min(bytes.length, 1024 * 1024));
  let exif = false;
  let xmp = false;
  for (let at = indexOfAscii(head, "infe"); at >= 0; at = indexOfAscii(head, "infe", at + 4)) {
    const win = head.subarray(at, Math.min(head.length, at + 80));
    if (indexOfAscii(win, "Exif") >= 0) exif = true;
    if (indexOfAscii(win, "mime") >= 0 && indexOfAscii(win, "rdf+xml") >= 0) xmp = true;
  }
  return { exif, xmp };
}

// ---------------------------------------------------------------- まとめ

const join = (xs: string[]) => xs.join("・");

function findingsOf(m: Meta): FormatFinding[] {
  const out: FormatFinding[] = [];
  const add = (f: Omit<FormatFinding, "page" | "where">) => out.push({ ...f, page: null, where: null });
  const exif = m.exif;
  const gps = exif.some((e) => e.gps);
  const xmpProps = m.xmp.map(xmpProperties);
  const xmpFilled = [...new Set(xmpProps.flatMap(nonEmptyXmp))];
  const xmpGps = xmpFilled.some((k) => XMP_GPS.has(k));
  if (gps || xmpGps) {
    add({
      type: "image.gps",
      severity: "high",
      title: "撮った場所（GPS）が入っています",
      why: "地図で、撮った場所（自宅・職場など）が分かります。",
      detail: [gps ? "EXIF" : "", xmpGps ? "XMP" : ""].filter(Boolean).join("・") + " に位置",
    });
  } else if (exif.some((e) => e.gpsTags > 0)) {
    add({ type: "image.gps", severity: "low", title: "GPS の欄があります（位置は入っていません）", why: "日時や高さなど、撮った時の様子が分かることがあります。", detail: `${exif.reduce((s, e) => s + e.gpsTags, 0)} 欄` });
  }
  for (const e of exif) {
    if (!e.thumbnail) continue;
    const t = e.thumbnail.jpeg ? jpegSize(e.thumbnail.jpeg) : null;
    const differs =
      t && m.size && Math.abs(t.width / t.height - m.size.width / m.size.height) / (m.size.width / m.size.height) > ASPECT_DIFF &&
      Math.abs(t.width / t.height - m.size.height / m.size.width) / (m.size.height / m.size.width) > ASPECT_DIFF; // 向きだけ違うものは除く
    add({
      type: "image.thumbnail",
      severity: differs ? "high" : "medium",
      title: differs ? "写真の中の小さな見本の画像が、本体と違う形です" : "写真の中に、小さな見本の画像が入っています",
      why: differs
        ? "切り取る前の写真が、見本として残っているかもしれません。見本を取り出すと、切り取った所が見えます。"
        : "切り取りや塗りつぶしの前の写真が、見本として残っていることがあります。",
      detail: [t ? `見本 ${t.width}×${t.height}` : "見本の大きさ不明", m.size ? `本体 ${m.size.width}×${m.size.height}` : "", formatSize(e.thumbnail.bytes)].filter(Boolean).join("／"),
    });
  }
  const person = [...new Set(exif.flatMap((e) => e.person))];
  if (person.length) add({ type: "image.exif_person", severity: "medium", title: "撮った人・持ち主・カメラの番号などの欄に、値が入っています", why: "写真を受け取った人が、撮った人や持ち物をたどれます。", detail: join(person) });
  const text = [...new Set(exif.flatMap((e) => e.text))];
  if (text.length) add({ type: "image.exif_text", severity: "medium", title: "写真の説明・コメントの欄に、値が入っています", why: "画面には出ませんが、ファイルの情報を開くと読めます。", detail: join(text) });
  const device = [...new Set(exif.flatMap((e) => e.device))];
  if (device.length) add({ type: "image.exif_device", severity: "low", title: "カメラの機種・撮った日時などが入っています", why: "同じカメラで撮った写真を結びつける手がかりになります。", detail: join(device) });
  if (m.xmp.length) {
    const named = xmpFilled.filter((k) => XMP_PERSON.has(k)).length;
    const history = xmpFilled.some((k) => XMP_HISTORY.has(k));
    add({
      type: "image.xmp",
      severity: named || history ? "medium" : "low",
      title: "埋め込まれた作成の記録（XMP）が入っています",
      why: "作った人や編集の履歴（元のファイルの名前など）が残っていることがあります。",
      detail: [`項目 ${xmpFilled.length} 個`, named ? `人をたどれる項目 ${named} 個` : "", history ? "編集の履歴あり" : ""].filter(Boolean).join("／"),
    });
  }
  if (m.iptc && m.iptc.datasets > 0) {
    add({ type: "image.iptc", severity: "medium", title: "写真の説明の記録（IPTC）が入っています", why: "撮った人・連絡先・説明などが残っていることがあります。", detail: [`項目 ${m.iptc.datasets} 個`, m.iptc.person ? "撮った人・連絡先などの項目あり" : ""].filter(Boolean).join("／") });
  }
  if (m.pngText.names.length || m.pngText.custom) {
    add({
      type: "image.png_text",
      severity: "medium",
      title: "画像の文字の欄に、値が入っています",
      why: "画面には出ませんが、ファイルの情報を開くと読めます。",
      detail: [m.pngText.names.length ? join(m.pngText.names) : "", m.pngText.custom ? `独自の欄 ${m.pngText.custom} 個` : ""].filter(Boolean).join("／"),
    });
  }
  return out;
}

function noticesOf(m: Meta): FormatNotice[] {
  const out: FormatNotice[] = [];
  if (m.broken || m.exif.some((e) => e.broken)) out.push({ kind: "broken", message: "ファイルの一部が壊れていたため、途中までしか調べていません。", unchecked: true });
  if (m.partial) out.push({ kind: "partial", message: "圧縮された文字の欄の一部を解けなかったため、調べていません。", unchecked: true });
  return out;
}

export async function inspectImage(bytes: Uint8Array, kind: Extract<FormatKind, "jpeg" | "png" | "webp" | "heic">): Promise<FormatReport> {
  if (kind === "heic") {
    const items = heicItems(bytes);
    const findings: FormatFinding[] = [];
    if (items.exif || items.xmp) {
      findings.push({
        type: "image.heic_meta",
        severity: "medium",
        title: "撮った時の記録（EXIF・XMP）が入っています",
        why: "撮った場所（GPS）や機種が入っていることがあります。HEIC の中身までは調べていません。",
        detail: [items.exif ? "EXIF" : "", items.xmp ? "XMP" : ""].filter(Boolean).join("・"),
        page: null,
        where: null,
      });
    }
    return {
      format: "heic",
      findings,
      notices: [{ kind: "unsupported", message: "HEIC・HEIF の写真は、記録が有るかだけを見て、中身（撮った場所など）までは調べていません。", unchecked: true }],
    };
  }
  const m = kind === "jpeg" ? readJpeg(bytes) : kind === "png" ? await readPng(bytes) : readWebp(bytes);
  return { format: kind, findings: findingsOf(m), notices: noticesOf(m) };
}

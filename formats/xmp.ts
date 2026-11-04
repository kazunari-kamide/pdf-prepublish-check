// SPDX-License-Identifier: AGPL-3.0-only
//
// XMP（埋め込まれた作成の記録）の項目を読む。写真・PDF の比べ（compare/）で共通に使う。
// 項目の中身は、比べる・数えるためだけに使い、外に返さない。

/** よく使う名前空間（この名前の項目は、名前を出してよい）。それ以外は「独自の項目」とし、名前も出さない */
export const XMP_KNOWN_PREFIXES = new Set([
  "dc", "xmp", "xap", "pdf", "pdfx", "pdfaid", "xmpMM", "xapMM", "xmpRights", "xapRights", "photoshop", "tiff", "exif", "exifEX",
  "aux", "crs", "stRef", "stEvt", "xmpTPg", "xmpGImg", "illustrator", "iptc4xmpCore", "Iptc4xmpCore", "Iptc4xmpExt", "plus", "lr",
]);
const SKIP = new Set(["rdf", "x", "xml", "xmlns"]);

/** 人をたどれる項目（作成者・権利者など） */
export const XMP_PERSON = new Set([
  "dc:creator", "dc:contributor", "dc:rights", "pdf:Author", "xmp:Author", "xmpRights:Owner", "photoshop:AuthorsPosition",
  "photoshop:CaptionWriter", "photoshop:Credit", "Iptc4xmpCore:CreatorContactInfo", "iptc4xmpCore:CreatorContactInfo",
]);
/** 編集の履歴・元のファイルをたどれる項目 */
export const XMP_HISTORY = new Set(["xmpMM:History", "xmpMM:DerivedFrom", "xmpMM:Ingredients", "xmpMM:Manifest", "photoshop:DocumentAncestors"]);
/** 撮った場所の項目 */
export const XMP_GPS = new Set(["exif:GPSLatitude", "exif:GPSLongitude", "exif:GPSAltitude"]);

/**
 * XMP の項目（rdf:Description の直下の要素と属性）の名前と、比べるための中身。
 * 入れ子の中（rdf:Seq の中の rdf:li など）は、1つの項目の中身にまとめる
 */
export function xmpProperties(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const tag = /<(\/?)([A-Za-z_][\w.-]*:[\w.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const attr = /([A-Za-z_][\w.-]*:[\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let inDesc = 0;
  let current: { name: string; start: number; depth: number } | null = null;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    const [, close, name, rest, self] = m;
    if (!name) continue;
    if (name === "rdf:Description" && !current) {
      if (close) inDesc = Math.max(0, inDesc - 1);
      else {
        for (const a of rest!.matchAll(attr)) {
          const n = a[1]!;
          if (!SKIP.has(n.split(":")[0]!)) out.set(n, a[3] ?? a[4] ?? "");
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
    if (!current && !SKIP.has(name.split(":")[0]!)) {
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

/** 中身が空でない項目（空白・タグだけのものは空とみなす） */
export function nonEmptyXmp(props: Map<string, string>): string[] {
  return [...props.entries()].filter(([, v]) => v.replace(/<[^>]*>/g, "").trim() !== "").map(([k]) => k);
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// テスト用の合成ファイル（写真・今の Office）を一から作る。中身はすべて架空の名前・番号。
// 外の道具・実在のファイルは使わない。画像は、調べる部分（記録の印・大きさ）だけを持つ形で、絵としては表示できなくてよい。

import { deflateRawSync, deflateSync } from "node:zlib";

export const FAKE_NAME = "Kasou Hanako";
export const FAKE_NAME_JA = "架空花子";
export const FAKE_PATH = "C:\\Users\\kasou-taro\\Documents\\template.dotx";

const enc = (s: string) => new TextEncoder().encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const u16be = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const u32be = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u16le = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
const u32le = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

// ---------------------------------------------------------------- TIFF（EXIF）

export type Tag = { tag: number; type: 2 | 3 | 4 | 5 | 7; value: string | number | number[] };

/** 字の欄（ASCII）。最後に 0 を足す */
export const asciiTag = (tag: number, s: string): Tag => ({ tag, type: 2, value: s });
export const longTag = (tag: number, n: number): Tag => ({ tag, type: 4, value: n });
/** 有理数の並び（GPS の緯度・経度など）。[分子, 分母, …] */
export const rationalTag = (tag: number, nums: number[]): Tag => ({ tag, type: 5, value: nums });

type Ifd = Tag[];

/**
 * リトルエンディアンの TIFF を作る。ifd0 の 0x8769（Exif）・0x8825（GPS）の指し先と、IFD1（縮小画像）は自動で入れる
 */
export function tiff(o: { ifd0?: Ifd; exif?: Ifd; gps?: Ifd; thumbnail?: Uint8Array }): Uint8Array {
  const ifd0 = [...(o.ifd0 ?? [])];
  if (o.exif) ifd0.push(longTag(0x8769, 0));
  if (o.gps) ifd0.push(longTag(0x8825, 0));
  const ifds: Ifd[] = [ifd0];
  if (o.exif) ifds.push(o.exif);
  if (o.gps) ifds.push(o.gps);
  const ifd1: Ifd | null = o.thumbnail ? [longTag(0x0103, 6), longTag(0x0201, 0), longTag(0x0202, o.thumbnail.length)] : null;
  if (ifd1) ifds.push(ifd1);

  // 配置：ヘッダー 8 バイト → 各 IFD（2 + 12n + 4）と、その値の場所 → 縮小画像
  const valueBytes = (t: Tag): Uint8Array => {
    if (t.type === 2 || t.type === 7) return concat(enc(String(t.value)), new Uint8Array([0]));
    if (t.type === 3) return u16le(Number(t.value));
    if (t.type === 4) return u32le(Number(t.value));
    const nums = t.value as number[];
    return concat(...nums.map((n) => u32le(n)));
  };
  const sizes = ifds.map((ifd) => 2 + ifd.length * 12 + 4 + ifd.reduce((s, t) => s + Math.max(0, valueBytes(t).length > 4 ? valueBytes(t).length : 0), 0));
  const offsets: number[] = [];
  let at = 8;
  for (const s of sizes) {
    offsets.push(at);
    at += s;
  }
  const thumbAt = at;
  const exifAt = o.exif ? offsets[1]! : 0;
  const gpsAt = o.gps ? offsets[o.exif ? 2 : 1]! : 0;
  const out: Uint8Array[] = [enc("II"), u16le(42), u32le(8)];
  ifds.forEach((ifd, i) => {
    const base = offsets[i]!;
    let extra = base + 2 + ifd.length * 12 + 4;
    const entries: Uint8Array[] = [];
    const extras: Uint8Array[] = [];
    for (const t0 of ifd) {
      let t = t0;
      if (t.tag === 0x8769 && i === 0) t = longTag(0x8769, exifAt);
      if (t.tag === 0x8825 && i === 0) t = longTag(0x8825, gpsAt);
      if (t.tag === 0x0201 && ifd === ifd1) t = longTag(0x0201, thumbAt);
      const v = valueBytes(t);
      const count = t.type === 2 || t.type === 7 ? v.length : t.type === 5 ? (t.value as number[]).length / 2 : 1;
      let field: Uint8Array;
      if (v.length <= 4) field = concat(v, new Uint8Array(4 - v.length));
      else {
        field = u32le(extra);
        extras.push(v);
        extra += v.length;
      }
      entries.push(concat(u16le(t.tag), u16le(t.type), u32le(count), field));
    }
    const next = i === 0 && ifd1 ? offsets[ifds.length - 1]! : 0;
    out.push(u16le(ifd.length), ...entries, u32le(ifd === ifd1 ? 0 : next), ...extras);
  });
  if (o.thumbnail) out.push(o.thumbnail);
  return concat(...out);
}

// ---------------------------------------------------------------- JPEG

const seg = (marker: number, data: Uint8Array) => concat(new Uint8Array([0xff, marker]), u16be(data.length + 2), data);
const sof = (w: number, h: number) => seg(0xc0, concat(new Uint8Array([8]), u16be(h), u16be(w), new Uint8Array([1, 1, 0x11, 0])));

/** 記録の印と大きさだけを持つ JPEG（絵の中身は空） */
export function jpeg(o: { width?: number; height?: number; exif?: Uint8Array; xmp?: string; iptc?: Uint8Array } = {}): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (o.exif) parts.push(seg(0xe1, concat(enc("Exif\0\0"), o.exif)));
  if (o.xmp) parts.push(seg(0xe1, concat(enc("http://ns.adobe.com/xap/1.0/\0"), enc(o.xmp))));
  if (o.iptc) parts.push(seg(0xed, o.iptc));
  parts.push(sof(o.width ?? 640, o.height ?? 480));
  parts.push(seg(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])), new Uint8Array([0x00, 0xff, 0xd9]));
  return concat(...parts);
}

/** Photoshop の資源の中の IPTC（項目 2:dataset の並び） */
export function iptc(datasets: Array<[number, string]>): Uint8Array {
  const body = concat(...datasets.map(([ds, v]) => concat(new Uint8Array([0x1c, 2, ds]), u16be(enc(v).length), enc(v))));
  const res = concat(enc("8BIM"), u16be(0x0404), new Uint8Array([0, 0]), u32be(body.length), body, body.length % 2 ? new Uint8Array([0]) : new Uint8Array());
  return concat(enc("Photoshop 3.0\0"), res);
}

export const XMP = (inner: string) =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:exif="http://ns.adobe.com/exif/1.0/">${inner}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const chunk = (type: string, data: Uint8Array) => concat(u32be(data.length), enc(type), data, u32be(crc32(concat(enc(type), data))));

export function png(o: { width?: number; height?: number; exif?: Uint8Array; text?: Array<[string, string]>; ztext?: Array<[string, string]>; xmp?: string; rawExifHex?: Uint8Array } = {}): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  parts.push(chunk("IHDR", concat(u32be(o.width ?? 320), u32be(o.height ?? 240), new Uint8Array([8, 2, 0, 0, 0]))));
  if (o.exif) parts.push(chunk("eXIf", o.exif));
  for (const [k, v] of o.text ?? []) parts.push(chunk("tEXt", concat(enc(k), new Uint8Array([0]), enc(v))));
  for (const [k, v] of o.ztext ?? []) parts.push(chunk("zTXt", concat(enc(k), new Uint8Array([0, 0]), new Uint8Array(deflateSync(enc(v))))));
  if (o.xmp) parts.push(chunk("iTXt", concat(enc("XML:com.adobe.xmp"), new Uint8Array([0, 0, 0, 0, 0]), enc(o.xmp))));
  if (o.rawExifHex) {
    const hex = [...concat(enc("Exif\0\0"), o.rawExifHex)].map((b) => b.toString(16).padStart(2, "0")).join("");
    parts.push(chunk("tEXt", concat(enc("Raw profile type exif"), new Uint8Array([0]), enc(`\nexif\n${hex.length / 2}\n${hex}\n`))));
  }
  parts.push(chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(10)))), chunk("IEND", new Uint8Array()));
  return concat(...parts);
}

// ---------------------------------------------------------------- WebP

const riffChunk = (type: string, data: Uint8Array) => concat(enc(type), u32le(data.length), data, data.length % 2 ? new Uint8Array([0]) : new Uint8Array());

export function webp(o: { width?: number; height?: number; exif?: Uint8Array; xmp?: string } = {}): Uint8Array {
  const w = (o.width ?? 400) - 1;
  const h = (o.height ?? 300) - 1;
  const flags = (o.exif ? 0x08 : 0) | (o.xmp ? 0x04 : 0);
  const vp8x = riffChunk("VP8X", new Uint8Array([flags, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]));
  const body = concat(enc("WEBP"), vp8x, riffChunk("VP8L", new Uint8Array([0x2f, 0, 0, 0, 0])), o.exif ? riffChunk("EXIF", o.exif) : new Uint8Array(), o.xmp ? riffChunk("XMP ", enc(o.xmp)) : new Uint8Array());
  return concat(enc("RIFF"), u32le(body.length), body);
}

// ---------------------------------------------------------------- HEIC（箱の並びだけ）

const box = (type: string, data: Uint8Array) => concat(u32be(data.length + 8), enc(type), data);

export function heic(o: { exifItem?: boolean } = {}): Uint8Array {
  const ftyp = box("ftyp", concat(enc("heic"), u32be(0), enc("mif1heic")));
  const items = [box("infe", concat(new Uint8Array([2, 0, 0, 0]), u16be(1), u16be(0), enc("hvc1"), new Uint8Array([0])))];
  if (o.exifItem) items.push(box("infe", concat(new Uint8Array([2, 0, 0, 0]), u16be(2), u16be(0), enc("Exif"), new Uint8Array([0]))));
  const iinf = box("iinf", concat(new Uint8Array([0, 0, 0, 0]), u16be(items.length), ...items));
  const meta = box("meta", concat(new Uint8Array([0, 0, 0, 0]), iinf));
  return concat(ftyp, meta);
}

// ---------------------------------------------------------------- ZIP

export function zip(files: Record<string, string | Uint8Array>, o: { store?: boolean } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? enc(content) : content;
    const method = o.store ? 0 : 8;
    const comp = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const crc = crc32(data);
    const n = enc(name);
    const head = concat(u16le(20), u16le(0x800), u16le(method), u16le(0), u16le(0), u32le(crc), u32le(comp.length), u32le(data.length), u16le(n.length), u16le(0));
    const local = concat(u32le(0x04034b50), head, n, comp);
    centrals.push(concat(u32le(0x02014b50), u16le(20), head, u16le(0), u16le(0), u16le(0), u32le(0), u32le(offset), n));
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(...centrals);
  const eocd = concat(u32le(0x06054b50), u16le(0), u16le(0), u16le(centrals.length), u16le(centrals.length), u32le(cd.length), u32le(offset), u16le(0));
  return concat(...locals, cd, eocd);
}

// ---------------------------------------------------------------- 今の Office

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const NS_P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export type Props = { creator?: string; lastModifiedBy?: string; title?: string; company?: string; template?: string; custom?: Record<string, string> };

function docProps(p: Props): Record<string, string> {
  const out: Record<string, string> = {};
  out["docProps/core.xml"] =
    XML_HEAD +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    (p.creator !== undefined ? `<dc:creator>${p.creator}</dc:creator>` : "") +
    (p.lastModifiedBy !== undefined ? `<cp:lastModifiedBy>${p.lastModifiedBy}</cp:lastModifiedBy>` : "") +
    (p.title !== undefined ? `<dc:title>${p.title}</dc:title>` : "") +
    `</cp:coreProperties>`;
  out["docProps/app.xml"] =
    XML_HEAD +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Template>${p.template ?? "Normal.dotm"}</Template><Application>KasouOffice</Application>` +
    (p.company !== undefined ? `<Company>${p.company}</Company>` : "") +
    `</Properties>`;
  if (p.custom) {
    out["docProps/custom.xml"] =
      XML_HEAD +
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      Object.entries(p.custom).map(([k, v], i) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" name="${k}"><vt:lpwstr>${v}</vt:lpwstr></property>`).join("") +
      `</Properties>`;
  }
  return out;
}

const rels = (items: Array<{ id: string; type: string; target: string; external?: boolean }>) =>
  XML_HEAD +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  items.map((r) => `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"${r.external ? ' TargetMode="External"' : ""}/>`).join("") +
  `</Relationships>`;

export type DocxOptions = {
  props?: Props;
  /** 本文の段落（w:p の中身の XML）。省くと、ふつうの段落が2つ */
  body?: string[];
  comments?: Array<{ author: string; text: string }>;
  styles?: string;
  attachedTemplate?: string;
  media?: Record<string, Uint8Array>;
  embeddings?: Record<string, Uint8Array>;
  links?: string[];
};

export const run = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
export const para = (...runs: string[]) => `<w:p>${runs.join("")}</w:p>`;

export function docx(o: DocxOptions = {}): Uint8Array {
  const body = o.body ?? [para(run("Notice of the meeting")), para(run("The meeting will be held on Monday."))];
  const files: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "_rels/.rels": rels([{ id: "rId1", type: "officeDocument", target: "word/document.xml" }]),
    "word/document.xml": XML_HEAD + `<w:document ${NS_W} ${NS_R}><w:body>${body.join("")}<w:sectPr/></w:body></w:document>`,
    ...docProps(o.props ?? {}),
  };
  const docRels: Array<{ id: string; type: string; target: string; external?: boolean }> = [];
  if (o.comments) {
    files["word/comments.xml"] =
      XML_HEAD + `<w:comments ${NS_W}>` + o.comments.map((c, i) => `<w:comment w:id="${i}" w:author="${c.author}"><w:p>${run(c.text)}</w:p></w:comment>`).join("") + `</w:comments>`;
    docRels.push({ id: "rIdC", type: "comments", target: "comments.xml" });
  }
  if (o.styles) files["word/styles.xml"] = XML_HEAD + `<w:styles ${NS_W}>${o.styles}</w:styles>`;
  if (o.attachedTemplate) {
    files["word/settings.xml"] = XML_HEAD + `<w:settings ${NS_W} ${NS_R}><w:attachedTemplate r:id="rIdT"/></w:settings>`;
    files["word/_rels/settings.xml.rels"] = rels([{ id: "rIdT", type: "attachedTemplate", target: o.attachedTemplate, external: true }]);
  }
  for (const [i, l] of (o.links ?? []).entries()) docRels.push({ id: `rIdL${i}`, type: "hyperlink", target: l, external: true });
  for (const [n, b] of Object.entries(o.media ?? {})) files[`word/media/${n}`] = b;
  for (const [n, b] of Object.entries(o.embeddings ?? {})) files[`word/embeddings/${n}`] = b;
  if (docRels.length) files["word/_rels/document.xml.rels"] = rels(docRels);
  return zip(files);
}

export type Cell = { ref: string; value: string; s?: number };
export type SheetOptions = { state?: "hidden" | "veryHidden"; cells?: Cell[]; hiddenRows?: number[]; hiddenCols?: [number, number][] };

export function xlsx(o: { props?: Props; sheets?: SheetOptions[]; styles?: string; comments?: number; externalLink?: string; revisions?: boolean } = {}): Uint8Array {
  const sheets = o.sheets ?? [{ cells: [{ ref: "A1", value: "1" }] }];
  const files: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "_rels/.rels": rels([{ id: "rId1", type: "officeDocument", target: "xl/workbook.xml" }]),
    "xl/workbook.xml":
      XML_HEAD +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${NS_R}><sheets>` +
      sheets.map((s, i) => `<sheet name="Sheet${i + 1}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`).join("") +
      `</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": rels(sheets.map((_, i) => ({ id: `rId${i + 1}`, type: "worksheet", target: `worksheets/sheet${i + 1}.xml` }))),
    ...docProps(o.props ?? {}),
  };
  sheets.forEach((s, i) => {
    const rows = new Map<number, Cell[]>();
    for (const c of s.cells ?? []) {
      const r = Number(c.ref.replace(/^[A-Z]+/, ""));
      rows.set(r, [...(rows.get(r) ?? []), c]);
    }
    for (const r of s.hiddenRows ?? []) if (!rows.has(r)) rows.set(r, []);
    const cols = (s.hiddenCols ?? []).map(([a, b]) => `<col min="${a}" max="${b}" width="9" hidden="1"/>`).join("");
    files[`xl/worksheets/sheet${i + 1}.xml`] =
      XML_HEAD +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols ? `<cols>${cols}</cols>` : ""}<sheetData>` +
      [...rows.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([r, cs]) => `<row r="${r}"${(s.hiddenRows ?? []).includes(r) ? ' hidden="1"' : ""}>${cs.map((c) => `<c r="${c.ref}"${c.s ? ` s="${c.s}"` : ""} t="inlineStr"><is><t>${c.value}</t></is></c>`).join("")}</row>`)
        .join("") +
      `</sheetData></worksheet>`;
  });
  if (o.styles) files["xl/styles.xml"] = XML_HEAD + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${o.styles}</styleSheet>`;
  if (o.comments) {
    files["xl/comments1.xml"] =
      XML_HEAD +
      `<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>${FAKE_NAME}</author></authors><commentList>` +
      Array.from({ length: o.comments }, (_, i) => `<comment ref="B${i + 1}" authorId="0"><text><t>memo ${i}</t></text></comment>`).join("") +
      `</commentList></comments>`;
  }
  if (o.externalLink) {
    files["xl/externalLinks/externalLink1.xml"] = XML_HEAD + `<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`;
    files["xl/externalLinks/_rels/externalLink1.xml.rels"] = rels([{ id: "rId1", type: "externalLinkPath", target: o.externalLink, external: true }]);
  }
  if (o.revisions) files["xl/revisions/revisionLog1.xml"] = XML_HEAD + `<revisions xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`;
  return zip(files);
}

export type Sp = { x: number; y: number; w: number; h: number; fill?: string; text?: string; textColor?: string };

const EMU = 12700;
const sp = (s: Sp, id: number) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="${s.x * EMU}" y="${s.y * EMU}"/><a:ext cx="${s.w * EMU}" cy="${s.h * EMU}"/></a:xfrm><a:prstGeom prst="rect"/>` +
  (s.fill ? `<a:solidFill><a:srgbClr val="${s.fill}"/></a:solidFill>` : "<a:noFill/>") +
  `</p:spPr>` +
  (s.text !== undefined
    ? `<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="ja-JP">${s.textColor ? `<a:solidFill><a:srgbClr val="${s.textColor}"/></a:solidFill>` : ""}</a:rPr><a:t>${s.text}</a:t></a:r></a:p></p:txBody>`
    : "") +
  `</p:sp>`;

export type SlideOptions = { hidden?: boolean; shapes?: Sp[]; notes?: string; group?: boolean };

export function pptx(o: { props?: Props; slides?: SlideOptions[]; comments?: number } = {}): Uint8Array {
  const slides = o.slides ?? [{ shapes: [{ x: 50, y: 50, w: 400, h: 60, text: "Notice of the meeting" }] }];
  const files: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "_rels/.rels": rels([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]),
    "ppt/presentation.xml":
      XML_HEAD +
      `<p:presentation ${NS_A} ${NS_R} ${NS_P}><p:sldIdLst>` +
      slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("") +
      `</p:sldIdLst><p:sldSz cx="${960 * EMU}" cy="${540 * EMU}"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels(slides.map((_, i) => ({ id: `rId${i + 1}`, type: "slide", target: `slides/slide${i + 1}.xml` }))),
    ...docProps(o.props ?? {}),
  };
  slides.forEach((s, i) => {
    const shapes = (s.shapes ?? []).map((x, j) => sp(x, j + 2)).join("");
    const group = s.group ? `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="99" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:grpSp>` : "";
    files[`ppt/slides/slide${i + 1}.xml`] =
      XML_HEAD + `<p:sld ${NS_A} ${NS_R} ${NS_P}${s.hidden ? ' show="0"' : ""}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}${group}</p:spTree></p:cSld></p:sld>`;
    if (s.notes !== undefined) {
      files[`ppt/notesSlides/notesSlide${i + 1}.xml`] =
        XML_HEAD +
        `<p:notes ${NS_A} ${NS_P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${s.notes}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
      files[`ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`] = rels([{ id: "rId1", type: "slide", target: `../slides/slide${i + 1}.xml` }]);
    }
  });
  if (o.comments) {
    files["ppt/comments/comment1.xml"] =
      XML_HEAD + `<p:cmLst ${NS_P}>` + Array.from({ length: o.comments }, (_, i) => `<p:cm authorId="0" idx="${i + 1}"><p:pos x="0" y="0"/><p:text>memo</p:text></p:cm>`).join("") + `</p:cmLst>`;
    files["ppt/commentAuthors.xml"] = XML_HEAD + `<p:cmAuthorLst ${NS_P}><p:cmAuthor id="0" name="${FAKE_NAME}" initials="KH" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`;
  }
  return zip(files);
}

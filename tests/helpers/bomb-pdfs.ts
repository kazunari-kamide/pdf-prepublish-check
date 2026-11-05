// SPDX-License-Identifier: AGPL-3.0-only
//
// 展開すると巨大になる合成 PDF（圧縮の爆弾）を、テストの中で作る（fixtures/ には置かない。解くと数百 MB〜1GB を超えるため）。
// - 中身は 0 の並びを FlateDecode で縮めたもの。300MB で約 0.3MB、1.2GB で約 1.2MB の PDF になる。
// - 縮めるときも 1MB ずつ流すので、テストの側は解いた大きさのメモリを使わない。
// - 実在の個人名・団体名は入れない。

import { createDeflate } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib";

export const MB = 1024 * 1024;

const cache = new Map<string, Uint8Array>();

/** head のあとに、0 を size バイト並べて、zlib の形（FlateDecode）で縮めたもの */
export async function deflatedZeros(size: number, head: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
  const key = `${size}:${new TextDecoder("latin1").decode(head)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const z = createDeflate({ level: 9 });
  const out: Buffer[] = [];
  z.on("data", (c: Buffer) => out.push(c));
  const ended = new Promise<void>((resolve, reject) => {
    z.on("end", () => resolve());
    z.on("error", reject);
  });
  const write = async (b: Uint8Array) => {
    if (!z.write(b)) await new Promise((r) => z.once("drain", r));
  };
  if (head.length) await write(head);
  const chunk = new Uint8Array(MB);
  for (let left = size; left > 0; left -= chunk.length) await write(chunk.subarray(0, Math.min(left, chunk.length)));
  z.end();
  await ended;
  const bytes = new Uint8Array(Buffer.concat(out));
  cache.set(key, bytes);
  return bytes;
}

function flate(doc: PDFDocument, data: Uint8Array, extra: Record<string, unknown> = {}): PDFRef {
  return doc.context.register(PDFRawStream.of(doc.context.obj({ ...extra, Filter: "FlateDecode", Length: data.length }), data));
}

async function save(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/** 字が 1 つある、ふつうのページの中身（爆弾ではないページ） */
const PLAIN_CONTENT = "BT /F1 12 Tf 72 720 Td (Sample text) Tj ET";

/** ページの中身を置き換える（前の中身は消す。どこからも使われない中身が残ると、P5 の見つけた所になるため） */
function setContents(doc: PDFDocument, pageIndex: number, ref: PDFRef): void {
  const node = doc.getPage(pageIndex).node;
  const old = node.get(PDFName.of("Contents"));
  if (old instanceof PDFRef) doc.context.delete(old);
  node.set(PDFName.of("Contents"), ref);
}

async function baseDoc(pages: number): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }));
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.node.set(PDFName.of("Resources"), doc.context.obj({ Font: { F1: font } }));
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(PLAIN_CONTENT)));
  }
  return doc;
}

/** ページの中身の爆弾。bombPage のページの中身が、解くと size バイトになる（ほかのページはふつう） */
export async function contentBomb(size: number, opts: { pages?: number; bombPage?: number } = {}): Promise<Uint8Array> {
  const pages = opts.pages ?? 2;
  const bombPage = opts.bombPage ?? 1;
  const doc = await baseDoc(pages);
  setContents(doc, bombPage - 1, flate(doc, await deflatedZeros(size, new TextEncoder().encode(PLAIN_CONTENT + "\n"))));
  return save(doc);
}

/** 1 つのファイルの合計の爆弾：each バイトに解けるページの中身を、pages ページ分。1 つずつは上限の内、合計は上限の外 */
export async function totalBomb(each: number, pages: number): Promise<Uint8Array> {
  const doc = await baseDoc(pages);
  // 同じ中身の流れを使い回すと 1 回しか数えないので、ページごとに別の流れにする（中身の頭の字を変える）
  for (let i = 0; i < pages; i++) {
    const head = new TextEncoder().encode(`${PLAIN_CONTENT}\n% page ${i + 1}\n`);
    setContents(doc, i, flate(doc, await deflatedZeros(each, head)));
  }
  return save(doc);
}

/** XMP の爆弾：文書の /Metadata が、解くと size バイトになる */
export async function xmpBomb(size: number): Promise<Uint8Array> {
  const doc = await baseDoc(1);
  const head = new TextEncoder().encode('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">');
  doc.catalog.set(PDFName.of("Metadata"), flate(doc, await deflatedZeros(size, head), { Type: "Metadata", Subtype: "XML" }));
  return save(doc);
}

/** 添付の爆弾：添付ファイル 1 つが、解くと size バイトになる */
export async function attachmentBomb(size: number): Promise<Uint8Array> {
  const doc = await baseDoc(1);
  const ef = flate(doc, await deflatedZeros(size), { Type: "EmbeddedFile" });
  const spec = doc.context.register(doc.context.obj({ Type: "Filespec", F: "data.bin", UF: "data.bin", EF: { F: ef } }));
  doc.catalog.set(PDFName.of("Names"), doc.context.obj({ EmbeddedFiles: { Names: ["data.bin", spec] } }));
  return save(doc);
}

/**
 * 画像の爆弾：辞書では小さい（width×height の 8bit の灰色）画像が、解くと size バイトになる。
 * 画像の上に黒い四角を重ねる（P6 が画像の画素を読みに行くように）。
 */
export async function imageBomb(size: number, width = 200, height = 200): Promise<Uint8Array> {
  const doc = await baseDoc(1);
  const page = doc.getPage(0);
  const im = flate(doc, await deflatedZeros(size), { Type: "XObject", Subtype: "Image", Width: width, Height: height, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
  const res = doc.context.obj({ XObject: { Im0: im } });
  page.node.set(PDFName.of("Resources"), res);
  setContents(doc, 0, doc.context.register(doc.context.stream("q 200 0 0 200 100 500 cm /Im0 Do Q q 0 g 150 550 100 40 re f Q")));
  return save(doc);
}

/** オブジェクトストリームの爆弾：読み込みのときに pdf-lib が解く /ObjStm が、解くと size バイトになる */
export async function objectStreamBomb(size: number): Promise<Uint8Array> {
  const doc = await baseDoc(1);
  // 中に 1 つだけオブジェクト（番号は使っていないもの）を入れ、そのあとを 0 で埋める
  const num = doc.context.largestObjectNumber + 100;
  const header = `${num} 0 `;
  const body = new TextEncoder().encode(`${header}<< /Note (x) >>\n`);
  const data = await deflatedZeros(size, body);
  doc.context.register(PDFRawStream.of(doc.context.obj({ Type: "ObjStm", N: 1, First: header.length, Filter: "FlateDecode", Length: data.length }), data));
  return save(doc);
}

/**
 * 上限の内に収まる大きなスキャンの対照：600dpi の A4 相当（4960×7016）の 8bit のカラー（RGB）の画像を 1 枚置いたページ。
 * 解くと約 104MB（1 つの流れの上限 256MB の内。片付けでは、丸ごと解く上限 64MB を超えるので、流して塗る道を通る）。
 * 濃淡の縞なので、よく縮む。上に黒い四角を 1 つ重ねる（P6 の画像の層が、画素を読みに行くように）。
 */
export async function largeScan(): Promise<Uint8Array> {
  const width = 4960;
  const height = 7016;
  const key = "scan";
  let data = cache.get(key);
  if (!data) {
    const z = createDeflate({ level: 6 });
    const out: Buffer[] = [];
    z.on("data", (c: Buffer) => out.push(c));
    const ended = new Promise<void>((resolve) => z.on("end", () => resolve()));
    for (let y = 0; y < height; y++) {
      // 行ごとに新しく作る（zlib は渡したかけらを、あとで読むため）
      const row = new Uint8Array(width * 3).fill(200 + ((y >> 4) % 40));
      if (!z.write(row)) await new Promise((r) => z.once("drain", r));
    }
    z.end();
    await ended;
    data = new Uint8Array(Buffer.concat(out));
    cache.set(key, data);
  }
  const doc = await baseDoc(1);
  const page = doc.getPage(0);
  const im = flate(doc, data, { Type: "XObject", Subtype: "Image", Width: width, Height: height, ColorSpace: "DeviceRGB", BitsPerComponent: 8 });
  page.node.set(PDFName.of("Resources"), doc.context.obj({ XObject: { Im0: im } }));
  setContents(doc, 0, doc.context.register(doc.context.stream("q 595 0 0 842 0 0 cm /Im0 Do Q q 0 g 100 600 200 40 re f Q")));
  return save(doc);
}

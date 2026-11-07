// SPDX-License-Identifier: AGPL-3.0-only
//
// 墨消し漏れの見本（架空の明細。値も宛名も架空）。ratchet/synthetic.ts の架空の束と、tests/ratchet.test.ts で使う。
//   漏れ：宛名と住所を黒く塗ったのに、その下の郵便用のバーコードが塗られずに残る（ベクターと、スキャン風の 2 つ）
//   対照：バーコードも塗ったもの・バーコードのないもの
//   同じ書式：2 ページのうち、1 ページだけ郵便番号の欄を塗り、もう 1 ページは同じ欄を残す
//   飾り：ページの幅いっぱいの黒い帯・グラフの棒・白い字の載った黒い見出し（墨消しに数えない）
//   実物に近いスキャン（s26〜s29）：傾き・紙の色・灰色の塗り・点・JPEG・罫線に触れる塗り、荒いもの、白黒の FAX 形式（CCITT）
//
// バーコードは、公開されている「郵便番号・バーコードマニュアル」のカスタマバーコードの仕様に従う（2026-11-07 に確かめた）：
//   バーの形 1 ロング・2 セミロング（上）・3 セミロング（下）・4 タイミング（https://www.post.japanpost.jp/service/search/zipcode/zipmanual/p11.html の図）
//   キャラクタのバーの組み合わせ（同 image/p12-1.gif の表）、チェックデジットは合計が 19 の倍数（同 p21.html）、
//   寸法（10 ポ相当）：ロングバー 3.6mm・タイミングバー 1.2mm・バーピッチ 1.2mm・バー幅 0.6mm（同 p12.html・image/p13-1.gif）
//   構成：スタート・郵便番号 7・住所表示番号 13（足りなければ CC4 で埋める）・チェックデジット 1・ストップ

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { concatTransformationMatrix, drawObject, PDFDocument, PDFName, PDFPage, popGraphicsState, pushGraphicsState, StandardFonts, rgb, type PDFFont } from "pdf-lib";

/** キャラクタのバーの組み合わせ（マニュアルの表のまま） */
export const BARS: Record<string, string> = {
  "1": "114", "2": "132", "3": "312", "4": "123", "5": "141", "6": "321", "7": "213", "8": "231", "9": "411", "0": "144",
  "-": "414", CC1: "324", CC2: "342", CC3: "234", CC4: "432", CC5: "243", CC6: "423", CC7: "441", CC8: "111",
  START: "13", STOP: "31",
};
const CHECK_VALUE = (c: string) => (/^\d$/.test(c) ? Number(c) : c === "-" ? 10 : 10 + Number(c.slice(2)));
const FROM_VALUE = (v: number) => (v <= 9 ? String(v) : v === 10 ? "-" : `CC${v - 10}`);

/** 郵便番号 7 けたと、住所表示番号（数字とハイフンだけ。架空の値）から、バーの形の並びを作る */
export function customerBarcode(zip: string, address: string): number[] {
  if (!/^\d{7}$/.test(zip) || !/^[\d-]*$/.test(address)) throw new Error("架空の値は、数字とハイフンだけ");
  const chars = [...zip, ...address.slice(0, 13)];
  while (chars.length < 20) chars.push("CC4");
  const sum = chars.reduce((a, c) => a + CHECK_VALUE(c), 0);
  chars.push(FROM_VALUE((19 - (sum % 19)) % 19));
  return ["START", ...chars, "STOP"].flatMap((c) => [...BARS[c]!].map(Number));
}

const MM = 72 / 25.4;

/** バーを描く（左下の x、真ん中の高さ y。単位 pt） */
function drawBarcode(p: PDFPage, x: number, yMid: number, bars: number[]): { x0: number; x1: number; y0: number; y1: number } {
  const half = 1.8 * MM, t = 0.6 * MM;
  bars.forEach((b, i) => {
    const [lo, hi] = b === 1 ? [-half, half] : b === 2 ? [-t, half] : b === 3 ? [-half, t] : [-t, t];
    p.drawRectangle({ x: x + i * 1.2 * MM, y: yMid + lo, width: 0.6 * MM, height: hi - lo, color: rgb(0, 0, 0) });
  });
  return { x0: x, x1: x + bars.length * 1.2 * MM, y0: yMid - half, y1: yMid + half };
}

type Kind = "leak" | "covered" | "none";

/** 架空の明細の 1 ページ（宛名・住所を黒く塗る）。kind でバーコードの扱いを変える */
function statementPage(d: PDFDocument, font: PDFFont, kind: Kind): void {
  const p = d.addPage([595, 842]);
  p.drawText("Kakuu Denki  Monthly statement", { x: 50, y: 790, size: 16, font });
  // 宛名と住所（架空）。黒く塗る
  p.drawText("999-0000", { x: 60, y: 730, size: 11, font });
  p.drawText("9-9-9 Kakuu-cho, Kakuu-shi", { x: 60, y: 714, size: 11, font });
  p.drawText("Kakuu Taro", { x: 60, y: 694, size: 13, font });
  p.drawRectangle({ x: 56, y: 708, width: 190, height: 34, color: rgb(0, 0, 0) });
  p.drawRectangle({ x: 56, y: 690, width: 90, height: 18, color: rgb(0, 0, 0) });
  if (kind !== "none") {
    const r = drawBarcode(p, 60, 676, customerBarcode("9990000", "9-9-9"));
    if (kind === "covered") p.drawRectangle({ x: r.x0 - 3, y: r.y0 - 3, width: r.x1 - r.x0 + 6, height: r.y1 - r.y0 + 6, color: rgb(0, 0, 0) });
  }
  // 表（線と文字。墨消しではない）
  for (let i = 0; i <= 5; i++) p.drawLine({ start: { x: 50, y: 600 - i * 24 }, end: { x: 545, y: 600 - i * 24 }, thickness: 0.6 });
  ["Item", "Usage", "Amount"].forEach((t, i) => p.drawText(t, { x: 60 + i * 160, y: 584, size: 11, font }));
  for (let r = 1; r < 5; r++) ["Kakuu plan", `${r * 10} kWh`, `${r * 1000} yen`].forEach((t, i) => p.drawText(t, { x: 60 + i * 160, y: 584 - r * 24, size: 11, font }));
}

async function newDoc(): Promise<{ d: PDFDocument; font: PDFFont }> {
  const d = await PDFDocument.create({ updateMetadata: false });
  d.setProducer("Kakuu Writer 1.0");
  return { d, font: await d.embedFont(StandardFonts.Helvetica) };
}

export async function statementPdf(kind: Kind): Promise<Uint8Array> {
  const { d, font } = await newDoc();
  statementPage(d, font, kind);
  return d.save({ useObjectStreams: false });
}

/** スキャン風：ベクターの明細を画像にして載せ、塗ったあとに読み取らせた文字の層（「■」の続き入り）を見えない字で重ねる */
export async function scannedStatementPdf(kind: Kind): Promise<Uint8Array> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const src = await getDocument({ data: await statementPdf(kind), verbosity: 0 }).promise;
  const page = await src.getPage(1);
  const vp = page.getViewport({ scale: 200 / 72 });
  const { canvas, context } = (src as any).canvasFactory.create(Math.ceil(vp.width), Math.ceil(vp.height));
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, canvas, viewport: vp } as any).promise;
  const png: Uint8Array = canvas.toBuffer("image/png");
  await (src as any).loadingTask?.destroy();

  const d = await PDFDocument.create({ updateMetadata: false });
  d.setProducer("Kakuu Scanner 1.0");
  d.registerFontkit(fontkit);
  const fontFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "design", "fonts", "source", "NotoSansJP[wght].ttf");
  const font = await d.embedFont(readFileSync(fontFile), { subset: true });
  const p = d.addPage([595, 842]);
  p.drawImage(await d.embedPng(png), { x: 0, y: 0, width: 595, height: 842 });
  // 読み取らせた文字の層（見えない）。塗った所は「■」の続きになる
  const layer: Array<[string, number, number]> = [["Kakuu Denki Monthly statement", 50, 790], ["■■■■■■■■", 60, 730], ["■■■■■■■■■■■■■■", 60, 714], ["■■■■ ■■■■", 60, 694]];
  for (const [t, x, y] of layer) p.drawText(t, { x, y, size: 11, font, opacity: 0 });
  return d.save({ useObjectStreams: false });
}

/** 宛名の欄が表の枠の中にあり、塗りが枠の線・欄の区切りの線に触れている明細（実物のスキャンでよくある形） */
function framedStatementPage(d: PDFDocument, font: PDFFont, kind: Kind, line = 0.8): void {
  const p = d.addPage([595, 842]);
  p.drawText("Kakuu Denki  Monthly statement", { x: 50, y: 790, size: 16, font });
  p.drawRectangle({ x: 40, y: 470, width: 515, height: 280, borderColor: rgb(0, 0, 0), borderWidth: 1 }); // ページの幅ほどの枠（表と宛名の欄を囲む）
  p.drawLine({ start: { x: 40, y: 708 }, end: { x: 555, y: 708 }, thickness: line });
  p.drawLine({ start: { x: 40, y: 650 }, end: { x: 555, y: 650 }, thickness: line });
  p.drawLine({ start: { x: 246, y: 708 }, end: { x: 246, y: 750 }, thickness: line });
  p.drawText("999-0000", { x: 56, y: 730, size: 11, font });
  p.drawText("9-9-9 Kakuu-cho, Kakuu-shi", { x: 56, y: 714, size: 11, font });
  p.drawText("Kakuu Taro", { x: 56, y: 694, size: 13, font });
  p.drawText("Sama", { x: 150, y: 694, size: 11, font }); // 塗りのすぐ右に接する字
  p.drawRectangle({ x: 40, y: 708, width: 206, height: 34, color: rgb(0, 0, 0) }); // 枠の左の線・区切りの線・縦の線に触れる
  p.drawRectangle({ x: 40, y: 690, width: 108, height: 18, color: rgb(0, 0, 0) });
  if (kind !== "none") {
    const r = drawBarcode(p, 58, 676, customerBarcode("9990000", "9-9-9"));
    if (kind === "covered") p.drawRectangle({ x: r.x0 - 3, y: r.y0 - 3, width: r.x1 - r.x0 + 6, height: r.y1 - r.y0 + 6, color: rgb(0, 0, 0) });
  }
  for (let i = 0; i <= 5; i++) p.drawLine({ start: { x: 50, y: 600 - i * 24 }, end: { x: 545, y: 600 - i * 24 }, thickness: 0.6 });
  for (const x of [40, 210, 370, 555]) p.drawLine({ start: { x, y: 650 }, end: { x, y: 470 }, thickness: 0.6 });
  ["Item", "Usage", "Amount"].forEach((t, i) => p.drawText(t, { x: 60 + i * 160, y: 584, size: 11, font }));
  for (let r = 1; r < 5; r++) ["Kakuu plan", `${r * 10} kWh`, `${r * 1000} yen`].forEach((t, i) => p.drawText(t, { x: 60 + i * 160, y: 584 - r * 24, size: 11, font }));
  // 表の中の 1 か所だけ、金額の欄を塗る（罫線に上下とも触れる）
  p.drawRectangle({ x: 370, y: 552, width: 100, height: 24, color: rgb(0, 0, 0) });
}

/** 再現できる乱数（見本が毎回同じになるように） */
function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * 実物に近いスキャン風（2026-11-07、実物 3 件で墨消しを 0 件と数えた反省）：200dpi・少し傾ける・紙の地の色・
 * 黒は 45 ほどの濃さ・ざらつきと点・JPEG の圧縮。塗りは表の罫線と、となりの字に触れる。文字の層は「■」入りの見えない字
 */
export type ScanLook = { angleDeg?: number; seed?: number; ink?: number; noise?: number; speckIn?: number; speckOut?: number; quality?: number; line?: number };

export async function realisticScanPdf(kind: Kind, opts: ScanLook = {}): Promise<Uint8Array> {
  const { d: vd, font: vf } = await newDoc();
  framedStatementPage(vd, vf, kind, opts.line ?? 0.8);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const src = await getDocument({ data: await vd.save({ useObjectStreams: false }), verbosity: 0 }).promise;
  const page = await src.getPage(1);
  const vp = page.getViewport({ scale: 200 / 72 });
  const W = Math.ceil(vp.width), H = Math.ceil(vp.height);
  const factory = (src as any).canvasFactory;
  const a = factory.create(W, H);
  a.context.fillStyle = "#ffffff";
  a.context.fillRect(0, 0, W, H);
  await page.render({ canvasContext: a.context, canvas: a.canvas, viewport: vp } as any).promise;
  const b = factory.create(W, H);
  const paper = [238, 235, 226];
  b.context.fillStyle = `rgb(${paper.join(",")})`;
  b.context.fillRect(0, 0, W, H);
  b.context.translate(W / 2, H / 2);
  b.context.rotate(((opts.angleDeg ?? 0.6) * Math.PI) / 180);
  b.context.translate(-W / 2, -H / 2);
  b.context.globalCompositeOperation = "multiply";
  b.context.drawImage(a.canvas, 0, 0);
  b.context.setTransform(1, 0, 0, 1, 0, 0);
  b.context.globalCompositeOperation = "source-over";
  const img = b.context.getImageData(0, 0, W, H);
  const px: Uint8ClampedArray = img.data;
  const r = rand(opts.seed ?? 7);
  for (let i = 0; i < W * H; i++) {
    const lum = (px[i * 4]! + px[i * 4 + 1]! + px[i * 4 + 2]!) / 3;
    const dark = lum < 128;
    const n = (r() - 0.5) * (opts.noise ?? 24);
    const speck = r();
    for (let c = 0; c < 3; c++) {
      // 黒を 45 ほどに持ち上げる（紙の色との間で、線形に）
      const ink = opts.ink ?? 45;
      let v = ink + (px[i * 4 + c]! / paper[c]!) * (paper[c]! - ink) + n;
      if (dark && speck < (opts.speckIn ?? 0.006)) v = 150; // 塗りの中の白い点
      if (!dark && speck < (opts.speckOut ?? 0.002)) v = 70; // 紙の上の黒い点
      px[i * 4 + c] = v;
    }
  }
  b.context.putImageData(img, 0, 0);
  const jpg: Uint8Array = await b.canvas.encode("jpeg", opts.quality ?? 55);
  await (src as any).loadingTask?.destroy();

  const d = await PDFDocument.create({ updateMetadata: false });
  d.setProducer("Kakuu Scanner 2.0");
  d.registerFontkit(fontkit);
  const fontFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "design", "fonts", "source", "NotoSansJP[wght].ttf");
  const font = await d.embedFont(readFileSync(fontFile), { subset: true });
  const p = d.addPage([595, 842]);
  p.drawImage(await d.embedJpg(jpg), { x: 0, y: 0, width: 595, height: 842 });
  for (const [t, x, y] of [["Kakuu Denki Monthly statement", 50, 790], ["■■■■■■■■", 56, 730], ["■■■■■■■■■■■■■■", 56, 714], ["■■■■ ■■■■ Sama", 56, 694]] as Array<[string, number, number]>) p.drawText(t, { x, y, size: 11, font, opacity: 0 });
  return d.save({ useObjectStreams: false });
}

/**
 * 白黒の FAX 形式（CCITT G4）のスキャン：ページいっぱいの画像に、黒い四角が 1 つ。
 * PDF.js は、解く部品の場所（wasmUrl）を渡さないと、この画像を白く描く（墨消しを 0 件と数えた原因とみられる形）。
 * 幅 64・高さ 32 の画素の 8〜15 行目・8〜15 列目だけ黒。G4 の符号を手で並べる（白 8＝10011、黒 8＝000101）
 */
export async function ccittScanPdf(): Promise<Uint8Array> {
  const w = 64, h = 32;
  let bits = "", prev: "white" | "ink" = "white";
  for (let row = 0; row < h; row++) {
    const now = row >= 8 && row < 16 ? "ink" : "white";
    if (now === "white") bits += prev === "white" ? "1" : "0001" + "1";
    else bits += prev === "white" ? "001" + "10011" + "000101" + "1" : "111";
    prev = now;
  }
  bits += "000000000001000000000001"; // EOFB
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i] === "1") bytes[i >> 3]! |= 0x80 >> (i & 7);
  const d = await PDFDocument.create({ updateMetadata: false });
  d.setProducer("Kakuu Fax Scanner 1.0");
  const p = d.addPage([595, 842]);
  const ref = d.context.register(d.context.stream(bytes, {
    Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 1, Filter: "CCITTFaxDecode", DecodeParms: d.context.obj({ K: -1, Columns: w, Rows: h }),
  }));
  p.node.setXObject(PDFName.of("Im1"), ref);
  p.pushOperators(pushGraphicsState(), concatTransformationMatrix(595, 0, 0, 842, 0, 0), drawObject("Im1"), popGraphicsState());
  return d.save({ useObjectStreams: false });
}

/** 同じ書式の 2 ページ：1 ページ目だけ郵便番号の欄を塗り、2 ページ目は同じ欄を残す（値は架空） */
export async function sameFormPdf(): Promise<Uint8Array> {
  const { d, font } = await newDoc();
  for (const [i, zip] of ["999-0001", "999-0002"].entries()) {
    const p = d.addPage([595, 842]);
    p.drawText("Kakuu application form", { x: 50, y: 790, size: 16, font });
    ["Postal code", "Name", "Phone", "Date"].forEach((label, r) => {
      p.drawText(label, { x: 60, y: 720 - r * 40, size: 11, font });
      p.drawRectangle({ x: 180, y: 712 - r * 40, width: 300, height: 24, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
    });
    p.drawText(zip, { x: 190, y: 720, size: 12, font });
    p.drawText(`Kakuu ${i ? "Hanako" : "Jiro"}`, { x: 190, y: 680, size: 12, font });
    p.drawText("2026-11-07", { x: 190, y: 600, size: 12, font });
    if (i === 0) p.drawRectangle({ x: 186, y: 716, width: 70, height: 16, color: rgb(0, 0, 0) });
  }
  return d.save({ useObjectStreams: false });
}

/** 飾り：幅いっぱいの黒い帯・グラフの棒・白い字の載った黒い見出し。墨消しは無い */
export async function decorPdf(): Promise<Uint8Array> {
  const { d, font } = await newDoc();
  const p = d.addPage([595, 842]);
  p.drawRectangle({ x: 0, y: 800, width: 595, height: 30, color: rgb(0, 0, 0) });
  p.drawRectangle({ x: 50, y: 740, width: 200, height: 24, color: rgb(0, 0, 0) });
  p.drawText("KAKUU REPORT 2026", { x: 58, y: 747, size: 14, font, color: rgb(1, 1, 1) });
  [60, 120, 90, 150, 40].forEach((h, i) => p.drawRectangle({ x: 80 + i * 50, y: 400, width: 30, height: h, color: rgb(0, 0, 0) }));
  p.drawText("Kakuu usage by month", { x: 80, y: 380, size: 11, font });
  return d.save({ useObjectStreams: false });
}

/** 荒いスキャン：灰色に近い塗り・強いざらつきと点・太く濃い罫線・強い圧縮・大きめの傾き */
export const ROUGH: ScanLook = { ink: 80, noise: 50, speckIn: 0.03, speckOut: 0.004, quality: 35, line: 1.6, angleDeg: 1.2, seed: 11 };

export const REDACTION_BUNDLE: Array<{ name: string; build: () => Promise<Uint8Array> }> = [
  { name: "s20-redact-barcode-left.pdf", build: () => statementPdf("leak") },
  { name: "s21-redact-barcode-scan.pdf", build: () => scannedStatementPdf("leak") },
  { name: "s22-redact-barcode-covered.pdf", build: () => statementPdf("covered") },
  { name: "s23-redact-no-barcode.pdf", build: () => statementPdf("none") },
  { name: "s24-redact-same-form.pdf", build: () => sameFormPdf() },
  { name: "s25-decor-black.pdf", build: () => decorPdf() },
  { name: "s26-redact-barcode-realscan.pdf", build: () => realisticScanPdf("leak") },
  { name: "s27-redact-covered-realscan.pdf", build: () => realisticScanPdf("covered") },
  { name: "s28-redact-barcode-roughscan.pdf", build: () => realisticScanPdf("leak", ROUGH) },
  { name: "s29-redact-ccitt-scan.pdf", build: () => ccittScanPdf() },
];

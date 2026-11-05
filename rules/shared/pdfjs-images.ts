// SPDX-License-Identifier: AGPL-3.0-only
//
// pdf-lib では解けない圧縮の画像（JPEG＝DCTDecode・CCITTFaxDecode・JBIG2Decode など）の画素を、PDF.js（pdfjs-dist）で取り出す。
//
// 作り：画像1つだけを写した小さな PDF を pdf-lib で作り（1×1 のページに、その画像を描くだけ）、PDF.js に読ませて、
// 描く命令の一覧（getOperatorList）から、PDF.js が解いた画素を受け取る。
// - PDF.js は、ここでは import しない（型だけ）。呼ぶ側が、自分の環境で読み込んだ PDF.js を渡す。
//   Node（採点・テスト）は pdfjs-dist/legacy/build/pdf.mjs、ブラウザは手を加えずに配る pdf.min.mjs（docs/no-network.md）。
//   こうすると、検査の Worker に PDF.js のコードが混ざらない（scripts/check-dist.mjs の写しの確かめが崩れない）。
// - PDF.js には、バイト列だけを渡す。URL・書体・CMap は渡さない（通信の道を使わない。useWorkerFetch: false、useWasm: false）。
// - JPEG（DCTDecode）は、PDF.js の中の JavaScript だけで解ける。
// - CCITT（CCITTFaxDecode）と JBIG2 は、PDF.js 6 では別の部品（pdfjs-dist/wasm/jbig2_nowasm_fallback.js）で解く。
//   呼ぶ側が jbig2Url（その部品のあるフォルダの URL。最後は /）を渡したときだけ使える。PDF.js は、そこから import() で読む
//   （useWasm: false なので、.wasm を fetch で取り寄せる道は使わない。pdf.worker.mjs の WasmImage#getJsModule）。
//   渡さなければ、CCITT・JBIG2 の画像は「調べられなかった」になる。
// - 細工された画像の前提で扱う：解く前に、画素の数から大きさの上限を見る。PDF.js が失敗したら「調べられなかった」にする。

import { PDFDocument, PDFName, PDFObjectCopier, PDFStream, type PDFContext } from "pdf-lib";
import { isInflateLimitError, peelOuterFilters } from "./inflate-limit.ts";
import type { PixelRead, PixelReader } from "../p6-text/images.ts";

/** 呼ぶ側が渡す PDF.js（pdfjs-dist の、使う所だけの形） */
export type PdfjsLike = {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfjsDoc>; destroy(): Promise<void> };
  OPS: Record<string, number>;
  ImageKind: { GRAYSCALE_1BPP: number; RGB_24BPP: number; RGBA_32BPP: number };
};
type PdfjsDoc = { getPage(n: number): Promise<PdfjsPage> };
type PdfjsPage = {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: { get(id: string, cb: (v: unknown) => void): void };
  commonObjs: { get(id: string, cb: (v: unknown) => void): void };
};
type PdfjsImage = { width: number; height: number; kind?: number; data?: Uint8Array | Uint8ClampedArray };

/** 画像の画素を、外の道具で取り出す関数。取り出せなければ unknown を返す */
export type ExternalImageDecoder = (ctx: PDFContext, stream: PDFStream, opts: { maxImagePixels: number; fillLuminance: number | null }) => Promise<PixelRead>;

/**
 * 解いた画素を写して持つ、点の数の上限（1.9.0 から）。これより大きい画像は、縦横を同じ間隔で間引いて写す。
 * 写したら、PDF.js の画素（1画素 3〜4 バイト）は手放す。ページの中で持つのは、1点 2〜3 バイト × この数まで
 */
export const COMPACT_MAX_POINTS = 16_000_000;

const LOAD_OPTIONS = {
  isOffscreenCanvasSupported: false, // 画素を ImageBitmap にせず、バイト列のまま受け取る
  isImageDecoderSupported: false, // ブラウザの ImageDecoder を使わず、PDF.js の中で解く（Node とブラウザで同じ結果にする）
  useWorkerFetch: false,
  useWasm: false,
  useSystemFonts: false,
  disableFontFace: true,
  stopAtErrors: false,
  verbosity: 0,
};

function numOf(stream: PDFStream, key: string): number {
  const v = stream.dict.lookup(PDFName.of(key));
  return v && "asNumber" in v && typeof v.asNumber === "function" ? (v.asNumber() as number) : 0;
}

/**
 * RGB・RGBA の画素を、明るさ・色の濃さ（・不透明さ）だけの小さな形に写す（1.9.0 から）。
 * 点の数が COMPACT_MAX_POINTS を超える画像は、縦横を同じ間隔で間引く。画素を読む道具は、写した形の大きさを返す
 * （画像の層は、画像の中の割合 u・v で点を読むので、大きさが違っても同じ所を読む）
 */
function compactReader(data: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: 3 | 4): PixelReader {
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / COMPACT_MAX_POINTS)));
  const cw = Math.ceil(width / step);
  const ch = Math.ceil(height / step);
  const per = channels === 4 ? 3 : 2;
  const out = new Uint8Array(cw * ch * per);
  for (let y = 0; y < ch; y++) {
    const sy = Math.min(height - 1, y * step);
    for (let x = 0; x < cw; x++) {
      const sx = Math.min(width - 1, x * step);
      const i = (sy * width + sx) * channels;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const o = (y * cw + x) * per;
      out[o] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      out[o + 1] = Math.max(r, g, b) - Math.min(r, g, b);
      if (per === 3) out[o + 2] = data[i + 3]!;
    }
  }
  return {
    width: cw,
    height: ch,
    at(x, y) {
      const o = (y * cw + x) * per;
      return { lum: out[o]! / 255, alpha: per === 3 ? out[o + 2]! / 255 : 1, chroma: out[o + 1]! / 255 };
    },
  };
}

/** PDF.js の画像（RGB・RGBA・1 ビットの灰色）を、画素を読む道具にする */
function readerOf(img: PdfjsImage, kinds: PdfjsLike["ImageKind"]): PixelReader | null {
  const { width, height, data, kind } = img;
  if (!data || !(width > 0) || !(height > 0)) return null;
  if (kind === kinds.RGB_24BPP && data.length >= width * height * 3) return compactReader(data, width, height, 3);
  if (kind === kinds.RGBA_32BPP && data.length >= width * height * 4) return compactReader(data, width, height, 4);
  if (kind === kinds.GRAYSCALE_1BPP) {
    const rowLen = (width + 7) >> 3;
    if (data.length < rowLen * height) return null;
    return {
      width,
      height,
      at(x, y) {
        const bit = (data[y * rowLen + (x >> 3)]! >> (7 - (x & 7))) & 1;
        return { lum: bit, alpha: 1 }; // PDF.js の 1 ビットの灰色は、1 が白
      },
    };
  }
  return null;
}

/** 型抜き（ImageMask）：PDF.js は、塗る点を 0 のビットで返す（Decode を反映したもの） */
function maskReaderOf(img: PdfjsImage, fillLuminance: number | null): PixelReader | null {
  const { width, height, data } = img;
  if (!data || !(width > 0) || !(height > 0)) return null;
  const rowLen = (width + 7) >> 3;
  if (data.length < rowLen * height) return null;
  return {
    width,
    height,
    at(x, y) {
      const bit = (data[y * rowLen + (x >> 3)]! >> (7 - (x & 7))) & 1;
      return bit === 0 ? { lum: fillLuminance, alpha: 1 } : { lum: null, alpha: 0 };
    },
  };
}

/** PDF.js を使って画像を解く関数を作る。jbig2Url は、CCITT・JBIG2 を解く部品のあるフォルダの URL（上の説明） */
export function createPdfjsImageDecoder(pdfjs: PdfjsLike, options: { jbig2Url?: string } = {}): ExternalImageDecoder {
  const loadOptions = { ...LOAD_OPTIONS, ...(options.jbig2Url ? { wasmUrl: options.jbig2Url } : {}) };
  return async (ctx, stream, opts) => {
    const width = Math.floor(numOf(stream, "Width"));
    const height = Math.floor(numOf(stream, "Height"));
    if (width <= 0 || height <= 0) return { kind: "unknown", reason: "broken" };
    // 画素の数で上限を見る（1.9.0 から）。PDF.js は、JPEG を解くとき、1画素あたり約 6 バイトを一度に使う
    // （600dpi の A4 のカラー JPEG、3,480 万画素で、Node の RSS が約 215MB 増えた。rules/p6-text/README.md）
    if (width * height > opts.maxImagePixels) return { kind: "unknown", reason: "too_large" };

    let mini: Uint8Array;
    try {
      const doc = await PDFDocument.create();
      // 外側の圧縮は、上限つきでこちらで解いてから渡す（PDF.js には解く大きさの上限を渡せないため。inflate-limit.ts）
      const copied = PDFObjectCopier.for(ctx, doc.context).copy(peelOuterFilters(stream));
      const ref = doc.context.register(copied);
      const page = doc.addPage([1, 1]);
      page.node.setXObject(PDFName.of("Im0"), ref);
      page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q 1 0 0 1 0 0 cm /Im0 Do Q")));
      mini = await doc.save({ useObjectStreams: false });
    } catch (e) {
      return { kind: "unknown", reason: isInflateLimitError(e) ? "too_large" : "broken" };
    }

    const task = pdfjs.getDocument({ data: mini, ...loadOptions });
    try {
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i] ?? [];
        let img: PdfjsImage | null = null;
        let isMask = false;
        if (fn === pdfjs.OPS.paintImageXObject) {
          const id = args[0];
          if (typeof id !== "string") continue;
          const store = id.startsWith("g_") ? page.commonObjs : page.objs;
          img = (await new Promise<unknown>((resolve) => store.get(id, resolve))) as PdfjsImage;
        } else if (fn === pdfjs.OPS.paintInlineImageXObject) {
          img = args[0] as PdfjsImage;
        } else if (fn === pdfjs.OPS.paintImageMaskXObject) {
          img = args[0] as PdfjsImage;
          isMask = true;
        }
        if (!img) continue;
        // 大きさが辞書と違う（PDF.js が縮めたなど）ものは、座標がずれるので使わない
        if (img.width !== width || img.height !== height) return { kind: "unknown", reason: "broken" };
        const reader = isMask ? maskReaderOf(img, opts.fillLuminance) : readerOf(img, pdfjs.ImageKind);
        return reader ? { kind: "pixels", reader } : { kind: "unknown", reason: "unsupported_color" };
      }
      return { kind: "unknown", reason: "broken" };
    } catch {
      return { kind: "unknown", reason: "broken" };
    } finally {
      await task.destroy().catch(() => undefined);
    }
  };
}

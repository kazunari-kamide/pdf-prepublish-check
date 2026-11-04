// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付けで、pdf-lib では解けない画像を塗るための道具（ImageCodec）を作る。
// - JPEG（DCTDecode）：解いて塗り、JPEG に書き直す（2026-11-04 人が決めた）
// - CCITT（FAX 形式）・JBIG2 の白黒画像：解いて塗り、1 ビットのまま Flate で書き直す（2026-11-04 から）
//
// - 解く：PDF.js。片付けのコードは PDF.js を読み込まない。呼ぶ側が、自分の環境で読み込んだ PDF.js を渡す
//   （ブラウザ：dist/ に手を加えずに入れて配る pdf.min.mjs。Node：sanitize/node/image-codec.ts が legacy の版を渡す）。
//   PDF.js には、画像1つだけを描いた小さな PDF のバイト列だけを渡す。URL・書体・CMap は渡さない（通信の道を使わない）。
//   ブラウザの ImageDecoder・OffscreenCanvas を使わず、PDF.js の中の JavaScript で解く（Node とブラウザで同じ画素にするため）。
//   CCITT・JBIG2 は、PDF.js が別の部品（jbig2_nowasm_fallback.js。PDF.js と一緒に配られるもの）を import() で読んで解く。
//   その部品のあるフォルダの URL（wasmUrl。最後は /）を渡したときだけ解ける。渡さなければ、CCITT・JBIG2 は塗れない（notDone）。
// - 書く：JPEG は、ブラウザは OffscreenCanvas（Worker の中でも使える。offscreenCanvasJpegEncoder）。Node は sanitize/node/image-codec.ts の道具。
//   JPEG の書き方はブラウザと Node で違うので、書き直した JPEG のバイト列は、ブラウザと Node で同じにならない。

import type { DecodedImage, ImageCodec } from "./types.ts";

/** 呼ぶ側が渡す PDF.js（使う所だけの形） */
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

/**
 * 画素を JPEG に書く関数。画素は、帯（y0 行目から rows 行）ごとに strip で RGBA（1画素 4 バイト）を受け取り、描く板に並べる。
 * 画像全体の RGBA の写しを作らないため（全体の写しを作っていたとき、Node の 600dpi の A3 で、書く段のメモリの最大が +590MB だった。2026-11-04 測定）
 */
export type RgbaJpegEncoder = (
  width: number,
  height: number,
  strip: (y0: number, rows: number) => Uint8ClampedArray,
  quality: number,
) => Promise<Uint8Array | null>;

/** 帯の行の数（1帯の RGBA は 幅 × この数 × 4 バイト。600dpi の A3 で約 7MB） */
export const STRIP_ROWS = 256;

const LOAD_OPTIONS = {
  isOffscreenCanvasSupported: false, // 画素を ImageBitmap にせず、バイト列のまま受け取る
  isImageDecoderSupported: false, // ブラウザの ImageDecoder を使わず、PDF.js の中で解く
  useWorkerFetch: false,
  useWasm: false,
  useSystemFonts: false,
  disableFontFace: true,
  stopAtErrors: false,
  verbosity: 0,
};

/** PDF.js の画像の画素を、RGB（1画素 3 バイト）か、1 ビットの灰色（1 が白）にそろえる */
function normalize(img: PdfjsImage, pdfjs: PdfjsLike): DecodedImage | null {
  const { width, height, data, kind } = img;
  if (!data || width <= 0 || height <= 0) return null;
  const n = width * height;
  if (kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
    const rowBytes = Math.ceil(width / 8);
    if (data.length < rowBytes * height) return null;
    const bits = data instanceof Uint8Array ? data.subarray(0, rowBytes * height) : new Uint8Array(data.buffer, data.byteOffset, rowBytes * height);
    return { kind: "gray1", width, height, data: bits };
  }
  if (kind === pdfjs.ImageKind.RGB_24BPP && data.length >= n * 3) {
    return { kind: "rgb", width, height, data: data instanceof Uint8Array ? data.subarray(0, n * 3) : new Uint8Array(data.buffer, data.byteOffset, n * 3) };
  }
  if (kind === pdfjs.ImageKind.RGBA_32BPP && data.length >= n * 4) {
    const out = new Uint8Array(n * 3);
    for (let i = 0, j = 0; j < out.length; i += 4, j += 3) {
      out[j] = data[i]!;
      out[j + 1] = data[i + 1]!;
      out[j + 2] = data[i + 2]!;
    }
    return { kind: "rgb", width, height, data: out };
  }
  return null;
}

/**
 * PDF.js と、RGBA を JPEG に書く関数から、ImageCodec を作る。
 * wasmUrl：CCITT・JBIG2 を解く部品（jbig2_nowasm_fallback.js）のあるフォルダの URL（最後は /）。なければ CCITT・JBIG2 は解かない
 */
export function createPdfjsImageCodec(pdfjs: PdfjsLike, encodeRgba: RgbaJpegEncoder, options: { wasmUrl?: string } = {}): ImageCodec {
  return {
    bitonal: options.wasmUrl !== undefined,
    async decode(pdf, maxPixels) {
      const task = pdfjs.getDocument({ ...LOAD_OPTIONS, ...(options.wasmUrl ? { wasmUrl: options.wasmUrl } : {}), data: pdf, maxImageSize: maxPixels });
      try {
        const doc = await task.promise;
        const page = await doc.getPage(1);
        const ops = await page.getOperatorList();
        const k = ops.fnArray.indexOf(pdfjs.OPS.paintImageXObject!);
        if (k < 0) return null;
        const id = ops.argsArray[k]?.[0];
        if (typeof id !== "string") return null;
        const store = id.startsWith("g_") ? page.commonObjs : page.objs;
        const img = await new Promise<PdfjsImage | null>((resolve) => {
          try {
            store.get(id, (v) => resolve((v as PdfjsImage) ?? null));
          } catch {
            resolve(null);
          }
        });
        return img ? normalize(img, pdfjs) : null;
      } catch {
        return null;
      } finally {
        await task.destroy().catch(() => {});
      }
    },
    async encodeJpeg(rgb, width, height, quality) {
      const n = width * height;
      if (rgb.length < n * 3) return null;
      const strip = (y0: number, rows: number) => {
        const rgba = new Uint8ClampedArray(width * rows * 4);
        for (let i = 0, j = y0 * width * 3; i < rgba.length; i += 4, j += 3) {
          rgba[i] = rgb[j]!;
          rgba[i + 1] = rgb[j + 1]!;
          rgba[i + 2] = rgb[j + 2]!;
          rgba[i + 3] = 255;
        }
        return rgba;
      };
      return encodeRgba(width, height, strip, quality);
    },
  };
}

/** ブラウザ（Worker の中でもよい）の OffscreenCanvas で、RGBA を JPEG に書く。OffscreenCanvas がない所では null を返す */
export const offscreenCanvasJpegEncoder: RgbaJpegEncoder = async (width, height, strip, quality) => {
  // Node の型（tsconfig.node.json）でも読めるよう、ブラウザの部品は使う所だけの形で受け取る
  type Ctx2D = { putImageData(data: unknown, x: number, y: number): void };
  type Offscreen = { getContext(kind: "2d", o: { willReadFrequently: boolean }): Ctx2D | null; convertToBlob(o: { type: string; quality: number }): Promise<{ type: string; arrayBuffer(): Promise<ArrayBuffer> }> };
  const g0 = globalThis as unknown as {
    OffscreenCanvas?: new (w: number, h: number) => Offscreen;
    ImageData?: new (data: Uint8ClampedArray, w: number, h: number) => unknown;
  };
  if (!g0.OffscreenCanvas || !g0.ImageData) return null;
  const canvas = new g0.OffscreenCanvas(width, height);
  // GPU を使わない板にする（GPU の板だと、GPU のプロセスに画像の写しができ、600dpi の A3 で +1.4GB だった。2026-11-04 測定）
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  for (let y0 = 0; y0 < height; y0 += STRIP_ROWS) {
    const rows = Math.min(STRIP_ROWS, height - y0);
    g.putImageData(new g0.ImageData(strip(y0, rows), width, rows), 0, y0);
  }
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  if (blob.type !== "image/jpeg") return null; // JPEG を書けないブラウザは PNG を返すことがある
  return new Uint8Array(await blob.arrayBuffer());
};

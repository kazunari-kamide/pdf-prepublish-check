// SPDX-License-Identifier: AGPL-3.0-only
//
// 片付けの Worker。片付け（sanitize/）は C の担当で、ここでは呼ぶだけ。
// 重い処理は画面とは別のところで動かし、上限を超えたら画面の側からこの Worker だけを止める（CLAUDE.md §5）。
// ここから外へ通信しない。importScripts も使わない。

// PDF.js は、npm の pdfjs-dist のファイルを手を加えずに配る（?url。docs/no-network.md の例外の形のまま。検査の Worker と同じ）
import pdfjsUrl from "pdfjs-dist/build/pdf.min.mjs?url";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createPdfjsImageCodec, offscreenCanvasJpegEncoder, type PdfjsLike } from "../../sanitize/image-codec.ts";
import type { ImageCodec } from "../../sanitize/types.ts";

/**
 * 覆いの下の JPEG の画像を塗って書き直す道具（11/5 B）。解くのは PDF.js、書くのは OffscreenCanvas（Worker の中でも使える）。
 * CCITT・JBIG2・JPEG 2000 を解く部品は、配信の中の /pdfjs/wasm/ に置いたもの（pdfjs-dist の写し）を読む（2026-11-06。src/render/pdfjs-parts.ts）。
 * 読み込めなかったときは、道具なしで片付ける。
 */
let libPromise: Promise<PdfjsLike | undefined> | null = null;
/** PDF.js と、その Worker の部品を、この Worker の中に 1 回だけ読み込む（温め・片付け・検査で同じものを使う） */
function pdfjsLib(): Promise<PdfjsLike | undefined> {
  libPromise ??= Promise.all([import(/* @vite-ignore */ pdfjsUrl) as Promise<PdfjsLike>, import(/* @vite-ignore */ pdfjsWorkerUrl)])
    .then(([lib]) => lib)
    .catch(() => undefined);
  return libPromise;
}

async function imageCodec(): Promise<ImageCodec | undefined> {
  const lib = await pdfjsLib();
  return lib ? createPdfjsImageCodec(lib, offscreenCanvasJpegEncoder) : undefined;
}

/** 温める：PDF.js を読み込み、小さな見本の画像を 1 回解かせて、画像を解く部品も読み込んでおく（src/render/warm-pdf.ts） */
async function warm(): Promise<boolean> {
  const lib = await pdfjsLib();
  if (!lib) return false;
  return warmPdfjs(lib as unknown as Parameters<typeof warmPdfjs>[0], {
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useWorkerFetch: false,
    useWasm: false,
    wasmUrl: PDFJS_WASM_URL,
    disableFontFace: true,
    stopAtErrors: false,
    verbosity: 0,
  });
}
import { createPdfjsImageDecoder } from "../../rules/shared/pdfjs-images.ts";
import { rulesCheck } from "../../sanitize/redact-check.ts";
import { inspectAll } from "../inspect/inspect.ts";
import { PDFJS_WASM_URL } from "../render/pdfjs-parts.ts";
import { warmPdfjs } from "../render/warm-pdf.ts";
import { compressJob, preflightJob, sanitizeJob } from "../sanitize/job.ts";
import type { SanitizeRequest, SanitizeResponse } from "../sanitize/protocol.ts";

type WorkerScope = {
  onmessage: ((e: MessageEvent<SanitizeRequest>) => void) | null;
  postMessage(message: SanitizeResponse, transfer?: Transferable[]): void;
};
const scope = self as unknown as WorkerScope;

/** 渡し切れる ArrayBuffer にする（写しを作らない。ほかの中身と共有していることがあるので、そのときだけ写す） */
function transferable(b: Uint8Array): ArrayBuffer {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer ? b.buffer : b.slice().buffer;
}

/**
 * 小さくする前と後にかける作品の検査（全部のルール）。画像を解く道具も、検査の Worker と同じ PDF.js から作る。
 * PDF.js は imageCodec() で読み込み済み（同じ URL の import は1回だけ読まれる）
 */
async function inspectCheck() {
  let ctx = {};
  try {
    const lib = (await pdfjsLib()) as Parameters<typeof createPdfjsImageDecoder>[0] | undefined;
    ctx = lib ? { imageDecoder: createPdfjsImageDecoder(lib, { jbig2Url: PDFJS_WASM_URL }) } : {};
  } catch {
    ctx = {};
  }
  return rulesCheck((b) => inspectAll(b, undefined, undefined, ctx));
}

scope.onmessage = async (e) => {
  const req = e.data;
  if (req?.type === "warm") {
    scope.postMessage({ type: "warm-done", id: req.id, ok: await warm() });
    return;
  }
  if (!req || !(req.buffer instanceof ArrayBuffer)) return;
  try {
    const codec = await imageCodec();
    if (req.type === "compress") {
      const r = await compressJob(new Uint8Array(req.buffer), { maxDpi: req.maxDpi, jpegQuality: req.jpegQuality }, codec, [await inspectCheck()]);
      if (r.type === "refused") scope.postMessage({ type: "refused", id: req.id, message: r.message });
      else if (r.type === "compress_blocked") scope.postMessage({ type: "compress_blocked", id: req.id, sizeBefore: r.sizeBefore, sizeAfter: r.sizeAfter, increased: r.increased });
      else {
        const buffer = transferable(r.bytes);
        scope.postMessage({ type: "compressed", id: req.id, buffer, sizeBefore: r.sizeBefore, sizeAfter: r.sizeAfter, changed: r.changed, images: r.images }, [buffer]);
      }
      return;
    }
    if (req.type === "preflight") {
      scope.postMessage({ type: "preflighted", id: req.id, result: await preflightJob(new Uint8Array(req.buffer)) });
      return;
    }
    if (req.type !== "sanitize") return;
    // 自分で選んだ所があれば片付けの redact、なければふつうの片付け（src/sanitize/job.ts）
    const r = await sanitizeJob(new Uint8Array(req.buffer), req.areas, codec, req.tidy ?? {});
    if (r.type === "refused") {
      scope.postMessage({ type: "refused", id: req.id, message: r.message });
      return;
    }
    if (r.type === "redact_blocked") {
      scope.postMessage({ type: "redact_blocked", id: req.id, removed: r.removed, notDone: r.notDone, leftovers: r.leftovers });
      return;
    }
    const buffer = transferable(r.bytes);
    scope.postMessage(
      { type: "sanitized", id: req.id, buffer, pages: r.pages, removed: r.removed, notDone: r.notDone, decrypted: r.decrypted, ...(r.properties ? { properties: r.properties } : {}) },
      [buffer],
    );
  } catch {
    // 例外の中身（ファイルの中身を含むことがある）は画面に出さない
    scope.postMessage({ type: "error", id: req.id, message: "片付けの途中で問題が起きました。" });
  }
};

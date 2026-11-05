// SPDX-License-Identifier: AGPL-3.0-only
//
// ファイルを小さくする（片付けのあとの PDF に使う入口）。
//
//   const r = await compress(cleanedBytes, { codec, maxDpi: 150, jpegQuality: 0.75, checks: [rulesCheck((b) => inspectAll(b))] });
//   r.status === "ok"      → r.bytes（小さくした PDF。小さくならなければ元のバイト列のまま）・r.sizeBefore・r.sizeAfter・r.images
//   r.status === "blocked" → 小さくしたあとの読み直しで、残りが増えた。r.increased（増えた種類と数）。バイト列は返さない（保存させない）
//   r.status === "error"   → r.code・r.message
//
// 小さくするもの：ページに描かれた画像のうち、いちばん大きく描かれた所でも maxDpi を超える細かさのもの。
// 画素を平均して maxDpi まで縮め、JPEG（jpegQuality）に書き直す。元より小さくなったときだけ置き換える。
// 字・図形・書体・透明の型（/SMask）には手を付けない。
//
// 手を付けない画像（理由つきで数える）：
//   - 1 ビットの白黒（JPEG にすると大きく、字がにじむ）・型抜き（/ImageMask・/Mask）・/Matte のある透明の型
//   - 注釈の見た目・模様（パターン）・透明の型など、ページと部品（Form）の中身の外からも使う画像（描かれる大きさが分からない）
//   - どこにも描かれていない画像・重くて読めなかったページの画像（描かれる大きさが分からない）
//
// 保存の前に、入れた PDF と出来上がった PDF の両方に同じ確かめ（checks）をかけ、種類ごとの残りが1つでも増えたら blocked にする。

import { PDFArray, PDFBool, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { isInflateLimitError } from "../rules/shared/inflate-limit.ts";
import { loadPdf } from "../rules/shared/load.ts";
import { SETTINGS, makeVisibility, readPageForCheck } from "./content.ts";
import { onePagePdf } from "./image-sample.ts";
import { MAX_INPUT_BYTES } from "./index.ts";
import type { CompressIncrease, CompressOptions, CompressResult, CompressSkip, RedactLeftover } from "./types.ts";

/** 選べる細かさの範囲（dpi） */
export const COMPRESS_DPI = { min: 50, max: 600, default: 150 } as const;
/** 選べる JPEG の質の範囲（0〜1） */
export const COMPRESS_QUALITY = { min: 0.3, max: 0.95, default: 0.75 } as const;
/** 縮めても小さくならない程度の差は縮めない（目標の細かさの何倍までは、そのままにするか） */
const SLACK = 1.1;

const SKIP_LABEL: Record<CompressSkip["reason"], string> = {
  within_dpi: "すでに選んだ細かさ以下",
  not_smaller: "書き直しても小さくならなかった",
  bitonal: "白黒（1 ビット）の画像",
  mask: "型抜きの画像・/Matte のある透明の型",
  used_elsewhere: "注釈の見た目・模様などからも使う画像",
  not_placed: "描かれる大きさが分からない画像",
  too_large: "大きすぎて解けない画像",
  unreadable: "解けなかった画像",
};

function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

const numOf = (ctx: PDFContext, d: PDFDict, key: string): number => {
  const v = ctx.lookup(d.get(PDFName.of(key)));
  return v instanceof PDFNumber ? v.asNumber() : 0;
};

const isImage = (ctx: PDFContext, o: PDFObject | undefined): o is PDFStream =>
  o instanceof PDFStream && ctx.lookup(o.dict.get(PDFName.of("Subtype"))) === PDFName.of("Image");

/**
 * ページと部品（Form）の /Resources の /XObject の辞書（＝描く大きさを Walker で測れる所）を集める。
 * 模様（/Pattern）・注釈の見た目（/AP）の中の /XObject は入れない
 */
function placeableHolders(ctx: PDFContext, pages: PDFDict[]): Set<PDFDict> {
  const out = new Set<PDFDict>();
  const seenRes = new Set<PDFDict>();
  const stack: PDFDict[] = [];
  for (const p of pages) {
    const r = dictOf(ctx, p.get(PDFName.of("Resources")));
    if (r) stack.push(r);
  }
  while (stack.length) {
    const res = stack.pop()!;
    if (seenRes.has(res)) continue;
    seenRes.add(res);
    const xo = dictOf(ctx, res.get(PDFName.of("XObject")));
    if (!xo) continue;
    out.add(xo);
    for (const [, v] of xo.entries()) {
      const s = ctx.lookup(v);
      if (s instanceof PDFStream && ctx.lookup(s.dict.get(PDFName.of("Subtype"))) === PDFName.of("Form")) {
        const fr = dictOf(ctx, s.dict.get(PDFName.of("Resources")));
        if (fr) stack.push(fr);
      }
    }
  }
  return out;
}

/** 画像の参照ごとに、その参照を持つ入れ物（辞書・配列）を集める。入れ物ごとに、どの鍵で持つかも残す */
function holdersOfImages(ctx: PDFContext): Map<PDFRef, Array<{ holder: PDFDict | PDFArray; key: string | null }>> {
  const out = new Map<PDFRef, Array<{ holder: PDFDict | PDFArray; key: string | null }>>();
  const add = (ref: PDFRef, holder: PDFDict | PDFArray, key: string | null) => {
    if (!isImage(ctx, ctx.lookup(ref))) return;
    out.set(ref, [...(out.get(ref) ?? []), { holder, key }]);
  };
  const visit = (o: PDFObject, depth: number) => {
    if (depth > 64) return;
    const d = o instanceof PDFStream ? o.dict : o;
    if (d instanceof PDFDict) {
      for (const [k, v] of d.entries()) {
        if (v instanceof PDFRef) add(v, d, k.asString());
        else visit(v, depth + 1);
      }
    } else if (d instanceof PDFArray) {
      for (const v of d.asArray()) {
        if (v instanceof PDFRef) add(v, d, null);
        else visit(v, depth + 1);
      }
    }
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj, 0);
  return out;
}

/** 平均して縮める（RGB 8 ビット） */
function downsample(src: Uint8Array, w: number, h: number, nw: number, nh: number): Uint8Array {
  const out = new Uint8Array(nw * nh * 3);
  const sx = w / nw;
  const sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * sy)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * w + x0) * 3;
        for (let xx = x0; xx < x1; xx++, i += 3) {
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * nw + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

/** 確かめの残りを、種類ごとの数にまとめる（場所は比べない。小さくすると画像の境の画素がずれるため） */
function tally(left: RedactLeftover[]): Map<string, { label: string; count: number; check: RedactLeftover["check"]; kind: RedactLeftover["kind"]; pattern?: string }> {
  const out = new Map<string, { label: string; count: number; check: RedactLeftover["check"]; kind: RedactLeftover["kind"]; pattern?: string }>();
  for (const l of left) {
    const key = `${l.check}|${l.kind}|${l.pattern ?? ""}`;
    const cur = out.get(key);
    if (cur) cur.count += l.count;
    else out.set(key, { label: l.label, count: l.count, check: l.check, kind: l.kind, ...(l.pattern ? { pattern: l.pattern } : {}) });
  }
  return out;
}

export async function compress(bytes: Uint8Array, options: CompressOptions): Promise<CompressResult> {
  try {
    return await compressCore(bytes, options);
  } catch (e) {
    if (isInflateLimitError(e)) return { status: "error", code: "too_large", message: "解くと大きすぎる所があるため、小さくできませんでした。" };
    // 細工・破損した PDF で、途中の部品の読み取りが失敗したとき（止まらずにエラーを返す）
    return { status: "error", code: "unreadable", message: "PDF の中を読めなかったため、小さくできませんでした。" };
  }
}

async function compressCore(bytes: Uint8Array, options: CompressOptions): Promise<CompressResult> {
  const maxDpi = options.maxDpi ?? COMPRESS_DPI.default;
  const quality = options.jpegQuality ?? COMPRESS_QUALITY.default;
  if (typeof maxDpi !== "number" || !Number.isFinite(maxDpi) || maxDpi < COMPRESS_DPI.min || maxDpi > COMPRESS_DPI.max) {
    return { status: "error", code: "bad_options", message: `画像の細かさは ${COMPRESS_DPI.min}〜${COMPRESS_DPI.max} dpi の中で選んでください。` };
  }
  if (typeof quality !== "number" || !Number.isFinite(quality) || quality < COMPRESS_QUALITY.min || quality > COMPRESS_QUALITY.max) {
    return { status: "error", code: "bad_options", message: `JPEG の質は ${COMPRESS_QUALITY.min}〜${COMPRESS_QUALITY.max} の中で選んでください。` };
  }
  if (!options.codec) return { status: "error", code: "no_codec", message: "画像を書き直す道具がないため、小さくできません。" };
  if (bytes.length === 0) return { status: "error", code: "empty", message: "ファイルが空です。" };
  if (bytes.length > MAX_INPUT_BYTES) return { status: "error", code: "too_large", message: "ファイルが大きすぎるため、小さくできません。" };
  const maxPixels = options.maxImagePixels ?? SETTINGS.maxImagePixels;

  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") {
    return loaded.code === "encrypted"
      ? { status: "error", code: "encrypted", message: "暗号化された PDF は小さくできません。先に片付けてください。" }
      : { status: "error", code: "unreadable", message: "PDF として読めませんでした。" };
  }
  if (loaded.decrypted) return { status: "error", code: "encrypted", message: "暗号化された PDF は小さくできません。先に片付けてください。" };
  const doc = loaded.doc;
  const ctx = doc.context;
  const pages = doc.getPages();
  const visible = makeVisibility(ctx, doc.catalog);

  // 1. 画像ごとに、いちばん大きく描かれた大きさ（ポイント）を測る。読めないページの画像は、大きさが分からないものにする
  const drawn = new Map<PDFStream, { w: number; h: number; colorSpaces: PDFDict | undefined }>();
  const unknown = new Set<PDFStream>();
  for (const page of pages) {
    try {
      const read = readPageForCheck(ctx, page, visible, SETTINGS);
      for (const im of read.images) {
        const [a, b, c, d] = im.ctm;
        const w = Math.hypot(a!, b!);
        const h = Math.hypot(c!, d!);
        const cur = drawn.get(im.stream);
        const colorSpaces = dictOf(ctx, im.res?.get(PDFName.of("ColorSpace")));
        if (!cur) drawn.set(im.stream, { w, h, colorSpaces });
        else drawn.set(im.stream, { w: Math.max(cur.w, w), h: Math.max(cur.h, h), colorSpaces: cur.colorSpaces ?? colorSpaces });
      }
    } catch {
      // 重い・壊れたページ：このページから届く画像は全部、大きさが分からないものにする
      const holders = placeableHolders(ctx, [page.node]);
      for (const xo of holders) for (const [, v] of xo.entries()) {
        const s = ctx.lookup(v);
        if (isImage(ctx, s)) unknown.add(s);
      }
    }
  }

  // 2. 書き直してよい画像を選ぶ（ページと部品の /XObject からだけ使われるもの）
  const placeable = placeableHolders(ctx, pages.map((p) => p.node));
  const holders = holdersOfImages(ctx);
  const skipped = new Map<CompressSkip["reason"], number>();
  const skip = (r: CompressSkip["reason"]) => skipped.set(r, (skipped.get(r) ?? 0) + 1);
  let changed = 0;
  let savedBytes = 0;

  for (const [ref, hs] of holders) {
    const stream = ctx.lookup(ref) as PDFStream;
    const d = stream.dict;
    if (hs.some((h) => !(h.holder instanceof PDFDict) || !placeable.has(h.holder))) {
      // 透明の型・型抜き（ほかの画像の /SMask・/Mask）として使われる画像は、ここで数えない（その親の画像で数える）
      if (!hs.every((h) => h.key === "/SMask" || h.key === "/Mask")) skip("used_elsewhere");
      continue;
    }
    const size = drawn.get(stream);
    if (unknown.has(stream) || !size || size.w <= 0 || size.h <= 0) {
      skip("not_placed");
      continue;
    }
    const im = d.lookup(PDFName.of("ImageMask"));
    const mask = ctx.lookup(d.get(PDFName.of("Mask")));
    const smask = ctx.lookup(d.get(PDFName.of("SMask")));
    if ((im instanceof PDFBool && im.asBoolean()) || mask !== undefined || (smask instanceof PDFStream && smask.dict.get(PDFName.of("Matte")) !== undefined)) {
      skip("mask");
      continue;
    }
    if (numOf(ctx, d, "BitsPerComponent") === 1) {
      skip("bitonal");
      continue;
    }
    const W = Math.floor(numOf(ctx, d, "Width"));
    const H = Math.floor(numOf(ctx, d, "Height"));
    if (W <= 0 || H <= 0) {
      skip("unreadable");
      continue;
    }
    // 目標の画素の数：いちばん大きく描かれた所で maxDpi になる数
    const nw = Math.max(1, Math.ceil((size.w / 72) * maxDpi));
    const nh = Math.max(1, Math.ceil((size.h / 72) * maxDpi));
    if (W <= nw * SLACK && H <= nh * SLACK) {
      skip("within_dpi");
      continue;
    }
    if (W * H > maxPixels) {
      skip("too_large");
      continue;
    }
    const tw = Math.min(W, nw);
    const th = Math.min(H, nh);

    let decoded;
    try {
      decoded = await options.codec.decode(await onePagePdf(ctx, stream, size.colorSpaces), W * H);
    } catch (e) {
      // 解くと大きすぎる画像は、そのまま残す（小さくしない）
      if (isInflateLimitError(e)) {
        skip("too_large");
        continue;
      }
      decoded = null;
    }
    if (!decoded || decoded.width !== W || decoded.height !== H) {
      skip("unreadable");
      continue;
    }
    if (decoded.kind === "gray1") {
      skip("bitonal");
      continue;
    }
    if (decoded.data.length < W * H * 3) {
      skip("unreadable");
      continue;
    }
    let jpeg: Uint8Array | null;
    try {
      jpeg = await options.codec.encodeJpeg(downsample(decoded.data, W, H, tw, th), tw, th, quality);
    } catch {
      jpeg = null;
    }
    if (!jpeg || jpeg.length === 0) {
      skip("unreadable");
      continue;
    }
    const oldLen = stream instanceof PDFRawStream ? stream.contents.length : Infinity;
    if (jpeg.length >= oldLen) {
      skip("not_smaller");
      continue;
    }
    const out = PDFRawStream.of(ctx.obj({}), jpeg);
    for (const [k, v] of d.entries()) {
      if (["Length", "Filter", "DecodeParms", "Width", "Height", "ColorSpace", "BitsPerComponent", "Decode", "ColorTransform"].includes(k.asString().slice(1))) continue;
      out.dict.set(k, v);
    }
    out.dict.set(PDFName.of("Width"), PDFNumber.of(tw));
    out.dict.set(PDFName.of("Height"), PDFNumber.of(th));
    out.dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
    out.dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    out.dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
    ctx.assign(ref, out);
    changed++;
    savedBytes += oldLen - jpeg.length;
  }

  const imagesReport = {
    changed,
    savedBytes,
    skipped: [...skipped].map(([reason, count]) => ({ reason, count, label: SKIP_LABEL[reason] })),
  };
  if (changed === 0) {
    return { status: "ok", bytes, sizeBefore: bytes.length, sizeAfter: bytes.length, changed: false, images: imagesReport, checked: [] };
  }
  let out: Uint8Array;
  try {
    out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false });
  } catch {
    return { status: "error", code: "unreadable", message: "小さくした PDF を書き出せませんでした。" };
  }
  if (out.length >= bytes.length) {
    return { status: "ok", bytes, sizeBefore: bytes.length, sizeAfter: bytes.length, changed: false, images: { ...imagesReport, changed: 0, savedBytes: 0 }, checked: [] };
  }

  // 3. 読み直し：ページの数が同じで、どの確かめでも残りが増えていないこと
  const increased: CompressIncrease[] = [];
  const re = await loadPdf(out);
  if (re.status === "error" || re.doc.getPageCount() !== pages.length) {
    increased.push({ check: "area", kind: "unreadable_page", label: "小さくした PDF を読み直せませんでした", before: 0, after: 1 });
  }
  const checked: string[] = [];
  for (const c of options.checks ?? []) {
    let before: RedactLeftover[], after: RedactLeftover[];
    try {
      before = await c.run(bytes, []);
    } catch {
      before = [];
    }
    try {
      after = await c.run(out, []);
    } catch {
      after = [{ check: c.name, kind: c.name === "rules" ? "rule_error" : "verifier_error", count: 1, label: "小さくした PDF を確かめられませんでした" }];
    }
    checked.push(c.name);
    const tb = tally(before);
    for (const [key, a] of tally(after)) {
      const b = tb.get(key)?.count ?? 0;
      if (a.count > b) increased.push({ check: a.check, kind: a.kind, ...(a.pattern ? { pattern: a.pattern } : {}), label: a.label, before: b, after: a.count });
    }
  }
  if (increased.length) return { status: "blocked", sizeBefore: bytes.length, sizeAfter: out.length, increased, checked };
  return { status: "ok", bytes: out, sizeBefore: bytes.length, sizeAfter: out.length, changed: true, images: imagesReport, checked };
}

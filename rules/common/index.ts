// SPDX-License-Identifier: AGPL-3.0-only
//
// 新しい検出ルール（P2 の文書全体の XMP・P8・P10・P11・P12 など）で共通に使う小さな部品。
// rules/shared/ は P5・P6・P7 の部品（別の持ち場）なので、そこは変えずに、ここに置く。
// - openPdf：読み込みと、読めないとき・暗号化のときの報告の文（どのルールでも同じ文にする）
// - textOf：文字の値を読む（P1 と同じ読み方）
// - streamData：ストリームを展開して読む（大きさの上限つき）
// - countShownGlyphs：描く命令の列（ページ・注釈の見た目・部品）で、描かれる字の数を数える（中の部品もたどる）

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from "pdf-lib";
import { decodeStreamUpTo, rethrowIfInflateLimit } from "../shared/inflate-limit.ts";
import { operations } from "../shared/content-lexer.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { readFont, type FontInfo } from "../shared/fonts.ts";
import { loadPdf } from "../shared/load.ts";
import { decodeTextBytes } from "../p1-info/index.ts";

export type RuleError = { code: "empty" | "unreadable" | "encrypted"; message: string };

export type Opened =
  | { ok: true; doc: PDFDocument; ctx: PDFContext; decrypted: (EncryptionSummary & { failedObjects: number }) | null }
  | { ok: false; error: RuleError };

/** 読み込み。読めない・パスワードが要るときは、画面に出す文つきの error を返す */
export async function openPdf(bytes: Uint8Array): Promise<Opened> {
  if (bytes.length === 0) return { ok: false, error: { code: "empty", message: "ファイルが空です。" } };
  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") {
    if (loaded.code === "encrypted") {
      const message = loaded.reason === "password_required" ? "パスワードが要る PDF は、調べられません。" : "この形の暗号化は、いまは調べられません。";
      return { ok: false, error: { code: "encrypted", message } };
    }
    return { ok: false, error: { code: "unreadable", message: "PDF として読めませんでした。" } };
  }
  return { ok: true, doc: loaded.doc, ctx: loaded.doc.context, decrypted: loaded.decrypted };
}

export const N = (s: string) => PDFName.of(s);

export function lookup(ctx: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  try {
    return obj instanceof PDFRef ? ctx.lookup(obj) : obj;
  } catch {
    return undefined;
  }
}

export function dictOf(ctx: PDFContext, obj: PDFObject | undefined): PDFDict | undefined {
  const v = lookup(ctx, obj);
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

export function nameOf(ctx: PDFContext, obj: PDFObject | undefined): string | undefined {
  const v = lookup(ctx, obj);
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function numOf(ctx: PDFContext, obj: PDFObject | undefined): number | undefined {
  const v = lookup(ctx, obj);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

/** 文字の値（文字列）を読む。文字列でなければ null。読み方は P1 と同じ（UTF-16BE・UTF-16LE・UTF-8・PDFDocEncoding） */
export function textOf(ctx: PDFContext, obj: PDFObject | undefined): string | null {
  const v = lookup(ctx, obj);
  if (v instanceof PDFString || v instanceof PDFHexString) return decodeTextBytes(v.asBytes()).text;
  return null;
}

/** NUL と前後の空白を除いた字。空なら "" */
export function visibleText(text: string): string {
  return text.replace(/\u0000/g, "").trim();
}

export const charCount = (s: string) => [...s].length;

/** ストリームを展開して読む。上限を超える・読めないときは null */
export function streamData(stream: PDFStream, maxBytes: number): Uint8Array | null {
  try {
    const raw = stream instanceof PDFRawStream ? stream.contents : stream.getContents();
    if (raw.length > maxBytes) return null;
    // 上限までだけ解く（途中で止める）。ファイルの合計の上限で止めたときは、投げ直す（「読めない」にしない）
    return decodeStreamUpTo(stream, maxBytes);
  } catch (e) {
    rethrowIfInflateLimit(e);
    return null;
  }
}

/** バイト列を字にする（BOM を見て UTF-16・UTF-8。なければ UTF-8 として読み、壊れていれば Shift_JIS、だめなら latin1） */
export function bytesToText(bytes: Uint8Array): { text: string; encoding: "utf16be" | "utf16le" | "utf8" | "shift_jis" | "latin1" } {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf16be" };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf16le" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes), encoding: "utf8" };
  } catch {
    /* 次へ */
  }
  try {
    return { text: new TextDecoder("shift_jis", { fatal: true }).decode(bytes), encoding: "shift_jis" };
  } catch {
    return { text: new TextDecoder("latin1").decode(bytes), encoding: "latin1" };
  }
}

// ---------------------------------------------------------------- 描かれる字の数

export type GlyphCount = {
  /** 描かれる字の数（空白を除く） */
  glyphs: number;
  /** 調べるときだけ（includeText）。取り出される字。記録やログには使わない */
  text: string;
  /** 上限で打ち切ったか */
  truncated: boolean;
};

export type GlyphCountOptions = { maxOps?: number; maxDepth?: number; maxBytes?: number; includeText?: boolean };

/**
 * 描く命令の列で、描かれる字（Tj・TJ・'・"）の数を数える。中の部品（Do で呼ぶフォーム XObject）もたどる。
 * 字の色・大きさ・場所は見ない（見えるかどうかは、呼ぶ側が決める。隠した注釈の見た目など）。
 * 描画モード 3（描かない）・7（切り取りだけ）の字は数えない。
 */
export function countShownGlyphs(
  ctx: PDFContext,
  content: Uint8Array,
  resources: PDFDict | undefined,
  options: GlyphCountOptions = {},
): GlyphCount {
  const maxOps = options.maxOps ?? 1_000_000;
  const maxDepth = options.maxDepth ?? 8;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const out: GlyphCount = { glyphs: 0, text: "", truncated: false };
  let ops = 0;
  const visited = new Set<PDFObject>();

  const walk = (data: Uint8Array, res: PDFDict | undefined, depth: number) => {
    const fonts = dictOf(ctx, res?.get(N("Font")));
    const xobjects = dictOf(ctx, res?.get(N("XObject")));
    const fontCache = new Map<string, FontInfo>();
    let font: FontInfo | undefined;
    const stack: Array<{ font: FontInfo | undefined; mode: number }> = [];
    let mode = 0;
    const show = (bytes: Uint8Array) => {
      if (mode === 3 || mode === 7) return;
      const f = font ?? readFont(ctx, undefined);
      for (const g of f.decode(bytes)) {
        if (g.isSpace) continue;
        out.glyphs++;
        if (options.includeText) out.text += g.text;
      }
    };
    try {
      for (const { op, args } of operations(data)) {
        if (++ops > maxOps) {
          out.truncated = true;
          return;
        }
        switch (op) {
          case "q":
            stack.push({ font, mode });
            break;
          case "Q": {
            const s = stack.pop();
            if (s) ({ font, mode } = s);
            break;
          }
          case "Tf": {
            const name = args[0]?.t === "name" ? args[0].v : undefined;
            if (name === undefined) break;
            let f = fontCache.get(name);
            if (!f) {
              f = readFont(ctx, fonts?.get(N(name)));
              fontCache.set(name, f);
            }
            font = f;
            break;
          }
          case "Tr":
            if (args[0]?.t === "num") mode = args[0].v;
            break;
          case "Tj":
          case "'":
            if (args[0]?.t === "str") show(args[0].v);
            break;
          case '"':
            if (args[2]?.t === "str") show(args[2].v);
            break;
          case "TJ":
            if (args[0]?.t === "arr") for (const a of args[0].v) if (a.t === "str") show(a.v);
            break;
          case "Do": {
            if (depth >= maxDepth) {
              out.truncated = true;
              break;
            }
            const name = args[0]?.t === "name" ? args[0].v : undefined;
            const ref = name !== undefined ? xobjects?.get(N(name)) : undefined;
            if (!ref || visited.has(ref)) break;
            visited.add(ref);
            const xo = lookup(ctx, ref);
            if (!(xo instanceof PDFStream) || nameOf(ctx, xo.dict.get(N("Subtype"))) !== "Form") break;
            const inner = streamData(xo, maxBytes);
            if (inner) walk(inner, dictOf(ctx, xo.dict.get(N("Resources"))) ?? res, depth + 1);
            break;
          }
        }
      }
    } catch {
      out.truncated = true; // 読めない所で止める（数えた分は返す）
    }
  };
  walk(content, resources, 0);
  return out;
}

/** 見た目のストリーム（/AP の /N）を集める。状態ごとの辞書（チェックボックスなど）なら、全部の状態のストリーム */
export function appearanceStreams(ctx: PDFContext, annot: PDFDict): PDFStream[] {
  const ap = dictOf(ctx, annot.get(N("AP")));
  if (!ap) return [];
  const n = lookup(ctx, ap.get(N("N")));
  if (n instanceof PDFStream) return [n];
  if (n instanceof PDFDict) {
    const out: PDFStream[] = [];
    for (const [, v] of n.entries()) {
      const s = lookup(ctx, v);
      if (s instanceof PDFStream) out.push(s);
    }
    return out;
  }
  return [];
}

/** 配列（PDFArray）の中身。配列でなければ空 */
export function arrayItems(ctx: PDFContext, obj: PDFObject | undefined): PDFObject[] {
  const v = lookup(ctx, obj);
  return v instanceof PDFArray ? v.asArray() : [];
}

/** 名前の木（/Names の中の /JavaScript・/EmbeddedFiles など）の、名前と値の組みを集める。上限つき */
export function nameTreeEntries(
  ctx: PDFContext,
  root: PDFObject | undefined,
  limits: { maxNodes: number; maxDepth: number } = { maxNodes: 10_000, maxDepth: 32 },
): { entries: Array<{ name: string; value: PDFObject }>; truncated: boolean } {
  const entries: Array<{ name: string; value: PDFObject }> = [];
  let nodes = 0;
  let truncated = false;
  const seen = new Set<PDFObject>();
  const visit = (obj: PDFObject | undefined, depth: number) => {
    if (!obj || seen.has(obj)) return;
    seen.add(obj);
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) {
      truncated = true;
      return;
    }
    const d = dictOf(ctx, obj);
    if (!d) return;
    const names = arrayItems(ctx, d.get(N("Names")));
    for (let i = 0; i + 1 < names.length; i += 2) entries.push({ name: textOf(ctx, names[i]) ?? "", value: names[i + 1]! });
    for (const kid of arrayItems(ctx, d.get(N("Kids")))) visit(kid, depth + 1);
  };
  visit(root, 0);
  return { entries, truncated };
}

/** カタログ（文書の入口の辞書） */
export function catalogOf(ctx: PDFContext): PDFDict | undefined {
  return dictOf(ctx, ctx.trailerInfo.Root);
}

/** 注釈の /F の印から、隠しの印（Hidden＝2、NoView＝32）があるか。読み取り専用（64）・ロック（128）などは隠しではない */
export function hiddenFlagOf(ctx: PDFContext, annot: PDFDict): "hidden" | "no_view" | null {
  const f = numOf(ctx, annot.get(N("F"))) ?? 0;
  if (!Number.isFinite(f)) return null;
  const flags = Math.trunc(f);
  if (flags & 2) return "hidden";
  if (flags & 32) return "no_view";
  return null;
}

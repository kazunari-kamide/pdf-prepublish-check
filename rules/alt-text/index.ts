// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：しおりの題と、代わりの文字（`alt-text`）1.0.0。型は P7（隠れたテキスト）の仲間として扱う【仮】。
// ページには描かれていないが、画面の横・読み上げ・コピーで取り出される字を、数と場所で返す。値そのものは返さない。
//
// 種類（kind）：
//   actual_text_diff：ページの中の /ActualText（マーク付きの中身の代わりの文字）が、描いた字と違う（コピーすると、描いた字ではなく代わりの字が出る）
//   outline：しおり（/Outlines）の題。画面の横に見えるもの。低い「確認してほしい所」
//   alt：読み上げ用の説明（構造の /Alt）と、構造の /ActualText・/T（題）・/E（略語の展開。/T・/E は 1.1.0 から）、字を描いていない所の /ActualText。
//        行政の PDF のアクセシビリティで推奨されるので危険にはせず、低い「確認してほしい所」として件数を出す
// 数えないもの：描いた字と同じ /ActualText（合字・異体字を、ふつうの字に直すためのもの）。
//   1.1.0 から：ページに描いた字の中にそのまま出てくる、しおりの題・読み上げ用の説明（見出しと同じ題、図の見える説明と同じ /Alt）。
//   ページに描いていない字だけを数える（notCounted.inBody）。字の中身が分からない書体の字は比べられないので、これまでどおり数える。
//   字の中身が分からない書体（ToUnicode なし）の上の /ActualText は、比べられないので notCounted に数える。

import { PDFDict, PDFStream, type PDFContext, type PDFObject, type PDFPage } from "pdf-lib";
import { operations, type Tok } from "../shared/content-lexer.ts";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { readFont, type FontInfo } from "../shared/fonts.ts";
import { decodeTextBytes } from "../p1-info/index.ts";
import { arrayItems, catalogOf, dictOf, lookup, N, nameOf, openPdf, streamData, textOf, visibleText, type RuleError } from "../common/index.ts";

export const RULE_ID = "alt-text";
export const RULE_VERSION = "1.1.0";

export type AltKind = "actual_text_diff" | "outline" | "alt";

export type AltFinding = {
  pattern: "P7";
  kind: AltKind;
  /** どこにあったか（ページの中・しおり・構造） */
  where: "page" | "outlines" | "structure";
  /** ページの中のときのページ（小さい順。構造・しおりは空） */
  pages: number[];
  /** 件数（しおりの題の数・説明の数・食い違いの数） */
  count: number;
  /** 字数の合計 */
  chars: number;
};

export type AltReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  findings: AltFinding[];
  notCounted: { sameText: number; unknownFont: number; inBody: number };
  limits: Array<"too_many_outlines" | "too_many_struct" | "too_many_ops" | "unreadable_page">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export const LIMITS = { outlines: 100_000, structElements: 200_000, opsPerPage: 3_000_000, depth: 64, streamBytes: 32 * 1024 * 1024 } as const;

const norm = (s: string) => s.normalize("NFKC").replace(/[\s\u0000​﻿]/g, "");

function tokText(t: Tok | undefined): string | null {
  if (!t || t.t !== "str") return null;
  return decodeTextBytes(t.v).text;
}

export async function detectAltText(bytes: Uint8Array): Promise<AltReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], notCounted: { sameText: 0, unknownFont: 0, inBody: 0 }, limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { doc, ctx } = opened;
  const report: AltReport = { ...base, status: "ok", findings: [], notCounted: { sameText: 0, unknownFont: 0, inBody: 0 }, limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;
  const limit = (l: AltReport["limits"][number]) => {
    if (!report.limits.includes(l)) report.limits.push(l);
  };

  // ---- しおり（題を集め、ページの字を読んだあとで数える。1.1.0 から）
  const outlineTitles: string[] = [];
  const structTexts: string[] = [];
  const outlines = dictOf(ctx, catalogOf(ctx)?.get(N("Outlines")));
  if (outlines) {
    let seen = 0;
    const visited = new Set<PDFObject>();
    const stack: Array<{ obj: PDFObject | undefined; depth: number }> = [{ obj: outlines.get(N("First")), depth: 0 }];
    while (stack.length) {
      const { obj, depth } = stack.pop()!;
      let cur = obj;
      while (cur) {
        const d = dictOf(ctx, cur);
        if (!d || visited.has(d)) break;
        visited.add(d);
        if (++seen > LIMITS.outlines) {
          limit("too_many_outlines");
          stack.length = 0;
          break;
        }
        const t = visibleText(textOf(ctx, d.get(N("Title"))) ?? "");
        if (t) outlineTitles.push(t);
        if (depth < LIMITS.depth) stack.push({ obj: d.get(N("First")), depth: depth + 1 });
        cur = d.get(N("Next"));
      }
    }
  }

  // ---- 構造（/StructTreeRoot）の /Alt と /ActualText
  const root = dictOf(ctx, catalogOf(ctx)?.get(N("StructTreeRoot")));
  if (root) {
    let n = 0;
    const visited = new Set<PDFObject>();
    const stack: Array<{ obj: PDFObject | undefined; depth: number }> = [{ obj: root.get(N("K")), depth: 0 }];
    while (stack.length) {
      const { obj, depth } = stack.pop()!;
      const v = lookup(ctx, obj);
      if (!v || visited.has(v) || depth > LIMITS.depth) continue;
      visited.add(v);
      if (v instanceof PDFDict) {
        if (++n > LIMITS.structElements) {
          limit("too_many_struct");
          break;
        }
        // 構造要素の題（/T）と略語の展開（/E）も、読み上げや支援技術で取り出される（1.1.0 から。ページに描いた字と同じものは数えない）
        for (const key of ["Alt", "ActualText", "T", "E"]) {
          const t = visibleText(textOf(ctx, v.get(N(key))) ?? "");
          if (t) structTexts.push(t);
        }
        stack.push({ obj: v.get(N("K")), depth: depth + 1 });
      } else for (const k of arrayItems(ctx, v)) stack.push({ obj: k, depth: depth + 1 });
    }
  }

  // ---- ページの中の /ActualText
  const diff = { count: 0, chars: 0, pages: new Set<number>() };
  // ページに描いた字（中身の分かるものだけ。比べるため。1.1.0 から）
  const bodyParts: string[] = [];
  const noGlyph = { count: 0, chars: 0, pages: new Set<number>() };
  let pages: PDFPage[];
  try {
    pages = doc.getPages();
  } catch {
    pages = [];
  }
  pages.forEach((page, i) => {
    const pageNo = i + 1;
    const res = dictOf(ctx, page.node.get(N("Resources"))) ?? page.node.Resources();
    const contents = lookup(ctx, page.node.get(N("Contents")));
    const streams = contents instanceof PDFStream ? [contents] : arrayItems(ctx, contents).map((c) => lookup(ctx, c)).filter((c): c is PDFStream => c instanceof PDFStream);
    const parts = streams.map((s) => streamData(s, LIMITS.streamBytes)).filter((b): b is Uint8Array => !!b);
    const data = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0));
    let at = 0;
    for (const p of parts) {
      data.set(p, at);
      at += p.length + 1;
      data[at - 1] = 0x0a;
    }
    try {
      walkActualText(ctx, data, res, (actual, shown, glyphs, unknown) => {
        const a = norm(actual);
        if (!a) return;
        if (glyphs === 0) {
          noGlyph.count++;
          noGlyph.chars += [...a].length;
          noGlyph.pages.add(pageNo);
        } else if (unknown) report.notCounted.unknownFont++;
        else if (a === norm(shown)) report.notCounted.sameText++;
        else {
          diff.count++;
          diff.chars += [...a].length;
          diff.pages.add(pageNo);
        }
      }, () => limit("too_many_ops"), (t) => bodyParts.push(t));
    } catch {
      limit("unreadable_page");
    }
  });
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  // しおりの題・構造の説明は、ページに描いた字の中にそのまま出てこないものだけを数える（1.1.0 から）
  const body = norm(bodyParts.join(""));
  const notInBody = (list: string[]) => {
    const out = { count: 0, chars: 0 };
    for (const t of list) {
      const n = norm(t);
      if (n && body.includes(n)) {
        report.notCounted.inBody++;
        continue;
      }
      out.count++;
      out.chars += [...t].length;
    }
    return out;
  };
  const ol = notInBody(outlineTitles);
  if (ol.count) report.findings.push({ pattern: "P7", kind: "outline", where: "outlines", pages: [], count: ol.count, chars: ol.chars });
  const st = notInBody(structTexts);
  if (st.count) report.findings.push({ pattern: "P7", kind: "alt", where: "structure", pages: [], count: st.count, chars: st.chars });
  if (diff.count) report.findings.unshift({ pattern: "P7", kind: "actual_text_diff", where: "page", pages: sorted(diff.pages), count: diff.count, chars: diff.chars });
  if (noGlyph.count) report.findings.push({ pattern: "P7", kind: "alt", where: "page", pages: sorted(noGlyph.pages), count: noGlyph.count, chars: noGlyph.chars });
  return report;
}

type Capture = { actual: string; shown: string; glyphs: number; unknown: boolean; depth: number };

/**
 * 描く命令を読み、/ActualText のあるマーク付きの中身（BDC … EMC）ごとに、代わりの字と、中で描いた字を渡す。
 * 中の部品（フォーム XObject）もたどる。入れ子の /ActualText は、外側のものにまとめる（外側が字を置き換えるため）。
 */
function walkActualText(
  ctx: PDFContext,
  content: Uint8Array,
  resources: PDFDict | undefined,
  onSpan: (actual: string, shown: string, glyphs: number, unknown: boolean) => void,
  onLimit: () => void,
  onShown: (text: string) => void = () => {},
) {
  let ops = 0;
  const captures: Capture[] = [];
  let mcDepth = 0;
  const visited = new Set<PDFObject>();
  const walk = (data: Uint8Array, res: PDFDict | undefined, depth: number) => {
    const fonts = dictOf(ctx, res?.get(N("Font")));
    const props = dictOf(ctx, res?.get(N("Properties")));
    const xobjects = dictOf(ctx, res?.get(N("XObject")));
    const cache = new Map<string, FontInfo>();
    let font: FontInfo | undefined;
    const fontStack: Array<FontInfo | undefined> = [];
    const show = (b: Uint8Array) => {
      const cap = captures[0];
      const glyphs = (font ?? readFont(ctx, undefined)).decode(b);
      onShown(glyphs.map((g) => g.text).join(""));
      if (!cap) return;
      for (const g of glyphs) {
        if (g.isSpace) continue;
        cap.glyphs++;
        if (!g.text) cap.unknown = true;
        cap.shown += g.text;
      }
    };
    for (const { op, args } of operations(data)) {
      if (++ops > LIMITS.opsPerPage) {
        onLimit();
        return;
      }
      switch (op) {
        case "q":
          fontStack.push(font);
          break;
        case "Q":
          font = fontStack.pop() ?? font;
          break;
        case "Tf": {
          const name = args[0]?.t === "name" ? args[0].v : undefined;
          if (name === undefined) break;
          let f = cache.get(name);
          if (!f) cache.set(name, (f = readFont(ctx, fonts?.get(N(name)))));
          font = f;
          break;
        }
        case "BMC":
          mcDepth++;
          break;
        case "BDC": {
          mcDepth++;
          const p = args[1];
          let actual: string | null = null;
          if (p?.t === "dict") actual = tokText(p.v.get("ActualText"));
          else if (p?.t === "name") actual = textOf(ctx, dictOf(ctx, props?.get(N(p.v)))?.get(N("ActualText")));
          if (actual !== null && captures.length === 0) captures.push({ actual, shown: "", glyphs: 0, unknown: false, depth: mcDepth });
          break;
        }
        case "EMC": {
          const cap = captures[0];
          if (cap && cap.depth === mcDepth) {
            captures.length = 0;
            onSpan(cap.actual, cap.shown, cap.glyphs, cap.unknown);
          }
          mcDepth = Math.max(0, mcDepth - 1);
          break;
        }
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
          const name = args[0]?.t === "name" ? args[0].v : undefined;
          const ref = name !== undefined ? xobjects?.get(N(name)) : undefined;
          if (!ref || visited.has(ref) || depth >= 8) break;
          visited.add(ref);
          const xo = lookup(ctx, ref);
          if (!(xo instanceof PDFStream) || nameOf(ctx, xo.dict.get(N("Subtype"))) !== "Form") break;
          const inner = streamData(xo, LIMITS.streamBytes);
          if (inner) walk(inner, dictOf(ctx, xo.dict.get(N("Resources"))) ?? res, depth + 1);
          break;
        }
      }
    }
  };
  walk(content, resources, 0);
}

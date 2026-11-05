// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りしたあと、消した字だけで使っていた「字の対応表」（/ToUnicode）の行を消す。
// 字を絞った書体（部分埋め込み）の対応表には、その書体で使った字が全部並ぶ。黒塗りで消した字が対応表に残ると、
// 「この文書にはこの字があった」ことが分かってしまうため。
//
// - 絞るのは、選んだ場所のあるページ（と、その部品）で使う書体だけ。
// - 文書の中で、まだ使っているコード（ページ・部品・注釈の見た目で描く字）は残す。
// - 読み切れない所（読めない中身、Type3 の書体の中・模様の中・フォームの既定の書体など）から使う書体は、絞らない（字のコピーを壊さないため）。
// - 書体の中の字の形（字形）は消さない（書体を作り直す道具が要る。限界は README）。

import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFObject } from "pdf-lib";
import { operations } from "../rules/shared/content-lexer.ts";
import { readFont, type FontInfo } from "../rules/shared/fonts.ts";
import { contentData, streamData } from "./content.ts";
import type { RemovedItem } from "./types.ts";

const MAX_DEPTH = 12;

function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

/** 対応表に書いてあるコード（bfchar・bfrange）。読めないときは null */
export function cmapCodes(data: Uint8Array): Set<number> | null {
  const text = new TextDecoder("latin1").decode(data);
  const codes = new Set<number>();
  const hex = (h: string) => parseInt(h, 16);
  try {
    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*(?:<[0-9a-fA-F]*>|\/[^\s<\[]+)/g)) codes.add(hex(m[1]!));
    }
    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const lo = hex(m[1]!), hi = hex(m[2]!);
        if (!(hi >= lo) || hi - lo > 0xffff) return null;
        for (let c = lo; c <= hi; c++) codes.add(c);
      }
    }
  } catch {
    return null;
  }
  return codes;
}

function utf16Hex(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return out;
}

/** コード → 字 の表から、対応表（CMap）を作る */
function buildCMap(map: Array<[number, string]>, twoByte: boolean): string {
  const w = twoByte ? 4 : 2;
  const code = (c: number) => `<${c.toString(16).padStart(w, "0").toUpperCase()}>`;
  const lines = [
    "/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def", "/CMapName /Adobe-Identity-UCS def", "/CMapType 2 def",
    "1 begincodespacerange", `${code(0)} ${code(twoByte ? 0xffff : 0xff)}`, "endcodespacerange",
  ];
  for (let i = 0; i < map.length; i += 100) {
    const part = map.slice(i, i + 100);
    lines.push(`${part.length} beginbfchar`);
    for (const [c, t] of part) lines.push(`${code(c)} <${utf16Hex(t)}>`);
    lines.push("endbfchar");
  }
  lines.push("endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end");
  return lines.join("\n") + "\n";
}

type Usage = { info: FontInfo; codes: Set<number> };

/** 文書の中で、書体ごとに使っている字のコード。読み切れなかったときは null */
export type FontUsage = { usage: Map<PDFObject, Usage>; scannedRes: Set<PDFDict>; candidates: Set<PDFObject> };

/**
 * 文書の中で使う字のコードを、書体ごとに数える（ページ・部品・注釈の見た目）。
 * candidates は、pages（1から）で使う書体（部品の中も）。参照（PDFRef）で置いた書体だけを見る（直接書いた書体は、書き直しで写されて見分けられないため）
 */
export function fontUsage(doc: PDFDocument, pages: Set<number>, maxOps = Infinity): FontUsage | null {
  const ctx = doc.context;
  const scannedRes = new Set<PDFDict>();
  const usage = new Map<PDFObject, Usage>();
  const fontKey = (o: PDFObject): PDFObject => o;
  let broken = false;
  let ops = 0;

  const fontsIn = (res: PDFDict | undefined): Map<string, PDFObject> => {
    const out = new Map<string, PDFObject>();
    const fonts = dictOf(ctx, res?.get(PDFName.of("Font")));
    if (fonts) for (const [k, v] of fonts.entries()) out.set(k.decodeText(), v);
    return out;
  };

  /** 中身1つを読み、使う字のコードを集める。部品（Form）は中へ入る */
  const scan = (data: Uint8Array, res: PDFDict | undefined, depth: number, seen: Set<PDFObject>) => {
    if (res) scannedRes.add(res);
    const fonts = fontsIn(res);
    const xobjects = dictOf(ctx, res?.get(PDFName.of("XObject")));
    let cur: Usage | null = null;
    const use = (bytes: Uint8Array) => {
      if (!cur) return;
      for (const g of cur.info.decode(bytes)) cur.codes.add(g.code);
    };
    for (const { op, args } of operations(data)) {
      if (++ops > maxOps) throw new Error("too many operations");
      if (op === "Tf") {
        const ref = args[0]?.t === "name" ? fonts.get(args[0].v) : undefined;
        if (!ref) {
          cur = null;
          continue;
        }
        const key = fontKey(ref);
        let u = usage.get(key);
        if (!u) {
          u = { info: readFont(ctx, ref), codes: new Set() };
          usage.set(key, u);
        }
        cur = u;
      } else if (op === "Tj" || op === "'") {
        if (args[0]?.t === "str") use(args[0].v);
      } else if (op === '"') {
        if (args[2]?.t === "str") use(args[2].v);
      } else if (op === "TJ") {
        if (args[0]?.t === "arr") for (const el of args[0].v) if (el.t === "str") use(el.v);
      } else if (op === "Do" && args[0]?.t === "name" && xobjects) {
        const ref = xobjects.get(PDFName.of(args[0].v));
        const xo = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
        if (!(xo instanceof PDFStream) || depth >= MAX_DEPTH || seen.has(xo)) continue;
        const st = xo.dict.lookup(PDFName.of("Subtype"));
        if (!(st instanceof PDFName) || st.decodeText() !== "Form") continue;
        const next = new Set(seen);
        next.add(xo);
        scan(streamData(xo), dictOf(ctx, xo.dict.get(PDFName.of("Resources"))) ?? res, depth + 1, next);
      }
    }
  };

  /** 選んだページで使う書体（部品の中も） */
  const candidates = new Set<PDFObject>();
  const collectFonts = (res: PDFDict | undefined, depth: number, seen: Set<PDFDict>) => {
    if (!res || seen.has(res) || depth > MAX_DEPTH) return;
    seen.add(res);
    for (const f of fontsIn(res).values()) candidates.add(fontKey(f));
    const xobjects = dictOf(ctx, res.get(PDFName.of("XObject")));
    if (xobjects) for (const v of xobjects.values()) {
      const xo = v instanceof PDFRef ? ctx.lookup(v) : v;
      if (xo instanceof PDFStream) collectFonts(dictOf(ctx, xo.dict.get(PDFName.of("Resources"))), depth + 1, seen);
    }
  };

  try {
    const all = doc.getPages();
    for (const [i, page] of all.entries()) {
      const res = dictOf(ctx, page.node.get(PDFName.of("Resources"))) ?? page.node.Resources();
      scan(contentData(ctx, page.node.get(PDFName.of("Contents"))), res, 0, new Set());
      if (pages.has(i + 1)) collectFonts(res, 0, new Set());
      // 注釈の見た目
      const annots = ctx.lookup(page.node.get(PDFName.of("Annots")));
      if (annots instanceof PDFArray) for (const a of annots.asArray()) {
        const ad = dictOf(ctx, a);
        const ap = ad ? dictOf(ctx, ad.get(PDFName.of("AP"))) : undefined;
        if (!ap) continue;
        for (const v of ap.values()) {
          const o = v instanceof PDFRef ? ctx.lookup(v) : v;
          const streams = o instanceof PDFStream ? [o] : o instanceof PDFDict ? [...o.values()].map((x) => ctx.lookup(x)).filter((x): x is PDFStream => x instanceof PDFStream) : [];
          for (const st of streams) scan(streamData(st), dictOf(ctx, st.dict.get(PDFName.of("Resources"))), 0, new Set([st]));
        }
      }
    }
  } catch {
    broken = true;
  }
  if (broken) return null;
  return { usage, scannedRes, candidates };
}

/**
 * 黒塗りの前（before）に使っていて、いま（文書の片付けのあと）はどこでも使っていないコードの行を、
 * 選んだ場所のあるページで使う書体の対応表から消す。もとから使っていなかった行は、そのまま残す（黒塗りで分かることが増えないため）。
 * 消したコードの数を返す（0 なら項目は出さない）
 */
export function shrinkToUnicode(doc: PDFDocument, pages: Set<number>, before: FontUsage | null): RemovedItem[] {
  if (!before) return [];
  const ctx = doc.context;
  const after = fontUsage(doc, pages);
  if (!after) return [];
  const fontsIn = (res: PDFDict | undefined): PDFObject[] => {
    const fonts = dictOf(ctx, res?.get(PDFName.of("Font")));
    return fonts ? [...fonts.values()] : [];
  };

  // 読み切っていない所（Type3 の書体の中・模様の中・フォームの既定の書体など）から使う書体は、絞らない
  const exclude = new Set<PDFObject>();
  const acro = dictOf(ctx, doc.catalog.get(PDFName.of("AcroForm")));
  for (const f of fontsIn(dictOf(ctx, acro?.get(PDFName.of("DR"))))) exclude.add(f);
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!d) continue;
    const type = d.lookup(PDFName.of("Type"));
    if (type instanceof PDFName && type.decodeText() === "Pages") continue; // 受け継ぐリソースは、ページの側で読んでいる
    const res = dictOf(ctx, d.get(PDFName.of("Resources")));
    if (!res || after.scannedRes.has(res) || before.scannedRes.has(res)) continue;
    for (const f of fontsIn(res)) exclude.add(f);
  }

  let removedCodes = 0;
  for (const key of new Set([...before.candidates, ...after.candidates])) {
    if (!(key instanceof PDFRef) || exclude.has(key)) continue;
    const used = before.usage.get(key)?.codes;
    if (!used?.size) continue;
    const font = dictOf(ctx, key);
    const tu = font ? ctx.lookup(font.get(PDFName.of("ToUnicode"))) : undefined;
    if (!font || !(tu instanceof PDFStream)) continue;
    let old: Set<number> | null;
    try {
      old = cmapCodes(streamData(tu));
    } catch {
      old = null;
    }
    if (!old) continue;
    const now = after.usage.get(key)?.codes ?? new Set<number>();
    const info = before.usage.get(key)!.info;
    const kept: Array<[number, string]> = [];
    let drop = 0;
    let unsure = false;
    for (const c of [...old].sort((a, b) => a - b)) {
      if (used.has(c) && !now.has(c)) {
        drop++;
        continue;
      }
      const bytes = info.twoByte ? Uint8Array.of(c >> 8, c & 0xff) : Uint8Array.of(c & 0xff);
      const t = info.decode(bytes)[0]?.text ?? "";
      if (!t) unsure = true; // 残す行の字を読めない：作り直すと行が消えるので、この書体は触らない
      kept.push([c, t]);
    }
    if (drop === 0 || unsure) continue;
    font.set(PDFName.of("ToUnicode"), ctx.register(ctx.flateStream(buildCMap(kept, info.twoByte), {})));
    removedCodes += drop;
  }
  if (!removedCodes) return [];
  return [{
    pattern: "P6", kind: "font_unicode", count: removedCodes,
    label: `消した字だけで使っていた、字の対応表の行（${removedCodes} 字分）を消しました（書体の中の字の形は残ります）`,
  }];
}

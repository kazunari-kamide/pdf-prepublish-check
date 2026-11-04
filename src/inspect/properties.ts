// SPDX-License-Identifier: AGPL-3.0-only
//
// プロパティの一覧（11/5 B の 8）：文書情報（/Info）と XMP のすべての欄を、値ごと読む。Worker の中で使う。
// - 値を画面に出してよいのは、この一覧だけ（11/5 共通の決まりの例外。外には出ない。画面では textContent だけで出す）。
// - 値の字の決まり（UTF-16・PDFDocEncoding など）は P1 の読み方、XMP の取り出しは P2 の読み方を使う（呼ぶだけ）。
// - 細工された PDF の前提で、欄の数と値の長さに上限をかける。

import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFContext, type PDFObject } from "pdf-lib";
import { decodeTextBytes } from "../../rules/p1-info/index.ts";
import { catalogXmp } from "../../rules/p2-xmp/index.ts";
import { loadPdf } from "../../rules/shared/load.ts";

export type Property = { key: string; value: string; truncated: boolean };
export type PropertyList = {
  info: Property[];
  xmp: Property[];
  /** XMP を読めなかったとき（大きすぎる・字の形が読めない） */
  xmpProblem: "too_large" | "unreadable" | null;
  /** 欄が多すぎて、途中までしか並べていないとき true */
  limited: boolean;
};

/** 並べる欄の数の上限（文書情報と XMP それぞれ） */
export const MAX_PROPERTIES = 200;
/** 1つの値を出す長さの上限（字） */
export const MAX_VALUE_CHARS = 500;

function clip(text: string): { value: string; truncated: boolean } {
  const chars = [...text.replace(/\u0000/g, "")];
  return chars.length > MAX_VALUE_CHARS ? { value: chars.slice(0, MAX_VALUE_CHARS).join(""), truncated: true } : { value: chars.join(""), truncated: false };
}

function infoValue(ctx: PDFContext, raw: PDFObject | undefined, depth = 0): string {
  if (raw === undefined || depth > 4) return "";
  const v = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
  if (v instanceof PDFString || v instanceof PDFHexString) return decodeTextBytes(v.asBytes()).text;
  if (v instanceof PDFName) return v.decodeText();
  if (v instanceof PDFNumber || v instanceof PDFBool) return v.toString();
  if (v instanceof PDFArray) return v.asArray().map((x) => infoValue(ctx, x, depth + 1)).filter(Boolean).join(" ");
  if (v instanceof PDFDict) return "（入れ子の欄）";
  return "";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16) || 0x3f);
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10) || 0x3f);
    return ENTITIES[e] ?? "";
  });
}

/** 入れ物（値を並べる枠）の名前。値の欄の名前には使わない */
const CONTAINERS = new Set(["rdf:RDF", "rdf:Description", "rdf:Seq", "rdf:Bag", "rdf:Alt", "rdf:li", "x:xmpmeta", "x:xapmeta"]);

/** XMP の字から、値のある欄を順に取り出す（属性の形と、要素の形の両方） */
export function xmpProperties(xml: string, max = MAX_PROPERTIES): { list: Array<{ key: string; value: string }>; limited: boolean } {
  const list: Array<{ key: string; value: string }> = [];
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w.-]*:[\w.-]+|[A-Za-z_][\w.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (key: string, value: string) => {
    const v = unescapeXml(value).trim();
    if (v && list.length < max) list.push({ key, value: v });
    return list.length >= max;
  };
  const owner = () => [...stack].reverse().find((n) => !CONTAINERS.has(n));
  while ((m = tag.exec(xml))) {
    const text = xml.slice(last, m.index);
    last = tag.lastIndex;
    if (text.trim() && owner() && push(owner()!, text)) return { list, limited: true };
    if (m[2] === undefined) continue; // 処理命令・注釈
    const [, close, name, attrs = "", selfClose] = m;
    if (close) {
      const i = stack.lastIndexOf(name!);
      if (i >= 0) stack.length = i;
      continue;
    }
    for (const a of attrs.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const key = a[1]!;
      if (key.startsWith("xmlns") || key.startsWith("rdf:") || key.startsWith("xml:")) continue;
      if (push(key, a[2] ?? a[3] ?? "")) return { list, limited: true };
    }
    if (!selfClose) stack.push(name!);
  }
  return { list, limited: false };
}

export async function readProperties(bytes: Uint8Array): Promise<PropertyList | null> {
  const loaded = await loadPdf(bytes);
  if (loaded.status !== "ok") return null;
  const ctx = loaded.doc.context;
  let limited = false;
  const info: Property[] = [];
  const infoRaw = ctx.trailerInfo.Info;
  const dict = infoRaw instanceof PDFRef ? ctx.lookup(infoRaw) : infoRaw;
  if (dict instanceof PDFDict) {
    for (const [k, v] of dict.entries()) {
      if (info.length >= MAX_PROPERTIES) {
        limited = true;
        break;
      }
      const text = infoValue(ctx, v);
      if (text.replace(/\u0000/g, "").trim()) info.push({ key: k.decodeText(), ...clip(text) });
    }
  }
  const xmp: Property[] = [];
  let xmpProblem: PropertyList["xmpProblem"] = null;
  const x = catalogXmp(ctx);
  if (typeof x === "string") xmpProblem = x;
  else if (x) {
    const r = xmpProperties(x.xml);
    limited ||= r.limited;
    for (const p of r.list) xmp.push({ key: p.key, ...clip(p.value) });
  }
  return { info, xmp, xmpProblem, limited };
}

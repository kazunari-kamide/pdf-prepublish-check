// SPDX-License-Identifier: AGPL-3.0-only
//
// 資源にあるが描かれない部品（1.3.0 から。見ないで作るテスト集の T19）。
// ページの資源（/Resources の /XObject）に入っているのに、どの中身からも Do で呼ばれない部品（Form XObject）は、
// 画面には出ないが、中の字を取り出せる。前の版の残りと同じく「いまの見た目にない中身」として数える。
//
// 描く入口：ページの中身（資源は親から受け継ぐ）、注釈の見た目（/AP の N・R・D）、模様（Pattern）の中身、Type3 の字の形。
// 入口のどれかを読めなかったときは、何も数えない（呼んでいるのに読めなかっただけの部品を、描かれないと誤らないため）。

import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFObject } from "pdf-lib";
import { operations, nameArg } from "../shared/content-lexer.ts";

const N = (s: string) => PDFName.of(s);
const MAX_DEPTH = 12;
const MAX_STREAMS = 20_000;
const MAX_PARENT = 32;

type Resolve = (o: PDFObject | undefined) => PDFObject | undefined;

function dictOf(resolve: Resolve, o: PDFObject | undefined): PDFDict | undefined {
  const v = resolve(o);
  return v instanceof PDFDict ? v : undefined;
}

function decode(s: PDFStream): Uint8Array {
  return s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
}

/**
 * 資源にあるが描かれない部品の番号を返す（いまの版のオブジェクトだけ）。
 * pages：いまの版のページの辞書。resolve：いまの版の参照を解く関数
 */
export function unusedForms(pages: PDFDict[], resolve: Resolve): Set<number> {
  const offered = new Map<number, PDFStream>(); // 資源の /XObject にある部品
  const drawn = new Set<number>();
  const visitedStreams = new Set<PDFStream>();
  let streams = 0;
  let failed = false;

  const offer = (res: PDFDict | undefined) => {
    if (!res) return;
    const xo = dictOf(resolve, res.get(N("XObject")));
    if (!xo) return;
    for (const [, v] of xo.entries()) {
      if (!(v instanceof PDFRef)) continue;
      const s = resolve(v);
      if (s instanceof PDFStream && s.dict.get(N("Subtype")) === N("Form")) offered.set(v.objectNumber, s);
    }
  };

  // 中身の流れを読み、Do で呼ぶ部品をたどる。模様と Type3 の字の形も、資源にあれば読む
  const visit = (content: PDFStream, res: PDFDict | undefined, depth: number) => {
    if (failed || depth > MAX_DEPTH || visitedStreams.has(content)) return;
    visitedStreams.add(content);
    let data: Uint8Array;
    try {
      data = decode(content);
    } catch {
      failed = true;
      return;
    }
    visitData(data, res, depth);
  };

  const visitData = (data: Uint8Array, res: PDFDict | undefined, depth: number) => {
    if (failed) return;
    if (++streams > MAX_STREAMS) {
      failed = true;
      return;
    }
    offer(res);
    visitResourceSide(res, depth);
    try {
      for (const { op, args } of operations(data)) {
        if (op !== "Do") continue;
        const name = nameArg(args[0]);
        const xo = res ? dictOf(resolve, res.get(N("XObject"))) : undefined;
        const ref = name && xo ? xo.get(N(name)) : undefined;
        const s = resolve(ref);
        if (!(s instanceof PDFStream) || s.dict.get(N("Subtype")) !== N("Form")) continue;
        if (ref instanceof PDFRef) drawn.add(ref.objectNumber);
        visit(s, dictOf(resolve, s.dict.get(N("Resources"))) ?? res, depth + 1);
      }
    } catch {
      failed = true;
    }
  };

  const visitResourceSide = (res: PDFDict | undefined, depth: number) => {
    if (!res) return;
    const pat = dictOf(resolve, res.get(N("Pattern")));
    if (pat) {
      for (const [, v] of pat.entries()) {
        const s = resolve(v);
        if (s instanceof PDFStream) visit(s, dictOf(resolve, s.dict.get(N("Resources"))), depth + 1);
      }
    }
    const fonts = dictOf(resolve, res.get(N("Font")));
    if (fonts) {
      for (const [, v] of fonts.entries()) {
        const f = dictOf(resolve, v);
        if (!f || f.get(N("Subtype")) !== N("Type3")) continue;
        const procs = dictOf(resolve, f.get(N("CharProcs")));
        const fres = dictOf(resolve, f.get(N("Resources"))) ?? res;
        if (!procs) continue;
        for (const [, p] of procs.entries()) {
          const s = resolve(p);
          if (s instanceof PDFStream) visit(s, fres, depth + 1);
        }
      }
    }
  };

  const inheritedResources = (page: PDFDict): PDFDict | undefined => {
    let node: PDFDict | undefined = page;
    for (let i = 0; node && i < MAX_PARENT; i++) {
      const r = dictOf(resolve, node.get(N("Resources")));
      if (r) return r;
      node = dictOf(resolve, node.get(N("Parent")));
    }
    return undefined;
  };

  const visitAppearance = (o: PDFObject | undefined, res: PDFDict | undefined) => {
    const v = resolve(o);
    if (v instanceof PDFStream) {
      if (o instanceof PDFRef) drawn.add(o.objectNumber);
      visit(v, dictOf(resolve, v.dict.get(N("Resources"))) ?? res, 1);
    } else if (v instanceof PDFDict) {
      for (const [, s] of v.entries()) visitAppearance(s, res);
    }
  };

  for (const page of pages) {
    const res = inheritedResources(page);
    const c = resolve(page.get(N("Contents")));
    const parts: PDFObject[] = c instanceof PDFArray ? c.asArray() : c ? [c] : [];
    // ページの中身が複数の流れに分かれていても、1つの中身として読む（流れの境で命令が切れることがあるため、つないで読む）
    const chunks: Uint8Array[] = [];
    for (const p of parts) {
      const s = resolve(p);
      if (!(s instanceof PDFStream)) continue;
      try {
        chunks.push(decode(s), new Uint8Array([0x0a]));
      } catch {
        failed = true;
      }
    }
    if (failed) break;
    const joined = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of chunks) {
      joined.set(b, at);
      at += b.length;
    }
    visitData(joined, res, 0);
    const annots = resolve(page.get(N("Annots")));
    if (annots instanceof PDFArray) {
      for (const a of annots.asArray()) {
        const ad = dictOf(resolve, a);
        const ap = ad ? dictOf(resolve, ad.get(N("AP"))) : undefined;
        if (!ap) continue;
        for (const k of ["N", "R", "D"]) visitAppearance(ap.get(N(k)), res);
      }
    }
    if (failed) break;
  }
  if (failed) return new Set();
  const out = new Set<number>();
  for (const [num] of offered) if (!drawn.has(num)) out.add(num);
  return out;
}


// SPDX-License-Identifier: AGPL-3.0-only
//
// 文書全体の隠れた情報を取り除く。
// - P1 文書情報：Info 辞書を丸ごと消す（作成者などの欄は書き換えずに消す。2026-11-03 人が決めた）
// - P2 XMP：/Metadata をすべて外す（文書・ページ・画像・部品のもの）
// - P8 注釈の中身：コメント（/Contents・/RC）・作者名（/T）・件名・日時を消し、吹き出し（Popup）を外す。見た目は残す
// - P9 添付ファイル：名前の木の /EmbeddedFiles、添付ファイルの注釈、関連ファイル（/AF）、ポートフォリオ（/Collection）を外す
// - P12 JavaScript：名前の木の /JavaScript、JavaScript の動作（/OpenAction・/A・/AA の中）を外す
// - P5 前の版：最後に、文書の根（/Root）からたどれないオブジェクトをすべて捨て、1つの版として書き出す（index.ts）
//
// 取り出した中身（名前・ファイル名・コメントの字）は、結果に入れない。数だけを返す。

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
  PDFHexString,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from "pdf-lib";
import type { RemovedItem } from "./types.ts";

const N = (s: string) => PDFName.of(s);

function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}
function nameOf(ctx: PDFContext, o: PDFObject | undefined): string | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFName ? v.decodeText() : undefined;
}
function hasValue(ctx: PDFContext, o: PDFObject | undefined): boolean {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFString || v instanceof PDFHexString) return v.asBytes().some((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0);
  return v !== undefined;
}

/** 名前の木の葉（名前と値の組）の数。/Kids の入れ子もたどる */
function countNameTree(ctx: PDFContext, node: PDFObject | undefined, seen = new Set<PDFObject>(), depth = 0): number {
  const d = dictOf(ctx, node);
  if (!d || seen.has(d) || depth > 64) return 0;
  seen.add(d);
  let n = 0;
  const names = ctx.lookup(d.get(N("Names")));
  if (names instanceof PDFArray) n += Math.floor(names.size() / 2);
  const kids = ctx.lookup(d.get(N("Kids")));
  if (kids instanceof PDFArray) for (const k of kids.asArray()) n += countNameTree(ctx, k, seen, depth + 1);
  return n;
}

/** P1：Info 辞書を外す。値のあった欄の数を返す */
export function removeDocInfo(doc: PDFDocument): RemovedItem[] {
  const ctx = doc.context;
  const info = dictOf(ctx, ctx.trailerInfo.Info);
  if (ctx.trailerInfo.Info === undefined) return [];
  let fields = 0;
  if (info) for (const [, v] of info.entries()) if (hasValue(ctx, v)) fields++;
  ctx.trailerInfo.Info = undefined;
  return fields > 0
    ? [{ pattern: "P1", kind: "docinfo", count: fields, label: `文書のプロパティ（作成者・タイトル・作成ソフトなど）の欄（${fields} 個）を消しました` }]
    : [];
}

/** すべての辞書を1回ずつ見る（文書の根から。参照の輪は1回だけ） */
function walkDicts(ctx: PDFContext, from: PDFObject[], visit: (d: PDFDict) => void) {
  const seen = new Set<PDFObject>();
  const stack: PDFObject[] = [...from];
  while (stack.length) {
    const o = stack.pop()!;
    const v = o instanceof PDFRef ? ctx.lookup(o) : o;
    if (!v || seen.has(v)) continue;
    seen.add(v);
    if (v instanceof PDFDict) {
      visit(v);
      for (const [, x] of v.entries()) stack.push(x);
    } else if (v instanceof PDFStream) {
      visit(v.dict);
      for (const [, x] of v.dict.entries()) stack.push(x);
    } else if (v instanceof PDFArray) {
      for (const x of v.asArray()) stack.push(x);
    }
  }
}

const rootRefs = (ctx: PDFContext): PDFObject[] => (ctx.trailerInfo.Root ? [ctx.trailerInfo.Root] : []);

/** P2：/Metadata を外す */
export function removeXmp(ctx: PDFContext): RemovedItem[] {
  let n = 0;
  walkDicts(ctx, rootRefs(ctx), (d) => {
    if (d.has(N("Metadata"))) {
      d.delete(N("Metadata"));
      n++;
    }
  });
  return n > 0 ? [{ pattern: "P2", kind: "xmp", count: n, label: `XMP メタデータ（${n} か所）を消しました` }] : [];
}

const isJsAction = (ctx: PDFContext, o: PDFObject | undefined) => {
  const d = dictOf(ctx, o);
  return !!d && nameOf(ctx, d.get(N("S"))) === "JavaScript";
};

/** P12：JavaScript を外す */
export function removeJavaScript(ctx: PDFContext): RemovedItem[] {
  let n = 0;
  const catalog = dictOf(ctx, ctx.trailerInfo.Root);
  const names = catalog ? dictOf(ctx, catalog.get(N("Names"))) : undefined;
  if (names?.has(N("JavaScript"))) {
    n += Math.max(1, countNameTree(ctx, names.get(N("JavaScript"))));
    names.delete(N("JavaScript"));
  }
  walkDicts(ctx, rootRefs(ctx), (d) => {
    for (const key of ["OpenAction", "A"]) {
      if (isJsAction(ctx, d.get(N(key)))) {
        d.delete(N(key));
        n++;
      }
    }
    // 動作の続き（/Next）の中の JavaScript
    const next = d.get(N("Next"));
    if (next !== undefined) {
      if (isJsAction(ctx, next)) {
        d.delete(N("Next"));
        n++;
      } else {
        const arr = ctx.lookup(next);
        if (arr instanceof PDFArray) {
          for (let i = arr.size() - 1; i >= 0; i--) if (isJsAction(ctx, arr.get(i))) {
            arr.remove(i);
            n++;
          }
        }
      }
    }
    // 追加の動作（/AA：ページを開いたとき・欄を変えたときなど）の中の JavaScript
    const aa = dictOf(ctx, d.get(N("AA")));
    if (aa) {
      for (const [k, v] of aa.entries()) if (isJsAction(ctx, v)) {
        aa.delete(k);
        n++;
      }
      if (aa.entries().length === 0) d.delete(N("AA"));
    }
  });
  return n > 0 ? [{ pattern: "P12", kind: "javascript", count: n, label: `JavaScript（${n} か所）を外しました` }] : [];
}

/** P9：添付ファイルを外す（中身のストリームは、最後の掃除でファイルから消える） */
export function removeAttachments(doc: PDFDocument): RemovedItem[] {
  const ctx = doc.context;
  let files = 0;
  const catalog = doc.catalog;
  const names = dictOf(ctx, catalog.get(N("Names")));
  if (names?.has(N("EmbeddedFiles"))) {
    files += countNameTree(ctx, names.get(N("EmbeddedFiles")));
    names.delete(N("EmbeddedFiles"));
  }
  if (catalog.has(N("Collection"))) catalog.delete(N("Collection"));
  // 関連ファイル（/AF）は、どの辞書にも付けられる
  walkDicts(ctx, rootRefs(ctx), (d) => {
    const af = ctx.lookup(d.get(N("AF")));
    if (af !== undefined) {
      if (af instanceof PDFArray) files += af.size();
      else files++;
      d.delete(N("AF"));
    }
  });
  // 添付ファイルの注釈は、注釈ごと外す
  doc.getPages().forEach((page) => {
    const annots = ctx.lookup(page.node.get(N("Annots")));
    if (!(annots instanceof PDFArray)) return;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = dictOf(ctx, annots.get(i));
      if (a && nameOf(ctx, a.get(N("Subtype"))) === "FileAttachment") {
        annots.remove(i);
        files++;
      }
    }
  });
  return files > 0 ? [{ pattern: "P9", kind: "attachment", count: files, label: `添付ファイル（${files} 個）を、中身ごと消しました` }] : [];
}

/** 注釈の中で、作者名（/T）を消してよい種類（フォームの欄・リンクは /T の意味が違うので除く） */
const NOT_MARKUP = new Set(["Widget", "Link", "Popup"]);

/** P8：注釈のコメント・作者名を消し、吹き出しを外す。墨消し注釈（適用したもの）もここで外す */
export function cleanAnnotations(doc: PDFDocument, redactAnnots: Set<PDFObject>): RemovedItem[] {
  const ctx = doc.context;
  const out: RemovedItem[] = [];
  doc.getPages().forEach((page, index) => {
    const annots = ctx.lookup(page.node.get(N("Annots")));
    if (!(annots instanceof PDFArray)) return;
    let contents = 0;
    let popups = 0;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const ref = annots.get(i);
      const a = dictOf(ctx, ref);
      if (!a) continue;
      if (redactAnnots.has(ref) || redactAnnots.has(a)) {
        annots.remove(i);
        continue;
      }
      const subtype = nameOf(ctx, a.get(N("Subtype"))) ?? "";
      if (subtype === "Popup") {
        annots.remove(i);
        popups++;
        continue;
      }
      let had = false;
      for (const key of ["Contents", "RC"]) if (a.has(N(key))) {
        if (hasValue(ctx, a.get(N(key)))) had = true;
        a.delete(N(key));
      }
      if (!NOT_MARKUP.has(subtype)) {
        for (const key of ["T", "Subj", "M", "CreationDate"]) if (a.has(N(key))) {
          if (key === "T" && hasValue(ctx, a.get(N(key)))) had = true;
          a.delete(N(key));
        }
      }
      if (a.has(N("Popup"))) a.delete(N("Popup"));
      if (had) contents++;
    }
    if (annots.size() === 0) page.node.delete(N("Annots"));
    if (contents) out.push({ pattern: "P8", kind: "annotation_content", page: index + 1, count: contents, label: `注釈のコメント・作者名（${contents} 個の注釈）を消しました（注釈の見た目は残しています）` });
    if (popups) out.push({ pattern: "P8", kind: "popup", page: index + 1, count: popups, label: `コメントの吹き出し（${popups} 個）を外しました` });
  });
  return out;
}

/** 文書の根からたどれないオブジェクトを捨てる。捨てた数を返す */
export function dropUnreachable(ctx: PDFContext): number {
  const reached = new Set<string>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo;
  for (const o of [t.Root, t.Info, t.Encrypt]) if (o) stack.push(o);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (reached.has(o.tag)) continue;
      reached.add(o.tag);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, x] of o.entries()) stack.push(x);
    } else if (o instanceof PDFStream) {
      for (const [, x] of o.dict.entries()) stack.push(x);
    } else if (o instanceof PDFArray) {
      for (const x of o.asArray()) stack.push(x);
    }
  }
  let dropped = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reached.has(ref.tag)) {
      ctx.delete(ref);
      dropped++;
    }
  }
  return dropped;
}

/** 元のファイルの版の数（%%EOF の数の目安。xref の /Prev の数と合わないこともある） */
export function countRevisions(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 5 <= bytes.length; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x25 && bytes[i + 2] === 0x45 && bytes[i + 3] === 0x4f && bytes[i + 4] === 0x46) n++;
  }
  return n;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P9（添付ファイル）。
// ファイルの中に残っている添付ファイルの中身（ファイル指定の /EF が指すストリーム）を見つける。
// 1件 ＝ 中身のストリーム1つ（rubric/p9.md §2）。同じ中身を2つの場所が指していても1件にまとめ、場所は
// names（名前の木）→ annotation（ページの添付ファイルの注釈）→ af（文書・ページの /AF）→ unreferenced（どこからも指されていない）の順で先のものにする。
// ファイル名そのものは返さず、字数と拡張子だけを返す（ファイル名に個人名が入ることがあるため）。

import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject,
} from "pdf-lib";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { loadPdf } from "../shared/load.ts";

export const RULE_ID = "p9-attach";
export const RULE_VERSION = "1.0.0";

export type P9Where = "names" | "annotation" | "af" | "unreferenced";
const ORDER: P9Where[] = ["names", "annotation", "af", "unreferenced"];

/** 上限。超えたら、そこから先はたどらず、limits に出す（固まらないため） */
export const LIMITS = { nameTreeNodes: 10_000, depth: 32, pages: 10_000 } as const;

export type P9AttachFinding = {
  pattern: "P9";
  where: P9Where;
  /** where が annotation か、ページの /AF のとき：ページ番号 */
  page?: number;
  /** 中身のストリームのオブジェクト番号 */
  object: number;
  /** 同じ中身を、ほかに指している場所 */
  also: Array<Exclude<P9Where, "unreferenced">>;
  /** ファイル名の字数（名前が分からなければ 0） */
  nameChars: number;
  /** ファイル名の拡張子（小文字。なければ null） */
  ext: string | null;
  /** 中身の大きさ（バイト）。/Params の /Size。なければ、圧縮していない中身の長さ。分からなければ null */
  size: number | null;
  /** 中身のストリームの /Subtype（MIME の種類） */
  subtype: string | null;
  /** includeNames のときだけ。ファイル名そのもの。記録やログには使わない */
  name?: string;
};

export type P9AttachReport = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: { code: "empty" | "unreadable" | "encrypted"; message: string };
  pages: number | null;
  findings: P9AttachFinding[];
  /** 中身のない（外のファイルを指すだけの）ファイル指定の数。漏れではない（参考） */
  externalRefs: number;
  /** 上限に当たって、たどるのをやめた所。空でなければ、見落としがありうる（「問題なし」ではない） */
  limits: Array<"name_tree_nodes" | "depth" | "pages">;
  /** パスワードなしで開ける暗号化 PDF を、復号して調べたときだけ */
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { includeNames?: boolean };

const N = (s: string) => PDFName.of(s);
const K = {
  Names: N("Names"),
  EmbeddedFiles: N("EmbeddedFiles"),
  Kids: N("Kids"),
  Annots: N("Annots"),
  Subtype: N("Subtype"),
  FileAttachment: N("FileAttachment"),
  FS: N("FS"),
  AF: N("AF"),
  EF: N("EF"),
  UF: N("UF"),
  F: N("F"),
  Type: N("Type"),
  EmbeddedFile: N("EmbeddedFile"),
  Params: N("Params"),
  Size: N("Size"),
  Filter: N("Filter"),
};

/** 文字の値を読む。UTF-16BE・UTF-16LE・UTF-8（BOM つき）と PDFDocEncoding（pdf-lib の decodeText） */
function text(obj: PDFObject | undefined): string | null {
  if (!(obj instanceof PDFString || obj instanceof PDFHexString)) return null;
  const b = obj.asBytes();
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
  return obj.decodeText();
}

export function extensionOf(name: string): string | null {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? m[1]!.toLowerCase() : null;
}

type Content = {
  ref: PDFRef;
  places: Map<P9Where, number | undefined>; // 場所 → ページ番号
  name: string | null;
};

class Collector {
  readonly contents = new Map<string, Content>();
  externalRefs = 0;
  readonly limits = new Set<P9AttachReport["limits"][number]>();
  /** ファイル指定ごとに、外のファイルだけの指定を1回だけ数える */
  private readonly seenExternal = new Set<PDFObject>();

  private readonly context: PDFContext;

  constructor(context: PDFContext) {
    this.context = context; // Node の型を外すだけの実行で動くように、引数のプロパティの書き方は使わない
  }

  lookup(obj: PDFObject | undefined): PDFObject | undefined {
    return obj instanceof PDFRef ? this.context.lookup(obj) : obj;
  }

  /** ファイル指定（辞書）から、中身のストリームを集める。where が null なら、場所はつけない（あとで unreferenced にする） */
  fileSpec(raw: PDFObject | undefined, where: P9Where, page?: number, fallbackName?: string | null) {
    const spec = this.lookup(raw);
    if (!(spec instanceof PDFDict)) {
      // 文字だけのファイル指定は、外のファイルを指すだけ
      if (spec instanceof PDFString || spec instanceof PDFHexString) this.countExternal(spec);
      return;
    }
    const name = text(this.lookup(spec.get(K.UF))) ?? text(this.lookup(spec.get(K.F))) ?? fallbackName ?? null;
    const ef = this.lookup(spec.get(K.EF));
    let found = 0;
    if (ef instanceof PDFDict) {
      for (const [, v] of ef.entries()) {
        if (!(v instanceof PDFRef)) continue; // ストリームは必ず間接オブジェクト
        if (!(this.context.lookup(v) instanceof PDFStream)) continue;
        this.add(v, where, page, name);
        found++;
      }
    }
    if (found === 0) this.countExternal(spec);
  }

  private countExternal(spec: PDFObject) {
    if (this.seenExternal.has(spec)) return;
    this.seenExternal.add(spec);
    this.externalRefs++;
  }

  add(ref: PDFRef, where: P9Where, page: number | undefined, name: string | null) {
    const key = ref.tag;
    let c = this.contents.get(key);
    if (!c) {
      c = { ref, places: new Map(), name };
      this.contents.set(key, c);
    }
    if (!c.places.has(where)) c.places.set(where, page);
    if (!c.name && name) c.name = name;
  }

  /** 名前の木（/Kids の入れ子も）。輪になった木は、同じ節を2回たどらない */
  nameTree(root: PDFObject | undefined) {
    const seen = new Set<PDFObject>();
    const stack: Array<{ node: PDFObject | undefined; depth: number }> = [{ node: root, depth: 0 }];
    let count = 0;
    while (stack.length) {
      const { node: raw, depth } = stack.pop()!;
      const node = this.lookup(raw);
      if (!(node instanceof PDFDict) || seen.has(node)) continue;
      seen.add(node);
      if (++count > LIMITS.nameTreeNodes) {
        this.limits.add("name_tree_nodes");
        return;
      }
      const names = this.lookup(node.get(K.Names));
      if (names instanceof PDFArray) {
        for (let i = 0; i + 1 < names.size(); i += 2) this.fileSpec(names.get(i + 1), "names", undefined, text(this.lookup(names.get(i))));
      }
      const kids = this.lookup(node.get(K.Kids));
      if (kids instanceof PDFArray) {
        if (depth + 1 > LIMITS.depth) {
          this.limits.add("depth");
          continue;
        }
        for (let i = kids.size() - 1; i >= 0; i--) stack.push({ node: kids.get(i), depth: depth + 1 });
      }
    }
  }

  af(raw: PDFObject | undefined, page?: number) {
    const arr = this.lookup(raw);
    if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i++) this.fileSpec(arr.get(i), "af", page);
    else if (arr instanceof PDFDict) this.fileSpec(arr, "af", page);
  }

  /**
   * どこからも指されていない中身：すべての間接オブジェクトを見て、
   * (1) ファイル指定（/EF を持つ辞書。間接オブジェクトの中に直接書かれたものも）の中身と、
   * (2) /Type /EmbeddedFile のストリームを集める。すでに場所のあるものは、add の中で場所が増えないだけ。
   */
  unreferenced() {
    for (const [ref, obj] of this.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFStream) {
        if (obj.dict.get(K.Type) === K.EmbeddedFile && !this.contents.has(ref.tag)) this.add(ref, "unreferenced", undefined, null);
        continue;
      }
      this.findSpecs(obj, 0);
    }
  }

  private findSpecs(obj: PDFObject, depth: number) {
    if (depth > LIMITS.depth) return;
    if (obj instanceof PDFDict) {
      if (obj.get(K.EF) !== undefined) {
        const before = this.externalRefs;
        this.fileSpec(obj, "unreferenced");
        this.externalRefs = before; // ここでは外のファイルの指定を数えない（場所のあるものだけ数える）
      }
      for (const [, v] of obj.entries()) if (!(v instanceof PDFRef)) this.findSpecs(v, depth + 1);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const v = obj.get(i);
        if (!(v instanceof PDFRef)) this.findSpecs(v, depth + 1);
      }
    }
  }
}

function sizeOf(stream: PDFObject | undefined, c: Collector): number | null {
  if (!(stream instanceof PDFStream)) return null;
  const params = c.lookup(stream.dict.get(K.Params));
  if (params instanceof PDFDict) {
    const s = c.lookup(params.get(K.Size));
    if (s instanceof PDFNumber) return s.asNumber();
  }
  if (stream instanceof PDFRawStream && stream.dict.get(K.Filter) === undefined) return stream.contents.length;
  return null;
}

function subtypeOf(stream: PDFObject | undefined): string | null {
  if (!(stream instanceof PDFStream)) return null;
  const s = stream.dict.get(K.Subtype);
  return s instanceof PDFName ? s.decodeText() : null;
}

export async function detectP9Attach(bytes: Uint8Array, options: DetectOptions = {}): Promise<P9AttachReport> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, pages: null, findings: [], externalRefs: 0, limits: [] };
  if (bytes.length === 0) return { ...base, status: "error", error: { code: "empty", message: "ファイルが空です。" } };

  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") {
    if (loaded.code === "encrypted") {
      const message =
        loaded.reason === "password_required" ? "パスワードが要る PDF は、調べられません。" : "この形の暗号化は、いまは調べられません。";
      return { ...base, status: "error", error: { code: "encrypted", message } };
    }
    return { ...base, status: "error", error: { code: "unreadable", message: "PDF として読めませんでした。" } };
  }
  const doc = loaded.doc;
  const c = new Collector(doc.context);

  let pages;
  try {
    // 1. 名前の木
    const catalog = doc.catalog;
    const names = c.lookup(catalog.get(K.Names));
    if (names instanceof PDFDict) c.nameTree(names.get(K.EmbeddedFiles));
    // 2. ページの添付ファイルの注釈と、3. 文書・ページの /AF
    c.af(catalog.get(K.AF));
    pages = doc.getPages();
  } catch {
    return { ...base, status: "error", error: { code: "unreadable", message: "文書の根やページの並びを読めませんでした。" } };
  }
  if (pages.length > LIMITS.pages) c.limits.add("pages");
  pages.slice(0, LIMITS.pages).forEach((page, i) => {
    const pageNo = i + 1;
    const annots = c.lookup(page.node.get(K.Annots));
    if (annots instanceof PDFArray) {
      for (let j = 0; j < annots.size(); j++) {
        const a = c.lookup(annots.get(j));
        if (a instanceof PDFDict && a.get(K.Subtype) === K.FileAttachment) c.fileSpec(a.get(K.FS), "annotation", pageNo);
      }
    }
    c.af(page.node.get(K.AF), pageNo);
  });
  // 4. どこからも指されていない中身
  c.unreferenced();

  const report: P9AttachReport = {
    ...base,
    status: "ok",
    pages: pages.length,
    findings: [],
    externalRefs: c.externalRefs,
    limits: [...c.limits],
  };
  if (loaded.decrypted) report.decrypted = loaded.decrypted;

  for (const content of c.contents.values()) {
    const where = ORDER.find((w) => content.places.has(w))!;
    const stream = doc.context.lookup(content.ref);
    const name = content.name ?? "";
    const f: P9AttachFinding = {
      pattern: "P9",
      where,
      object: content.ref.objectNumber,
      also: ORDER.filter((w): w is Exclude<P9Where, "unreferenced"> => w !== where && w !== "unreferenced" && content.places.has(w)),
      nameChars: [...name.trim()].length,
      ext: extensionOf(name),
      size: sizeOf(stream, c),
      subtype: subtypeOf(stream),
    };
    const page = content.places.get(where);
    if (page !== undefined) f.page = page;
    if (options.includeNames && content.name) f.name = content.name;
    report.findings.push(f);
  }
  report.findings.sort((a, b) => ORDER.indexOf(a.where) - ORDER.indexOf(b.where) || a.object - b.object);
  return report;
}

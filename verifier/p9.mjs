// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器：P9（添付ファイル）。PDF のバイト列を入れると、ファイルの中に残っている添付ファイル（埋め込まれた別のファイル）を返す。
//
// 検査器から独立させるため、pdf-lib は使わない（検出ルールは pdf-lib で書く予定）。
// 1. 主の読み方：バイト列を自分で読み（p9-pdfbytes.mjs）、いまの版の xref が指すオブジェクトから、
//    - 名前の木（/Names の /EmbeddedFiles。/Kids の入れ子も）
//    - ページの添付ファイルの注釈（/FileAttachment）
//    - 関連ファイル（文書・ページの /AF）
//    をたどって、中身のストリーム（/EF）を集める。どこからもたどれない中身のストリーム（/Type /EmbeddedFile）も「指されていない」として集める。
// 2. 突き合わせ：PDF.js（pdfjs-dist）の getAttachments と、ページの注釈（getAnnotations）でも読み、ファイル名の食い違いを cross_check に出す。
// 1件 ＝ 中身のストリーム1つ。ファイル名は既定では出さない（字数と拡張子だけ）。includeNames のときだけ出す（記録やログには使わない）。

import { createHash } from "node:crypto";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { LIMITS, ParseError, decodeTextString, latin1, makeResolver, readXref, streamData } from "./p9-pdfbytes.mjs";

export const VERIFIER = { name: "omamori-verifier-p9", version: "0.1.0" };
export { LIMITS };

const MAX_TREE_NODES = 10_000;
const MAX_PAGES = 10_000;

function extOf(name) {
  if (!name) return null;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : null;
}

function readFromBytes(buf) {
  const { table, trailers } = readXref(buf);
  const trailer = trailers[0];
  if (trailer.v.get("Encrypt")) return { encrypted: true };
  const { resolve, resolveFull } = makeResolver(buf, table);
  const deref = (v) => (v?.t === "ref" ? resolve(v.v) : v);

  /** 中身のストリームの番号 → 見つけた場所の一覧 */
  const found = new Map();
  const add = (streamNum, where, name, page) => {
    const list = found.get(streamNum) ?? [];
    list.push({ where, name, page });
    found.set(streamNum, list);
  };

  const nameOfFilespec = (fs, fallback) => {
    for (const k of ["UF", "F", "Unix", "DOS", "Mac"]) {
      const v = deref(fs.v.get(k));
      if (v?.t === "str") return decodeTextString(v.v);
    }
    return fallback ?? null;
  };

  /** ファイル指定（/Filespec）から、中身のストリームの番号を出す。/EF がなければ（外のファイルを指すだけなら）なし */
  const visitFilespec = (fsVal, where, fallbackName, page) => {
    const fs = deref(fsVal);
    if (fs?.t !== "dict") return;
    const ef = deref(fs.v.get("EF"));
    if (ef?.t !== "dict") return;
    const seenHere = new Set();
    for (const k of ["F", "UF", "DOS", "Mac", "Unix"]) {
      const r = ef.v.get(k);
      if (r?.t === "ref" && !seenHere.has(r.v[0])) {
        seenHere.add(r.v[0]);
        add(r.v[0], where, nameOfFilespec(fs, fallbackName), page);
      }
    }
  };

  const root = deref(trailer.v.get("Root"));
  if (root?.t !== "dict") throw new ParseError("文書の根（/Root）が読めない");

  // 1. 名前の木
  let nodes = 0;
  const walkTree = (nodeVal, depth, seen) => {
    if (depth > LIMITS.maxDepth || ++nodes > MAX_TREE_NODES) throw new ParseError("名前の木が深すぎる・大きすぎる");
    if (nodeVal?.t === "ref") {
      if (seen.has(nodeVal.v[0])) return; // 輪になった木
      seen = new Set(seen).add(nodeVal.v[0]);
    }
    const node = deref(nodeVal);
    if (node?.t !== "dict") return;
    const names = deref(node.v.get("Names"));
    if (names?.t === "array") {
      for (let i = 0; i + 1 < names.v.length; i += 2) {
        const key = deref(names.v[i]);
        visitFilespec(names.v[i + 1], "names", key?.t === "str" ? decodeTextString(key.v) : null, null);
      }
    }
    const kids = deref(node.v.get("Kids"));
    if (kids?.t === "array") for (const k of kids.v) walkTree(k, depth + 1, seen);
  };
  const namesDict = deref(root.v.get("Names"));
  if (namesDict?.t === "dict" && namesDict.v.get("EmbeddedFiles")) walkTree(namesDict.v.get("EmbeddedFiles"), 0, new Set());

  // 3. 関連ファイル（文書の /AF）
  const visitAF = (afVal, page) => {
    const af = deref(afVal);
    if (af?.t === "array") for (const fs of af.v) visitFilespec(fs, "af", null, page);
  };
  visitAF(root.v.get("AF"), null);

  // 2. ページの注釈と、ページの /AF
  let pageNo = 0;
  const walkPages = (nodeVal, depth, seen) => {
    if (depth > LIMITS.maxDepth || pageNo > MAX_PAGES) throw new ParseError("ページの木が深すぎる・大きすぎる");
    if (nodeVal?.t === "ref") {
      if (seen.has(nodeVal.v[0])) return;
      seen = new Set(seen).add(nodeVal.v[0]);
    }
    const node = deref(nodeVal);
    if (node?.t !== "dict") return;
    const kids = deref(node.v.get("Kids"));
    if (node.v.get("Type")?.v === "Pages" || kids?.t === "array") {
      if (kids?.t === "array") for (const k of kids.v) walkPages(k, depth + 1, seen);
      return;
    }
    pageNo++;
    visitAF(node.v.get("AF"), pageNo);
    const annots = deref(node.v.get("Annots"));
    if (annots?.t !== "array") return;
    for (const a of annots.v) {
      const ad = deref(a);
      if (ad?.t !== "dict") continue;
      if (ad.v.get("Subtype")?.v === "FileAttachment") visitFilespec(ad.v.get("FS"), "annotation", null, pageNo);
    }
  };
  walkPages(root.v.get("Pages"), 0, new Set());

  // 4. どこからもたどれない中身のストリーム（/Type /EmbeddedFile）
  //    名前を探すため、ファイル指定（/EF を持つ辞書）も集めておく
  const filespecNames = new Map();
  let count = 0;
  const unreferenced = [];
  for (const [num, loc] of table) {
    if (loc.kind === "free") continue;
    if (++count > LIMITS.maxObjects) throw new ParseError("オブジェクトが多すぎる");
    let full;
    try {
      full = resolveFull(num);
    } catch {
      continue; // 読めないオブジェクトは飛ばす（ほかの所は読む）
    }
    const v = full.value;
    if (v?.t !== "dict") continue;
    if (full.stream && v.v.get("Type")?.v === "EmbeddedFile" && !found.has(num)) unreferenced.push(num);
    const ef = v.v.get("EF");
    const efd = ef?.t === "ref" ? deref(ef) : ef;
    if (efd?.t === "dict") {
      for (const r of efd.v.values()) if (r?.t === "ref") filespecNames.set(r.v[0], nameOfFilespec(v, null));
    }
  }
  for (const num of unreferenced) add(num, "unreferenced", filespecNames.get(num) ?? null, null);

  // 中身の大きさと種類
  const items = [];
  for (const [num, places] of [...found].sort((a, b) => a[0] - b[0])) {
    let size = null;
    let subtype = null;
    try {
      const full = resolveFull(num);
      if (full.value?.t === "dict") {
        const st = full.value.v.get("Subtype");
        subtype = st?.t === "name" ? st.v : null;
        const params = deref(full.value.v.get("Params"));
        const ps = params?.t === "dict" ? deref(params.v.get("Size")) : null;
        if (full.stream) {
          try {
            size = streamData(full.value.v, full.stream).length;
          } catch {
            size = ps?.t === "num" ? ps.v : full.stream.length;
          }
        }
      }
    } catch {
      // 中身が読めなくても、指されていることは残す
    }
    // 名前の木・注釈・/AF が同じ中身を指すとき（pdf-lib の attach は名前の木と /AF の両方に入れる）、1件にまとめる
    const order = ["names", "annotation", "af", "unreferenced"];
    places.sort((a, b) => order.indexOf(a.where) - order.indexOf(b.where));
    const first = places[0];
    const name = places.find((p) => p.name)?.name ?? null;
    items.push({
      object: num,
      where: first.where,
      page: first.page,
      also: [...new Set(places.slice(1).map((p) => p.where))].filter((w) => w !== first.where),
      name,
      size,
      subtype,
    });
  }
  return { items, pages: pageNo, revisions: trailers.length };
}

async function readWithPdfjs(buf) {
  let task;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    const doc = await task.promise;
    // pdfjs-dist 6.4.299：getAttachments は Map（名前の木の鍵 → { filename など }）を返し、中身は持たない。
    // 中身があるか（/EF があるか）は getAttachmentContent(id) で確かめる（id は、名前の木の鍵か、注釈の fileId）
    const names = [];
    const atts = (await doc.getAttachments()) ?? new Map();
    const entries = atts instanceof Map ? [...atts.entries()] : Object.entries(atts);
    const hasContent = async (id) => {
      try {
        const c = await doc.getAttachmentContent(id);
        return c != null;
      } catch {
        return false;
      }
    };
    for (const [id, a] of entries) if (await hasContent(id)) names.push({ where: "names", name: a?.filename ?? "" });
    for (let p = 1; p <= Math.min(doc.numPages, MAX_PAGES); p++) {
      const page = await doc.getPage(p);
      for (const an of await page.getAnnotations({ intent: "display" })) {
        if (an.annotationType !== pdfjs.AnnotationType.FILEATTACHMENT || !an.file) continue;
        if (an.fileId !== undefined && (await hasContent(an.fileId))) names.push({ where: "annotation", page: p, name: an.file.filename ?? "" });
      }
    }
    return { ok: true, names };
  } catch (e) {
    return { ok: false, encrypted: e?.name === "PasswordException" };
  } finally {
    await task?.destroy().catch(() => {});
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error("timeout")), ms);
    }),
  ]);
}

/**
 * PDF のバイト列 → 結果（形は p9-schema.json）
 * @param {Uint8Array} bytes
 * @param {{ includeNames?: boolean }} [options]
 */
export async function verifyP9(bytes, options = {}) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = {
    verifier: VERIFIER,
    checked: ["P9"],
    input: { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex"), pages: null },
    status: "ok",
    items: [],
    revisions: 0,
    cross_check: { only_bytes: 0, only_pdfjs: 0 },
  };
  const fail = (code, message) => ({ ...result, status: "error", error: { code, message }, items: [] });
  if (buf.byteLength === 0) return fail("empty", "ファイルが空です");
  if (buf.byteLength > LIMITS.maxBytes) return fail("too_large", "ファイルが大きすぎます");
  if (latin1(buf.subarray(0, 1024)).indexOf("%PDF-") < 0) return fail("unreadable", "PDF として読めません");

  let fromBytes;
  try {
    fromBytes = readFromBytes(buf);
  } catch (e) {
    if (e instanceof ParseError && /深すぎる|大きすぎる|多すぎる/.test(e.message)) return fail("too_deep", "入れ子が深すぎる・大きすぎるため、読みませんでした");
    // バイト列で読めない PDF は、0 件と数えない（PDF.js で読めても、指されていない添付を確かめられないため）
    return fail("unreadable", "PDF として読めません");
  }
  if (fromBytes.encrypted) return fail("encrypted", "暗号化されていて読めません");
  result.input.pages = fromBytes.pages;
  result.revisions = fromBytes.revisions;

  let fromPdfjs;
  try {
    fromPdfjs = await withTimeout(readWithPdfjs(buf), LIMITS.timeoutMs);
  } catch {
    return fail("timeout", "時間内に読み終わりませんでした");
  }

  for (const it of fromBytes.items) {
    const item = {
      pattern: "P9",
      where: it.where,
      object: it.object,
      also: it.also,
      name_chars: it.name ? [...it.name].length : 0,
      ext: extOf(it.name),
      size: it.size,
      subtype: it.subtype,
    };
    if (it.page) item.page = it.page;
    if (options.includeNames) item.name = it.name ?? "";
    result.items.push(item);
  }

  // 突き合わせ（名前の木・注釈のファイル名の数）。PDF.js は指されていない添付と /AF だけのものは返さない
  if (fromPdfjs.ok) {
    const key = (w, n) => `${w}\u0000${n}`;
    // 同じ中身を名前の木と注釈の両方が指すとき、items では1件にまとめるが、PDF.js は場所ごとに返すので、場所ごとに並べて比べる
    const bytesSide = fromBytes.items.flatMap((i) =>
      [i.where, ...i.also].filter((w) => w === "names" || w === "annotation").map((w) => key(w, i.name ?? "")),
    );
    const pdfjsSide = fromPdfjs.names.map((n) => key(n.where, n.name));
    const rest = [...pdfjsSide];
    for (const b of bytesSide) {
      const k = rest.indexOf(b);
      if (k >= 0) rest.splice(k, 1);
      else result.cross_check.only_bytes++;
    }
    result.cross_check.only_pdfjs = rest.length;
  } else result.cross_check.pdfjs_unreadable = true;
  return result;
}

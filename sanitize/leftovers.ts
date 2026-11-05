// SPDX-License-Identifier: AGPL-3.0-only
//
// 文書全体の、見つけているのに片付けていなかったもの（0.7.0 から。見ないで作るテスト集の「片付け後の残り」）。
// - P12 外の動作：外のプログラムを起動する動作（Launch）、手元のファイルを読む動作（ImportData）、
//   手元・社内のファイルを指す URI（file:・smb:・\\サーバー）・ほかのファイルへ移る動作（GoToR・GoToE の行き先が手元の場所）を外す
// - P10 写真の情報：JPEG の画像の中の Exif（位置・機種・撮影者・日時・縮小画像）・XMP・IPTC・コメントを外す（画素は書き直さない）
// - P7 しおり（/Outlines）：題に、本文にない名前などが入っていることがあるので、しおりを丸ごと外す（2026-11-05 人が決めた）
// - P7 構造要素の題（/T）・P11 欄の書き出し用の名前（/TM）を外す。読み上げ用の説明（/Alt・/E・/TU）は消さず、notDone にする（同じ日に人が決めた）
// - P11 フォームの値：見えない欄（見た目のない欄・隠した見た目の欄）の値を消す。見えている欄の値は notDone にする（同じ日に人が決めた）
//
// 取り出した中身（名前・パス・値）は、結果に入れない。数だけを返す。

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, type PDFContext, type PDFDocument, type PDFObject } from "pdf-lib";
import { dictOf, hasValue, nameOf, rootRefs, walkDicts } from "./structure.ts";
import type { NotDoneItem, RemovedItem } from "./types.ts";

const N = (s: string) => PDFName.of(s);

function textOf(ctx: PDFContext, o: PDFObject | undefined): string | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return null;
}

// ---------------------------------------------------------------- P12 外の動作

/** 手元・社内の場所を指す文字列か（file:、smb: など、\\サーバー・\ で始まる道、C:\、/ で始まる絶対の道） */
export function isLocalPlace(s: string): boolean {
  const t = s.trim();
  return /^(file|smb|afp|nfs|cifs):/i.test(t) || /^\\/.test(t) || /^[a-zA-Z]:[\\/]/.test(t) || /^\//.test(t);
}

/** ファイルの指定（文字列か、/F・/UF・/DOS・/Unix・/Mac を持つ辞書）の中に、手元・社内の場所があるか */
function fileSpecIsLocal(ctx: PDFContext, o: PDFObject | undefined): boolean {
  const s = textOf(ctx, o);
  if (s !== null) return isLocalPlace(s);
  const d = dictOf(ctx, o);
  if (!d) return false;
  return ["F", "UF", "DOS", "Unix", "Mac"].some((k) => {
    const v = textOf(ctx, d.get(N(k)));
    return v !== null && isLocalPlace(v);
  });
}

/** 外す動作か */
function isExternalAction(ctx: PDFContext, o: PDFObject | undefined): boolean {
  const d = dictOf(ctx, o);
  if (!d) return false;
  const s = nameOf(ctx, d.get(N("S")));
  if (s === "Launch" || s === "ImportData") return true;
  if (s === "URI") {
    const uri = textOf(ctx, d.get(N("URI")));
    return uri !== null && isLocalPlace(uri);
  }
  if (s === "GoToR" || s === "GoToE") return fileSpecIsLocal(ctx, d.get(N("F")));
  return false;
}

/** P12：外のプログラム・手元のファイルを開く動作を外す（/OpenAction・/A・/AA・/Next の中） */
export function removeExternalActions(ctx: PDFContext): RemovedItem[] {
  let n = 0;
  walkDicts(ctx, rootRefs(ctx), (d) => {
    for (const key of ["OpenAction", "A"]) {
      if (isExternalAction(ctx, d.get(N(key)))) {
        d.delete(N(key));
        n++;
      }
    }
    const next = d.get(N("Next"));
    if (next !== undefined) {
      if (isExternalAction(ctx, next)) {
        d.delete(N("Next"));
        n++;
      } else {
        const arr = ctx.lookup(next);
        if (arr instanceof PDFArray) {
          for (let i = arr.size() - 1; i >= 0; i--) if (isExternalAction(ctx, arr.get(i))) {
            arr.remove(i);
            n++;
          }
        }
      }
    }
    const aa = dictOf(ctx, d.get(N("AA")));
    if (aa) {
      for (const [k, v] of aa.entries()) if (isExternalAction(ctx, v)) {
        aa.delete(k);
        n++;
      }
      if (aa.entries().length === 0) d.delete(N("AA"));
    }
  });
  return n > 0
    ? [{ pattern: "P12", kind: "external_action", count: n, label: `外のプログラム・手元や社内のファイルを開く動作（${n} か所）を外しました` }]
    : [];
}

// ---------------------------------------------------------------- P10 写真の情報

const enc = new TextEncoder();
const startsWith = (b: Uint8Array, at: number, s: string) => {
  const t = enc.encode(s);
  for (let i = 0; i < t.length; i++) if (b[at + i] !== t[i]) return false;
  return true;
};

/**
 * JPEG のバイト列から、写真の情報の区切り（APP1：Exif・XMP、APP2 のうち ICC 以外、APP3〜APP13・APP15、COM）を外す。
 * 色に要る APP0（JFIF。縮小画像は外す）・APP2 の ICC・APP14（Adobe）と、画素の区切りはそのまま。変わらなければ null
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let changed = false;
  while (i < b.length) {
    if (b[i] !== 0xff) return null; // 読めない形：触らない
    let j = i;
    while (j < b.length && b[j] === 0xff) j++;
    if (j >= b.length) return null;
    const marker = b[j]!;
    const at = j - 1; // 区切りの先頭（0xFF の最後）
    if (marker === 0xda) {
      parts.push(b.subarray(at));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      parts.push(b.subarray(at, j + 1));
      i = j + 1;
      continue;
    }
    if (j + 2 >= b.length) return null;
    const len = (b[j + 1]! << 8) | b[j + 2]!;
    if (len < 2 || j + 1 + len > b.length) return null;
    const end = j + 1 + len;
    const body = j + 3;
    let keep = true;
    let replace: Uint8Array | null = null;
    if (marker === 0xe0) {
      // JFIF：縮小画像（Xthumbnail・Ythumbnail）を 0 にした形に作り直す。JFXX（縮小画像だけの区切り）は外す
      if (startsWith(b, body, "JFIF\0") && len >= 16) {
        if (b[body + 12] !== 0 || b[body + 13] !== 0 || len > 16) {
          replace = new Uint8Array(18);
          replace.set([0xff, 0xe0, 0x00, 0x10]);
          replace.set(b.subarray(body, body + 12), 4);
          replace[16] = 0;
          replace[17] = 0;
        }
      } else keep = false;
    } else if (marker === 0xe2) keep = startsWith(b, body, "ICC_PROFILE\0");
    else if (marker === 0xee) keep = true; // APP14 Adobe（色の変換に要る）
    else if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) keep = false;
    if (replace) {
      parts.push(replace);
      changed = true;
    } else if (keep) parts.push(b.subarray(at, end));
    else changed = true;
    i = end;
  }
  if (!changed) return null;
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const isDctOnly = (ctx: PDFContext, d: PDFDict): boolean => {
  const f = ctx.lookup(d.get(N("Filter")));
  if (f instanceof PDFName) return f.decodeText() === "DCTDecode" || f.decodeText() === "DCT";
  if (f instanceof PDFArray && f.size() === 1) return ["DCTDecode", "DCT"].includes(nameOf(ctx, f.get(0)) ?? "");
  return false;
};

/** P10：PDF の中の JPEG の画像から、写真の情報を外す */
export function removeImageExif(ctx: PDFContext): RemovedItem[] {
  let n = 0;
  for (const [ref, o] of ctx.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream) || nameOf(ctx, o.dict.get(N("Subtype"))) !== "Image" || !isDctOnly(ctx, o.dict)) continue;
    const out = stripJpegMetadata(o.contents);
    if (!out) continue;
    ctx.assign(ref, PDFRawStream.of(o.dict, out));
    n++;
  }
  return n > 0
    ? [{ pattern: "P10", kind: "image_exif", count: n, label: `写真（${n} 枚）の中の撮影の情報（位置・機種・撮影者・日時・縮小画像など）を消しました（写真の見た目は変えていません）` }]
    : [];
}

// ---------------------------------------------------------------- P7 しおり

/** P7：しおりを丸ごと外す */
export function removeOutlines(doc: PDFDocument): RemovedItem[] {
  const ctx = doc.context;
  const catalog = doc.catalog;
  const root = dictOf(ctx, catalog.get(N("Outlines")));
  if (!catalog.has(N("Outlines"))) return [];
  let items = 0;
  const seen = new Set<PDFDict>();
  const stack: PDFDict[] = [];
  const first = root ? dictOf(ctx, root.get(N("First"))) : undefined;
  if (first) stack.push(first);
  while (stack.length && items < 100_000) {
    const d = stack.pop()!;
    if (seen.has(d)) continue;
    seen.add(d);
    items++;
    for (const k of ["First", "Next"]) {
      const x = dictOf(ctx, d.get(N(k)));
      if (x) stack.push(x);
    }
  }
  catalog.delete(N("Outlines"));
  if (nameOf(ctx, catalog.get(N("PageMode"))) === "UseOutlines") catalog.delete(N("PageMode"));
  return items > 0 ? [{ pattern: "P7", kind: "outline", count: items, label: `しおり（${items} 個）を外しました（しおりの題に、本文にない名前などが残っていることがあるため）` }] : [];
}

// ---------------------------------------------------------------- 構造要素の題・欄の名前

/** 構造ツリーの要素を1回ずつ見る */
function walkStructElements(ctx: PDFContext, catalog: PDFDict, visit: (d: PDFDict) => void) {
  const root = dictOf(ctx, catalog.get(N("StructTreeRoot")));
  if (!root) return;
  const seen = new Set<PDFDict>();
  const stack: PDFObject[] = [root.get(N("K")) as PDFObject].filter(Boolean);
  while (stack.length) {
    const o = stack.pop()!;
    const v = o instanceof PDFRef ? ctx.lookup(o) : o;
    if (v instanceof PDFArray) {
      for (const x of v.asArray()) stack.push(x);
      continue;
    }
    if (!(v instanceof PDFDict) || seen.has(v)) continue;
    seen.add(v);
    // 中身への参照（/MCR・/OBJR）は要素ではない
    const type = nameOf(ctx, v.get(N("Type")));
    if (type === "MCR" || type === "OBJR") continue;
    if (!v.has(N("S"))) continue;
    visit(v);
    const k = v.get(N("K"));
    if (k !== undefined) stack.push(k);
  }
}

/** フォームの欄を1回ずつ見る（/Fields から /Kids をたどる） */
function walkFields(ctx: PDFContext, catalog: PDFDict, visit: (d: PDFDict, parent: PDFDict | null) => void) {
  const form = dictOf(ctx, catalog.get(N("AcroForm")));
  const fields = form ? ctx.lookup(form.get(N("Fields"))) : undefined;
  if (!(fields instanceof PDFArray)) return;
  const seen = new Set<PDFDict>();
  const stack: Array<{ o: PDFObject; parent: PDFDict | null; depth: number }> = fields.asArray().map((o) => ({ o, parent: null, depth: 0 }));
  while (stack.length) {
    const { o, parent, depth } = stack.pop()!;
    const d = dictOf(ctx, o);
    if (!d || seen.has(d) || depth > 64) continue;
    seen.add(d);
    visit(d, parent);
    const kids = ctx.lookup(d.get(N("Kids")));
    if (kids instanceof PDFArray) for (const k of kids.asArray()) stack.push({ o: k, parent: d, depth: depth + 1 });
  }
}

/** P7・P11：構造要素の題（/T）と欄の書き出し用の名前（/TM）を外す。読み上げ用の説明（/Alt・/E・/TU）は消さずに数える */
export function cleanStructText(doc: PDFDocument): { removed: RemovedItem[]; notDone: NotDoneItem[] } {
  const ctx = doc.context;
  let titles = 0;
  let alt = 0;
  walkStructElements(ctx, doc.catalog, (d) => {
    if (d.has(N("T"))) {
      if (hasValue(ctx, d.get(N("T")))) titles++;
      d.delete(N("T"));
    }
    for (const k of ["Alt", "E"]) if (hasValue(ctx, d.get(N(k)))) alt++;
  });
  let tm = 0;
  let tu = 0;
  walkFields(ctx, doc.catalog, (d) => {
    if (d.has(N("TM"))) {
      if (hasValue(ctx, d.get(N("TM")))) tm++;
      d.delete(N("TM"));
    }
    if (hasValue(ctx, d.get(N("TU")))) tu++;
  });
  const removed: RemovedItem[] = [];
  const notDone: NotDoneItem[] = [];
  if (titles) removed.push({ pattern: "P7", kind: "struct_title", count: titles, label: `構造ツリーの要素の題（/T。${titles} か所）を消しました` });
  if (tm) removed.push({ pattern: "P11", kind: "struct_title", count: tm, label: `フォームの欄の書き出し用の名前（/TM。${tm} 個）を消しました` });
  if (alt) {
    notDone.push({
      pattern: "P7", reason: "accessibility_text",
      label: `読み上げ用の説明（図の代わりの説明 /Alt・略語の読み /E。${alt} か所）は、読み上げに使うため消していません。名前など、載せてはいけない字が入っていないか確かめてください`,
    });
  }
  if (tu) {
    notDone.push({
      pattern: "P11", reason: "accessibility_text",
      label: `フォームの欄の読み上げ用の名前（/TU。${tu} 個）は、読み上げに使うため消していません。名前など、載せてはいけない字が入っていないか確かめてください`,
    });
  }
  return { removed, notDone };
}

// ---------------------------------------------------------------- P11 フォームの値

const FLAG_HIDDEN = 2;
const FLAG_NOVIEW = 32;

/** P11：見えない欄の値を消す。見えている欄の値は notDone にする（ページごとに数をまとめる） */
export function cleanFormValues(doc: PDFDocument): { removed: RemovedItem[]; notDone: NotDoneItem[] } {
  const ctx = doc.context;
  const catalog = doc.catalog;
  // ページに載っている注釈 → ページの番号
  const onPage = new Map<PDFDict, number>();
  doc.getPages().forEach((p, i) => {
    const annots = ctx.lookup(p.node.get(N("Annots")));
    if (annots instanceof PDFArray) for (const a of annots.asArray()) {
      const d = dictOf(ctx, a);
      if (d) onPage.set(d, i + 1);
    }
  });
  const isWidget = (d: PDFDict) => nameOf(ctx, d.get(N("Subtype"))) === "Widget";
  const shown = (w: PDFDict): number | null => {
    const page = onPage.get(w);
    if (page === undefined) return null;
    const f = ctx.lookup(w.get(N("F")));
    if (f instanceof PDFNumber && f.asNumber() & (FLAG_HIDDEN | FLAG_NOVIEW)) return null;
    return page;
  };
  /** 欄の下の、見た目（Widget）を集める（欄そのものが見た目を兼ねることもある） */
  const widgetsOf = (d: PDFDict, depth = 0): PDFDict[] => {
    const out: PDFDict[] = isWidget(d) ? [d] : [];
    const kids = ctx.lookup(d.get(N("Kids")));
    if (kids instanceof PDFArray && depth < 64) for (const k of kids.asArray()) {
      const kd = dictOf(ctx, k);
      if (kd) out.push(...widgetsOf(kd, depth + 1));
    }
    return out;
  };

  let cleared = 0;
  const visibleByPage = new Map<number, number>();
  walkFields(ctx, catalog, (d) => {
    if (!hasValue(ctx, d.get(N("V"))) && !hasValue(ctx, d.get(N("DV")))) return;
    const ws = widgetsOf(d);
    const pages = ws.map(shown).filter((p): p is number => p !== null);
    if (pages.length) {
      if (hasValue(ctx, d.get(N("V")))) visibleByPage.set(pages[0]!, (visibleByPage.get(pages[0]!) ?? 0) + 1);
      return;
    }
    d.delete(N("V"));
    d.delete(N("DV"));
    // 隠した見た目には、値の字が描かれている。見た目も外す（表示されないので、見た目は変わらない）
    for (const w of ws) {
      w.delete(N("AP"));
      w.delete(N("AS"));
    }
    cleared++;
  });
  const removed: RemovedItem[] = [];
  const notDone: NotDoneItem[] = [];
  if (cleared) removed.push({ pattern: "P11", kind: "field_value", count: cleared, label: `ページに出ない・隠したフォームの欄（${cleared} 個）の値を消しました` });
  for (const [page, n] of [...visibleByPage].sort((a, b) => a[0] - b[0])) {
    notDone.push({
      pattern: "P11", reason: "field_visible", page,
      label: `見えているフォームの欄（${n} 個）の値は、提出のための記入かもしれないため消していません。要らない値なら、自分で消してください`,
    });
  }
  return { removed, notDone };
}

/** 文書全体の残りの片付け（index.ts から呼ぶ。順番：動作 → 写真の情報 → しおり → 題・名前 → フォームの値） */
export function cleanLeftovers(doc: PDFDocument): { removed: RemovedItem[]; notDone: NotDoneItem[] } {
  const ctx = doc.context;
  const removed: RemovedItem[] = [...removeExternalActions(ctx), ...removeImageExif(ctx), ...removeOutlines(doc)];
  const s = cleanStructText(doc);
  const f = cleanFormValues(doc);
  return { removed: [...removed, ...s.removed, ...f.removed], notDone: [...s.notDone, ...f.notDone] };
}


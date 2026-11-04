// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする：利用者が選んだ場所（ページと箱）を、本当に消して保存する。見た目に黒い四角を重ねるだけにはしない。
//
//   const r = await redact(bytes, [{ page: 1, rect: [x0, y0, x1, y1] }], { codec, checks: [rulesCheck(inspectAll)] });
//   r.status === "ok"      → r.bytes（保存してよい PDF）・r.removed（消したもの）
//   r.status === "blocked" → 読み直しで残りが見つかった。r.leftovers（何が残ったか）。バイト列は返さない（保存させない）
//   r.status === "error"   → r.code・r.message
//
// 選んだ場所で消すもの：
//   - 字：字の箱が少しでも掛かる字（1字まるごと。残す字の位置は変わらない）
//   - 画像の画素：中心が場所の中にある画素を黒く塗る（今の片付けの塗り方。透明の型 /SMask は不透明にする）
//   - 注釈：場所に掛かる注釈を外す。フォームの欄は、見た目（Widget）ごと外し、ほかに見た目がなければ欄ごと外す（値も消える）
//   - 前の版・孤立した部品：片付けと同じく、1つの版にまとめて捨てる
//   - 字の対応表（/ToUnicode）：消した字だけで使っていた行を消す（redact-fonts.ts）
// そのうえで、片付け（sanitizePdf）と同じ片付けを全部かけ、場所の上に黒い四角を描く。
// 保存の前に、出来上がった PDF を最初から読み直す（redact-check.ts と、呼ぶ側が渡す checks）。

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFObject } from "pdf-lib";
import type { Rect } from "../rules/p6-text/geometry.ts";
import { sanitizeCore } from "./index.ts";
import { checkAreas, touches } from "./redact-check.ts";
import { fontUsage, shrinkToUnicode, type FontUsage } from "./redact-fonts.ts";
import type { NotDoneItem, RedactArea, RedactLeftover, RedactOptions, RedactResult, RemovedItem } from "./types.ts";

/** 1回に選べる場所の数の上限（細工した入力で止まらないように） */
const MAX_AREAS = 10_000;

const round = (r: Rect): Rect => r.map((v) => Math.round(v * 100) / 100) as Rect;

function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

function rectOfAnnot(ctx: PDFContext, d: PDFDict): Rect | null {
  const arr = ctx.lookup(d.get(PDFName.of("Rect")));
  if (!(arr instanceof PDFArray) || arr.size() < 4) return null;
  const v = arr.asArray().slice(0, 4).map((x) => ctx.lookup(x));
  if (!v.every((x) => x instanceof PDFNumber)) return null;
  const [x0, y0, x1, y1] = v.map((x) => (x as PDFNumber).asNumber()) as [number, number, number, number];
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** 入力の場所を確かめ、ページごとにまとめる（箱は小さい方から大きい方へ並べ直す） */
function normalizeAreas(areas: unknown): Map<number, Rect[]> | string {
  if (!Array.isArray(areas)) return "選んだ場所の形が正しくありません。";
  if (areas.length > MAX_AREAS) return "選んだ場所が多すぎます。";
  const out = new Map<number, Rect[]>();
  for (const a of areas as Array<Partial<RedactArea>>) {
    const page = a?.page;
    const r = a?.rect;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return "選んだ場所のページの番号が正しくありません。";
    if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => typeof v === "number" && Number.isFinite(v))) return "選んだ場所の箱が正しくありません。";
    const rect: Rect = [Math.min(r[0]!, r[2]!), Math.min(r[1]!, r[3]!), Math.max(r[0]!, r[2]!), Math.max(r[1]!, r[3]!)];
    if (rect[2] - rect[0] <= 0 || rect[3] - rect[1] <= 0) return "選んだ場所の箱に、広さがありません。";
    out.set(page, [...(out.get(page) ?? []), rect]);
  }
  return out;
}

/** 選んだ場所に掛かる注釈・フォームの欄を外す */
function removeInAreas(doc: PDFDocument, byPage: Map<number, Rect[]>, notDone: NotDoneItem[]): RemovedItem[] {
  const ctx = doc.context;
  const removed: RemovedItem[] = [];
  const pages = doc.getPages();
  const removedWidgets = new Set<PDFDict>();
  const widgetPage = new Map<PDFDict, { page: number; rect: Rect }>();

  for (const [pageNo, rects] of byPage) {
    const page = pages[pageNo - 1];
    if (!page) continue;
    const annots = ctx.lookup(page.node.get(PDFName.of("Annots")));
    if (!(annots instanceof PDFArray)) continue;
    const list = annots.asArray();
    const drop = new Set<number>();
    const dicts = list.map((a) => dictOf(ctx, a));
    for (const [i, d] of dicts.entries()) {
      if (!d) continue;
      const rect = rectOfAnnot(ctx, d);
      if (!rect || !rects.some((r) => touches(rect, r))) continue;
      drop.add(i);
      const sub = d.lookup(PDFName.of("Subtype"));
      if (sub instanceof PDFName && sub.decodeText() === "Widget") {
        removedWidgets.add(d);
        widgetPage.set(d, { page: pageNo, rect: round(rect) });
      }
      // 注釈の吹き出し（/Popup）と、吹き出しの持ち主（/Parent）も外す（吹き出しは持ち主のコメントを見せるため）
      const pop = d.get(PDFName.of("Popup"));
      const parent = sub instanceof PDFName && sub.decodeText() === "Popup" ? d.get(PDFName.of("Parent")) : undefined;
      for (const link of [pop, parent]) {
        if (!link) continue;
        const target = dictOf(ctx, link);
        const k = dicts.findIndex((x) => x === target);
        if (k >= 0) drop.add(k);
      }
    }
    if (!drop.size) continue;
    let annotsCount = 0;
    for (const i of drop) {
      const sub = dicts[i]?.lookup(PDFName.of("Subtype"));
      if (!(sub instanceof PDFName && sub.decodeText() === "Widget")) annotsCount++;
    }
    page.node.set(PDFName.of("Annots"), ctx.obj(list.filter((_, i) => !drop.has(i))));
    if (annotsCount) removed.push({ pattern: "P6", kind: "redacted_annotation", page: pageNo, count: annotsCount, label: `選んだ所に掛かる注釈（${annotsCount} 個）を外しました` });
  }

  if (removedWidgets.size) removed.push(...removeFields(doc, removedWidgets, widgetPage, notDone));
  return removed;
}

/**
 * 外した見た目（Widget）の欄を片付ける。欄の見た目が全部外れたら、欄ごと外す（値 /V・既定の値 /DV も消える）。
 * ほかの所に同じ欄の見た目が残るときは、値を消すと残った見た目と食い違うので、欄は残して片付けられなかった所にする
 */
function removeFields(doc: PDFDocument, widgets: Set<PDFDict>, where: Map<PDFDict, { page: number; rect: Rect }>, notDone: NotDoneItem[]): RemovedItem[] {
  const ctx = doc.context;
  const acro = dictOf(ctx, doc.catalog.get(PDFName.of("AcroForm")));
  if (!acro) return [];
  const removed: RemovedItem[] = [];
  let fieldsRemoved = 0;
  const pagesOf = new Set<number>();

  /** 欄の木をたどる。戻り値：この節を親から外すか */
  const visit = (ref: PDFObject, depth: number): boolean => {
    const d = dictOf(ctx, ref);
    if (!d || depth > 32) return false;
    const kids = ctx.lookup(d.get(PDFName.of("Kids")));
    const isWidget = (x: PDFDict) => {
      const s = x.lookup(PDFName.of("Subtype"));
      return s instanceof PDFName && s.decodeText() === "Widget";
    };
    if (kids instanceof PDFArray) {
      const list = kids.asArray();
      const keep: PDFObject[] = [];
      let hadWidget = false;
      for (const k of list) {
        const kd = dictOf(ctx, k);
        if (kd && isWidget(kd) && !kd.has(PDFName.of("T"))) {
          hadWidget = true;
          if (!widgets.has(kd)) keep.push(k);
          continue;
        }
        if (!visit(k, depth + 1)) keep.push(k);
      }
      if (keep.length !== list.length) d.set(PDFName.of("Kids"), ctx.obj(keep));
      if (hadWidget && keep.length === 0) {
        fieldsRemoved++;
        return true;
      }
      if (hadWidget && keep.length < list.length) {
        const w = [...widgets].find((x) => list.some((k) => dictOf(ctx, k) === x));
        const at = w ? where.get(w) : undefined;
        notDone.push({
          pattern: "P6", reason: "field_shared", ...(at ? { page: at.page, rect: at.rect } : {}),
          label: "選んだ所のフォームの欄は、ほかの所にも同じ欄があるため、欄の値を消せませんでした（ほかの所の欄も選んでください）",
        });
      }
      return keep.length === 0 && list.length > 0 && !hadWidget;
    }
    // 欄と見た目が1つになったもの
    if (widgets.has(d)) {
      fieldsRemoved++;
      return true;
    }
    return false;
  };

  const fields = ctx.lookup(acro.get(PDFName.of("Fields")));
  if (fields instanceof PDFArray) {
    const list = fields.asArray();
    const keep = list.filter((f) => !visit(f, 0));
    if (keep.length !== list.length) acro.set(PDFName.of("Fields"), ctx.obj(keep));
  }
  for (const w of widgets) {
    const at = where.get(w);
    if (at) pagesOf.add(at.page);
  }
  // XFA のフォームは、欄の値をまとめて持つ。欄を外したら、XFA も外す（値が残らないように）
  if (fieldsRemoved && acro.has(PDFName.of("XFA"))) acro.delete(PDFName.of("XFA"));
  if (fieldsRemoved) {
    removed.push({ pattern: "P6", kind: "redacted_field", count: fieldsRemoved, ...(pagesOf.size === 1 ? { page: [...pagesOf][0]! } : {}), label: `選んだ所に掛かるフォームの欄（${fieldsRemoved} 個）を、値ごと外しました` });
  }
  return removed;
}

export async function redact(bytes: Uint8Array, areas: RedactArea[], options: RedactOptions = {}): Promise<RedactResult> {
  const byPage = normalizeAreas(areas);
  if (typeof byPage === "string") return { status: "error", code: "bad_areas", message: byPage };
  const notDoneExtra: NotDoneItem[] = [];
  const { checks = [], ...sanitizeOptions } = options;

  let usageBefore: FontUsage | null = null;
  const core = await sanitizeCore(bytes, sanitizeOptions, {
    areas: byPage,
    beforePages: (doc) => {
      if (byPage.size) usageBefore = fontUsage(doc, new Set(byPage.keys()));
    },
    afterPages: (doc) => {
      const bad = [...byPage.keys()].find((p) => p > doc.getPageCount());
      if (bad !== undefined) throw new BadAreas();
      return removeInAreas(doc, byPage, notDoneExtra);
    },
    beforeDrop: (doc) => (byPage.size ? shrinkToUnicode(doc, new Set(byPage.keys()), usageBefore) : []),
  }).catch((e) => {
    if (e instanceof BadAreas) return null;
    throw e;
  });
  if (core === null) return { status: "error", code: "bad_areas", message: "選んだ場所のページが、この PDF にありません。" };
  if (core.status === "error") return core;

  const removed = [...core.removed];
  for (const [page, rects] of byPage) {
    for (const rect of rects) removed.push({ pattern: "P6", kind: "redaction_box", page, rect: round(rect), count: 1, label: "選んだ所に黒い四角を描きました" });
  }
  const notDone = [...core.notDone, ...notDoneExtra];

  // 保存の前の読み直し
  const flat: RedactArea[] = [...byPage].flatMap(([page, rects]) => rects.map((rect) => ({ page, rect })));
  const leftovers: RedactLeftover[] = notDone.map((n) => ({
    check: "not_done" as const, kind: "not_done" as const, count: 1, label: n.label, pattern: n.pattern,
    ...(n.page !== undefined ? { page: n.page } : {}), ...(n.rect ? { rect: n.rect } : {}),
  }));
  const checked = ["area"];
  leftovers.push(...(await checkAreas(core.bytes, flat, {
    ...(options.codec ? { codec: options.codec } : {}),
    ...(options.maxImageBytes !== undefined ? { maxImageBytes: options.maxImageBytes } : {}),
    ...(options.maxImagePixels !== undefined ? { maxImagePixels: options.maxImagePixels } : {}),
  })));
  for (const c of checks) {
    checked.push(c.name);
    try {
      leftovers.push(...(await c.run(core.bytes, flat)));
    } catch {
      leftovers.push({ check: c.name, kind: c.name === "rules" ? "rule_error" : "verifier_error", count: 1, label: "読み直しの確かめが途中で止まったため、残りがないと確かめられませんでした" });
    }
  }
  if (leftovers.length) return { status: "blocked", pages: core.pages, removed, notDone, leftovers, decrypted: core.decrypted, checked };
  return { status: "ok", bytes: core.bytes, pages: core.pages, removed, notDone, decrypted: core.decrypted, checked };
}

class BadAreas extends Error {}

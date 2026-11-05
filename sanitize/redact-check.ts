// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りしたあと、保存の前に行う読み直しの確かめ。
// 片付けた PDF のバイト列を最初から読み直し（片付けの報告は使わない）、選んだ場所ごとに次を数える：
//   - 字：場所に字の箱が少しでも掛かる字（空白は数えない）
//   - 画像の画素：場所の中に中心がある画素のうち、黒く塗られていないもの（透明の型 /SMask は、不透明でないもの）
//   - ページに直接埋め込んだ画像・読めない画像：場所に掛かれば、確かめられないので残りとして数える
//   - 注釈：場所に掛かる注釈
// 作品の検査（全部のルール）と検証器は、呼ぶ側が RedactCheck として渡す（片付けのコードは src/・verifier/ を読み込まない）。

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { loadPdf } from "../rules/shared/load.ts";
import { intersectionArea, type Rect } from "../rules/p6-text/geometry.ts";
import { SETTINGS, makeVisibility, readPageForCheck } from "./content.ts";
import { burnImage } from "./images.ts";
import type { ImageCodec, RedactArea, RedactCheck, RedactLeftover } from "./types.ts";

const round = (r: Rect): Rect => r.map((v) => Math.round(v * 100) / 100) as Rect;

function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

/** 箱 a と b が重なるか（面積のない箱は、もう一方の中にあれば重なるとする） */
export function touches(a: Rect, b: Rect): boolean {
  if (a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]) return false;
  const zero = (r: Rect) => r[2] - r[0] <= 0 || r[3] - r[1] <= 0;
  return zero(a) || zero(b) ? true : intersectionArea(a, b) > 0;
}

/** 選んだ場所の確かめ（いつも行う） */
export async function checkAreas(bytes: Uint8Array, areas: RedactArea[], opts: { codec?: ImageCodec; maxImageBytes?: number; maxImagePixels?: number } = {}): Promise<RedactLeftover[]> {
  const out: RedactLeftover[] = [];
  const loaded = await loadPdf(bytes);
  if (loaded.status === "error") return [{ check: "area", kind: "unreadable_page", count: 1, label: "黒塗りしたあとの PDF を読み直せませんでした" }];
  const doc = loaded.doc;
  const ctx = doc.context;
  const pages = doc.getPages();
  const visible = makeVisibility(ctx, doc.catalog);
  const limits = {
    maxBytes: opts.maxImageBytes ?? SETTINGS.maxImageBytes, maxPixels: opts.maxImagePixels ?? SETTINGS.maxImagePixels,
    jpegQuality: SETTINGS.jpegQuality, checkOnly: true, ...(opts.codec ? { codec: opts.codec } : {}),
  };
  const byPage = new Map<number, Rect[]>();
  for (const a of areas) byPage.set(a.page, [...(byPage.get(a.page) ?? []), a.rect]);

  for (const [pageNo, rects] of byPage) {
    const page = pages[pageNo - 1];
    if (!page) {
      out.push({ check: "area", kind: "unreadable_page", page: pageNo, count: 1, label: "選んだ所のページが、黒塗りしたあとの PDF にありません" });
      continue;
    }
    let read;
    try {
      read = readPageForCheck(ctx, page, visible, { ...SETTINGS, maxOperationsPerPage: SETTINGS.maxOperationsPerPage });
    } catch {
      out.push({ check: "area", kind: "unreadable_page", page: pageNo, count: 1, label: "このページを読み直せなかったため、選んだ所を確かめられませんでした" });
      continue;
    }
    const annots = ctx.lookup(page.node.get(PDFName.of("Annots")));
    for (const rect of rects) {
      const chars = read.glyphs.filter((g) => !g.isSpace && intersectionArea(g.rect, rect) > 0).length;
      if (chars) out.push({ check: "area", kind: "text", page: pageNo, rect: round(rect), count: chars, label: `選んだ所に、取り出せる字が ${chars} 字残っています` });

      let pixels = 0;
      let unchecked = 0;
      for (const im of read.images) {
        if (!touches(im.box, rect)) continue;
        const cs = dictOf(ctx, im.res?.get(PDFName.of("ColorSpace")));
        const r = await burnImage(ctx, im.stream, cs, im.ctm, [{ seq: 1, rect, kind: "user" }], limits);
        if (!r.ok) unchecked++;
        else pixels += r.offPerCover[0] ?? 0;
        const sm = im.stream.dict.get(PDFName.of("SMask"));
        const smask = sm instanceof PDFRef ? ctx.lookup(sm) : sm;
        if (smask instanceof PDFStream) {
          const m = await burnImage(ctx, smask, undefined, im.ctm, [{ seq: 1, rect, kind: "user", tone: "light" }], limits);
          if (!m.ok) unchecked++;
          else pixels += m.offPerCover[0] ?? 0;
        }
        // 型抜きの画像（/Mask に画像を指定したもの）は塗らないので、形が残っているかもしれない。確かめられないものとして数える
        const mk = im.stream.dict.get(PDFName.of("Mask"));
        if ((mk instanceof PDFRef ? ctx.lookup(mk) : mk) instanceof PDFStream) unchecked++;
      }
      if (pixels) out.push({ check: "area", kind: "pixels", page: pageNo, rect: round(rect), count: pixels, label: `選んだ所に、塗られていない画像の画素が ${pixels} 個残っています` });
      if (unchecked) out.push({ check: "area", kind: "unchecked_image", page: pageNo, rect: round(rect), count: unchecked, label: `選んだ所の画像（${unchecked} 個）を読み直せず、塗られたかを確かめられませんでした` });
      const pat = read.patternText.filter((b) => touches(b, rect)).length;
      if (pat) out.push({ check: "area", kind: "pattern_text", page: pageNo, rect: round(rect), count: pat, label: `選んだ所に、字の入った模様（${pat} か所）が残っています` });
      const inline = read.inlineImages.filter((b) => touches(b, rect)).length;
      if (inline) out.push({ check: "area", kind: "inline_image", page: pageNo, rect: round(rect), count: inline, label: `選んだ所に、ページに直接埋め込んだ画像（${inline} 個）が残っています` });

      let ann = 0;
      if (annots instanceof PDFArray) for (const a of annots.asArray()) {
        const d = dictOf(ctx, a);
        const arr = d ? ctx.lookup(d.get(PDFName.of("Rect"))) : undefined;
        if (!(arr instanceof PDFArray) || arr.size() < 4) continue;
        const v = arr.asArray().map((x) => ctx.lookup(x));
        if (!v.every((x) => x instanceof PDFNumber)) continue;
        const [x0, y0, x1, y1] = v.map((x) => (x as PDFNumber).asNumber()) as [number, number, number, number];
        if (touches([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)], rect)) ann++;
      }
      if (ann) out.push({ check: "area", kind: "annotation", page: pageNo, rect: round(rect), count: ann, label: `選んだ所に、注釈・フォームの欄が ${ann} 個残っています` });
    }
  }
  return out;
}

/** 作品の検査の結果の形（src/inspect/report.ts の InspectSummary のうち、使う所だけ。src/ は読み込まない） */
type InspectLike = {
  rules: Array<{ ruleId: string; pattern: string; status: "ok" | "error"; items: Array<{ pattern: string; page: number | null; rect: Rect | null; field?: string }> }>;
};

/**
 * 黒塗りの候補として示すだけの型。残りではないので、読み直しの「全部のルール」から外す（画面の片付けの読み直し src/ui/clean-model.ts と同じ扱い）。
 * P13【仮】（見える文字の個人情報らしい字）：選んだ場所の中に字が残っていないかは、場所ごとの確かめ（checkAreas）で見る
 */
export const CANDIDATE_PATTERNS: readonly string[] = ["P13"];

/**
 * 作品の検査（全部のルール。黒塗りの候補の型を除く）を、読み直しの確かめにする。見つかった所は 1 件ずつ残りにする。調べられなかったルールも残りにする（確かめられないため）。
 * 画面：rulesCheck((b) => inspectAll(b)) のように、src/inspect/inspect.ts の inspectAll を渡す
 */
export function rulesCheck(inspect: (bytes: Uint8Array) => Promise<InspectLike>): RedactCheck {
  return {
    name: "rules",
    async run(bytes) {
      const r = await inspect(bytes);
      const out: RedactLeftover[] = [];
      for (const rule of r.rules) {
        if (CANDIDATE_PATTERNS.includes(rule.pattern)) continue;
        if (rule.status === "error") {
          out.push({ check: "rules", kind: "rule_error", pattern: rule.pattern, count: 1, label: `検査（${rule.pattern}）を最後まで調べられなかったため、残りがないと確かめられませんでした` });
          continue;
        }
        for (const it of rule.items) {
          if (CANDIDATE_PATTERNS.includes(it.pattern)) continue;
          out.push({
            check: "rules", kind: "rule_item", pattern: it.pattern, count: 1, label: `読み直しの検査で、${it.pattern} の残りが見つかりました`,
            ...(it.page !== null ? { page: it.page } : {}), ...(it.rect ? { rect: it.rect } : {}), ...(it.field ? { field: it.field } : {}),
          });
        }
      }
      return out;
    },
  };
}

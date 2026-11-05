// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P11（フォームの値）1.1.0。フォームの欄（/AcroForm /Fields の木）に入っている値（/V）を、字数で返す。
// 値そのものも、欄の名前も返さない（欄の名前が人をたどる手がかりになりうるため）。
//
// 見え方（visibility）で分ける：
//   visible：ページに見えるウィジェットがある（画面にも値が見えている）
//   hidden：ウィジェットがあるが、すべて隠しの印（Hidden・NoView）か、大きさが 0（画面には出ない）
//   no_widget：ウィジェットが無い、またはどのページにも置かれていない（値はファイルの中にだけある）
// 数えないもの：空・空白だけの値、チェックボックスなどの /Off、署名の欄の値（署名の辞書）、/V の無い欄（/DV の既定の値だけ）。
//
// 1.1.0 から、値とは別に次も返す（字数とページだけ）：
//   tooltips：欄の説明（/TU）・書き出し用の名前（/TM）に、連絡先らしい字（3けた以上の数字・メールアドレス・「内線」「担当」「様」「さん」など）があるもの。
//     「お名前を入れてください」のような、ふつうの説明は数えない。
//   signatures：署名した欄の署名の辞書にある、署名者名（/Name）・連絡先（/ContactInfo）。漏れとは言い切れないので「知らせるだけ」にする。

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFString, type PDFContext, type PDFObject } from "pdf-lib";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { arrayItems, catalogOf, charCount, dictOf, hiddenFlagOf, lookup, N, nameOf, numOf, openPdf, textOf, visibleText, type RuleError } from "../common/index.ts";

export const RULE_ID = "p11-forms";
export const RULE_VERSION = "1.1.0";

export type P11Visibility = "visible" | "hidden" | "no_widget";
export type P11FieldType = "text" | "choice" | "button" | "unknown";

export type P11Finding = {
  pattern: "P11";
  visibility: P11Visibility;
  fieldType: P11FieldType;
  /** 値の字数（チェックボックス・ラジオボタンは 0。入っているかだけ） */
  chars: number;
  /** ウィジェットのある最初のページ（no_widget なら null） */
  page: number | null;
  /** includeValues のときだけ。値そのもの。記録やログには使わない */
  value?: string;
};

export type P11Report = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  /** フォームがあるか（/AcroForm の /Fields） */
  hasForm: boolean;
  /** 見た欄（値を持てる終わりの欄）の数 */
  fields: number;
  findings: P11Finding[];
  notCounted: { empty: number; off: number; signature: number; defaultOnly: number };
  /** 欄の説明（/TU・/TM）の中の、連絡先らしい字（1.1.0） */
  tooltips: Array<{ key: "TU" | "TM"; chars: number; page: number | null }>;
  /** 署名の辞書の署名者名・連絡先（1.1.0。知らせるだけ） */
  signatures: Array<{ key: "Name" | "ContactInfo"; chars: number; page: number | null }>;
  limits: Array<"too_many_fields" | "too_deep">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { includeValues?: boolean };

/** 見る欄の数の上限【仮の値】 */
export const MAX_FIELDS = 100_000;
const MAX_DEPTH = 32;
const TYPE_OF: Record<string, P11FieldType> = { Tx: "text", Ch: "choice", Btn: "button" };

/** 欄の説明に、連絡先らしい字があるか（電話・内線の数字、メールアドレス、担当・様・さん など） */
export function contactLike(text: string): boolean {
  const t = text.normalize("NFKC");
  return /\d{3,}/.test(t) || /[\w.+-]+@[\w-]+\.[\w.-]+/.test(t) || /内線|担当|様|さん|\bext\.?\s*\d|\b(?:tel|phone|contact)\b/i.test(t);
}

/** 値を字にする。数えない値は、理由を返す */
function valueOf(ctx: PDFContext, raw: PDFObject | undefined): { text: string } | { skip: "empty" | "off" } | null {
  const v = lookup(ctx, raw);
  if (v === undefined) return null;
  if (v instanceof PDFString || v instanceof PDFHexString) {
    const t = visibleText(textOf(ctx, v) ?? "");
    return t ? { text: t } : { skip: "empty" };
  }
  if (v instanceof PDFName) {
    const n = v.decodeText();
    return n === "Off" || n === "" ? { skip: "off" } : { text: n };
  }
  if (v instanceof PDFArray) {
    const parts = v
      .asArray()
      .map((x) => textOf(ctx, x))
      .filter((x): x is string => x !== null)
      .map(visibleText)
      .filter(Boolean);
    return parts.length ? { text: parts.join("\n") } : { skip: "empty" };
  }
  return { skip: "empty" };
}

function inherited(field: PDFDict, key: string, parents: PDFDict[]): PDFObject | undefined {
  const own = field.get(N(key));
  if (own !== undefined) return own;
  for (let i = parents.length - 1; i >= 0; i--) {
    const v = parents[i]!.get(N(key));
    if (v !== undefined) return v;
  }
  return undefined;
}

function zeroSize(ctx: PDFContext, w: PDFDict): boolean {
  const r = arrayItems(ctx, w.get(N("Rect"))).map((x) => numOf(ctx, x));
  if (r.length !== 4 || r.some((x) => x === undefined)) return false;
  const [x0, y0, x1, y1] = r as number[];
  return Math.abs(x1! - x0!) < 0.5 || Math.abs(y1! - y0!) < 0.5;
}

export async function detectP11Forms(bytes: Uint8Array, options: DetectOptions = {}): Promise<P11Report> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, hasForm: false, fields: 0, findings: [], notCounted: { empty: 0, off: 0, signature: 0, defaultOnly: 0 }, tooltips: [], signatures: [], limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { doc, ctx } = opened;
  const report: P11Report = { ...base, status: "ok", findings: [], notCounted: { empty: 0, off: 0, signature: 0, defaultOnly: 0 }, tooltips: [], signatures: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;

  const acro = dictOf(ctx, catalogOf(ctx)?.get(N("AcroForm")));
  const roots = acro ? arrayItems(ctx, acro.get(N("Fields"))) : [];
  report.hasForm = roots.length > 0;
  if (!report.hasForm) return report;

  // ページに置かれた注釈と、そのページ
  const pageOf = new Map<PDFDict, number>();
  try {
    doc.getPages().forEach((p, i) => {
      for (const ref of arrayItems(ctx, p.node.get(N("Annots")))) {
        const a = dictOf(ctx, ref);
        if (a && !pageOf.has(a)) pageOf.set(a, i + 1);
      }
    });
  } catch {
    /* ページが読めなくても、欄は見る */
  }

  const seen = new Set<PDFDict>();
  const visit = (obj: PDFObject, parents: PDFDict[]) => {
    const f = dictOf(ctx, obj);
    if (!f || seen.has(f)) return;
    seen.add(f);
    if (parents.length > MAX_DEPTH) {
      if (!report.limits.includes("too_deep")) report.limits.push("too_deep");
      return;
    }
    // 子のうち、名前（/T）を持つものは子の欄、持たないものはウィジェット
    const kids = arrayItems(ctx, f.get(N("Kids")))
      .map((k) => dictOf(ctx, k))
      .filter((k): k is PDFDict => !!k);
    const childFields = kids.filter((k) => k.has(N("T")));
    if (childFields.length) {
      for (const k of childFields) visit(k, [...parents, f]);
      // 名前のない子（ウィジェット）が混ざっていても、値はこの欄のもの（下で見る）
      if (childFields.length === kids.length) return;
    }
    if (++report.fields > MAX_FIELDS) {
      if (!report.limits.includes("too_many_fields")) report.limits.push("too_many_fields");
      return;
    }
    const widgets = [...(nameOf(ctx, f.get(N("Subtype"))) === "Widget" ? [f] : []), ...kids.filter((k) => !k.has(N("T")))];
    const placed = widgets.filter((w) => pageOf.has(w));
    const firstPage = placed.length ? Math.min(...placed.map((w) => pageOf.get(w)!)) : null;
    for (const key of ["TU", "TM"] as const) {
      const t = visibleText(textOf(ctx, f.get(N(key))) ?? "");
      if (t && contactLike(t)) report.tooltips.push({ key, chars: charCount(t), page: firstPage });
    }
    const ft = nameOf(ctx, inherited(f, "FT", parents));
    if (ft === "Sig") {
      const sig = dictOf(ctx, f.get(N("V")));
      if (sig) {
        report.notCounted.signature++;
        for (const key of ["Name", "ContactInfo"] as const) {
          const t = visibleText(textOf(ctx, sig.get(N(key))) ?? "");
          if (t) report.signatures.push({ key, chars: charCount(t), page: firstPage });
        }
      }
      return;
    }
    const v = valueOf(ctx, f.get(N("V")));
    if (v === null) {
      if (f.has(N("DV"))) report.notCounted.defaultOnly++;
      return;
    }
    if ("skip" in v) {
      report.notCounted[v.skip]++;
      return;
    }
    let visibility: P11Visibility;
    if (!placed.length) visibility = "no_widget";
    else if (placed.every((w) => hiddenFlagOf(ctx, w) !== null || zeroSize(ctx, w))) visibility = "hidden";
    else visibility = "visible";
    const fieldType = (ft && TYPE_OF[ft]) || "unknown";
    const finding: P11Finding = {
      pattern: "P11",
      visibility,
      fieldType,
      chars: fieldType === "button" ? 0 : charCount(v.text),
      page: firstPage,
    };
    if (options.includeValues) finding.value = v.text;
    report.findings.push(finding);
  };
  for (const r of roots) visit(r, []);

  const order: P11Visibility[] = ["no_widget", "hidden", "visible"];
  report.findings.sort((a, b) => order.indexOf(a.visibility) - order.indexOf(b.visibility) || (a.page ?? 0) - (b.page ?? 0));
  return report;
}

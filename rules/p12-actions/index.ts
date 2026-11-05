// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P12（JavaScript・開いたときの動作）1.2.0。
// 文書の JavaScript と、開いた・閉じた・印刷したときなどに自動で動く動作を、有る・無いと場所で返す。深刻度は「注意」。
// JavaScript の中身は返さない（字数だけ）。実行もしない。
//
// 見る所（where）：
//   names：文書の JavaScript の一覧（カタログの /Names /JavaScript）
//   open_action：開いたときの動作（カタログの /OpenAction）
//   document_aa：文書の自動の動作（カタログの /AA。閉じる前・保存の前・印刷の前など）
//   page_aa：ページを開いた・閉じたときの動作（ページの /AA）
//   annotation：注釈を押したときの動作（/A・/AA）
//   field：フォームの欄の動作（/AA。入力の形を整える・計算するなど）
//   other：上のどこからも指されていない JavaScript の動作（ファイルに残っている）
// 数える動作（kind）：
//   どこでも：javascript・submit_form（入力を送る）・import_data（外のデータを読み込む）
//   自動で動く所（開いたとき・文書の /AA・ページの /AA・フォームの欄の /AA・名前の一覧）だけ：
//     launch（ほかのプログラムやファイルを開く）・remote_goto（別のファイルへ移る）・uri（ウェブのページを開く）・そのほか（other_action）
// 押したときだけ動く所（注釈の /A・/AA、フォームのボタンの /A）の launch・remote_goto・uri は、ふつうのリンク
// （「別紙.pdf を開く」など）なので数えず、notCounted.link に数える（合成 PDF の P9 の対照で、別のファイルへのリンクを誤検知したため）。
// 1.1.0：押したときに外のウェブのページを開くリンク（uri）は、押したときだけ動く所でも数える（低い「確認してほしい所」）。
// 1.2.0：押したときだけ動くリンクの uri は、気をつける行き先（cautionUri）のときだけ数える。ふつうの https・mailto・tel のリンクは数えない（notCounted.link）。
//   気をつける行き先：暗号化されない http、ウェブ以外の種類（file・smb・javascript・data など）、内向きのサーバー（点の無いホスト名・内向きの IP アドレス）・
//   IP アドレスそのもの、ログイン情報（user:pass@）の入った URL。
// 行き先が公開してよい場所か（庁内の場所・作業中の場所でないか）を確かめてもらうため。launch・remote_goto は、いままでどおり数えない。
// 数えない動作：同じ文書の中のページへ移る（GoTo・行き先の配列）・名前つきの動作（Named。次のページなど）。

import { PDFDict, PDFRef, PDFStream, type PDFContext, type PDFObject, type PDFPage } from "pdf-lib";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { arrayItems, catalogOf, dictOf, lookup, N, nameOf, nameTreeEntries, openPdf, streamData, textOf, type RuleError } from "../common/index.ts";

export const RULE_ID = "p12-actions";
export const RULE_VERSION = "1.2.0";

export type P12Where = "names" | "open_action" | "document_aa" | "page_aa" | "annotation" | "field" | "other";
export type P12Kind = "javascript" | "launch" | "submit_form" | "import_data" | "remote_goto" | "uri" | "other_action";

export type P12Finding = {
  pattern: "P12";
  kind: P12Kind;
  where: P12Where;
  /** 自動の動作の引き金（/AA の鍵：O・C・WC・WP・K・F・V など）。/A・/OpenAction・名前の一覧は null */
  trigger: string | null;
  /** ページ（page_aa・annotation のとき） */
  page: number | null;
  /** 同じ所・同じ種類の動作の数 */
  count: number;
  /** JavaScript の字数の合計（javascript のときだけ。ほかは 0） */
  chars: number;
};

export type P12Report = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  pages: number | null;
  findings: P12Finding[];
  /** 数えなかった、ふつうの動作の数（同じ文書の中へ移る・名前つきの動作・押したときだけ動く URL・別のファイルへのリンク） */
  notCounted: { goto: number; named: number; link: number };
  limits: Array<"too_many_actions" | "name_tree" | "too_many_objects">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

/** たどる動作の数の上限（/Next の鎖を含む）【仮の値】 */
export const MAX_ACTIONS = 100_000;
/** 見るオブジェクトの数の上限（どこからも指されていない動作を探すとき）【仮の値】 */
export const MAX_OBJECTS = 1_000_000;
const MAX_JS_BYTES = 16 * 1024 * 1024;

const KIND_OF: Record<string, P12Kind> = {
  JavaScript: "javascript",
  Launch: "launch",
  SubmitForm: "submit_form",
  ImportData: "import_data",
  GoToR: "remote_goto",
  GoToE: "remote_goto",
  URI: "uri",
};
/** どこでも数える動作（押したときだけ動く所でも） */
const ALWAYS: ReadonlySet<P12Kind> = new Set(["javascript", "submit_form", "import_data"]);

export async function detectP12Actions(bytes: Uint8Array): Promise<P12Report> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, pages: null, findings: [], notCounted: { goto: 0, named: 0, link: 0 }, limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { doc, ctx } = opened;
  const report: P12Report = { ...base, status: "ok", findings: [], notCounted: { goto: 0, named: 0, link: 0 }, limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;

  const groups = new Map<string, P12Finding>();
  const seen = new Set<PDFObject>(); // たどった動作（同じ動作を2回数えない。どこからも指されていない動作を探すのにも使う）
  let actions = 0;
  const limit = (l: P12Report["limits"][number]) => {
    if (!report.limits.includes(l)) report.limits.push(l);
  };
  const add = (kind: P12Kind, where: P12Where, trigger: string | null, page: number | null, chars: number) => {
    const key = [kind, where, trigger ?? "", page ?? ""].join("\u0000");
    const g = groups.get(key) ?? { pattern: "P12" as const, kind, where, trigger, page, count: 0, chars: 0 };
    g.count++;
    g.chars += chars;
    groups.set(key, g);
  };

  /** 動作の辞書1つ（と /Next の鎖）を見る */
  const visitAction = (raw: PDFObject | undefined, where: P12Where, trigger: string | null, page: number | null, depth = 0) => {
    if (!raw || depth > 64) return;
    // 行き先の配列（[ページ /Fit] など）は、同じ文書の中へ移るだけ
    const v = lookup(ctx, raw);
    if (!(v instanceof PDFDict)) {
      if (v !== undefined && where === "open_action") report.notCounted.goto++;
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);
    if (raw instanceof PDFRef) seen.add(raw);
    if (++actions > MAX_ACTIONS) {
      limit("too_many_actions");
      return;
    }
    const s = nameOf(ctx, v.get(N("S")));
    const kind = s !== undefined ? KIND_OF[s] : undefined;
    // 押したときだけ動く所：注釈の /A・/AA と、フォームのボタンの /A（trigger が null）
    const clicked = where === "annotation" || (where === "field" && trigger === null);
    if (s === "GoTo" || s === undefined) report.notCounted.goto++;
    else if (s === "Named") report.notCounted.named++;
    else if (kind && (ALWAYS.has(kind) || !clicked || (kind === "uri" && cautionUri(textOf(ctx, v.get(N("URI"))) ?? "")))) add(kind, where, trigger, page, kind === "javascript" ? jsChars(ctx, v.get(N("JS"))) : 0);
    else if (!kind && !clicked) add("other_action", where, trigger, page, 0);
    else report.notCounted.link++;
    // 続きの動作（/Next。1つか配列）
    const next = v.get(N("Next"));
    const nv = lookup(ctx, next);
    if (nv instanceof PDFDict) visitAction(next, where, trigger, page, depth + 1);
    else for (const n of arrayItems(ctx, next)) visitAction(n, where, trigger, page, depth + 1);
  };
  const visitAA = (aa: PDFObject | undefined, where: P12Where, page: number | null) => {
    const d = dictOf(ctx, aa);
    if (!d) return;
    for (const [k, a] of d.entries()) visitAction(a, where, k.decodeText(), page);
  };

  const cat = catalogOf(ctx);
  if (cat) {
    const names = dictOf(ctx, cat.get(N("Names")));
    if (names) {
      const tree = nameTreeEntries(ctx, names.get(N("JavaScript")));
      if (tree.truncated) limit("name_tree");
      for (const e of tree.entries) visitAction(e.value, "names", null, null);
    }
    visitAction(cat.get(N("OpenAction")), "open_action", null, null);
    visitAA(cat.get(N("AA")), "document_aa", null);
  }

  let pages: PDFPage[];
  try {
    pages = doc.getPages();
    report.pages = pages.length;
  } catch {
    pages = [];
  }
  const widgetsSeen = new Set<PDFObject>();
  pages.forEach((p, i) => {
    const pageNo = i + 1;
    visitAA(p.node.get(N("AA")), "page_aa", pageNo);
    for (const ref of arrayItems(ctx, p.node.get(N("Annots")))) {
      const a = dictOf(ctx, ref);
      if (!a) continue;
      const sub = nameOf(ctx, a.get(N("Subtype")));
      if (sub === "Widget") {
        widgetsSeen.add(a);
        visitAction(a.get(N("A")), "field", null, pageNo);
        visitAA(a.get(N("AA")), "field", pageNo);
      } else {
        visitAction(a.get(N("A")), "annotation", null, pageNo);
        visitAA(a.get(N("AA")), "annotation", pageNo);
      }
    }
  });

  // フォームの欄（/AcroForm /Fields の木）。ウィジェットと一体の欄はページの側で見たので、親の欄の /AA を見る
  const acro = cat ? dictOf(ctx, cat.get(N("AcroForm"))) : undefined;
  if (acro) {
    const stack: Array<{ obj: PDFObject; depth: number }> = arrayItems(ctx, acro.get(N("Fields"))).map((obj) => ({ obj, depth: 0 }));
    const fieldSeen = new Set<PDFObject>();
    while (stack.length) {
      const { obj, depth } = stack.pop()!;
      const f = dictOf(ctx, obj);
      if (!f || fieldSeen.has(f) || depth > 32) continue;
      fieldSeen.add(f);
      if (!widgetsSeen.has(f)) visitAA(f.get(N("AA")), "field", null);
      for (const k of arrayItems(ctx, f.get(N("Kids")))) stack.push({ obj: k, depth: depth + 1 });
    }
  }

  // どこからも指されていない JavaScript の動作
  let count = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (++count > MAX_OBJECTS) {
      limit("too_many_objects");
      break;
    }
    if (!(obj instanceof PDFDict) || seen.has(obj)) continue;
    if (nameOf(ctx, obj.get(N("S"))) === "JavaScript") {
      seen.add(obj);
      add("javascript", "other", null, null, jsChars(ctx, obj.get(N("JS"))));
    }
  }

  const order: P12Where[] = ["open_action", "document_aa", "names", "page_aa", "field", "annotation", "other"];
  report.findings = [...groups.values()].sort((a, b) => order.indexOf(a.where) - order.indexOf(b.where) || (a.page ?? 0) - (b.page ?? 0));
  return report;
}

/** JavaScript の字数（文字列か、ストリーム） */
/** 押して開くリンクの行き先が、気をつける所か（ふつうの https・mailto・tel は false） */
export function cautionUri(uri: string): boolean {
  const u = uri.trim();
  const m = u.match(/^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s);
  if (!m) return false; // 種類の無いもの（相対の場所）は、ここでは見ない
  const scheme = m[1]!.toLowerCase();
  if (scheme === "mailto" || scheme === "tel") return false;
  if (scheme !== "https" && scheme !== "http") return true; // file・smb・javascript・data など
  if (scheme === "http") return true; // 暗号化されない
  const auth = m[2]!.replace(/^\/\//, "").split(/[/?#]/)[0] ?? "";
  if (auth.includes("@")) return true; // ログイン情報の入った URL
  const host = auth.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(".")) return true; // 点の無いホスト名（intranet など）・IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IP アドレスそのもの
  if (/\.(local|lan|internal|intranet|corp|home)$/.test(host)) return true;
  return false;
}

function jsChars(ctx: PDFContext, raw: PDFObject | undefined): number {
  const t = textOf(ctx, raw);
  if (t !== null) return [...t.trim()].length;
  const v = lookup(ctx, raw);
  if (v instanceof PDFStream) {
    const data = streamData(v, MAX_JS_BYTES);
    if (data) return [...new TextDecoder("latin1").decode(data).trim()].length;
  }
  return 0;
}


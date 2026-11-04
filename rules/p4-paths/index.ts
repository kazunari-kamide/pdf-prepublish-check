// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P4（ファイルパス・内部ホスト名）1.0.0。
// 文書情報・XMP・注釈・リンク先・ファイル指定の中の、パソコンや庁内のサーバーの場所を示す字を見分けて数える。
// 値そのものは返さない（種類・場所・字数だけ）。
//
// 種類（kind）：
//   user_path：ユーザーのフォルダを含むパス（C:\Users\<名前>\…・/Users/<名前>/…・/home/<名前>/…）。chars はユーザーの名前の字数
//   server：共有フォルダ（\\<サーバー>\…・smb://<サーバー>/…）と、点の無いホスト名・内向きの IP アドレスの URL（http や https で、ホスト名が fileserver01 のようなもの）。chars はサーバー名の字数
//   drive_path：ドライブ名から始まるパス（D:\広報\…）で、ユーザーのフォルダを含まないもの。chars はパス全体の字数
// file:// の URL は、中のパスとして見る。
// 場所（where）：info（文書情報）・xmp（文書全体と部品の XMP）・annotation（注釈の内容・作成者・件名）・link（リンクや動作の行き先の URL とファイル）・filespec（添付などのファイル指定の名前）
// 数えないもの：ふつうの URL（点のあるホスト名）、相対パス（../別紙.pdf）、ドライブ名の無いファイル名。

import { PDFDict, PDFHexString, PDFStream, PDFString, type PDFContext, type PDFObject } from "pdf-lib";
import type { EncryptionSummary } from "../shared/decrypt.ts";
import { dictOf, lookup, N, nameOf, openPdf, streamData, textOf, type RuleError } from "../common/index.ts";

export const RULE_ID = "p4-paths";
export const RULE_VERSION = "1.0.0";

export type P4Kind = "user_path" | "server" | "drive_path";
export type P4Where = "info" | "xmp" | "annotation" | "link" | "filespec";

export type P4Finding = {
  pattern: "P4";
  kind: P4Kind;
  where: P4Where;
  /** 同じ値を持っていた所の数 */
  places: number;
  /** user_path はユーザーの名前、server はサーバー名、drive_path はパス全体の字数 */
  chars: number;
  /** includeValues のときだけ。見つけた字（パス・URL の全体）。記録やログには使わない */
  value?: string;
};

export type P4Report = {
  rule: { id: string; version: string };
  status: "ok" | "error";
  error?: RuleError;
  findings: P4Finding[];
  limits: Array<"too_many_objects">;
  decrypted?: EncryptionSummary & { failedObjects: number };
};

export type DetectOptions = { includeValues?: boolean };

export const MAX_OBJECTS = 1_000_000;
const MAX_XMP_BYTES = 16 * 1024 * 1024;

export type PathHit = { kind: P4Kind; chars: number; value: string };

const USER = /(?:^|[\\/])(?:Users|Documents and Settings|home)[\\/]+([^\\/\s"'<>|]+)/i;

function classify(path: string): PathHit | null {
  const u = path.match(USER);
  if (u) return { kind: "user_path", chars: [...u[1]!].length, value: path };
  const unc = path.match(/^(?:\\\\|\/\/)([^\\/\s"'<>|]+)[\\/]/);
  if (unc) return { kind: "server", chars: [...unc[1]!].length, value: path };
  if (/^[A-Za-z]:[\\/]/.test(path)) return { kind: "drive_path", chars: [...path].length, value: path };
  return null;
}

function isInternalHost(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  return !host.includes("."); // 点の無いホスト名（fileserver01・intranet など）
}

/** 字の中から、パス・内部のサーバーを探す */
export function findPaths(text: string): PathHit[] {
  const out: PathHit[] = [];
  const seen = new Set<string>();
  const push = (h: PathHit | null) => {
    if (h && !seen.has(h.value)) {
      seen.add(h.value);
      out.push(h);
    }
  };
  // file:// と smb:// の URL
  for (const m of text.matchAll(/\b(file|smb):\/\/([^\s"'<>]*)/gi)) {
    let rest = m[2]!;
    try {
      rest = decodeURIComponent(rest);
    } catch {
      /* そのまま */
    }
    if (m[1]!.toLowerCase() === "smb") {
      const host = rest.split(/[\\/]/)[0] ?? "";
      if (host) push({ kind: "server", chars: [...host].length, value: m[0] });
      continue;
    }
    // file:///C:/… → C:/…、file://server/share → //server/share
    const p = rest.startsWith("/") ? rest.replace(/^\/(?=[A-Za-z]:)/, "") : `//${rest}`;
    const h = classify(p);
    if (h) push({ ...h, value: m[0] });
  }
  const noUrl = text.replace(/\b(file|smb):\/\/[^\s"'<>]*/gi, " ");
  // 共有フォルダ（\\サーバー\共有）
  for (const m of noUrl.matchAll(/(?<![\\\w])\\\\[^\\/\s"'<>|]+\\[^\s"'<>|]*/g)) push(classify(m[0]));
  // ドライブ名から始まるパス（前が英字でないもの。http: の「p:」などは / が続くので、\ のときだけ見る。C:/ も見る）
  for (const m of noUrl.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:(?:\\|\/(?!\/))[^\s"'<>|*?]*/g)) push(classify(m[0]));
  // Mac・Linux のユーザーのフォルダ
  for (const m of noUrl.matchAll(/(?<![\w:/])\/(?:Users|home)\/[^\s"'<>|]+/g)) push(classify(m[0]));
  // 内向きのサーバーの URL（点の無いホスト名・内向きの IP アドレス）
  for (const m of noUrl.matchAll(/\bhttps?:\/\/([^\s"'<>/:?#]+)/gi)) {
    const host = m[1]!;
    if (isInternalHost(host)) push({ kind: "server", chars: [...host].length, value: m[0] });
  }
  return out;
}

export async function detectP4Paths(bytes: Uint8Array, options: DetectOptions = {}): Promise<P4Report> {
  const base = { rule: { id: RULE_ID, version: RULE_VERSION }, findings: [], limits: [] };
  const opened = await openPdf(bytes);
  if (!opened.ok) return { ...base, status: "error", error: opened.error };
  const { ctx } = opened;
  const report: P4Report = { ...base, status: "ok", findings: [], limits: [] };
  if (opened.decrypted) report.decrypted = opened.decrypted;

  const groups = new Map<string, P4Finding & { v: string }>();
  const scan = (text: string | null, where: P4Where) => {
    if (!text) return;
    for (const h of findPaths(text)) {
      // 同じ値は1件にまとめる（場所は最初に見つけた所。リンクの行き先のファイル指定を、filespec と link で二重に数えない）
      const key = [h.kind, h.value].join("\u0000");
      const g = groups.get(key);
      if (g) {
        g.places++;
        if (g.where === "filespec" && where === "link") g.where = "link"; // リンクの行き先のファイル指定は、link とする
      }
      else groups.set(key, { pattern: "P4", kind: h.kind, where, places: 1, chars: h.chars, v: h.value });
    }
  };
  const str = (o: PDFObject | undefined) => textOf(ctx, o);

  // 文書情報
  const info = dictOf(ctx, ctx.trailerInfo.Info);
  if (info) for (const [, v] of info.entries()) scan(str(v), "info");

  let count = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (++count > MAX_OBJECTS) {
      report.limits.push("too_many_objects");
      break;
    }
    if (obj instanceof PDFStream) {
      // XMP（文書全体・部品）
      if (nameOf(ctx, obj.dict.get(N("Type"))) === "Metadata") {
        const data = streamData(obj, MAX_XMP_BYTES);
        if (data) scan(new TextDecoder("utf-8").decode(data).replace(/&amp;/g, "&"), "xmp");
      }
      continue;
    }
    if (!(obj instanceof PDFDict)) continue;
    const type = nameOf(ctx, obj.get(N("Type")));
    const sub = nameOf(ctx, obj.get(N("Subtype")));
    if (type === "Annot" || (sub && obj.has(N("Rect")))) {
      if (sub !== "Widget") for (const k of ["Contents", "T", "Subj", "RC"]) scan(str(obj.get(N(k))), "annotation");
      visitAction(ctx, obj.get(N("A")), scan);
      const aa = dictOf(ctx, obj.get(N("AA")));
      if (aa) for (const [, a] of aa.entries()) visitAction(ctx, a, scan);
    }
    if (type === "Filespec" || obj.has(N("EF"))) for (const k of ["F", "UF", "DOS", "Mac", "Unix"]) scan(str(obj.get(N(k))), "filespec");
    if (obj.has(N("S")) && (obj.has(N("URI")) || obj.has(N("F")))) visitAction(ctx, obj, scan);
  }

  for (const g of groups.values()) {
    const { v, ...f } = g;
    if (options.includeValues) f.value = v;
    report.findings.push(f);
  }
  const order: P4Kind[] = ["user_path", "server", "drive_path"];
  report.findings.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return report;
}

/** 動作の行き先（URI・ファイル）を見る */
function visitAction(ctx: PDFContext, raw: PDFObject | undefined, scan: (t: string | null, w: P4Where) => void) {
  const a = dictOf(ctx, raw);
  if (!a) return;
  const uri = lookup(ctx, a.get(N("URI")));
  if (uri instanceof PDFString || uri instanceof PDFHexString) scan(textOf(ctx, uri), "link");
  const f = lookup(ctx, a.get(N("F")));
  if (f instanceof PDFString || f instanceof PDFHexString) scan(textOf(ctx, f), "link");
  else if (f instanceof PDFDict) for (const k of ["F", "UF"]) scan(textOf(ctx, f.get(N(k))), "link");
  const win = dictOf(ctx, a.get(N("Win")));
  if (win) scan(textOf(ctx, win.get(N("F"))), "link");
}


// SPDX-License-Identifier: AGPL-3.0-only
//
// P9（添付ファイル）の中身を調べる（1.1.0）。
// - 添付が PDF なら、同じ検出ルール（呼ぶ側が渡す detectors）で中も調べ、型ごとの件数を返す。中の PDF の添付も、同じように調べる（入れ子）。
// - 文字のファイル（text/…・.txt・.csv など）なら、字数を数える（UTF-8・UTF-16・Shift_JIS）。
// - 中身の字・ファイル名は返さない（数と種類だけ）。
// 上限：入れ子の深さ（maxDepth）・1つの添付の大きさ（MAX_CONTENT_BYTES）・調べる添付の数の合計（maxFiles）。
// 検出ルールの一覧を渡してもらう形にしたのは、画面のルールの一覧（src/inspect/rules.ts）から呼ぶときに、輪になった import を作らないため。

import { bytesToText } from "../common/index.ts";
import { detectP9Attach, type P9AttachFinding } from "./index.ts";

/** 中の PDF にかける検出ルール1つ。見つけた件の型の番号の並びを返す */
export type InnerDetector = (bytes: Uint8Array) => Promise<Array<{ pattern: string }>>;

export const INNER_LIMITS = { maxDepth: 3, maxFiles: 50 } as const;

export const TEXT_EXTENSIONS = ["txt", "csv", "tsv", "md", "json", "xml", "html", "htm", "log", "ini", "yaml", "yml"] as const;

export type P9InnerKind = "pdf" | "text" | "other" | "too_large" | "too_deep" | "not_checked";

export type P9Inner = {
  /** 添付の中身のオブジェクト番号（P9 の findings[].object と同じ） */
  object: number;
  kind: P9InnerKind;
  /** text のとき：字数（空白を除く） */
  chars?: number;
  /** pdf のとき：中で見つけた件の数（型ごと）。中の添付の中の分も足す */
  counts?: Record<string, number>;
  /** pdf のとき：調べられなかった検出ルールの数（暗号化・壊れているなど） */
  errors?: number;
  /** 入れ子の深さ（文書の添付が 1） */
  depth: number;
  /** 中の PDF の、さらに中の添付 */
  inner?: P9Inner[];
};

function isPdf(b: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(b.subarray(0, 1024));
  return head.includes("%PDF-");
}

function looksText(f: P9AttachFinding, b: Uint8Array): boolean {
  if (f.subtype && /^text[/#]/i.test(f.subtype.replace("#2F", "/"))) return true;
  if (f.ext && (TEXT_EXTENSIONS as readonly string[]).includes(f.ext)) return true;
  // 種類が分からないときは、先頭に NUL が無く、字として読めるものを文字のファイルとみなす
  if (f.ext || f.subtype) return false;
  const head = b.subarray(0, 4096);
  if (head.includes(0) && !(head[0] === 0xfe || head[0] === 0xff)) return false;
  return bytesToText(head).encoding !== "latin1";
}

export function textChars(b: Uint8Array): number {
  const { text } = bytesToText(b);
  return [...text.replace(/^﻿/, "").replace(/\s+/g, "")].length;
}

/**
 * 添付の中身を調べる。bytes は外側の PDF。depth は、この PDF の入れ子の深さ（文書そのものは 0）。
 * budget は調べる添付の数の残り（入れ子の全体で共有する）
 */
export async function inspectAttachments(
  bytes: Uint8Array,
  detectors: InnerDetector[],
  options: { maxDepth?: number; depth?: number; budget?: { files: number } } = {},
): Promise<P9Inner[]> {
  const maxDepth = options.maxDepth ?? INNER_LIMITS.maxDepth;
  const depth = (options.depth ?? 0) + 1;
  const budget = options.budget ?? { files: INNER_LIMITS.maxFiles };
  const report = await detectP9Attach(bytes, { includeContents: true });
  if (report.status !== "ok") return [];
  const out: P9Inner[] = [];
  for (const f of report.findings) {
    const b = f.contents;
    if (b === null || b === undefined) {
      out.push({ object: f.object, kind: "too_large", depth });
      continue;
    }
    if (budget.files <= 0) {
      out.push({ object: f.object, kind: "not_checked", depth });
      continue;
    }
    budget.files--;
    if (isPdf(b)) {
      if (depth > maxDepth) {
        out.push({ object: f.object, kind: "too_deep", depth });
        continue;
      }
      const counts: Record<string, number> = {};
      let errors = 0;
      for (const d of detectors) {
        try {
          for (const item of await d(b)) counts[item.pattern] = (counts[item.pattern] ?? 0) + 1;
        } catch {
          errors++;
        }
      }
      const inner = await inspectAttachments(b, detectors, { maxDepth, depth, budget });
      // 中の添付の中で見つけた分も、この添付の数に足す（画面では添付ごとの合計を出す）
      // 中の PDF の添付そのものも、P9 として1件ずつ数える
      if (inner.length) counts.P9 = (counts.P9 ?? 0) + inner.length;
      for (const i of inner) for (const [p, n] of Object.entries(i.counts ?? {})) counts[p] = (counts[p] ?? 0) + n;
      const r: P9Inner = { object: f.object, kind: "pdf", counts, errors, depth };
      if (inner.length) r.inner = inner;
      out.push(r);
    } else if (looksText(f, b)) {
      out.push({ object: f.object, kind: "text", chars: textChars(b), depth });
    } else {
      out.push({ object: f.object, kind: "other", depth });
    }
  }
  return out;
}

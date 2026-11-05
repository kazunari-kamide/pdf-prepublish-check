// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧の絞り込みに使うタグ。タグごとに一覧のページ（/articles/tags/<slug>.html）を作るので、スクリプトなしで絞り込める。
// - 種類のタグ（型の解説・手順）と話題のタグは、記事の型の番号と slug から付ける（記事の側に書かなくてよい）。
// - 記事の側（articles.ts の tags）で足せるのは、TAGS にあるタグだけ（知らないタグは、ビルドで止める）。

import type { Article } from "./types.ts";

export interface Tag {
  /** 画面に出す名前 */
  label: string;
  /** 一覧のページの名前（/articles/tags/<slug>。ファイルは <slug>.html）。英小文字・数字・- だけ */
  slug: string;
  /** 種類か話題か（一覧で、分けて並べる） */
  group: "kind" | "topic";
}

export const TAGS: readonly Tag[] = [
  { label: "型の解説", slug: "patterns", group: "kind" },
  { label: "手順", slug: "guides", group: "kind" },
  { label: "黒塗り", slug: "redaction", group: "topic" },
  { label: "見えない字", slug: "hidden-text", group: "topic" },
  { label: "文書の情報", slug: "document-info", group: "topic" },
  { label: "前の版", slug: "old-versions", group: "topic" },
  { label: "注釈", slug: "annotations", group: "topic" },
  { label: "添付ファイル", slug: "attachments", group: "topic" },
  { label: "写真の情報", slug: "photos", group: "topic" },
  { label: "フォーム", slug: "forms", group: "topic" },
  { label: "スクリプト", slug: "scripts", group: "topic" },
  { label: "スキャン", slug: "scans", group: "topic" },
  { label: "ファイルを小さく", slug: "shrink", group: "topic" },
  { label: "Word・Excel・一太郎", slug: "office", group: "topic" },
];

/** 型の番号から付ける話題のタグ */
const BY_PATTERN: Record<string, string> = {
  P1: "文書の情報",
  P2: "文書の情報",
  P3: "文書の情報",
  P4: "文書の情報",
  P5: "前の版",
  P6: "黒塗り",
  P7: "見えない字",
  P8: "注釈",
  P9: "添付ファイル",
  P10: "写真の情報",
  P11: "フォーム",
  P12: "スクリプト",
};

/** 手順の記事の slug から付ける話題のタグ（slug の頭で見る） */
const BY_GUIDE: Array<[RegExp, string[]]> = [
  [/^guide-(word|excel|ichitaro)/, ["Word・Excel・一太郎", "文書の情報"]],
  [/^guide-acrobat-redaction/, ["黒塗り"]],
  [/^guide-scan/, ["スキャン", "黒塗り"]],
  [/^guide-photo/, ["写真の情報"]],
  [/^guide-shrink/, ["ファイルを小さく"]],
];

export function tagBySlug(slug: string): Tag | undefined {
  return TAGS.find((t) => t.slug === slug);
}

/** 記事に付くタグ（種類 → 話題の順。重ならない） */
export function articleTags(a: Article): Tag[] {
  const labels = [a.pattern ? "型の解説" : "手順"];
  if (a.pattern && BY_PATTERN[a.pattern]) labels.push(BY_PATTERN[a.pattern]!);
  if (!a.pattern) for (const [re, ls] of BY_GUIDE) if (re.test(a.slug)) labels.push(...ls);
  labels.push(...(a.tags ?? []));
  const out: Tag[] = [];
  for (const label of labels) {
    const t = TAGS.find((x) => x.label === label);
    if (!t) throw new Error(`記事 ${a.slug} のタグ「${label}」は、src/site/tags.ts の TAGS にありません`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export const tagPath = (t: Tag) => `/articles/tags/${t.slug}`;

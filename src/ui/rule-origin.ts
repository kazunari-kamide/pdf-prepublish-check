// SPDX-License-Identifier: AGPL-3.0-only
//
// ルール・型の出どころの札。見つける段（Claude Code が公開 PDF を読み、今のルールで捕まらない漏れ方を見つけた回）から来た型だけに、
// 「このルール：Claude が公開 PDF から見つけ、人が確かめて取り入れました（PR #N）」と出す。最初から人が書いたルール・型には出さない。
//
// 表は、docs/evolution.md・git log・PR の本文で、見つける段から来たと書いてあるものだけ（2026-11-05 に調べた）。
// 分からないものは載せない（推測で PR の番号を付けない）。
// PR へのリンクは、ページを移るだけ（通信の仕組みは足さない）。リポジトリの場所はコードに書かず、ビルドの時に入れる
// <meta name="omamori-repo">（site.ts）から読む。読めなければ、リンクにせず字だけにする。

export type RuleOrigin = {
  /** マージした PR の番号 */
  pr: number;
};

type OriginEntry = {
  ruleId: string;
  /** Item の kind（型の名前）。この中のものだけに札を出す */
  kinds: readonly string[];
  pr: number;
  /** 根拠（画面には出さない。表を直す人のため） */
  source: string;
};

export const RULE_ORIGINS: readonly OriginEntry[] = [
  {
    // スキャン画像の上に黒・白の四角や注釈を置いただけの型（fixtures/p6/p6-i03-scan-square-annotation.pdf など）
    ruleId: "p6-text",
    kinds: ["image"],
    pr: 43,
    source: "docs/evolution.md の p6-text 1.5.0（画像の層）の行。PR #43「見つける段で見つかった3つの型を、検出ルールにする」",
  },
  {
    // 白い四角の注釈の下の、線や形で描いた字（図形の層）
    ruleId: "p6-text",
    kinds: ["vector"],
    pr: 92,
    source: "rules/p6-text/README.md「見つける段の3回目で…見逃していた」。PR #92 の p6-text 1.13.0",
  },
  {
    // 注釈の作成者欄・内容・件名・リッチテキスト（1.0.0 の範囲。隠した注釈〔1.1.0〕と見た目の中の字〔1.2.0〕は除く）
    ruleId: "p8-annot",
    kinds: ["T", "Contents", "Subj", "RC"],
    pr: 43,
    source: "docs/evolution.md の p8-annot 1.0.0 の行。PR #43",
  },
  {
    // 部品の XMP の人名・パス・GPS と、アプリの編集用データ（1.0.0 の範囲。製造番号・機種〔1.2.0〕は除く）
    ruleId: "p2-parts",
    kinds: ["person", "path", "gps", "private_data"],
    pr: 43,
    source: "docs/evolution.md の p2-parts 1.0.0 の行。PR #43",
  },
];

/** ルールと型の名前から、出どころを引く。見つける段から来たと分かっているものだけ返す */
export function ruleOrigin(ruleId: string, kind: string | undefined): RuleOrigin | null {
  if (kind === undefined) return null;
  const e = RULE_ORIGINS.find((o) => o.ruleId === ruleId && o.kinds.includes(kind));
  return e ? { pr: e.pr } : null;
}

export const ORIGIN_TEXT = "このルール：Claude が公開 PDF から見つけ、人が確かめて取り入れました";

/** リポジトリの場所の形を確かめる（GitHub の「持ち主/名前」だけ。問い合わせ・#・それより深い道は受けない） */
export function parseRepo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.search || u.hash) return null;
  const path = u.pathname.replace(/\/$/, "");
  if (!/^\/[\w.-]+\/[\w.-]+$/.test(path)) return null;
  return `${u.origin}${path}`;
}

/** PR のページの場所。repo が null なら null */
export function prUrl(repo: string | null, pr: number): string | null {
  return repo ? `${repo}/pull/${pr}` : null;
}

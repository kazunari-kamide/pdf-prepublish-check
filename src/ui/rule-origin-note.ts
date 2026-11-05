// SPDX-License-Identifier: AGPL-3.0-only
//
// 出どころの札の部品（画面だけ。DOM を使う）。どの型に出すかの表と字は src/ui/rule-origin.ts。

import { ORIGIN_MARK, ORIGIN_TEXT, parseRepo, prUrl, type RuleOrigin } from "./rule-origin";

/**
 * リポジトリの場所（ビルドの時に入れた <meta name="omamori-repo">）。GitHub のリポジトリの形でなければ null。
 * 中身は利用者のファイルから来ないが、念のため形を確かめてからリンクにする
 */
export function repoFromMeta(doc: Document): string | null {
  return parseRepo(doc.querySelector('meta[name="omamori-repo"]')?.getAttribute("content"));
}

/**
 * 項目の下に置く、出どころの札（小さな 1 行）。字は textContent だけで入れる。
 * リンクは別のタブで開き、移る先に、このページの場所を渡さない（noreferrer）
 */
export function originNote(doc: Document, origin: RuleOrigin, repo: string | null): HTMLElement {
  const p = doc.createElement("p");
  p.className = "origin-note";
  const mark = doc.createElement("span");
  mark.className = "origin-mark";
  mark.textContent = ORIGIN_MARK;
  // 札の字は飾り。読み上げでは、続く文を読む（同じことを 2 回読ませない）
  mark.setAttribute("aria-hidden", "true");
  const text = doc.createElement("span");
  text.className = "origin-text";
  text.append(`${ORIGIN_TEXT}（`);
  const href = prUrl(repo, origin.pr);
  if (href) {
    const a = doc.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `PR #${origin.pr}`;
    a.setAttribute("aria-label", `PR ${origin.pr} 番（GitHub。新しいタブで開きます）`);
    text.append(a);
  } else {
    text.append(`PR #${origin.pr}`);
  }
  text.append("）");
  p.append(mark, text);
  return p;
}

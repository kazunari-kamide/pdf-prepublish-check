// SPDX-License-Identifier: AGPL-3.0-only
//
// 前の回に却下された候補を読む（2026-11-07 本人の決定）。
// 本人は、ループの PR を閉じるときに「却下：〈理由〉」で始まるコメントを書く。ループは始めに gh で、
// ラベル ratchet の付いた、マージされずに閉じた PR を読み、型と理由だけを取り出して、候補を出す Claude にデータとして渡す。
// 同じ候補を挙げ直したら、反証の段で「前に却下された」として落とす。
// 読むのは、リポジトリの持ち主（authorAssociation が OWNER）が書いたコメントだけ。公開のリポジトリなので、
// ほかの人の「却下：」を読むと、ループの候補を外から抑えたり、プロンプトに指示を入れたりできてしまう（2026-11-07 本人の決定）。

import { spawnSync } from "node:child_process";

export const LABEL = "ratchet";

export type Rejection = { pr: number; pattern: string | null; title: string; reason: string };

export type GhComment = { body: string; author?: { login?: string } | null; authorAssociation?: string };

type GhPr = { number: number; title: string; mergedAt: string | null; comments: GhComment[] };

/** 却下として読んでよいコメントか。持ち主（OWNER）が書いたものだけ。書いた人が分からないものは読まない */
export function fromOwner(c: GhComment): boolean {
  return c.authorAssociation === "OWNER" && typeof c.author?.login === "string" && c.author.login.length > 0;
}

/** PR の題から型を読む（ループの PR の題は「Ratchet：P6 …」の形で出す） */
export function patternOf(title: string): string | null {
  return /\b(P\d{1,2}|NEW)\b/.exec(title)?.[1] ?? null;
}

/** 持ち主のコメントから「却下：」の理由を取り出す（最後のものを使う）。無ければ null。持ち主以外のコメントは読まない */
export function reasonOf(comments: GhComment[]): string | null {
  let found: string | null = null;
  for (const c of comments) {
    if (!fromOwner(c)) continue;
    for (const line of String(c.body ?? "").split(/\r?\n/)) {
      const m = /^\s*却下[：:]\s*(.+)$/.exec(line);
      if (m) found = m[1]!.trim().slice(0, 200);
    }
  }
  return found;
}

/** stats を渡すと、読まずに捨てた持ち主以外のコメントの数を ignored に足す（中身は残さない） */
export function parseRejections(prs: GhPr[], stats?: { ignored: number }): Rejection[] {
  const out: Rejection[] = [];
  for (const p of prs) {
    if (p.mergedAt) continue;
    if (stats) stats.ignored += (p.comments ?? []).filter((c) => !fromOwner(c)).length;
    const reason = reasonOf(p.comments ?? []);
    if (!reason) continue;
    out.push({ pr: p.number, pattern: patternOf(p.title), title: p.title.slice(0, 120), reason });
  }
  return out;
}

/** gh で読む。gh が無い・失敗したときは空にして、そのことを返す（ループは止めない。記録に残す） */
export function loadRejections(cwd: string): { list: Rejection[]; note: string | null } {
  const r = spawnSync("gh", ["pr", "list", "--state", "closed", "--label", LABEL, "--limit", "100", "--json", "number,title,mergedAt,comments"], {
    cwd, encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  if (r.status !== 0) return { list: [], note: "却下の理由を gh で読めなかった" };
  try {
    // gh の comments には author と authorAssociation が入る（持ち主が書いたかを確かめるのに使う）
    const stats = { ignored: 0 };
    const list = parseRejections(JSON.parse(r.stdout), stats);
    return { list, note: stats.ignored ? `持ち主以外のコメント ${stats.ignored} 件を読まずに捨てた` : null };
  } catch {
    return { list: [], note: "却下の理由の形を読めなかった" };
  }
}

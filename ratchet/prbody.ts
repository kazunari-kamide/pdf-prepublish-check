// SPDX-License-Identifier: AGPL-3.0-only
//
// ループの PR の本文（docs/ratchet.md §3.5）。形は固定：何の型か、Claude の判断、採点表、歯止めの結果、捨てた案、その回の費用、
// docs/evolution.md に足す行。動画の字幕にそのまま使うので、短い平易な日本語にする。
// 出す前に、本文に「手元のパス」「束のファイル名」「束の置き場所」が混ざっていないかを確かめ、混ざっていたら出さない（findLeaks）。

import { basename } from "node:path";
import type { GateResult } from "./gate.ts";

export type Candidate = { id: string; pattern: string; title: string; nearestRule: string; whyMissed: string; evidenceCount: number; fixturePlan: string; evidenceIds?: string[] };

export type PrInput = {
  date: string;
  runId: string;
  candidate: Candidate;
  refute: { reason: string; explanation: string };
  write: { ruleId: string; summary: string; discarded: string };
  gate: GateResult;
  attempts: number;
  counts: { read: number; skipped: number; suspicions: number; candidates: number; refuted: number };
  calls: Record<string, number>;
  costUsd: number;
  /** 役ごとに、実際に使った呼び方とモデル ID（claude.ts の Caller.used）。無ければ claude -p だけの回として書く */
  used?: Partial<Record<string, { via: "api" | "cli"; model: string }>>;
  /** 根拠の実物にかけた件数（ratchet/evidence.ts）。loose は、根拠の番号でなく人が渡した一覧で確かめたとき。null は確かめていない */
  evidence?: { total: number; hit: number; loose: boolean } | null;
};

const ROLE_NAME: Record<string, string> = { skim: "下読み", judge: "判断", refute: "反証", write: "ルール書き" };

/** 呼び方の 1 文。段ごとに Claude API か claude -p か、どのモデルか */
export function viaLine(used: PrInput["used"]): string {
  if (!used || !Object.keys(used).length) return "claude -p";
  return ["skim", "judge", "refute", "write"]
    .flatMap((r) => (used[r] ? [`${ROLE_NAME[r]}は ${used[r]!.via === "api" ? "Claude API（Messages API）" : "claude -p"}・${used[r]!.model}`] : []))
    .join("、");
}

/** 費用の数え方の 1 文 */
function costNote(used: PrInput["used"]): string {
  const vias = new Set(Object.values(used ?? {}).map((u) => u?.via));
  if (vias.has("api") && vias.has("cli")) return "Claude API が返した使った量から数えた額と、claude -p が返した額の合計";
  if (vias.has("api")) return "Claude API が返した使った量から数えた額の合計";
  return "claude -p が返した額の合計";
}

/** 根拠の実物の結果の 1 文（件数だけ） */
export function evidenceLine(e: PrInput["evidence"]): string {
  if (!e) return "確かめていない（根拠の実物を渡していない）";
  const s = `根拠 ${e.total} 件のうち ${e.hit} 件で当たった`;
  return e.loose ? `${s}（根拠の番号が記録に無い回なので、人が渡した ${e.total} 件の一覧で確かめた。本来の「候補が挙げた根拠」よりゆるい）` : s;
}

const md = (s: string) => s.replaceAll("|", "／").replaceAll("\n", " ");

export function prTitle(p: PrInput): string {
  return `Ratchet：${p.candidate.pattern} ${p.candidate.title}`.slice(0, 120);
}

export function renderPrBody(p: PrInput): string {
  const g = p.gate;
  const lines = [
    `## 何の型か`,
    ``,
    `${p.candidate.pattern}：${p.candidate.title}（ルール \`${p.write.ruleId}\`）`,
    ``,
    `## Claude の判断`,
    ``,
    `- なぜ怪しいと見たか：${p.candidate.whyMissed}`,
    `- いちばん近い今のルールと、それでは足りない理由：${p.candidate.nearestRule}`,
    `- 根拠：束の中の ${p.candidate.evidenceCount} 件（番号だけで数えた。どの PDF かは書かない）`,
    `- 反証の結果：${p.refute.reason}。${p.refute.explanation}`,
    `- 作った合成 PDF：${p.candidate.fixturePlan}`,
    `- 書いたもの：${p.write.summary}`,
    ``,
    `## 採点表（main → この PR）`,
    ``,
    `| 型 | 前 | 後 | 変化 |`,
    `|---|---|---|---|`,
    ...g.table.filter((r) => r.change !== "同じ").map((r) => `| ${md(r.key)} | ${md(r.before)} | ${md(r.after)} | ${r.change} |`),
    ...(p.evidence !== undefined ? [`| 根拠の実物（新しいルール \`${md(p.write.ruleId)}\`） | — | ${p.evidence ? `${p.evidence.total} 件のうち ${p.evidence.hit} 件で当たった` : "確かめていない"} | 新しい |`] : []),
    ``,
    `変わらなかった型：${g.table.filter((r) => r.change === "同じ").length} 個`,
    ``,
    `## 歯止めの結果`,
    ``,
    `- 良くなった所：${g.improved.length ? g.improved.join("、") : "なし"}`,
    `- 下がった所：${g.declined.length ? g.declined.join("、") : "なし"}`,
    ...(p.evidence !== undefined ? [`- 根拠の実物：${evidenceLine(p.evidence)}`] : []),
    `- 判定：${g.pass ? "通った（どれも下がらず、1 つ以上良くなった）" : `通らない（${g.reasons.join("、")}）`}`,
    `- 直した回数：${p.attempts} 回（上限 3 回）`,
    ``,
    `## 捨てた案`,
    ``,
    `- ${p.write.discarded}`,
    ``,
    `## この回の量と費用`,
    ``,
    `- 読んだ PDF：${p.counts.read} 件（調べきれずに省いた ${p.counts.skipped} 件は、数に入れていない）`,
    `- 下読みの疑い：${p.counts.suspicions} 件 → 候補 ${p.counts.candidates} 件 → 反証で落とした ${p.counts.refuted} 件`,
    `- 呼び出し：下読み ${p.calls.skim ?? 0} 回・判断 ${p.calls.judge ?? 0} 回・反証 ${p.calls.refute ?? 0} 回・ルール書き ${p.calls.write ?? 0} 回`,
    `- 呼び方：${viaLine(p.used)}`,
    `- 費用：${p.costUsd.toFixed(2)} ドル（${costNote(p.used)}）`,
    ``,
    `## docs/evolution.md に足す行`,
    ``,
    `| ${p.date} | ${p.write.ruleId} | ${md(beforeAfter(g, "検出"))} | ${md(beforeAfter(g, "誤検知"))} | ${md(p.write.summary).slice(0, 120)} | ${md(p.candidate.whyMissed).slice(0, 80)} | ${md(p.write.discarded).slice(0, 80)} |`,
    ``,
    `マージは人が決めます。入れないときは、「却下：〈理由〉」で始まるコメントを書いてから閉じてください（次の回に読みます）。`,
    ``,
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ];
  return lines.join("\n");
}

function beforeAfter(g: GateResult, what: "検出" | "誤検知"): string {
  const r = g.table.find((x) => x.change !== "同じ");
  if (!r) return "—";
  const pick = (s: string) => (what === "検出" ? /検出 [^・]+/.exec(s)?.[0] : /誤検知 [^・]+/.exec(s)?.[0]) ?? "—";
  return `${pick(r.before)} → ${pick(r.after)}`;
}

/** 本文に、出してはいけない字が混ざっていないかを確かめる。見つかった種類だけを返す（中身は返さない） */
export function findLeaks(text: string, opts: { secrets: string[]; files: string[] }): string[] {
  const found: string[] = [];
  // ドライブの文字は、前が英字でない 1 文字だけ（staff:/ のような字を、パスと見まちがえない）
  if (/(^|[^A-Za-z0-9_])[A-Za-z]:[\\/][^\s]/.test(text) || /(^|[\s(（`])\/(Users|home|mnt|tmp)\//.test(text)) found.push("手元のパス");
  const norm = (s: string) => s.replaceAll("\\", "/").toLowerCase();
  const t = norm(text);
  for (const s of opts.secrets) if (s && t.includes(norm(s))) found.push("束の置き場所");
  for (const f of opts.files) {
    const b = basename(f).toLowerCase();
    const stem = b.replace(/\.pdf$/i, "");
    if (stem.length >= 4 && t.includes(stem)) {
      found.push("束のファイル名");
      break;
    }
  }
  if (/[0-9a-f]{64}/i.test(text)) found.push("ファイルの sha256");
  return [...new Set(found)];
}

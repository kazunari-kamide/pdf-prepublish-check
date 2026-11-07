// SPDX-License-Identifier: AGPL-3.0-only
//
// Ratchet の 1 回分のループ（docs/ratchet.md §3）の設定。
// 置き場所は環境変数でだけ受け取る（原文の公開 PDF の場所をリポジトリに入れない。CLAUDE.md §2-7）。
// 上限の値は 2026-11-07 本人の決定：直す回数 3 回、費用は呼び出しの回数でかける（合成の束で測ってから値を決める）、
// 下読みは Haiku 5.5、判断・反証・ルール書きは Opus 5.5。
// 呼び方の既定は api（下読み・判断・反証は Claude API の Messages API、ルール書きは claude -p。2026-11-07 夜 本人の決定）。

export type Limits = {
  /** 1 回に読む数（docs/ratchet.md §3.1。まず 50 件） */
  bundleSize: number;
  /** 呼び出しの回数の上限 */
  skimCalls: number;
  judgeCalls: number;
  writeCalls: number;
  /** 候補 1 件を直す回数の上限（最初に書く 1 回は数えない） */
  fixAttempts: number;
  /** 1 回のループでルールにまで進める候補の数 */
  maxCandidates: number;
  /** 1 回の呼び出しにかけてよい金額（claude -p の --max-budget-usd。API では出力の長さの上限に直してかける）。値は合成の束で測ってから決める【要確認】。null なら付けない */
  perCallBudgetUsd: number | null;
  /** 1 回のループ全体の金額の上限。値は合成の束で測ってから決める【要確認】。null なら回数の上限だけ */
  runBudgetUsd: number | null;
};

export const DEFAULT_LIMITS: Limits = {
  bundleSize: 50,
  skimCalls: 50,
  judgeCalls: 10,
  writeCalls: 9,
  fixAttempts: 3,
  maxCandidates: 3,
  perCallBudgetUsd: null,
  runBudgetUsd: null,
};

export const MODELS = {
  skim: "claude-haiku-5-5",
  judge: "claude-opus-5-5",
  refute: "claude-opus-5-5",
  write: "claude-opus-5-5",
} as const;

/** 呼び方の既定 */
export const DEFAULT_VIA = "api" as const;

/** --via の値を読む。api か cli だけ */
export function viaFrom(v: string | undefined): "api" | "cli" {
  if (v === undefined || v === "") return DEFAULT_VIA;
  if (v === "api" || v === "cli") return v;
  throw new Error(`--via は api か cli です：${v}`);
}

export type Env = {
  /** 公開 PDF の束のフォルダ */
  corpus: string;
  /** 採点用の実データの sha256 の一覧（1 行に 1 つ）。無ければ除くものなし */
  exclude: string | null;
  /** 読んだ記録・ログを置くフォルダ（リポジトリの外） */
  state: string;
};

export const ENV_NAMES = {
  corpus: "OMAMORI_RATCHET_CORPUS",
  exclude: "OMAMORI_RATCHET_EXCLUDE",
  state: "OMAMORI_RATCHET_STATE",
} as const;

/** 環境変数を読む。足りないときは、変数の名前だけを出して止める（値は出さない） */
export function readEnv(env: Record<string, string | undefined> = process.env): Env {
  const corpus = env[ENV_NAMES.corpus];
  const state = env[ENV_NAMES.state];
  const missing = [!corpus && ENV_NAMES.corpus, !state && ENV_NAMES.state].filter(Boolean);
  if (missing.length) throw new Error(`環境変数がありません：${missing.join("、")}`);
  return { corpus: corpus!, state: state!, exclude: env[ENV_NAMES.exclude] || null };
}

function num(v: string | undefined, fallback: number | null): number | null {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`数ではない値です：${v}`);
  return n;
}

/** 上限を、コマンドの選択肢で上書きする（--bundle 5 など）。上げる方向にも動かせるが、既定は本人の決定の値 */
export function limitsFrom(opts: Record<string, string | undefined>): Limits {
  const d = DEFAULT_LIMITS;
  return {
    bundleSize: num(opts.bundle, d.bundleSize)!,
    skimCalls: num(opts["skim-calls"], d.skimCalls)!,
    judgeCalls: num(opts["judge-calls"], d.judgeCalls)!,
    writeCalls: num(opts["write-calls"], d.writeCalls)!,
    fixAttempts: num(opts["fix-attempts"], d.fixAttempts)!,
    maxCandidates: num(opts["max-candidates"], d.maxCandidates)!,
    perCallBudgetUsd: num(opts["call-budget"], d.perCallBudgetUsd),
    runBudgetUsd: num(opts["run-budget"], d.runBudgetUsd),
  };
}

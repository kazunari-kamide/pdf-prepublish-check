// SPDX-License-Identifier: AGPL-3.0-only
//
// Claude API（Messages API）で、道具を使わない段（下読み・判断・反証）を呼ぶ層（2026-11-07 本人の決定）。
// - 答えは決めた JSON スキーマ（output_config.format）で返させ、claude.ts でもう一度確かめる。合わなければ捨てる。
// - 道具は 1 つも渡さない。PDF から取り出した中身に指示が埋め込まれていても、何もできない（CLAUDE.md §11-5）。
// - API キーは環境変数 ANTHROPIC_API_KEY からだけ読み、明示して渡す。ほかの資格情報（ANTHROPIC_AUTH_TOKEN・プロフィール）は使わない。
//   送り先も既定の API に固定する（ANTHROPIC_BASE_URL で、キーをほかへ送らせない）。キーの値は、記録・ログ・エラーの文に出さない。
// - 費用は、API が返す使った量（usage）に、下の値段の表を掛けて数える。
// - effort は付けない（Opus 5.5・Haiku 5.5 とも既定の medium。本人の決定）。記録には "medium（既定）" と残す。
// - 答えを断ったとき（refusal）にほかのモデルへ回す仕組み（fallbacks）は使わない。決めたモデルの使い分けを変えないため。

import Anthropic from "@anthropic-ai/sdk";
import type { Schema } from "./schema.ts";

export const API_KEY_ENV = "ANTHROPIC_API_KEY";
export const API_BASE_URL = "https://api.anthropic.com";
/** 記録に残す effort（何も付けないときの既定の値） */
export const API_EFFORT = "medium（既定）";
/** 1 回の答えの長さの上限（考える分も入る）。1 回の呼び出しの金額の上限は、これを下げてかける */
export const API_MAX_TOKENS = 32_000;

/** 1M トークンあたりのドル。2026-10-06 時点の公開の値段（入力・出力）。Haiku 5.5 は入力が 10 万トークンを超えると上の段 */
export const PRICES: Record<string, { input: number; output: number; over?: { above: number; input: number; output: number } }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, over: { above: 100_000, input: 0.5, output: 2.5 } },
};

export type ApiUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** 使った量から費用（ドル）を数える。値段の表にないモデルは数えられないので null */
export function costOf(model: string, u: ApiUsage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const prompt = u.input_tokens + write + read;
  const rate = p.over && prompt > p.over.above ? p.over : p;
  // キャッシュの書き込みは入力の 1.25 倍、読み出しは 0.1 倍
  return (u.input_tokens * rate.input + write * rate.input * 1.25 + read * rate.input * 0.1 + u.output_tokens * rate.output) / 1_000_000;
}

/** 1 回の呼び出しの金額の上限から、出力の長さの上限を決める（出力の値段で割る。入力の分は見込まない） */
export function maxTokensFor(model: string, budgetUsd: number | null | undefined): number {
  const p = PRICES[model];
  if (budgetUsd == null || !p) return API_MAX_TOKENS;
  return Math.max(1024, Math.min(API_MAX_TOKENS, Math.floor((budgetUsd / p.output) * 1_000_000)));
}

/**
 * API に渡すスキーマ。構造化出力が受け付けない制約（長さ・数の上下限・配列の数）を外す。
 * 外した制約は、答えが返ったあと validate で確かめる。
 */
export function toApiSchema(s: Schema): Record<string, unknown> {
  switch (s.type) {
    case "object":
      return {
        type: "object",
        properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toApiSchema(v)])),
        required: s.required,
        additionalProperties: false,
      };
    case "array":
      return { type: "array", items: toApiSchema(s.items) };
    case "string":
      return s.enum ? { type: "string", enum: s.enum } : { type: "string" };
    case "integer":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
  }
}

export type ApiRequest = { model: string; text: string; schema: Schema; maxTokens: number; timeoutMs: number };

/** API の 1 回分の答え。中身の文（JSON のはず）と、止まった理由と、使った量 */
export type ApiReply =
  | { ok: true; text: string; stopReason: string | null; usage: ApiUsage }
  | { ok: false; detail: string; usage: ApiUsage | null };

/** API の 1 回分を呼ぶ道具。テストでは差し替える（本物の API は呼ばない） */
export type ApiSend = (r: ApiRequest) => Promise<ApiReply>;

/** API キーを読む。無ければ変数の名前だけを出して止める（値は出さない） */
export function readApiKey(env: Record<string, string | undefined> = process.env): string {
  const k = env[API_KEY_ENV];
  if (!k) throw new Error(`環境変数がありません：${API_KEY_ENV}`);
  return k;
}

/** エラーを、種類と状態コードだけの短い文にする（文の中身にキーや送ったものが混ざらないように、message は使わない） */
export function errorDetail(e: unknown): string {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "API 時間切れ";
  if (e instanceof Anthropic.APIConnectionError) return "API につながらない";
  if (e instanceof Anthropic.APIError) return `API ${e.status ?? "状態なし"}${e.type ? ` ${e.type}` : ""}`;
  return "API の呼び出しで止まった";
}

/** 本物の API を呼ぶ道具。キーは呼ぶときにだけ読む */
export function realApiSend(env: Record<string, string | undefined> = process.env): ApiSend {
  let client: Anthropic | null = null;
  return async (r) => {
    client ??= new Anthropic({ apiKey: readApiKey(env), baseURL: API_BASE_URL, maxRetries: 2 });
    try {
      // 答えが長くなっても HTTP が時間切れにならないよう、流して受け取り、最後にまとめる
      const msg = await client.messages
        .stream(
          {
            model: r.model,
            max_tokens: r.maxTokens,
            messages: [{ role: "user", content: r.text }],
            output_config: { format: { type: "json_schema", schema: toApiSchema(r.schema) } },
          },
          { timeout: r.timeoutMs },
        )
        .finalMessage();
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { ok: true, text, stopReason: msg.stop_reason, usage: msg.usage };
    } catch (e) {
      return { ok: false, detail: errorDetail(e), usage: null };
    }
  };
}

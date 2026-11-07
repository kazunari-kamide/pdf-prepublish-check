// SPDX-License-Identifier: AGPL-3.0-only
//
// Claude の答えの形（JSON スキーマ）と、形に合わない答えを捨てる確かめ（CLAUDE.md §5・§11-5）。
// claude -p の --json-schema にも同じスキーマを渡すが、向こうの確かめを信じきらず、ここでもう一度確かめる。
// 確かめ方は、ここで使う形（object・array・string・integer・boolean・enum・最大の長さ）だけに絞った小さなもの。

export type Schema =
  | { type: "object"; properties: Record<string, Schema>; required: string[]; additionalProperties: false }
  | { type: "array"; items: Schema; maxItems?: number }
  | { type: "string"; maxLength?: number; enum?: string[] }
  | { type: "integer"; minimum?: number; maximum?: number }
  | { type: "boolean" };

const str = (maxLength: number): Schema => ({ type: "string", maxLength });
const int = (minimum = 0, maximum = 1_000_000): Schema => ({ type: "integer", minimum, maximum });
const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** 型の番号。P1〜P12 と、新しい型の案（NEW） */
export const PATTERNS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12", "NEW"];

/** 下読み（Haiku）：PDF 1 件の構造の要約から、今のルールで捕まっていない疑いを挙げる */
export const SKIM: Schema = obj({
  suspicions: {
    type: "array",
    maxItems: 5,
    items: obj({
      pattern: { type: "string", enum: PATTERNS },
      /** どの構造の手がかりから疑ったか（団体をたどれない言い方。値は書かない） */
      signal: str(200),
      /** 今のルールの報告に、同じものがすでにあるか */
      alreadyReported: { type: "boolean" },
    }),
  },
});

/** 判断（Opus）：束全体の下読みをまとめて、候補にする */
export const CANDIDATES: Schema = obj({
  candidates: {
    type: "array",
    maxItems: 10,
    items: obj({
      id: str(40),
      pattern: { type: "string", enum: PATTERNS },
      title: str(80),
      /** いちばん近い今のルール（一覧の id。無ければ「なし」）と、それでは足りない理由を 1 文 */
      nearestRule: str(300),
      /** なぜ今のルールで捕まらないか */
      whyMissed: str(400),
      /** 根拠になった束の中の件数（番号 b01 などの数だけ） */
      evidenceCount: int(0, 1000),
      /** 根拠にした束の番号（b01 など）。その回に下読みした番号だけを受け付ける（ratchet/evidence.ts） */
      evidenceIds: { type: "array", maxItems: 60, items: str(8) },
      /** 作る合成 PDF の案（架空の中身だけ） */
      fixturePlan: str(600),
    }),
  },
});

/** 反証（Opus）：候補 1 件を落とすか */
export const REFUTE: Schema = obj({
  keep: { type: "boolean" },
  reason: { type: "string", enum: ["残す", "もう捕まる", "漏れではない", "合成で再現できない", "前に却下された"] },
  explanation: str(400),
});

/** ルール書き（Opus）が最後に返す報告 */
export const WRITE_REPORT: Schema = obj({
  ruleId: str(60),
  changedFiles: { type: "array", maxItems: 40, items: str(200) },
  summary: str(600),
  /** 捨てた案（1 つ） */
  discarded: str(300),
  /** 今あるルールで足りると分かったときだけ、そのルールの id（書かずに返す）。書いたときは空 */
  alreadyCovered: str(60),
});

export type ValidationError = { path: string; message: string };

/** 形に合うかを確かめる。合わない所を並べて返す（空なら合う） */
export function validate(schema: Schema, value: unknown, path = "$"): ValidationError[] {
  const errs: ValidationError[] = [];
  const bad = (message: string) => errs.push({ path, message });
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [{ path, message: "object ではない" }];
      const v = value as Record<string, unknown>;
      for (const k of schema.required) if (!(k in v)) errs.push({ path: `${path}.${k}`, message: "ない" });
      for (const k of Object.keys(v)) {
        const s = schema.properties[k];
        if (!s) errs.push({ path: `${path}.${k}`, message: "決めていない欄" });
        else errs.push(...validate(s, v[k], `${path}.${k}`));
      }
      break;
    }
    case "array":
      if (!Array.isArray(value)) return [{ path, message: "array ではない" }];
      if (schema.maxItems !== undefined && value.length > schema.maxItems) bad(`多すぎる（${value.length}）`);
      value.forEach((x, i) => errs.push(...validate(schema.items, x, `${path}[${i}]`)));
      break;
    case "string":
      if (typeof value !== "string") return [{ path, message: "string ではない" }];
      if (schema.maxLength !== undefined && [...value].length > schema.maxLength) bad("長すぎる");
      if (schema.enum && !schema.enum.includes(value)) bad("決めた値ではない");
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return [{ path, message: "整数ではない" }];
      if (schema.minimum !== undefined && value < schema.minimum) bad("小さすぎる");
      if (schema.maximum !== undefined && value > schema.maximum) bad("大きすぎる");
      break;
    case "boolean":
      if (typeof value !== "boolean") bad("boolean ではない");
      break;
  }
  return errs;
}

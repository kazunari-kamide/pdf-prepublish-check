// SPDX-License-Identifier: AGPL-3.0-only
//
// 歯止め（docs/ratchet.md §3.4）。main と候補の数を比べて、PR にしてよいかを決める。
//   1. 合格基準：変わった型・新しい型は、検出率 95% 以上・誤検知率 5% 以下。合格基準のある型は、片付けたあとに残る情報 0 件。
//   2. どれも下がらず、少なくとも 1 つは良くなる。すべてが同じなら「良くなった所がない」として入れない。
//   3. npm test・npm run build が通る。外への要求が 0 件のまま（check:browser の結果は呼ぶ側が渡す）。
// あわせて、候補が「採点する側」を変えていないかを、main との差分のファイルで確かめる（ルールの側の採点の数を、
// 合成 PDF を書き換えて良く見せることを止める）。

import type { Metrics, TypeScore } from "./metrics.ts";

export const THRESHOLDS = { recallMin: 0.95, falsePositiveRateMax: 0.05, residualMax: 0 };

export type GateResult = {
  pass: boolean;
  /** 入れない理由（平易な日本語。1 つ以上あれば pass は false） */
  reasons: string[];
  improved: string[];
  declined: string[];
  table: Array<{ key: string; before: string; after: string; change: "上がった" | "下がった" | "同じ" | "新しい" }>;
};

const rate = (t: TypeScore) => (t.expected ? t.found / t.expected : null);
const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const show = (t: TypeScore | undefined) =>
  t ? `検出 ${t.found}/${t.expected}（${pct(rate(t))}）・誤検知 ${t.falsePositives} 件（${pct(t.falsePositiveRate)}）${t.residual == null ? "" : `・残り ${t.residual}`}` : "—";

function meetsThreshold(t: TypeScore): string | null {
  const r = rate(t);
  if (r == null) return `${t.key}：隠しの入った合成 PDF がない`;
  if (r < THRESHOLDS.recallMin) return `${t.key}：検出率 ${pct(r)} が 95% に届かない`;
  if (t.falsePositiveRate == null) return `${t.key}：対照（隠しのない合成 PDF）がなく、誤検知率を測れない`;
  if (t.falsePositiveRate > THRESHOLDS.falsePositiveRateMax) return `${t.key}：誤検知率 ${pct(t.falsePositiveRate)} が 5% を超える`;
  if (t.source === "rubric" && t.residual != null && t.residual > THRESHOLDS.residualMax) return `${t.key}：片付けたあとに ${t.residual} 件残る`;
  return null;
}

export function compareMetrics(base: Metrics, cand: Metrics, browser: { ok: boolean; external: number | null } | null): GateResult {
  const reasons: string[] = [];
  const improved: string[] = [];
  const declined: string[] = [];
  const table: GateResult["table"] = [];

  if (!cand.test.ok) reasons.push(`npm test が通らない（落ちた ${cand.test.failed ?? "?"} 件）`);
  if (!cand.build.ok) reasons.push("npm run build が通らない");
  if (cand.errors.length) reasons.push(`採点が終わらない所がある（${cand.errors.join("、")}）`);
  if (!browser) reasons.push("外への要求の確かめ（check:browser）を流していない");
  else if (!browser.ok || browser.external !== 0) reasons.push(`外への要求が 0 件ではない（${browser.external ?? "数えられない"}）`);

  const cmap = new Map(cand.types.map((t) => [t.key, t]));
  for (const b of base.types) {
    const c = cmap.get(b.key);
    if (!c) {
      declined.push(`${b.key}：採点から消えた`);
      table.push({ key: b.key, before: show(b), after: "—", change: "下がった" });
      continue;
    }
    if (c.expected !== b.expected) {
      reasons.push(`${b.key}：合成 PDF の隠しの数が変わった（${b.expected} → ${c.expected}）。今ある型の採点の材料は変えない`);
    }
    let up = false;
    let down = false;
    const rb = rate(b) ?? 0;
    const rc = rate(c) ?? 0;
    if (rc < rb) (down = true), declined.push(`${b.key}：検出率 ${pct(rb)} → ${pct(rc)}`);
    if (rc > rb) (up = true), improved.push(`${b.key}：検出率 ${pct(rb)} → ${pct(rc)}`);
    if (c.falsePositives > b.falsePositives) (down = true), declined.push(`${b.key}：誤検知 ${b.falsePositives} → ${c.falsePositives} 件`);
    if (c.falsePositives < b.falsePositives) (up = true), improved.push(`${b.key}：誤検知 ${b.falsePositives} → ${c.falsePositives} 件`);
    if (b.residual != null) {
      if (c.residual == null) (down = true), declined.push(`${b.key}：片付けたあとの残りを測れなくなった`);
      else if (c.residual > b.residual) (down = true), declined.push(`${b.key}：片付けたあとの残り ${b.residual} → ${c.residual}`);
      else if (c.residual < b.residual) (up = true), improved.push(`${b.key}：片付けたあとの残り ${b.residual} → ${c.residual}`);
    }
    if (up || down) {
      const miss = meetsThreshold(c);
      if (miss) reasons.push(miss);
    }
    table.push({ key: b.key, before: show(b), after: show(c), change: down ? "下がった" : up ? "上がった" : "同じ" });
  }
  const bkeys = new Set(base.types.map((t) => t.key));
  for (const c of cand.types) {
    if (bkeys.has(c.key)) continue;
    const miss = meetsThreshold(c);
    if (miss) reasons.push(miss);
    else improved.push(`${c.key}：新しい型（${show(c)}）`);
    table.push({ key: c.key, before: "—", after: show(c), change: "新しい" });
  }
  if (base.blind && cand.blind) {
    if (cand.blind.pass < base.blind.pass) declined.push(`見ないで作るテスト集の「合」：${base.blind.pass} → ${cand.blind.pass}`);
    if (cand.blind.pass > base.blind.pass) improved.push(`見ないで作るテスト集の「合」：${base.blind.pass} → ${cand.blind.pass}`);
  } else if (base.blind && !cand.blind) declined.push("見ないで作るテスト集を測れなくなった");

  // マージしたら検査器に入るか：新しい型があるなら、画面の一覧（RULES）にルールが増えていること。今あるルールは消えないこと
  const newTypes = cand.types.filter((c) => !bkeys.has(c.key)).length;
  if (base.ruleIds !== undefined || cand.ruleIds !== undefined) {
    if (!base.ruleIds || !cand.ruleIds) reasons.push("画面の一覧（RULES）のルールを読めない");
    else {
      const gone = base.ruleIds.filter((id) => !cand.ruleIds!.includes(id));
      if (gone.length) reasons.push(`画面の一覧（RULES）からルールが消えた（${gone.join("、")}）`);
      const added = cand.ruleIds.filter((id) => !base.ruleIds!.includes(id));
      if (newTypes && !added.length) reasons.push("新しい型のルールが、画面の一覧（RULES）に入っていない（マージしても検査器に入らない）");
    }
  }

  if (declined.length) reasons.push(`下がった所がある（${declined.length} か所）`);
  if (!declined.length && !improved.length) reasons.push("良くなった所がない");
  return { pass: reasons.length === 0, reasons, improved, declined, table };
}

/** git diff --name-status の 1 行 */
export type DiffEntry = { status: string; path: string };

/** ファイルごとの、足した行と消した行の数（git diff --numstat） */
export type LineCounts = Record<string, { added: number; removed: number }>;

/**
 * ルールの一覧を固定で並べている所。新しいルールを RULES に足すと、ここにも 1 行足さないとテストが落ちる。
 * ループには「1 行足すだけ」を許す（2026-11-07 本人の決定）。消す・書き換えるのは許さない。
 */
export const ADD_ONE_LINE = ["tests/inspect-all.test.ts", "src/ui/fuda.ts"];

/**
 * 候補が変えてよいファイルかを確かめる。返すのは、変えてはいけない所の一覧（空なら良い）。
 * lines：ファイルごとの足した行・消した行の数
 */
export function checkDiff(entries: DiffEntry[], lines: LineCounts): string[] {
  const bad: string[] = [];
  const count = (p: string) => lines[p] ?? { added: 0, removed: 0 };
  for (const { status, path } of entries) {
    const s = status[0];
    const p = path.replaceAll("\\", "/");
    const add = s === "A";
    const mod = s === "M";
    let ok = false;
    if (p.startsWith("rules/")) ok = add || mod;
    else if (p === "src/inspect/rules.ts") ok = mod;
    else if (p === "eval/cases/registry.ts") ok = mod && count(p).removed === 0;
    else if (ADD_ONE_LINE.includes(p)) {
      ok = mod && count(p).removed === 0 && count(p).added === 1;
      if (!ok) {
        bad.push(`${s} ${p}（1 行足すだけにする。足した ${count(p).added} 行・消した ${count(p).removed} 行）`);
        continue;
      }
    }
    else if (/^eval\/cases\/[^/]+\.ts$/.test(p)) ok = add;
    else if (p.startsWith("proposals/") && !p.startsWith("proposals/blind/")) ok = add || mod;
    else if (p.startsWith("tests/")) ok = add;
    else if (p.startsWith("sanitize/")) ok = add || mod;
    if (!ok) bad.push(`${s} ${p}`);
  }
  // 新しいルールは、画面の一覧（src/inspect/rules.ts の RULES）にも足す。足さないと、マージしても検査器に入らない
  const newRule = entries.some((e) => e.status[0] === "A" && /^rules\/[^/]+\/index\.ts$/.test(e.path.replaceAll("\\", "/")));
  const listed = entries.some((e) => e.status[0] === "M" && e.path.replaceAll("\\", "/") === "src/inspect/rules.ts");
  if (newRule && !listed) bad.push("新しいルールを、画面の一覧（src/inspect/rules.ts の RULES）に足していない");
  return bad;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// 「1回の指示で作った版」を、見ないで作るテスト集（eval:blind）と同じ判定で採点する（決まりは BLIND.md）。
//   node baseline/one_prompt/blind-score.ts [--out <run-baseline.mjs と同じ書き出し先>] [--dir <テスト集のフォルダ>]
// 先に：node baseline/one_prompt/run-baseline.mjs --dir <テスト集のフォルダ>/pdf --name blind
//
// - 判定は、作品の採点（eval/blind/run.ts）と同じ関数（eval/blind/judge.ts の judge）。期待値も同じ expected.json。
// - 違うのは項目の出どころだけ：その版の生の結果（見出しと項目の文）を、対応表（blind-map.json）で { 型, 深刻度, ページ } にする。
// - その版が出したものだけを写す。出していない場所・理由・型は足さない。こちらの検出ルールは使わない。
// - 2 通り出す。A：その版が出したものすべて（info の参考も含む）。B：high と mid だけ。
// - 片付けたあとの残りは測らない（その版に片付ける機能がない）。
// 書き出し：<out>/blind/report-A.md・report-B.md・report.json・mapping-log.tsv（どの出力をどの型に当てたかを1行ずつ。項目の字の中身は書かない）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judge, type Case, type Found, type RunOut } from "../../eval/blind/judge.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = path.resolve(opt("--out") ?? path.join(root, ".tmp", "one-prompt"));
const dir = opt("--dir")
  ? path.resolve(opt("--dir")!)
  : [path.join(root, "fixtures/blind"), path.join(root, "proposals/blind/fixtures/blind")].find((d) => existsSync(path.join(d, "expected.json")));
if (!dir) throw new Error("テスト集が見つかりません");
const RAW = path.join(OUT, "raw", "blind");
const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as {
  types: { id: string; title: string; plan: string }[];
  skipped: { id: string }[];
  cases: Case[];
};

type Rule = { title: string; pattern?: string | null; doubt?: boolean; why: string; byItemPrefix?: { prefix: string; pattern: string; why: string }[] };
const MAP = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "blind-map.json"), "utf8")) as {
  severity: Record<string, string>;
  rules: Rule[];
};
type Raw = { ok: boolean; findings?: { level: string; title: string; items: string[] }[]; passwordPrompts?: number; timeout?: boolean; exception?: string };
const rawName = (file: string) => file.replace(/^pdf[\\/]/, "").replace(/[\\/]/g, "__").replace(/\.pdf$/, ".json");

type LogRow = { variant: string; caseId: string; title: string; item: number; pattern: string; page: string; severity: string; rule: string };
const log: LogRow[] = [];
const unknownTitles = new Map<string, number>();
const doubtTitles = new Map<string, Set<string>>();

function toRunOut(c: Case, raw: Raw, variant: "A" | "B"): RunOut {
  const out: RunOut = { items: [], notices: [], errors: [], versions: {} };
  if (!raw.ok) {
    out.errors.push(raw.passwordPrompts ? "encrypted" : raw.timeout ? "timeout" : "unreadable");
    log.push({ variant, caseId: c.id, title: "（開けなかった）", item: 0, pattern: "error", page: "", severity: "", rule: "開けなかった PDF は、作品の「ルールのエラー」と同じ扱い" });
    return out;
  }
  for (const f of raw.findings ?? []) {
    if (variant === "B" && f.level === "info") continue;
    const rule = MAP.rules.find((r) => f.title.startsWith(r.title));
    const sev = MAP.severity[f.level] ?? "low";
    if (!rule) {
      unknownTitles.set(f.title, (unknownTitles.get(f.title) ?? 0) + 1);
      log.push({ variant, caseId: c.id, title: f.title, item: 0, pattern: "（表にない）", page: "", severity: sev, rule: "当てない" });
      continue;
    }
    if (rule.doubt) (doubtTitles.get(rule.title) ?? doubtTitles.set(rule.title, new Set()).get(rule.title)!).add(c.id);
    if (rule.pattern === "error") {
      out.errors.push("unchecked_pages");
      log.push({ variant, caseId: c.id, title: rule.title, item: 0, pattern: "error", page: "", severity: sev, rule: rule.why });
      continue;
    }
    const items = f.items.length ? f.items : [""];
    items.forEach((text, i) => {
      let pattern: string | null | undefined = rule.pattern;
      let why = rule.why;
      if (rule.byItemPrefix) {
        const sub = rule.byItemPrefix.find((s) => text.startsWith(s.prefix));
        pattern = sub?.pattern ?? null;
        why = sub?.why ?? "行の頭が表にないので当てない";
      }
      const m = /^p\.(\d+)\b/.exec(text);
      const page = m ? Number(m[1]) : null;
      log.push({ variant, caseId: c.id, title: rule.title, item: i + 1, pattern: pattern ?? "（当てない）", page: page === null ? "" : String(page), severity: sev, rule: why });
      if (pattern) out.items.push({ pattern, severity: sev, page } satisfies Found);
    });
  }
  return out;
}

const skipped = new Set(expected.skipped.map((s) => s.id));
const report: Record<string, unknown> = {};
const md: Record<string, string> = {};
let commit = "不明";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  /* なし */
}
const missing: string[] = [];
for (const variant of ["A", "B"] as const) {
  const rows: { id: string; type: string; kind: string; pass: boolean; why: string }[] = [];
  for (const c of expected.cases) {
    const p = path.join(RAW, rawName(c.file));
    if (!existsSync(p)) {
      if (variant === "A") missing.push(c.id);
      rows.push({ id: c.id, type: c.type, kind: c.kind, pass: false, why: "生の結果がない" });
      continue;
    }
    const v = judge(c, toRunOut(c, JSON.parse(readFileSync(p, "utf8")) as Raw, variant));
    rows.push({ id: c.id, type: c.type, kind: c.kind, pass: v.pass, why: v.why });
  }
  // 作品の採点と同じまとめ方：型は、その型の PDF がすべて期待どおりなら合。誤検知は、対照のうち合にならなかった数
  const typeRows = expected.types
    .filter((t) => !skipped.has(t.id) && rows.some((r) => r.type === t.id))
    .map((t) => {
      const rs = rows.filter((r) => r.type === t.id);
      const of = (k: string) => rs.filter((r) => r.kind === k);
      const pair = (k: string): [number, number] => [of(k).filter((r) => r.pass).length, of(k).length];
      return {
        type: t.id,
        title: t.title,
        verdict: rs.every((r) => r.pass) ? "合" : "否",
        leak: pair("leak"),
        control: [of("control").filter((r) => !r.pass).length, of("control").length] as [number, number],
        notice: pair("notice"),
        unchecked: pair("unchecked"),
        notes: rs.filter((r) => !r.pass).map((r) => `${r.id}：${r.why}`),
      };
    });
  const sum = (k: "leak" | "control" | "notice" | "unchecked") =>
    typeRows.reduce<[number, number]>((a, r) => [a[0] + r[k][0], a[1] + r[k][1]], [0, 0]);
  const total = { types: typeRows.length, typesPass: typeRows.filter((r) => r.verdict === "合").length, leak: sum("leak"), control: sum("control"), notice: sum("notice"), unchecked: sum("unchecked") };
  report[variant] = { total, typeRows, cases: rows };
  const head = variant === "A" ? "A：その版が出したものすべて（info の参考も含む）" : "B：その版の high と mid だけ（info を除く）";
  md[variant] = [
    `# 見ないで作るテスト集：1回の指示で作った版（${head}）`,
    "",
    `- 採点した日：${new Date().toISOString().slice(0, 10)}（このリポジトリのコミット ${commit}）。判定は eval/blind/judge.ts（作品と同じ）`,
    `- 合の型：**${total.typesPass}/${total.types}**。検出 ${total.leak[0]}/${total.leak[1]}、誤検知 ${total.control[0]}/${total.control[1]}、お知らせ ${total.notice[0]}/${total.notice[1]}、調べられない ${total.unchecked[0]}/${total.unchecked[1]}`,
    "- 片付けたあとの残り：扱えない（その版に片付ける機能がない）",
    "",
    "| 型 | 説明 | 合否 | 検出 | 誤検知 | お知らせ | 調べられない | 落ちた所 |",
    "|---|---|---|---|---|---|---|---|",
    ...typeRows.map((r) => {
      const f = (p: [number, number]) => (p[1] ? `${p[0]}/${p[1]}` : "—");
      return `| ${r.type} | ${r.title} | ${r.verdict} | ${f(r.leak)} | ${f(r.control)} | ${f(r.notice)} | ${f(r.unchecked)} | ${r.notes.join("<br>")} |`;
    }),
    "",
  ].join("\n");
}

const outDir = path.join(OUT, "blind");
mkdirSync(outDir, { recursive: true });
const doubt = [...doubtTitles].map(([t, s]) => ({ title: t, pdfs: s.size }));
writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ commit, set: path.relative(root, dir), missing, doubt, unknownTitles: Object.fromEntries(unknownTitles), ...report }, null, 2) + "\n");
writeFileSync(path.join(outDir, "report-A.md"), md.A);
writeFileSync(path.join(outDir, "report-B.md"), md.B);
writeFileSync(
  path.join(outDir, "mapping-log.tsv"),
  ["数え方\tPDF\tその版の見出し\t項目の番号\t当てた型\tページ\t深刻度\t理由", ...log.map((r) => [r.variant, r.caseId, r.title, r.item, r.pattern, r.page, r.severity, r.rule].join("\t"))].join("\n") + "\n",
);
for (const v of ["A", "B"] as const) {
  const t = (report[v] as { total: { typesPass: number; types: number; leak: number[]; control: number[]; notice: number[]; unchecked: number[] } }).total;
  console.log(`${v}：合の型 ${t.typesPass}/${t.types}、検出 ${t.leak[0]}/${t.leak[1]}、誤検知 ${t.control[0]}/${t.control[1]}、お知らせ ${t.notice[0]}/${t.notice[1]}、調べられない ${t.unchecked[0]}/${t.unchecked[1]}、片付け後の残り 扱えない`);
}
console.log(`迷って当てなかった見出し：${doubt.map((d) => `${d.title}（PDF ${d.pdfs} 個）`).join("、") || "なし"}`);
console.log(`表にない見出し：${unknownTitles.size ? [...unknownTitles].map(([t, n]) => `${t}（${n}）`).join("、") : "なし"}`);
if (missing.length) console.log(`生の結果がない PDF：${missing.length} 個`);
console.log(`書き出した：${path.relative(root, outDir)}`);

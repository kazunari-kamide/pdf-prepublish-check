// SPDX-License-Identifier: AGPL-3.0-only
//
// 見ないで作るテスト集（blind）を書き出す：型ごとの合成 PDF・期待値（expected.json）・一覧（index.md）・ハッシュ。
// 使い方：node build.mjs（このファイルのフォルダに書く）。同じ入力なら同じバイト列になる（日付・乱数を使わない）。

import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TYPES, SKIPPED, CASES } from "./cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pdfDir = join(here, "pdf");
mkdirSync(pdfDir, { recursive: true });
for (const f of readdirSync(pdfDir)) if (f.endsWith(".pdf")) unlinkSync(join(pdfDir, f));

// 型ごとに、隠しのある PDF（か、お知らせ・調べられない）と、対照が1つ以上あるかを確かめる
const skipped = new Set(SKIPPED.map((s) => s.id));
const problems = [];
for (const t of TYPES) {
  if (skipped.has(t.id)) continue;
  const cs = CASES.filter((c) => c.type === t.id);
  const isF = t.id.startsWith("F");
  if (!isF && !cs.some((c) => c.kind !== "control")) problems.push(`${t.id}：隠しのある PDF がない`);
  if (!cs.some((c) => c.kind === "control")) problems.push(`${t.id}：対照がない`);
}
const ids = new Set();
for (const c of CASES) {
  if (ids.has(c.id)) problems.push(`${c.id}：名前が重なっている`);
  ids.add(c.id);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const hashes = [];
const out = [];
for (const c of CASES) {
  const bytes = c.make();
  const file = `pdf/${c.id}.pdf`;
  writeFileSync(join(here, file), bytes);
  hashes.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
  out.push({ id: c.id, type: c.type, kind: c.kind, about: c.about, file, expect: c.expect, residual: c.residual });
}

writeFileSync(
  join(here, "expected.json"),
  JSON.stringify(
    {
      note: "型の一覧の説明だけから作った期待値。検出ルールを動かす前に決めた（動かしてから合わせない）。中身はすべて架空。",
      types: TYPES,
      skipped: SKIPPED,
      cases: out,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(join(here, "hashes.txt"), hashes.join("\n") + "\n");

const kindJa = { leak: "隠しあり", control: "対照", notice: "お知らせ", unchecked: "調べられない" };
let md = "# 見ないで作るテスト集（blind）の一覧\n\n`node build.mjs` が書き出す。型の説明だけから作った合成 PDF（中身はすべて架空）。\n\n";
md += "| 型 | ファイル | 種類 | 何を入れたか | 出てほしい型 |\n|---|---|---|---|---|\n";
for (const c of out) {
  const want =
    c.kind === "control"
      ? `出てはいけない：${c.expect.forbid ? c.expect.forbid.join("・") : "すべて"}`
      : c.kind === "unchecked"
        ? "調べられない"
        : `${c.expect.patterns ? c.expect.patterns.join("・") : "型を問わない"}${c.expect.level === "check" ? "（確認）" : c.expect.level === "high" ? "（高）" : ""}`;
  md += `| ${c.type} | \`${c.file}\` | ${kindJa[c.kind]} | ${c.about.replace(/\|/g, "｜")} | ${want} |\n`;
}
md += "\n## 作らなかった型\n\n| 型 | 理由 |\n|---|---|\n";
for (const s of SKIPPED) md += `| ${s.id} | ${s.why} |\n`;
writeFileSync(join(here, "index.md"), md);

console.log(`${out.length} 個の PDF を書き出した（型 ${new Set(out.map((c) => c.type)).size}、作らなかった型 ${SKIPPED.length}）`);

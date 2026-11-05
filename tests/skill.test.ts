// SPDX-License-Identifier: AGPL-3.0-only
//
// Claude Code のスキル（.claude/skills/omamori-check/SKILL.md）のテスト。
// スキルに書いたコマンドを、そのまま本物のコマンドの道具で動かし、結果が JSON で、中身の字を含まないことを確かめる。
// 合成 PDF はテストの中で一から作り（中身は架空）、OS の一時フォルダに書いて消す。

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKILL = readFileSync(path.join(ROOT, ".claude", "skills", "omamori-check", "SKILL.md"), "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "omamori-skill-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SECRET = "KasouTaroSecret";

function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** スキルの「コマンドを動かす」の節にある、コードの囲みの1行 */
function skillCommand(md: string): string {
  const m = /### 2\. コマンドを動かす[\s\S]*?```\r?\n(.+?)\r?\n```/.exec(md);
  if (!m) throw new Error("コマンドの行が見つかりません");
  return (m[1] ?? "").trim();
}

/** 黒い四角の下に字が残った、見せかけの黒塗りの合成 PDF（文書情報にも架空の名前） */
async function fakeRedaction(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setAuthor(SECRET);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(`Name: ${SECRET}`, { x: 72, y: 700, size: 14, font });
  page.drawRectangle({ x: 70, y: 694, width: 220, height: 22, color: rgb(0, 0, 0) });
  return doc.save({ useObjectStreams: false });
}

describe("スキルの決まり", () => {
  const fm = frontmatter(SKILL);
  it("名前と、いつ使うかの説明がある", () => {
    expect(fm.name).toBe("omamori-check");
    expect(fm.description).toContain("提出前にこの PDF を確かめて");
  });
  it("前もって許すのは、確かめのコマンドだけ（Read・WebFetch などは許さない）", () => {
    expect(fm["allowed-tools"]).toBe("Bash(node cli/omamori.ts check *) PowerShell(node cli/omamori.ts check *)");
  });
  it("ライセンスの行がある", () => {
    expect(SKILL).toContain("SPDX-License-Identifier: AGPL-3.0-only");
  });
  it("ファイルを開かない・中身を出さない・言い切らない、を書いている", () => {
    expect(SKILL).toContain("ファイルそのものを開かない");
    expect(SKILL).toContain("中身を会話に出さない");
    expect(SKILL).toContain("「安全です」「問題なし」");
  });
  it("データの設定を確かめるよう促し、根拠の公式の説明を添えている", () => {
    expect(SKILL).toContain("https://claude.ai/settings/data-privacy-controls");
    expect(SKILL).toContain("https://code.claude.com/docs/en/data-usage");
  });
  it("書いたコマンドは、前もって許したコマンドの形に合う", () => {
    expect(skillCommand(SKILL).startsWith("node cli/omamori.ts check ")).toBe(true);
  });
});

describe("スキルのコマンドを、そのまま動かす", { timeout: 120_000 }, () => {
  it("結果は JSON で、段階と型・数・場所だけ。中の字・欄の値は含まない", async () => {
    const file = path.join(tmp, "submit.pdf");
    writeFileSync(file, await fakeRedaction());
    const args = skillCommand(SKILL)
      .split(/\s+/)
      .slice(1)
      .map((a) => (a === "<ファイルやフォルダ>" ? file : a));
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
    expect(r.status).toBe(0); // --fail-on never
    expect(r.stdout).not.toContain(SECRET);
    expect(r.stderr).not.toContain(SECRET);
    const j = JSON.parse(r.stdout);
    expect(j.files).toHaveLength(1);
    expect(j.files[0].stage).toBe("high");
    const ids = j.files[0].items.map((i: { ruleId: string }) => i.ruleId);
    expect(ids).toContain("p6-text");
    expect(ids).toContain("p1-info");
    const p6 = j.files[0].items.find((i: { ruleId: string }) => i.ruleId === "p6-text");
    expect(p6.page).toBe(1);
    expect(p6.detail).toMatch(/\d+字/);
  });
});

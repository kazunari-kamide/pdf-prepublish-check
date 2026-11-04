// SPDX-License-Identifier: AGPL-3.0-only
//
// コマンドの道具（cli/）のテスト。本物のコマンドを別のプロセスで動かし、終了コードと出力を確かめる。
// 合成 PDF（fixtures/）は読むだけで使う。テストの中で作るファイルは、OS の一時フォルダに書いて消す。

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";
import { detectP6Text } from "../rules/p6-text/index.ts";
import { formatSarif, toSarifUri } from "../cli/output.ts";
import type { FileReport } from "../cli/report.ts";
import { exitCodeOf, parseFailOn, stagesOf } from "../cli/stage.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "cli", "omamori.ts");
const fx = (rel: string) => path.join("fixtures", rel);
const HIGH = fx("p6/p6-t01-rect-over-name.pdf"); // 見せかけの黒塗り（高）＋文書情報（中）
const REVIEW = fx("p1/p1-01-author-name.pdf"); // 文書情報（中）だけ
const NONE = fx("p6/p6-d07-translucent-03.pdf"); // 何も見つからない対照

const tmp = mkdtempSync(path.join(tmpdir(), "omamori-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("終了コード", { timeout: 120_000 }, () => {
  it("見つからない：0", () => {
    expect(run("check", NONE).code).toBe(0);
  });
  it("確認してほしい所だけ：1", () => {
    expect(run("check", REVIEW).code).toBe(1);
  });
  it("高い危険：2", () => {
    expect(run("check", HIGH).code).toBe(2);
  });
  it("調べられなかった所がある（PDF でないファイル）：3", () => {
    const f = path.join(tmp, "note.pdf");
    writeFileSync(f, "これは PDF ではありません");
    const r = run("check", f);
    expect(r.code).toBe(3);
    expect(r.out).toContain("PDF ファイルではないようです");
  });
  it("いくつかのファイルでは、届いた段階の一番大きい数", () => {
    expect(run("check", NONE, REVIEW, HIGH).code).toBe(2);
  });
  it("--fail-on で落とす段階を選べる", () => {
    expect(run("check", "--fail-on", "high", REVIEW).code).toBe(0);
    expect(run("check", "--fail-on", "high", HIGH).code).toBe(2);
    expect(run("check", "--fail-on=review", HIGH).code).toBe(1);
    expect(run("check", "--fail-on", "never", HIGH).code).toBe(0);
  });
  it("使い方の誤り：64", () => {
    expect(run("check").code).toBe(64);
    expect(run("check", "--format", "xml", NONE).code).toBe(64);
    expect(run("check", "--fail-on", "low", NONE).code).toBe(64);
    expect(run("check", "--unknown", NONE).code).toBe(64);
    expect(run("check", path.join(tmp, "ない.pdf")).code).toBe(64);
    expect(run("nothing").code).toBe(64);
  });
});

describe("出し方", { timeout: 120_000 }, () => {
  it("フォルダを渡すと、中の PDF をすべて調べる", () => {
    const r = run("check", "--format", "json", "--fail-on", "never", fx("p6"));
    const j = JSON.parse(r.out);
    expect(j.files.length).toBeGreaterThan(30);
    expect(j.files.every((f: { path: string }) => f.path.startsWith("fixtures/p6/") && f.path.endsWith(".pdf"))).toBe(true);
  });

  it("JSON：型・数・場所だけ。画面と同じルールの id が並ぶ", () => {
    const r = run("check", "--format", "json", HIGH);
    const j = JSON.parse(r.out);
    expect(j.exitCode).toBe(2);
    const f = j.files[0];
    expect(f.stage).toBe("high");
    const p6 = f.items.find((i: { ruleId: string }) => i.ruleId === "p6-text");
    expect(p6.page).toBe(1);
    expect(p6.rect).toHaveLength(4);
    expect(j.summary).toEqual({ files: 1, high: 1, review: 2, unchecked: 0 });
  });

  it("SARIF：2.1.0 の形。高は error、中は warning", () => {
    const r = run("check", "--format", "sarif", HIGH);
    const s = JSON.parse(r.out);
    expect(s.version).toBe("2.1.0");
    const results = s.runs[0].results;
    expect(results.map((x: { level: string }) => x.level).sort()).toEqual(["error", "warning", "warning"]);
    expect(results[0].locations[0].physicalLocation.artifactLocation.uri).toBe("fixtures/p6/p6-t01-rect-over-name.pdf");
    expect(s.runs[0].tool.driver.rules.map((x: { id: string }) => x.id).sort()).toEqual(["p1-info", "p6-text"]);
    expect(s.runs[0].invocations[0].exitCode).toBe(2);
  });

  it("--output でファイルに書く", () => {
    const out = path.join(tmp, "out.sarif");
    const r = run("check", "--format", "sarif", "--output", out, NONE);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });

  it("人が読む形：断定しない言い方で、見つからなかったと書く", () => {
    const r = run("check", NONE);
    expect(r.out).toContain("見つかりませんでした（調べた項目について）");
    expect(r.out).not.toMatch(/安全です|問題なし/);
  });
});

describe("中身を出さない", { timeout: 120_000 }, () => {
  it("文書情報の値を、どの出し方にも出さない", async () => {
    // p1-01 の作成者欄の値（架空の名前）を PDF から読み、それが出力にないことを確かめる
    const doc = await PDFDocument.load(readFileSync(path.join(ROOT, REVIEW)), { updateMetadata: false });
    const author = doc.getAuthor();
    expect(author?.length).toBeGreaterThan(0);
    for (const format of ["text", "json", "sarif"]) {
      const r = run("check", "--format", format, REVIEW);
      expect(r.out).toContain("作成者");
      expect(r.out).not.toContain(author!);
    }
  });

  it("覆われた字を、どの出し方にも出さない", async () => {
    // 覆われた字（架空）を、検出ルールに includeText で取り出させ、それが出力にないことを確かめる
    const rep = await detectP6Text(new Uint8Array(readFileSync(path.join(ROOT, HIGH))), { includeText: true });
    const texts = rep.findings.flatMap((f) => (f.layer === "text" && f.text ? [f.text.trim()] : []));
    expect(texts.length).toBeGreaterThan(0);
    for (const format of ["text", "json", "sarif"]) {
      const r = run("check", "--format", format, HIGH);
      for (const t of texts) expect(r.out).not.toContain(t);
    }
  });
});

describe("compare", { timeout: 120_000 }, () => {
  it("同じ黒塗りの PDF どうし：消したはずの字が残っている（2）", () => {
    const r = run("compare", HIGH, HIGH);
    expect(r.code).toBe(2);
    expect(r.out).toContain("残っています");
  });
  it("見つからないファイル：64", () => {
    expect(run("compare", HIGH, path.join(tmp, "ない.pdf")).code).toBe(64);
  });
  it("PDF でないファイル：3", () => {
    const f = path.join(tmp, "x.pdf");
    writeFileSync(f, "x");
    expect(run("compare", HIGH, f).code).toBe(3);
  });
});

describe("段階の決め方", () => {
  const rep = (sev: Array<"high" | "medium" | "low">, unchecked = false): FileReport => ({
    format: "pdf",
    items: sev.map((s) => ({ ruleId: "x", ruleVersion: "1", pattern: "P1", type: "P1", severity: s, title: "", why: "", detail: "", page: null, rect: null })),
    notices: unchecked ? [{ ruleId: null, kind: "skipped_pages", message: "", pages: [1], unchecked: true }] : [],
  });
  it("高と調べられなかった所が両方あれば、両方の段階に届く", () => {
    expect([...stagesOf(rep(["high"], true))].sort()).toEqual(["high", "unchecked"]);
    expect(exitCodeOf([rep(["high"], true)], parseFailOn("high")!)).toBe(2);
    expect(exitCodeOf([rep(["high"], true)], parseFailOn("high,unchecked")!)).toBe(3);
    expect(exitCodeOf([rep(["low"])], parseFailOn("review,high,unchecked")!)).toBe(1);
    expect(exitCodeOf([rep([])], parseFailOn("review,high,unchecked")!)).toBe(0);
  });
  it("SARIF の uri は / で区切り、符号化する", () => {
    expect(toSarifUri("a\\b c\\資料.pdf")).toBe("a/b%20c/%E8%B3%87%E6%96%99.pdf");
    const s = JSON.parse(formatSarif([{ path: "a.pdf", report: rep(["low"]), elapsedMs: 1 }], 1));
    expect(s.runs[0].results[0].level).toBe("note");
  });
});

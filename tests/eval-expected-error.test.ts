// SPDX-License-Identifier: AGPL-3.0-only
//
// 採点（eval/p6.ts・eval/p5.ts）が、正解データの expected_error を読むことのテスト（PR #26 の決めてほしいことの 1）。
// 期待どおりのエラーは「合っている」と数え、読めなかった PDF にも不合格にも数えない。
// - P6 の e03（パスワードつき）は、まだ proposals/p6/encrypted/ にある。そこにある間は、そこから読む（fixtures/p6/ に移ったら、そちらを読む）
// - P5 の p5-25（パスワードつき）は fixtures/p5/ にある

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectP5Revisions } from "../rules/p5-revisions/index.ts";
import { detectP6Text } from "../rules/p6-text/index.ts";
import { adaptP5Revisions } from "../eval/adapters/p5-revisions.ts";
import { adaptP6Text } from "../eval/adapters/p6-text.ts";
import { checkExpectedError } from "../eval/expected-error.ts";
import { scoreP5Fixture, type Expected as P5Expected } from "../eval/p5.ts";
import { scoreP6Fixture, type P6ExpectedFile } from "../eval/p6.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const readJson = <T>(p: string) => JSON.parse(readFileSync(p, "utf8")) as T;

function findE03(): string {
  const name = "p6-e03-encrypted-user-password";
  const moved = path.join(ROOT, "fixtures", "p6", `${name}.pdf`);
  return existsSync(moved) ? path.join(ROOT, "fixtures", "p6") : path.join(ROOT, "proposals", "p6", "encrypted", "fixtures", "p6");
}

describe("P6：expected_error", () => {
  const dir = findE03();
  const expected = readJson<P6ExpectedFile>(path.join(dir, "p6-e03-encrypted-user-password.expected.json"));
  const rule = readJson<{ match: Parameters<typeof scoreP6Fixture>[2] }>(path.join(ROOT, "rubric", "p6.json")).match;

  it("e03 の正解データは、開けないことが正しい入力（encrypted）", () => {
    expect(expected.expected_error).toBe("encrypted");
    expect(expected.leaks).toHaveLength(0);
    expect(expected.negatives).toHaveLength(0);
  });

  it("検出ルールが e03 で encrypted を返し、採点で「合っている」と数える", async () => {
    const raw = await detectP6Text(new Uint8Array(readFileSync(path.join(dir, expected.file))));
    expect(raw.status).toBe("error");
    expect(raw.error?.code).toBe("encrypted");
    const score = scoreP6Fixture(expected, adaptP6Text(raw), rule);
    expect(score.kind).toBe("expected_error");
    if (score.kind !== "expected_error") return;
    expect(score.result).toEqual({ file: expected.file, expected: "encrypted", got: "encrypted", ok: true });
  });

  it("開けてしまった報告や、別のエラーは「合っていない」", () => {
    const ok = scoreP6Fixture(expected, { status: "ok", items: [], skipped_pages: [] }, rule);
    const other = scoreP6Fixture(expected, { status: "error", error: { code: "unreadable" }, items: [], skipped_pages: [] }, rule);
    const noCode = scoreP6Fixture(expected, { status: "error", items: [], skipped_pages: [] }, rule);
    for (const s of [ok, other, noCode]) {
      expect(s.kind).toBe("expected_error");
      if (s.kind === "expected_error") expect(s.result.ok).toBe(false);
    }
  });

  it("expected_error のない正解データは、これまでどおり照らし合わせる", () => {
    const plain: P6ExpectedFile = { file: "x.pdf", pages: 1, leaks: [], negatives: [] };
    const s = scoreP6Fixture(plain, { status: "error", error: { code: "encrypted" }, items: [], skipped_pages: [] }, rule);
    expect(s.kind).toBe("match");
    if (s.kind === "match") expect(s.result.status).toBe("error");
  });
});

describe("P5：expected_error", () => {
  const dir = path.join(ROOT, "fixtures", "p5");
  const expected = readJson<P5Expected>(path.join(dir, "p5-25-encrypted-user-password.expected.json"));
  const rule = readJson<{ match: Parameters<typeof scoreP5Fixture>[2] }>(path.join(ROOT, "rubric", "p5.json")).match;

  it("検出ルールが p5-25 で encrypted を返し、採点で「合っている」と数える", async () => {
    expect(expected.expected_error).toBe("encrypted");
    const raw = await detectP5Revisions(new Uint8Array(readFileSync(path.join(dir, expected.file))));
    expect(raw.status).toBe("error");
    const score = scoreP5Fixture(expected, adaptP5Revisions(raw), rule);
    expect(score.kind).toBe("expected_error");
    if (score.kind !== "expected_error") return;
    expect(score.result.ok).toBe(true);
  });

  it("開けてしまった報告は「合っていない」", () => {
    const s = scoreP5Fixture(expected, { status: "ok", items: [], not_counted: [] }, rule);
    expect(s.kind === "expected_error" && s.result.ok).toBe(false);
  });
});

describe("checkExpectedError", () => {
  it("code が同じときだけ合う", () => {
    expect(checkExpectedError("a.pdf", "encrypted", { status: "error", error: { code: "encrypted" } }).ok).toBe(true);
    expect(checkExpectedError("a.pdf", "encrypted", { status: "error", error: { code: "empty" } }).ok).toBe(false);
    expect(checkExpectedError("a.pdf", "encrypted", { status: "ok" }).got).toBeNull();
  });
});

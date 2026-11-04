// SPDX-License-Identifier: AGPL-3.0-only
//
// Worker の中でする検査（src/inspect/inspect.ts）を、合成 PDF（fixtures/）で確かめる。
// - 登録した6つのルールがすべて結果を返す
// - 字の中身・欄の値・ファイル名が、画面に返す結果に入らない
// - 暗号化をほどいたことを知らせる（調べなかった画像・省いたページのまとめ方は tests/ui-model.test.ts）

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectP1Info } from "../rules/p1-info/index.ts";
import { detectP6Text } from "../rules/p6-text/index.ts";
import { detectP7Hidden } from "../rules/p7-hidden/index.ts";
import { detectP9Attach } from "../rules/p9-attach/index.ts";
import { inspectAll } from "../src/inspect/inspect";
import { RULES } from "../src/inspect/rules";
import { buildView } from "../src/ui/model";

const ROOT = path.resolve(import.meta.dirname, "..");
const pdf = (rel: string) => new Uint8Array(readFileSync(path.join(ROOT, "fixtures", rel)));

describe("登録したルール", () => {
  it("6つのルールが1か所に並んでいる", () => {
    expect(RULES.map((r) => r.id).sort()).toEqual(["p1-info", "p5-revisions", "p6-text", "p7-hidden", "p9-attach", "pii"]);
  });
});

describe("検査の結果", () => {
  it("見せかけの黒塗り：ページと場所が返り、全ルールの結果がそろう", async () => {
    const s = await inspectAll(pdf("p6/p6-t01-rect-over-name.pdf"));
    expect(s.rules).toHaveLength(RULES.length);
    expect(s.pagesUnreadable).toBe(false);
    const p6 = s.rules.find((r) => r.ruleId === "p6-text")!;
    expect(p6.status).toBe("ok");
    expect(p6.items.length).toBeGreaterThan(0);
    for (const it of p6.items) {
      expect(it.severity).toBe("high");
      expect(it.page).not.toBeNull();
      expect(it.rect).not.toBeNull();
    }
    const view = buildView(s);
    expect(view.pages.length).toBeGreaterThan(0);
    expect(view.clean).toBe(false);
  });

  it("進み具合を、ルールの数＋1回知らせる", async () => {
    const seen: number[] = [];
    await inspectAll(pdf("p6/p6-t01-rect-over-name.pdf"), (done) => seen.push(done));
    expect(seen).toEqual([...Array(RULES.length + 1).keys()]);
  });

  it("1つのルールが止まっても、ほかは続ける", async () => {
    const broken = { id: "x", label: "試し", pattern: "P12" as const, run: () => Promise.reject(new Error("中身")) };
    const s = await inspectAll(pdf("p6/p6-t01-rect-over-name.pdf"), () => {}, [broken, RULES[0]!]);
    expect(s.rules[0]!.status).toBe("error");
    expect(s.rules[0]!.message).not.toContain("中身");
    expect(s.rules[1]!.status).toBe("ok");
  });

  it("パスワードなしで開ける暗号化をほどいたことを知らせる", async () => {
    const s = await inspectAll(pdf("p6/p6-e01-encrypted-empty-userpw.pdf"));
    const view = buildView(s);
    expect(view.notices).toContain("パスワードなしで開ける暗号化がかかっていたので、ほどいて調べました。");
  });
});

describe("中身を画面に返さない", () => {
  const cases: Array<[string, (b: Uint8Array) => Promise<string[]>]> = [
    ["p6/p6-t01-rect-over-name.pdf", async (b) => (await detectP6Text(b, { includeText: true })).findings.map((f) => ("text" in f ? f.text : undefined) ?? "")],
    ["p6/p6-t02-partial-string.pdf", async (b) => (await detectP6Text(b, { includeText: true })).findings.map((f) => ("text" in f ? f.text : undefined) ?? "")],
    ["p1/p1-02-all-standard.pdf", async (b) => (await detectP1Info(b, { includeValues: true })).findings.map((f) => f.value ?? "")],
    ["p1/p1-03-custom-keys.pdf", async (b) => (await detectP1Info(b, { includeValues: true })).findings.map((f) => f.value ?? "")],
    ["p9/p9-01-names-xlsx.pdf", async (b) => (await detectP9Attach(b, { includeNames: true })).findings.map((f) => f.name ?? "")],
    ["p7/p7-01-white-text.pdf", async (b) => (await detectP7Hidden(b, { includeText: true })).findings.map((f) => ("text" in f ? f.text : undefined) ?? "")],
  ];
  for (const [file, secrets] of cases) {
    it(file, async () => {
      const bytes = pdf(file);
      const words = (await secrets(bytes)).map((s) => s.trim()).filter((s) => s.length >= 2);
      expect(words.length).toBeGreaterThan(0);
      const out = JSON.stringify(buildView(await inspectAll(bytes))) + JSON.stringify(await inspectAll(bytes));
      for (const w of words) expect(out).not.toContain(w);
    });
  }
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// Worker の中でする検査（src/inspect/inspect.ts）を、合成 PDF（fixtures/）で確かめる。
// - 登録したルールがすべて結果を返す
// - 字の中身・欄の値・ファイル名が、画面に返す結果に入らない
// - 暗号化をほどいたことを知らせる（調べなかった画像・省いたページのまとめ方は tests/ui-model.test.ts）

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectPii } from "../rules/pii/index.ts";
import { buildPdf, latinAt } from "./helpers/redact-pdfs.ts";
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
  it("ルールが1か所に並んでいる", () => {
    expect(RULES.map((r) => r.id).sort()).toEqual([
      "alt-text",
      "barcode-scan",
      "cross-page-redaction",
      "extras",
      "font-glyphs",
      "font-glyphs-cff",
      "p1-info",
      "p10-exif",
      "p11-forms",
      "p12-actions",
      "p2-parts",
      "p2-xmp",
      "p3-orgs",
      "p4-paths",
      "p5-revisions",
      "p6-text",
      "p7-hidden",
      "p8-annot",
      "p9-attach",
      "pii",
      "props-diff",
      "unused-images",
      "xmp-thumbnail",
    ]);
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
    expect(view.notices).toContain("パスワードなしで開ける暗号化がかかっていたので、外して調べました。");
  });
});

describe("頼まないときは、中身を返さない（コマンドの道具・スキル・片付けの読み直し）", () => {
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
      // プロパティの一覧（properties）だけは、値を画面に出してよい例外（11/5 B の 8）。それ以外の所には入れない
      const { properties: _props, ...rest } = await inspectAll(bytes);
      const out = JSON.stringify(buildView(await inspectAll(bytes))) + JSON.stringify(rest);
      for (const w of words) expect(out).not.toContain(w);
    });
  }
});

describe("画面の検査の Worker が頼んだとき（withContents）は、見つけた字の中身を content に入れる（2026-11-05 本人が決めた）", () => {
  const cases: Array<[string, string, (b: Uint8Array) => Promise<string[]>]> = [
    ["p6/p6-t01-rect-over-name.pdf", "P6", async (b) => (await detectP6Text(b, { includeText: true })).findings.map((f) => ("text" in f ? f.text : undefined) ?? "")],
    ["p1/p1-02-all-standard.pdf", "P1", async (b) => (await detectP1Info(b, { includeValues: true })).findings.map((f) => f.value ?? "")],
    ["p9/p9-01-names-xlsx.pdf", "P9", async (b) => (await detectP9Attach(b, { includeNames: true })).findings.map((f) => f.name ?? "")],
    ["p7/p7-01-white-text.pdf", "P7", async (b) => (await detectP7Hidden(b, { includeText: true })).findings.map((f) => ("text" in f ? f.text : undefined) ?? "")],
  ];
  for (const [file, pattern, secrets] of cases) {
    it(`${file}（${pattern}）`, async () => {
      const bytes = pdf(file);
      const words = (await secrets(bytes)).filter((s) => s.trim().length > 0);
      const s = await inspectAll(bytes, undefined, undefined, { withContents: true });
      const contents = s.rules.flatMap((r) => r.items).filter((i) => i.pattern === pattern && i.content).map((i) => i.content);
      expect(contents.length).toBeGreaterThan(0);
      for (const c of contents) expect(words).toContain(c);
      // 画面の形（buildView）の行にも content が入る（伏せて出すのは画面の部品）
      expect(buildView(s).rows.some((r) => r.content && words.includes(r.content))).toBe(true);
    });
  }
});

describe("個人情報の候補（P13）も、頼んだときは見つけた字を content に入れる（rules/pii 0.1.3 の includeText）", () => {
  it("合成 PDF の架空のメールアドレスと携帯の番号", async () => {
    const bytes = await buildPdf(() => ({ pages: [{ content: latinAt(50, 200, "ritsu@kakuu.test") + latinAt(50, 170, "TEL 090-0274-1883") }] }));
    const words = (await detectPii(bytes, { includeText: true })).findings.map((f) => f.text ?? "").filter(Boolean);
    expect(words.length).toBeGreaterThan(0);
    const withC = await inspectAll(bytes, undefined, undefined, { withContents: true });
    const contents = withC.rules.flatMap((r) => r.items).filter((i) => i.pattern === "P13").map((i) => i.content);
    expect(contents.length).toBe(words.length);
    for (const c of contents) expect(words).toContain(c);
    // 頼まないときは入れない
    const without = await inspectAll(bytes);
    expect(without.rules.flatMap((r) => r.items).filter((i) => i.pattern === "P13" && i.content)).toHaveLength(0);
  });
});

describe("プロパティの一覧だけは値を持つ（11/5 B の 8 の例外）", () => {
  it("文書情報の値は properties にだけ入り、画面の形（buildView）には入らない", async () => {
    const bytes = pdf("p1/p1-02-all-standard.pdf");
    const values = (await detectP1Info(bytes, { includeValues: true })).findings.map((f) => (f.value ?? "").trim()).filter((v) => v.length >= 2);
    const s = await inspectAll(bytes);
    const listed = JSON.stringify(s.properties);
    for (const v of values) expect(listed).toContain(JSON.stringify(v).slice(1, -1));
    expect(JSON.stringify(buildView(s))).not.toContain(values[0]!);
  });
});

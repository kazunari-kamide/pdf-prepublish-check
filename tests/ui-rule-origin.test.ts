// SPDX-License-Identifier: AGPL-3.0-only
//
// ルール・型の出どころの札（src/ui/rule-origin.ts）。
// - 見つける段から来た型（P6 の画像の層・図形の層、P8 の注釈の欄、部品の情報）だけに札が付く
// - 最初から人が書いた型（P6 の文字の層・P8 の隠した注釈など）には付かない
// - スキャン画像の上に黒い四角の注釈を置いた合成 PDF（p6-i03）で、画面の項目に PR #43 の札が付く
// - リポジトリの場所は、GitHub の「持ち主/名前」の形だけをリンクにする

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeImageDecoder } from "../eval/image-decoder.ts";
import { inspectAll } from "../src/inspect/inspect";
import { RULES } from "../src/inspect/rules";
import { buildView } from "../src/ui/model";
import { RULE_ORIGINS, parseRepo, prUrl, ruleOrigin } from "../src/ui/rule-origin";

const ROOT = path.resolve(import.meta.dirname, "..");
const pdf = (rel: string) => new Uint8Array(readFileSync(path.join(ROOT, "fixtures", rel)));

describe("出どころの表", () => {
  it("見つける段から来た型だけに PR の番号を返す", () => {
    expect(ruleOrigin("p6-text", "image")).toEqual({ pr: 43 });
    expect(ruleOrigin("p6-text", "vector")).toEqual({ pr: 92 });
    expect(ruleOrigin("p8-annot", "T")).toEqual({ pr: 43 });
    expect(ruleOrigin("p2-parts", "private_data")).toEqual({ pr: 43 });
  });

  it("最初から人が書いた型・あとから足した型・型の名前のない項目には返さない", () => {
    expect(ruleOrigin("p6-text", "text")).toBeNull();
    expect(ruleOrigin("p8-annot", "hidden")).toBeNull();
    expect(ruleOrigin("p8-annot", "AP")).toBeNull();
    expect(ruleOrigin("p2-parts", "serial")).toBeNull();
    expect(ruleOrigin("p2-parts", "camera")).toBeNull();
    expect(ruleOrigin("p1-info", undefined)).toBeNull();
  });

  it("表のルールは、どれも登録したルールにある", () => {
    const ids = new Set(RULES.map((r) => r.id));
    for (const o of RULE_ORIGINS) expect(ids.has(o.ruleId)).toBe(true);
  });
});

describe("画面の項目", () => {
  it("スキャン画像の上の黒い四角の注釈（p6-i03）に、PR #43 の札が付く", async () => {
    const s = await inspectAll(pdf("p6/p6-i03-scan-square-annotation.pdf"), () => {}, RULES, { imageDecoder: createNodeImageDecoder() });
    const view = buildView(s);
    const p6 = view.rows.filter((r) => r.pattern === "P6");
    expect(p6.length).toBeGreaterThan(0);
    for (const r of p6) expect(r.origin).toEqual({ pr: 43 });
  });

  it("黒い四角の下の字（文字の層。p6-t01）には札が付かない", async () => {
    const s = await inspectAll(pdf("p6/p6-t01-rect-over-name.pdf"));
    const view = buildView(s);
    const p6 = view.rows.filter((r) => r.pattern === "P6");
    expect(p6.length).toBeGreaterThan(0);
    for (const r of p6) expect(r.origin).toBeUndefined();
  });
});

describe("リポジトリの場所", () => {
  const gh = ["https", "://github.com"].join("");
  it("GitHub の持ち主/名前だけを受ける", () => {
    expect(parseRepo(`${gh}/owner/repo`)).toBe(`${gh}/owner/repo`);
    expect(parseRepo(`${gh}/owner/repo/`)).toBe(`${gh}/owner/repo`);
    expect(prUrl(parseRepo(`${gh}/owner/repo`), 43)).toBe(`${gh}/owner/repo/pull/43`);
  });

  it("ほかの形は受けない（リンクにせず字だけにする）", () => {
    for (const bad of [null, "", "javascript:alert(1)", `${gh}/owner`, `${gh}/owner/repo/pull/1`, `${gh}/owner/repo?x=1`, ["http", "://github.com/owner/repo"].join(""), ["https", "://example.com/owner/repo"].join("")]) {
      expect(parseRepo(bad)).toBeNull();
    }
    expect(prUrl(null, 43)).toBeNull();
  });
});

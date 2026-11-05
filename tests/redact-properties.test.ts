// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする（sanitize/redact.ts）ときの、プロパティの扱い。
// 本人が「そのまま」「書き直す」を選んだ欄の値は、読み直しで見つかっても残りに数えない（整えるほうと同じ決まり。11/5 本人）。
// 選んでいない値・欄の名前の無い残り・ほかの型の残りは、今までどおり保存させない。名前・団体名はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { redact, type RedactArea, type RedactCheck, type RedactResult } from "../sanitize/index.ts";
import { hex, lit, setInfo } from "../eval/cases/pdf.ts";
import { sanitizeJob } from "../src/sanitize/job.ts";
import { allChecks } from "./helpers/redact-checks.ts";
import { buildPdf, textAt } from "./helpers/redact-pdfs.ts";
import { HEAVY_TIMEOUT } from "./helpers/timeout.ts";

const OLD_TITLE = "見本の資料（第3版）";
const OLD_AUTHOR = "架空 太郎";
const NEW_TITLE = "お知らせ";
const AREA: RedactArea = { page: 1, rect: [75, 195, 121, 215] };

/** 本文に字があり、文書情報に題・作成者・作ったアプリのある PDF */
const pdfWithInfo = () =>
  buildPdf((doc) => {
    setInfo(doc, { Title: hex(OLD_TITLE), Author: hex(OLD_AUTHOR), Producer: lit("Kakuu PDF Writer 1.0") });
    return { pages: [{ content: textAt(50, 200, "氏名見本花子") }] };
  });

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");
const u16 = (s: string) => Array.from(s, (c) => String.fromCharCode(c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff)).join("");

/** 作品の検査の代わりに、決めた行を返す確かめ（欄の名前を持つ行を試す） */
const fakeRules = (items: Array<{ pattern: string; field?: string }>): RedactCheck => ({
  name: "rules",
  async run() {
    return items.map((it) => ({ check: "rules" as const, kind: "rule_item" as const, count: 1, label: "見本", pattern: it.pattern, ...(it.field ? { field: it.field } : {}) }));
  },
});

function ok(r: RedactResult): asserts r is Extract<RedactResult, { status: "ok" }> {
  if (r.status !== "ok") throw new Error(`ok になりませんでした：${JSON.stringify(r.status === "blocked" ? r.leftovers : r)}`);
}

describe("本人が選んだプロパティの値は、黒塗りの読み直しで残りに数えない", () => {
  it("「そのまま」「書き直す」を選んだ欄は、作品の検査で見つかっても保存できる。項目ごとの報告が返る", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await pdfWithInfo();
    const r = await redact(bytes, [AREA], { checks: allChecks, properties: { author: "keep", title: { set: NEW_TITLE } } });
    ok(r);
    expect(r.chosen).toBeGreaterThan(0);
    const actions = Object.fromEntries((r.properties ?? []).map((p) => [p.key, p.action]));
    expect(actions).toMatchObject({ author: "kept", title: "set", producer: "removed" });
    const doc = await PDFDocument.load(r.bytes, { updateMetadata: false });
    expect(doc.getAuthor()).toBe(OLD_AUTHOR);
    expect(doc.getProducer()).toBeUndefined();
  });

  it("書き直した値は元の値と違い、元の値は PDF のどこにも残らない", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await pdfWithInfo();
    const r = await redact(bytes, [AREA], { checks: allChecks, properties: { title: { set: NEW_TITLE } } });
    ok(r);
    const doc = await PDFDocument.load(r.bytes, { updateMetadata: false });
    expect(doc.getTitle()).toBe(NEW_TITLE);
    expect(doc.getTitle()).not.toBe(OLD_TITLE);
    const all = latin1(r.bytes);
    expect(all.includes(u16(OLD_TITLE))).toBe(false);
    expect(all.includes(latin1(new TextEncoder().encode(OLD_TITLE)))).toBe(false);
  });

  it("選んでいない欄の残りは、今までどおり保存させない（選んだ欄の分だけを外す）", async () => {
    const bytes = await pdfWithInfo();
    const r = await redact(bytes, [AREA], {
      checks: [fakeRules([{ pattern: "P1", field: "Author" }, { pattern: "P2", field: "dc:creator" }, { pattern: "P1", field: "Producer" }])],
      properties: { author: "keep" },
    });
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.leftovers.map((l) => l.field)).toEqual(["Producer"]);
    expect(r.chosen).toBe(2);
    expect(r.properties?.find((p) => p.key === "author")?.action).toBe("kept");
  });

  it("「消す」にした欄・欄の名前の無い行・ほかの型の行・調べられなかったことは、選んだ欄と同じ名前でも残りにする", async () => {
    const bytes = await pdfWithInfo();
    const r = await redact(bytes, [AREA], {
      checks: [
        fakeRules([{ pattern: "P1", field: "Title" }, { pattern: "P1" }, { pattern: "P8", field: "Author" }, { pattern: "P6" }]),
        { name: "verifier", run: async () => { throw new Error("止まった"); } },
      ],
      properties: { author: "keep", title: "remove" },
    });
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.leftovers.map((l) => `${l.kind}:${l.pattern ?? ""}:${l.field ?? ""}`)).toEqual([
      "rule_item:P1:Title", "rule_item:P1:", "rule_item:P8:Author", "rule_item:P6:", "verifier_error::",
    ]);
    expect(r.chosen).toBe(0);
  });

  it("プロパティを選ばないときは、今までどおり（欄の値の残りで保存させない。報告に properties・chosen を付けない）", async () => {
    const bytes = await pdfWithInfo();
    const r = await redact(bytes, [AREA], { checks: [fakeRules([{ pattern: "P1", field: "Author" }])] });
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.leftovers).toHaveLength(1);
    expect(r.properties).toBeUndefined();
    expect(r.chosen).toBeUndefined();
  });

  it("画面のつなぎ（片付けの Worker の中身）：黒塗りの結果にも、項目ごとの報告が付く", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await pdfWithInfo();
    const r = await sanitizeJob(bytes, [AREA], undefined, { properties: { author: "keep" } });
    expect(r.type).toBe("sanitized");
    if (r.type !== "sanitized") return;
    expect(r.properties?.find((p) => p.key === "author")?.action).toBe("kept");
  });
});

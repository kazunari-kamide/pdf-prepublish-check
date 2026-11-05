// SPDX-License-Identifier: AGPL-3.0-only
//
// 整えるときに本人が選ぶこと（src/ui/tidy-model.ts）と、片付けの Worker の中身（src/sanitize/job.ts）につないだときの結果。
// 合成 PDF（中身はすべて架空）を使う。

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { FIELDS } from "../sanitize/properties.ts";
import { inspectAll } from "../src/inspect/inspect";
import { preflightJob, sanitizeJob } from "../src/sanitize/job";
import { buildCleanView, saveGate } from "../src/ui/clean-model";
import { buildView } from "../src/ui/model";
import { buildEdits, changeLines, chosenFields, CONSENT_TEXT, PROPERTY_FIELDS } from "../src/ui/tidy-model";

async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 300]).drawText("SAMPLE", { x: 50, y: 200, font, size: 20 });
  doc.setTitle("Kakuu report draft");
  doc.setAuthor("Kakuu Taro");
  doc.setCreator("Kakuu Writer");
  return new Uint8Array(await doc.save());
}

describe("8 つの項目", () => {
  it("片付けの FIELDS と同じ組み（文書情報の欄・XMP の欄・日付か）", () => {
    expect(PROPERTY_FIELDS.map((f) => [f.key, f.info, f.xmp, f.date])).toEqual(FIELDS.map((f) => [f.key, f.info, f.xmp, f.date]));
  });
});

describe("選んだことを、片付けに渡す形にする", () => {
  it("選ばない項目は消す。そのまま・書き直す。空の書き直しは消す", () => {
    const { edits, bad } = buildEdits({ title: { mode: "set", value: " 申請書（見本） " }, author: { mode: "keep", value: "" }, subject: { mode: "set", value: "  " } });
    expect(bad).toEqual([]);
    expect(edits.title).toEqual({ set: "申請書（見本）" });
    expect(edits.author).toBe("keep");
    expect(edits.subject).toBe("remove");
    expect(edits.producer).toBe("remove");
    expect(Object.keys(edits)).toHaveLength(8);
  });
  it("日付の形が違うときは、その項目の名前を返す", () => {
    expect(buildEdits({ created: { mode: "set", value: "11月5日" } }).bad).toEqual(["作成日"]);
    expect(buildEdits({ created: { mode: "set", value: "2026-11-05T10:30" } }).edits.created).toEqual({ set: "2026-11-05T10:30" });
  });
  it("問いかけの文は C の #89 の案のまま", () => {
    expect(CONSENT_TEXT.pdfa).toContain("長期保存用の形式（PDF/A）の印");
    expect(CONSENT_TEXT.signatures(1)).toContain("署名は無効になります");
  });
});

describe("整える前に聞く・整える・読み直す", () => {
  it("今の値を聞き、題を書き直し、作成者をそのまま残すと、読み直しでその 2 つは「残り」に数えず、保存できる", { timeout: 60_000 }, async () => {
    const bytes = await samplePdf();
    const pre = await preflightJob(bytes);
    expect(pre.status).toBe("ok");
    if (pre.status !== "ok") return;
    expect(pre.properties.find((p) => p.key === "author")?.info).toBe("Kakuu Taro");
    expect(pre.pdfa).toBeNull();
    expect(pre.signatures).toBe(0);

    const before = buildView(await inspectAll(bytes, undefined, undefined, { withContents: true }));
    const { edits } = buildEdits({ title: { mode: "set", value: "Sample form" }, author: { mode: "keep", value: "" } });
    const r = await sanitizeJob(bytes, [], undefined, { properties: edits });
    expect(r.type).toBe("sanitized");
    if (r.type !== "sanitized") return;
    expect(r.properties?.find((c) => c.key === "title")?.action).toBe("set");
    expect(r.properties?.find((c) => c.key === "author")?.action).toBe("kept");
    expect(r.properties?.find((c) => c.key === "creator")?.action).toBe("removed");
    expect([...chosenFields(r.properties)].sort()).toEqual(["Author", "Title", "dc:creator", "dc:title"].sort());

    const afterSummary = await inspectAll(r.bytes, undefined, undefined, { withContents: true });
    const after = buildView(afterSummary);
    // 読み直しでは、題と作成者の値が見つかる（本人が選んだ値）
    expect(after.rows.some((x) => x.field === "Title" || x.field === "dc:title")).toBe(true);
    const c = buildCleanView({ before, after, removed: r.removed, notDone: r.notDone, decrypted: false, properties: r.properties });
    expect(c.chosen).toBeGreaterThan(0);
    expect(c.left).toBe(0);
    expect(saveGate(c)).not.toBe("blocked");
    expect(c.propertyLines).toContain("タイトル（Title）：書き直しました（本人が選んだ値）");
    expect(c.propertyLines.join("")).not.toMatch(/Kakuu|Sample form/);
    // 本人が選ばなかったら、同じ値は「残り」になる（選んだ欄だけを外していることの確かめ）
    const noChoice = buildCleanView({ before, after, removed: r.removed, notDone: r.notDone, decrypted: false });
    expect(noChoice.left).toBe(c.chosen);
  });

  it("何も選ばない（プロパティを渡さない）ときは、今までどおり全部消す", async () => {
    const r = await sanitizeJob(await samplePdf(), [], undefined, {});
    expect(r.type).toBe("sanitized");
    if (r.type !== "sanitized") return;
    expect(r.properties).toBeUndefined();
    const after = buildView(await inspectAll(r.bytes));
    expect(after.rows.filter((x) => x.pattern === "P1")).toHaveLength(0);
  });

  it("項目ごとの一言に、値は入れない", () => {
    expect(changeLines([{ key: "author", action: "kept", before: { info: true, xmp: true }, differed: true }])).toEqual([
      "作成者（Author）：そのまま残しました（本人が選んだ値）。文書情報と XMP で値が違っていたので、文書情報の値にそろえました",
    ]);
    expect(changeLines([{ key: "title", action: "absent", before: { info: false, xmp: false }, differed: false }])).toEqual([]);
  });
});

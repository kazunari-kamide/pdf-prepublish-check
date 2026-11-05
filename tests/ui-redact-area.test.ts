// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする画面のつなぎ（11/5 B の 9）。
// - 画面の箱をページの座標に戻す（src/inspect/view.ts の fromFraction）
// - 片付けの Worker の中身（src/sanitize/job.ts）が、選んだ所があれば片付けの redact（sanitize/redact.ts）を呼ぶ
// - 個人情報の候補（P13【仮】）から選んだ所が、片付けた PDF を検査し直すと消えている
// 合成 PDF（tests/helpers/redact-pdfs.ts。中身はすべて架空）を使う。

import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PageBox, Rect } from "../src/inspect/report";
import { inspectAll } from "../src/inspect/inspect";
import { fromFraction, toFraction } from "../src/inspect/view";
import { sanitizeJob } from "../src/sanitize/job";
import { buildView } from "../src/ui/model";
import { buildBlockedView, isCandidate, toAreas, toggleCandidate, type PickedArea } from "../src/ui/picks";
import { sanitizePdf } from "../sanitize/index.ts";
import { buildPdf, imageJpeg, latinAt } from "./helpers/redact-pdfs.ts";
import { HEAVY_TIMEOUT } from "./helpers/timeout.ts";

/** PDF.js で取り出せる字（ページごとにつなげたもの）。片付けと別の読み方で確かめる */
async function textOf(bytes: Uint8Array): Promise<string[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    out.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(""));
  }
  await task.destroy();
  return out;
}

describe("画面の箱をページの座標に戻す", () => {
  for (const rotate of [0, 90, 180, 270] as const) {
    it(`回転 ${rotate} 度でも、toFraction の逆になる`, () => {
      const box: PageBox = { page: 1, view: [10, 20, 610, 820], rotate };
      const rect: Rect = [100, 200, 300, 260];
      const back = fromFraction(box, toFraction(box, rect)!);
      back.forEach((v, i) => expect(v).toBeCloseTo(rect[i]!, 6));
    });
  }
});

describe("片付けの Worker の中身：選んだ所があれば redact を呼ぶ", () => {
  it("選んだ所の字は取り出せなくなり、選んでいない所の字は残る", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await buildPdf(() => ({ pages: [{ content: latinAt(100, 200, "HIDEME") + latinAt(100, 100, "KEEP") }] }));
    const r = await sanitizeJob(bytes, [{ page: 1, rect: [95, 195, 160, 215] }]);
    expect(r.type).toBe("sanitized");
    if (r.type !== "sanitized") return;
    expect(r.removed.some((x) => x.kind === "redacted_text")).toBe(true);
    expect(r.removed.filter((x) => x.kind === "redaction_box")).toHaveLength(1);
    const [text] = await textOf(r.bytes);
    expect(text).not.toContain("HIDEME");
    expect(text).toContain("KEEP");
  });

  it("何も選ばないときは、ふつうの片付けと同じ PDF になる", async () => {
    const bytes = await buildPdf(() => ({ pages: [{ content: latinAt(100, 200, "SAMPLE") }] }));
    const r = await sanitizeJob(bytes, []);
    const s = await sanitizePdf(bytes);
    expect(r.type).toBe("sanitized");
    if (r.type !== "sanitized" || s.status !== "ok") throw new Error("片付けられませんでした");
    expect(Buffer.from(r.bytes).equals(Buffer.from(s.bytes))).toBe(true);
  });

  it("選んだ所の下の JPEG を塗れないとき（画像の道具なし）は、PDF を返さず、何がどこに残ったかを返す", async () => {
    const bytes = await buildPdf(async (doc) => ({ pages: [{ content: "q 200 0 0 100 100 50 cm /Im1 Do Q\n", images: [await imageJpeg(doc.context, 200, 100)] }] }));
    const r = await sanitizeJob(bytes, [{ page: 1, rect: [150, 80, 250, 120] }]);
    expect(r.type).toBe("redact_blocked");
    if (r.type !== "redact_blocked") return;
    expect("bytes" in r).toBe(false);
    const v = buildBlockedView(r.leftovers, r.notDone);
    expect(v.headline).toMatch(/保存できるファイルは作っていません/);
    expect(v.lines.length).toBeGreaterThan(0);
    expect(v.lines.every((l) => /ページ 1/.test(l))).toBe(true);
  });

  it("ページの外を選んだときは、断って理由を返す", async () => {
    const bytes = await buildPdf(() => ({ pages: [{ content: latinAt(100, 200, "SAMPLE") }] }));
    const r = await sanitizeJob(bytes, [{ page: 9, rect: [0, 0, 10, 10] }]);
    expect(r).toEqual({ type: "refused", message: "選んだ場所のページが、この PDF にありません。" });
  });
});

describe("個人情報の候補（P13【仮】）から選んで黒塗りする", () => {
  it("候補を選んで片付けると、検査し直したとき、その候補は見つからない", { timeout: HEAVY_TIMEOUT }, async () => {
    // 架空のメールアドレスと携帯の番号（Helvetica で描く）。予約された見本の形（example.com・000-…）は候補にならないので使わない
    const bytes = await buildPdf(() => ({ pages: [{ content: latinAt(50, 200, "ritsu@kakuu.test") + latinAt(50, 170, "TEL 090-0274-1883") + latinAt(50, 100, "KEEP") }] }));
    const before = buildView(await inspectAll(bytes));
    const candidates = before.rows.filter(isCandidate);
    expect(candidates.length).toBeGreaterThan(0);
    let picks: PickedArea[] = [];
    for (const c of candidates) picks = toggleCandidate(picks, c);
    expect(picks.map((p) => p.candidate)).toEqual(candidates.map((c) => c.no));

    const r = await sanitizeJob(bytes, toAreas(picks));
    expect(r.type).toBe("sanitized");
    if (r.type !== "sanitized") return;
    const after = buildView(await inspectAll(r.bytes));
    expect(after.rows.filter((x) => x.pattern === "P13")).toHaveLength(0);
    expect(r.removed.filter((x) => x.kind === "redaction_box")).toHaveLength(picks.length);
    const [text] = await textOf(r.bytes);
    expect(text).not.toMatch(/ritsu|kakuu|0274|1883/);
    expect(text).toContain("KEEP");
  });
});

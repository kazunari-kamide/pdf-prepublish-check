// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査のページの「気づきにくい見本」（demo/subtle-sample/。作り方は build.mjs）が、決めた形のままかを確かめる。
// - 作り直すと、置いてあるファイルと 1 バイトも違わない
// - 本番と同じ検査（RULES・画像の解き手あり）で、入れた型がすべて出て、ほかの型は出ない
// - 整えると、消せるもの（塗った下の字・前の版・文書情報）は 0 になり、「整える」では消せない 3 つの型だけが残る。
//   そのときの説明の文（なぜ残ったか・どこか・元の書類で直すこと）が出る
// fixtures/ ではないので、採点（npm run eval）には入らない。

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BOXES, build, FICTION, OUT, PAGE } from "../demo/subtle-sample/build.mjs";
import { createNodeImageDecoder } from "../eval/image-decoder.ts";
import type { UnderProbe } from "../rules/redacted-text-elsewhere/index.ts";
import { sanitizePdf } from "../sanitize/index.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";
import { inspectAll } from "../src/inspect/inspect";
import { RULES } from "../src/inspect/rules";
import { buildCleanView } from "../src/ui/clean-model";
import { buildView, FIX_IN_SOURCE_LABELS, FIX_IN_SOURCE_WHY, fixInSourceWhy, kindSummary } from "../src/ui/model";
import { decodeDataUrl, SUBTLE_SAMPLE_NAME } from "../src/ui/sample";

const FILE = path.resolve(import.meta.dirname, "..", "demo", "subtle-sample", OUT);
const bytes = () => new Uint8Array(readFileSync(FILE));

/** 見つかったものを [ルール, ページ, 深刻度, 確かめるか] の並びにする */
const found = (s: Awaited<ReturnType<typeof inspectAll>>) =>
  s.rules.flatMap((r) => r.items.map((it) => [r.ruleId, it.page, it.severity, it.confidence === "check"] as const)).sort((a, b) => `${a[0]}`.localeCompare(`${b[0]}`) || (a[1] ?? 0) - (b[1] ?? 0));

describe("demo/subtle-sample（気づきにくい見本）", () => {
  // 字を画素に描く結果（@napi-rs/canvas）は、OS で少し変わることがある（推測）。作った OS（Windows）でだけ比べる
  it.runIf(process.platform === "win32")("作り直すと、置いてあるファイルと 1 バイトも違わない（4 ページ・A4）", async () => {
    const again = await build();
    expect(Buffer.from(again).equals(Buffer.from(bytes()))).toBe(true);
    expect(PAGE).toEqual({ width: 595, height: 842 });
    // 画面に埋め込むので、小さく保つ
    expect(bytes().length).toBeLessThan(200_000);
  }, 60_000);

  it("本番と同じ検査で、入れた型がすべて出て、ほかの型は出ない", async () => {
    const s = await inspectAll(bytes(), () => {}, RULES, { imageDecoder: createNodeImageDecoder() });
    expect(found(s)).toEqual([
      ["barcode-scan", 1, "medium", true], // 1 ページ目：塗った宛先のそばの記号
      ["cross-page-redaction", 3, "medium", true], // 3 ページ目：2 ページ目で塗った氏名の欄を塗り忘れ
      ["p1-info", null, "medium", false], // タイトル
      ["p1-info", null, "medium", false], // 作成者（人の名前）
      ["p5-revisions", null, "high", false], // 前の版の文書情報
      ["p6-text", 4, "high", false], // 4 ページ目：黒い四角の下に字が残る
      ["redacted-text-elsewhere", 4, "high", true], // 4 ページ目：同じ地名が下の段落に塗られずに出る
    ]);
    // 塗り忘れは、2 ページ目で塗った氏名の欄の位置
    const cross = s.rules.find((r) => r.ruleId === "cross-page-redaction")!.items[0]!;
    const b = BOXES.p2[0]!;
    expect(cross.rect).toEqual([b.x, PAGE.height - b.y - b.h, b.x + b.w, PAGE.height - b.y]);
  }, 120_000);

  it("整えると、消せるものは 0 になり、「整える」では消せない 3 つの型だけが残る。残った所の説明の文が出る", async () => {
    let probes: UnderProbe[] = [];
    const ctx = { imageDecoder: createNodeImageDecoder() };
    // 画面の Worker と同じく、整える前の検査で塗った下の字を覚え、読み直しに渡す（src/worker/inspect.worker.ts）
    const first = await inspectAll(bytes(), () => {}, RULES, { ...ctx, onUnderProbes: (p: UnderProbe[]) => (probes = p) });
    expect(probes.length).toBeGreaterThan(0);
    const r = await sanitizePdf(bytes(), { codec: createNodeImageCodec() });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const again = await inspectAll(r.bytes, () => {}, RULES, { ...ctx, underProbes: probes });
    expect(found(again)).toEqual([
      ["barcode-scan", 1, "medium", true],
      ["cross-page-redaction", 3, "medium", true],
      ["redacted-text-elsewhere", 4, "high", true],
    ]);
    // 整えた PDF には、塗った下の字・作成者の名前・前の版の題が残っていない
    const text = Buffer.from(r.bytes).toString("latin1");
    expect(text).not.toContain("Prev");
    const after = buildView(again);
    const c = buildCleanView({ before: buildView(first), after, removed: r.removed, notDone: r.notDone, decrypted: r.decrypted });
    expect({ left: c.left, notDone: c.notDone.length, verdict: c.verdict }).toEqual({ left: 3, notDone: 0, verdict: "left" });
    // 画面の上の面（読み直したあとも残っている所）に出す説明
    expect(fixInSourceWhy(after.rows)).toBe(FIX_IN_SOURCE_WHY);
    expect(kindSummary(after).shown.map((k) => k.where)).toEqual(["ページ 1、3、4"]);
  }, 180_000);
});

describe("「整える」では消せない残り方の説明", () => {
  it("3 つの名前は、どれも今のルールの名前", () => {
    const labels = new Set(RULES.map((r) => r.label));
    for (const l of FIX_IN_SOURCE_LABELS) expect(labels.has(l)).toBe(true);
  });
  it("なぜ残ったか・どこか・元の書類で直すことを言う", () => {
    expect(FIX_IN_SOURCE_WHY).toContain("「整える」では消せない");
    expect(FIX_IN_SOURCE_WHY).toContain("どこに出ているか");
    expect(FIX_IN_SOURCE_WHY).toContain("元の書類で");
  });
  it("ほかの残り方が混じれば出さない（片付けの失敗などを、元の書類のせいにしない）", () => {
    const row = (label: string) => ({ patternLabel: `${label}（P6）`, candidate: false }) as Parameters<typeof fixInSourceWhy>[0][number];
    expect(fixInSourceWhy([row("黒塗りのそばの記号")])).toBe(FIX_IN_SOURCE_WHY);
    expect(fixInSourceWhy([row("黒塗りのそばの記号"), row("見せかけの黒塗り")])).toBeNull();
    expect(fixInSourceWhy([])).toBeNull();
  });
});

describe("画面に埋め込む見本", () => {
  it("名前は架空と分かる形。中身は置いてあるファイルと同じ", () => {
    expect(SUBTLE_SAMPLE_NAME).toContain("架空");
    const url = `data:application/pdf;base64,${Buffer.from(bytes()).toString("base64")}`;
    expect(Buffer.from(decodeDataUrl(url)!).equals(Buffer.from(bytes()))).toBe(true);
  });
  it("架空の字だけを使う", () => {
    expect(FICTION.city).toBe("白樺野市");
  });
});

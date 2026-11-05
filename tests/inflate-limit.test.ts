// SPDX-License-Identifier: AGPL-3.0-only
//
// 圧縮を解く大きさの上限（rules/shared/inflate-limit.ts）を、合成の爆弾（tests/helpers/bomb-pdfs.ts。テストの中で作る）で確かめる。
// - 1 つの流れ 256MB・1 つのファイルの合計 1GB で、途中で止まる（全部解いてから大きさを見ない）
// - 止めた所は「大きすぎるため調べていません」と出て、調べられなかった所に数える。「見つかりませんでした」にしない
// - 片付けでは、書き換えられないページは片付けられなかった所（notDone）にし、ページの外で止まったら片付けた PDF を作らない
// - 上限の内に収まる大きなスキャン（600dpi の A4 のカラー、約 104MB）は、これまでどおり調べて片付ける（対照）
//
// メモリの少ない PC でも動くよう、爆弾は 1 つずつ作って 1 つずつ調べる（このファイルの中のテストは順に動く）。
// 止まらなければ、解いた大きさ（1.2GB の爆弾なら 2GB の入れ物）だけメモリを使うので、各テストの終わりに、
// これまでの最大のメモリ（maxRSS）が 1.2GB を超えていないことも見る。

import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { detectP6Text } from "../rules/p6-text/index.ts";
import {
  INFLATE_LIMITS,
  INFLATE_LIMIT_MESSAGE,
  InflateLimitError,
  decodeStream,
  decodeStreamUpTo,
  inflatedBytes,
  peelOuterFilters,
} from "../rules/shared/inflate-limit.ts";
import { sanitizePdf } from "../sanitize/index.ts";
import { inspectAll } from "../src/inspect/inspect";
import type { InspectSummary } from "../src/inspect/report";
import { buildCleanView, saveGate } from "../src/ui/clean-model";
import { buildCoverage } from "../src/ui/coverage";
import { buildView } from "../src/ui/model";
import { MB, attachmentBomb, contentBomb, deflatedZeros, imageBomb, largeScan, objectStreamBomb, totalBomb, xmpBomb } from "./helpers/bomb-pdfs.ts";

/** 1 つずつのテストの時間の上限（爆弾を作る時間を含む。GitHub Actions の機械は手元より遅い） */
const BOMB_TIMEOUT = 180_000;
/** 止まっていれば超えないメモリ（maxRSS） */
const MAX_RSS_BYTES = 1200 * MB;
const SIZES = [
  { label: "300MB", size: 300 * MB },
  { label: "1.2GB", size: 1200 * MB },
] as const;

const maxRss = () => process.resourceUsage().maxRSS * 1024;
const notices = (s: InspectSummary) => s.rules.flatMap((r) => r.notices);
const reasonsText = (s: InspectSummary) => buildCoverage(s).flatMap((c) => c.reasons).join("\n");

describe("上限の値（1 か所の設定）", () => {
  it("1 つの流れ 256MB、1 つのファイルの合計 1GB", () => {
    expect(INFLATE_LIMITS.streamBytes).toBe(256 * MB);
    expect(INFLATE_LIMITS.fileBytes).toBe(1024 * MB);
  });
});

describe("解く入口", () => {
  it("1 つの流れが上限を超えると、途中で止めて InflateLimitError を投げ、合計には数えない", async () => {
    const doc = await PDFDocument.create();
    const s = PDFRawStream.of(doc.context.obj({ Filter: "FlateDecode" }), await deflatedZeros(300 * MB));
    const t0 = Date.now();
    let err: unknown;
    try {
      decodeStream(s);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InflateLimitError);
    expect((err as InflateLimitError).scope).toBe("stream");
    expect(inflatedBytes(doc.context)).toBe(0);
    // 2 回目は解かずにすぐ止める
    const t1 = Date.now();
    expect(() => decodeStream(s)).toThrow(InflateLimitError);
    expect(Date.now() - t1).toBeLessThan(50);
    expect(Date.now() - t0).toBeLessThan(BOMB_TIMEOUT);
    expect(maxRss()).toBeLessThan(MAX_RSS_BYTES);
  }, BOMB_TIMEOUT);

  it("上限の内の流れは解ける。同じ流れは、何度解いても合計に 1 回だけ数える", async () => {
    const doc = await PDFDocument.create();
    const s = PDFRawStream.of(doc.context.obj({ Filter: "FlateDecode" }), await deflatedZeros(10 * MB));
    expect(decodeStream(s).length).toBe(10 * MB);
    const once = inflatedBytes(doc.context);
    expect(once).toBeGreaterThanOrEqual(10 * MB);
    decodeStream(s);
    expect(inflatedBytes(doc.context)).toBe(once);
  });

  it("呼ぶ側の上限（例：16MB）を超えたら、途中で止めて null（合計には数えない）", async () => {
    const doc = await PDFDocument.create();
    const s = PDFRawStream.of(doc.context.obj({ Filter: "FlateDecode" }), await deflatedZeros(300 * MB));
    expect(decodeStreamUpTo(s, 16 * MB)).toBeNull();
    expect(inflatedBytes(doc.context)).toBe(0);
  }, BOMB_TIMEOUT);

  it("1 つのファイルの合計が 1GB を超えると、その先の流れは止める（1 つずつは上限の内）", async () => {
    const doc = await PDFDocument.create();
    const results: Array<"ok" | "file" | "stream"> = [];
    for (let i = 0; i < 5; i++) {
      const head = new TextEncoder().encode(`% ${i}\n`);
      const s = PDFRawStream.of(doc.context.obj({ Filter: "FlateDecode" }), await deflatedZeros(240 * MB, head));
      try {
        decodeStream(s);
        results.push("ok");
      } catch (e) {
        expect(e).toBeInstanceOf(InflateLimitError);
        results.push((e as InflateLimitError).scope);
      }
    }
    expect(results).toEqual(["ok", "ok", "ok", "ok", "file"]);
    expect(inflatedBytes(doc.context)).toBeLessThanOrEqual(INFLATE_LIMITS.fileBytes);
    expect(maxRss()).toBeLessThan(MAX_RSS_BYTES);
  }, BOMB_TIMEOUT);

  it("PDF.js に渡す画像：外側の Flate を上限つきで解き、最後の圧縮（DCT など）だけを残す", async () => {
    const doc = await PDFDocument.create();
    const small = await deflatedZeros(1 * MB);
    const ok = peelOuterFilters(PDFRawStream.of(doc.context.obj({ Filter: ["FlateDecode", "DCTDecode"] }), small)) as PDFRawStream;
    expect(ok.dict.lookup(PDFName.of("Filter"))).toBe(PDFName.of("DCTDecode"));
    expect(ok.contents.length).toBe(1 * MB);
    // Flate だけの画像は解かない（PDF.js が要る大きさだけを読む）
    const flateOnly = PDFRawStream.of(doc.context.obj({ Filter: "FlateDecode" }), small);
    expect(peelOuterFilters(flateOnly)).toBe(flateOnly);
    // 外側が爆弾なら止める
    const bomb = PDFRawStream.of(doc.context.obj({ Filter: ["FlateDecode", "DCTDecode"] }), await deflatedZeros(300 * MB));
    expect(() => peelOuterFilters(bomb)).toThrow(InflateLimitError);
  }, BOMB_TIMEOUT);
});

describe("検査：ページの中身の爆弾", () => {
  it.each(SIZES)("$label：そのページを「解くと大きすぎる」として省き、ほかのページは調べる", async ({ size }) => {
    const s = await inspectAll(await contentBomb(size, { pages: 2, bombPage: 1 }));
    for (const id of ["p6-text", "p7-hidden", "pii"]) {
      const r = s.rules.find((x) => x.ruleId === id)!;
      expect(r.status).toBe("ok");
      const skipped = r.notices.filter((n) => n.kind === "skipped_pages");
      expect(skipped).toEqual([{ kind: "skipped_pages", message: "このページは、解くと大きすぎる中身があるため、検査を省きました。", pages: [1], reason: "too_large" }]);
    }
    const v = buildView(s);
    expect(v.clean).toBe(false);
    expect(v.verdict).not.toBe("none");
    // ページの絵も描かない（PDF.js には、解く大きさの上限を渡せないため）
    expect(v.heavyPages).toEqual([1]);
    expect(reasonsText(s)).toContain("解くと大きすぎる中身があるため、ページ 1 を省きました。");
    expect(maxRss()).toBeLessThan(MAX_RSS_BYTES);
  }, BOMB_TIMEOUT);

  it("合計の爆弾（240MB×5 ページ）：合計が 1GB を超えたページから省く", async () => {
    const r = await detectP6Text(await totalBomb(240 * MB, 5));
    expect(r.status).toBe("ok");
    expect(r.skippedPages).toEqual([{ page: 5, reason: "stream_too_large" }]);
    expect(maxRss()).toBeLessThan(MAX_RSS_BYTES);
  }, BOMB_TIMEOUT);
});

describe("検査：XMP の爆弾", () => {
  it.each(SIZES)("$label：作成の記録を「大きすぎる」として、調べられなかった所に数える", async ({ size }) => {
    const s = await inspectAll(await xmpBomb(size));
    const xmp = s.rules.find((x) => x.ruleId === "p2-xmp")!;
    expect(xmp.notices.some((n) => n.kind === "partial" && n.message.includes("大きすぎる"))).toBe(true);
    expect(buildCoverage(s).find((c) => c.key === "P2")!.state).not.toBe("checked");
    expect(buildView(s).clean).toBe(false);
    expect(maxRss()).toBeLessThan(MAX_RSS_BYTES);
  }, BOMB_TIMEOUT);
});

describe("検査：添付の爆弾", () => {
  it.each(SIZES)("$label：添付は見つけ、中身は「大きすぎるため調べていません」", async ({ size }) => {
    const s = await inspectAll(await attachmentBomb(size));
    const p9 = s.rules.find((x) => x.ruleId === "p9-attach")!;
    expect(p9.status).toBe("ok");
    expect(p9.items).toHaveLength(1);
    expect(p9.items[0]!.detail).toContain("中身：大きすぎるため調べていません");
    expect(maxRss()).toBeLessThan(MAX_RSS_BYTES);
  }, BOMB_TIMEOUT);
});

describe("検査：画像の爆弾", () => {
  it.each(SIZES)("$label：「読み解けない形式」ではなく「大きすぎるため調べていません」と出す", async ({ size }) => {
    const s = await inspectAll(await imageBomb(size));
    const images = notices(s).filter((n) => n.kind === "unchecked_images");
    expect(images).toHaveLength(1);
    expect(images[0]!.message).toContain("大きすぎるため調べていません");
    expect(images[0]!.reason).toBe("too_large");
    expect(images[0]!.pages).toEqual([1]);
    expect(notices(s).some((n) => n.message.includes("読み解けない形式"))).toBe(false);
    const text = reasonsText(s);
    expect(text).toContain("ページ 1 に、大きすぎるため調べていない画像があります。");
    expect(text).not.toContain("読み解けなかった画像");
    expect(buildView(s).clean).toBe(false);
    expect(maxRss()).toBeLessThan(MAX_RSS_BYTES);
  }, BOMB_TIMEOUT);
});

describe("検査：オブジェクトストリームの爆弾（読み込みのときに pdf-lib が解くもの）", () => {
  it("300MB：黙って中身を落とさず、すべての項目を「大きすぎるため調べていません」にする", async () => {
    const s = await inspectAll(await objectStreamBomb(300 * MB));
    for (const r of s.rules) {
      expect(r.status, r.ruleId).toBe("error");
      expect(r.message, r.ruleId).toBe(INFLATE_LIMIT_MESSAGE);
    }
    expect(buildView(s).clean).toBe(false);
    expect(maxRss()).toBeLessThan(MAX_RSS_BYTES);
  }, BOMB_TIMEOUT);
});

describe("対照：上限の内に収まる大きなスキャン（600dpi の A4 のカラー、約 104MB）", () => {
  it("これまでどおり画像を調べ、「大きすぎる」とは出さない", async () => {
    const bytes = await largeScan();
    const s = await inspectAll(bytes);
    const p6 = s.rules.find((x) => x.ruleId === "p6-text")!;
    expect(p6.status).toBe("ok");
    // 画像の上の黒い四角を、画像の層で見つける（画素を読めている）
    expect(p6.items.some((i) => i.pattern === "P6")).toBe(true);
    expect(s.rules.every((r) => r.status === "ok")).toBe(true);
    expect(notices(s).filter((n) => n.kind === "unchecked_images" || n.kind === "skipped_pages")).toEqual([]);
    expect(reasonsText(s)).not.toContain("大きすぎる");
  }, BOMB_TIMEOUT);

  it("片付けも、これまでどおり画像を塗り（流して塗る道）、片付けられなかった所はない", async () => {
    const r = await sanitizePdf(await largeScan());
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.notDone).toEqual([]);
    expect(r.removed.some((x) => x.pattern === "P6")).toBe(true);
  }, BOMB_TIMEOUT);
});

describe("片付け", () => {
  it.each(SIZES)("ページの中身の爆弾 $label：そのページは片付けられなかった所にし、保存をそのまま通さない", async ({ size }) => {
    const bytes = await contentBomb(size, { pages: 2, bombPage: 1 });
    const r = await sanitizePdf(bytes);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.notDone.map((n) => [n.reason, n.page])).toEqual([["stream_too_large", 1]]);
    const before = buildView(await inspectAll(bytes));
    const after = buildView(await inspectAll(r.bytes));
    const c = buildCleanView({ before, after, removed: r.removed, notDone: r.notDone, decrypted: false });
    expect(c.verdict).not.toBe("clean");
    expect(saveGate(c)).not.toBe("ok");
    expect(maxRss()).toBeLessThan(MAX_RSS_BYTES);
  }, BOMB_TIMEOUT);

  it.each(SIZES)("画像の爆弾 $label：画像を塗れないので、片付けられなかった所にする", async ({ size }) => {
    const r = await sanitizePdf(await imageBomb(size));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.notDone.map((n) => [n.reason, n.page])).toEqual([["image_too_large", 1]]);
    expect(maxRss()).toBeLessThan(MAX_RSS_BYTES);
  }, BOMB_TIMEOUT);

  it.each(SIZES)("XMP・添付の爆弾 $label：解かずに取り除けるので、片付けた PDF に残らない", async ({ size }) => {
    for (const make of [xmpBomb, attachmentBomb]) {
      const r = await sanitizePdf(await make(size));
      expect(r.status).toBe("ok");
      if (r.status !== "ok") return;
      expect(r.notDone).toEqual([]);
      // 取り除いたので、読み直しても「大きすぎる」は出ない
      expect(reasonsText(await inspectAll(r.bytes))).not.toContain("大きすぎる");
    }
    expect(maxRss()).toBeLessThan(MAX_RSS_BYTES);
  }, BOMB_TIMEOUT);

  it("オブジェクトストリームの爆弾：ページの外で止まるので、片付けた PDF を作らない", async () => {
    const r = await sanitizePdf(await objectStreamBomb(300 * MB));
    expect(r).toEqual({ status: "error", code: "too_large", message: "解くと大きすぎる所があるため、片付けられません。" });
  }, BOMB_TIMEOUT);
});

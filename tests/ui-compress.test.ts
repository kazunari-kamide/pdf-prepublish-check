// SPDX-License-Identifier: AGPL-3.0-only
//
// 「ファイルを小さくする」の画面のつなぎ（src/ui/compress-model.ts・src/sanitize/job.ts の compressJob）。
// 合成 PDF（tests/helpers/compress-pdfs.ts。中身はすべて架空）を使う。

import { describe, expect, it } from "vitest";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";
import { rulesCheck } from "../sanitize/redact-check.ts";
import { COMPRESS_DPI, COMPRESS_QUALITY } from "../sanitize/index.ts";
import { inspectAll } from "../src/inspect/inspect";
import { compressJob } from "../src/sanitize/job";
import { buildCompressView, COMPRESS_PRESETS, compressedFileName, DEFAULT_PRESET } from "../src/ui/compress-model";
import { SCENES } from "./helpers/compress-pdfs.ts";
import { HEAVY_TIMEOUT } from "./helpers/timeout.ts";

const scene = (name: string) => SCENES.find((s) => s.name.startsWith(name))!.make();
const checks = [rulesCheck((b) => inspectAll(b))];

describe("選べる値", () => {
  it("3つで、どれも片付けの compress の範囲の中。既定は「ふつう」（150 dpi・0.75）", () => {
    expect(COMPRESS_PRESETS.map((p) => p.id)).toEqual(["normal", "small", "fine"]);
    for (const p of COMPRESS_PRESETS) {
      expect(p.maxDpi).toBeGreaterThanOrEqual(COMPRESS_DPI.min);
      expect(p.maxDpi).toBeLessThanOrEqual(COMPRESS_DPI.max);
      expect(p.jpegQuality).toBeGreaterThanOrEqual(COMPRESS_QUALITY.min);
      expect(p.jpegQuality).toBeLessThanOrEqual(COMPRESS_QUALITY.max);
    }
    expect([DEFAULT_PRESET.maxDpi, DEFAULT_PRESET.jpegQuality]).toEqual([COMPRESS_DPI.default, COMPRESS_QUALITY.default]);
  });

  it("小さくした PDF の名前は、片付けた PDF の名前のあとに「_小」", () => {
    expect(compressedFileName("申請書_片付け済み.pdf")).toBe("申請書_片付け済み_小.pdf");
  });
});

describe("結果の見せ方", () => {
  const images = { changed: 2, savedBytes: 900_000, skipped: [{ reason: "within_dpi" as const, count: 3, label: "もう選んだ細かさ以下の画像" }, { reason: "mask" as const, count: 0, label: "型抜きの画像" }] };

  it("小さくできたら、前後の大きさ・減った割合・書き直した数・手を付けなかった理由と数", () => {
    const v = buildCompressView({ status: "ok", sizeBefore: 1_048_576, sizeAfter: 262_144, changed: true, images });
    expect(v.kind).toBe("ok");
    expect(v.headline).toBe("ファイルを小さくしました（75% 減りました）。");
    expect(v.sizes).toBe("小さくする前 1.0 MB → 小さくしたあと 256.0 KB");
    expect(v.lines).toEqual(["縮めて書き直した画像：2 個", "もう選んだ細かさ以下の画像：3 個"]);
  });

  it("小さくできる画像がなければ、そう言い、大きさは変わらないと書く", () => {
    const v = buildCompressView({ status: "ok", sizeBefore: 2048, sizeAfter: 2048, changed: false, images: { ...images, changed: 0 } });
    expect(v.kind).toBe("same");
    expect(v.headline).toMatch(/小さくできる画像がありませんでした/);
    expect(v.sizes).toBe("大きさ 2.0 KB（変わりません）");
  });

  it("読み直しで残りが増えたら、保存させないと言い、増えた種類と前後の数を並べる", () => {
    const v = buildCompressView({
      status: "blocked", sizeBefore: 5000, sizeAfter: 3000,
      increased: [{ check: "rules", kind: "rule_item", pattern: "P6", label: "読み直しの検査で、P6 の残りが見つかりました", before: 0, after: 1 }],
    });
    expect(v.kind).toBe("blocked");
    expect(v.headline).toMatch(/保存できるファイルは作っていません/);
    expect(v.lines).toEqual(["読み直しの検査で、P6 の残りが見つかりました（0 → 1）"]);
    expect([v.headline, ...v.lines].join("")).not.toMatch(/安全です|問題なし/);
  });
});

describe("片付けの Worker の中身：小さくする", () => {
  it("細かいスキャンを小さくする。前後に作品の検査をかけ、残りは増えない", { timeout: HEAVY_TIMEOUT }, async () => {
    const bytes = await scene("スキャン（灰色");
    const r = await compressJob(bytes, DEFAULT_PRESET, createNodeImageCodec(), checks);
    expect(r.type).toBe("compressed");
    if (r.type !== "compressed") return;
    expect(r.changed).toBe(true);
    expect(r.sizeAfter).toBeLessThan(r.sizeBefore);
    expect(r.images.changed).toBeGreaterThan(0);
  });

  it("画像の道具を読み込めなかったときは、断って理由を返す", async () => {
    const r = await compressJob(new Uint8Array([1]), DEFAULT_PRESET, undefined, checks);
    expect(r).toEqual({ type: "refused", message: "画像を書き直す道具を読み込めなかったため、小さくできません。" });
  });
});

describe("提出のために小さくする入口（上限を先に選ぶ）", async () => {
  const { SIZE_LIMITS, sizeLimitFrom, nextForLimit, limitLine, limitBytes } = await import("../src/ui/compress-model");
  const three = sizeLimitFrom("3")!;
  it("上限は 1MB＝1,000,000 バイトで数え、3MB 以下がある。知らない値は null", () => {
    expect(three.bytes).toBe(3_000_000);
    expect(SIZE_LIMITS.map((l) => l.mb)).toContain(3);
    for (const v of ["", "4", "3MB", "abc"]) expect(sizeLimitFrom(v)).toBeNull();
  });
  it("収まっていれば小さくしない。超えていれば「ふつう」→「もっと小さく」→あきらめる", () => {
    expect(nextForLimit(3_000_000, three, [])).toEqual({ kind: "fits" });
    const a = nextForLimit(3_000_001, three, []);
    expect(a.kind === "try" && a.preset.id).toBe("normal");
    const b = nextForLimit(4_000_000, three, ["normal"]);
    expect(b.kind === "try" && b.preset.id).toBe("small");
    expect(nextForLimit(4_000_000, three, ["normal", "small"])).toEqual({ kind: "gaveUp" });
  });
  it("上限の近くでも、上限と同じ数え方で大きさを書く（収まらないのに 3.0 MB 以下に見せない）", () => {
    expect(limitBytes(3_000_000)).toBe("3.0 MB");
    expect(limitBytes(3_000_001)).toBe("3.1 MB");
    expect(limitLine(3_050_000, three, true)).toContain("収まりませんでした");
    expect(limitLine(2_400_000, three, false)).toContain("小さくしなくても出せます");
    expect(limitLine(2_400_000, three, true)).toContain("収まりました（2.4 MB）");
  });
});

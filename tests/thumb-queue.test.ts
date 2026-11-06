// SPDX-License-Identifier: AGPL-3.0-only
//
// 左の列の縮小したページ（2026-11-06 朝）。
// - 見えたものから 1 枚ずつ描き、先頭から何枚という上限を置かない（前は 60 枚より後が白い枠のままだった）
// - 枠は縮めず、描いた絵の縦横比にそろえる（前は横長のページの絵が下の枠に重なっていた）
// - 列に横のスクロールバーを出さない

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createThumbQueue } from "../src/ui/thumb-queue.ts";

const root = path.resolve(import.meta.dirname, "..");
const css = readFileSync(path.join(root, "src", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const main = readFileSync(path.join(root, "src", "main.ts"), "utf8");
const rule = (selector: string) => {
  const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.split(",").some((s) => s.trim() === selector)).map((m) => m[2]!);
  if (found.length === 0) throw new Error(`指定が見つからない: ${selector}`);
  return found.join("\n");
};

describe("縮小したページを描く順番待ち", () => {
  it("450 ページでも、見えたページは最後まで描く（上限なし）", async () => {
    const drawn: number[] = [];
    const q = createThumbQueue(async (n) => {
      drawn.push(n);
      return true;
    });
    for (let n = 1; n <= 450; n++) q.want(n);
    await q.idle();
    expect(drawn.length).toBe(450);
    expect(drawn.at(-1)).toBe(450);
  });

  it("一度に描くのは 1 枚だけ。同じページは二度描かない", async () => {
    let now = 0;
    let most = 0;
    const drawn: number[] = [];
    const q = createThumbQueue(async (n) => {
      now++;
      most = Math.max(most, now);
      await new Promise((r) => setTimeout(r, 1));
      drawn.push(n);
      now--;
      return true;
    });
    for (const n of [3, 4, 3, 5, 4]) q.want(n);
    await q.idle();
    q.want(3);
    await q.idle();
    expect(most).toBe(1);
    expect(drawn).toEqual([3, 4, 5]);
  });

  it("見えなくなったページは、まだ描いていなければ待ちから外す", async () => {
    const drawn: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = createThumbQueue(async (n) => {
      if (n === 1) await gate;
      drawn.push(n);
      return true;
    });
    q.want(1);
    q.want(2);
    q.want(3);
    q.unwant(2);
    release();
    await q.idle();
    expect(drawn).toEqual([1, 3]);
  });

  it("描けなくなったら（時間の上限など）、そこで止める", async () => {
    const drawn: number[] = [];
    const q = createThumbQueue(async (n) => {
      drawn.push(n);
      if (n === 2) throw new Error("時間の上限");
      return true;
    });
    for (const n of [1, 2, 3, 4]) q.want(n);
    await q.idle();
    q.want(5);
    await q.idle();
    expect(drawn).toEqual([1, 2]);
  });

  it("stop のあとは描かない", async () => {
    const drawn: number[] = [];
    const q = createThumbQueue(async (n) => {
      drawn.push(n);
      return true;
    });
    q.stop();
    q.want(1);
    await q.idle();
    expect(drawn).toEqual([]);
  });
});

describe("縮小したページの枠と列", () => {
  it("枠は縮めない（高さに上限のある列で、絵が下の枠に重ならない）", () => {
    expect(rule(".thumb")).toMatch(/flex: none/);
  });

  it("描いた絵は枠いっぱいに、比を保って収め、枠の比は描いたページの比にそろえる", () => {
    const img = rule(".thumb-pic img");
    expect(img).toMatch(/width: 100%/);
    expect(img).toMatch(/height: 100%/);
    expect(img).toMatch(/object-fit: contain/);
    expect(main).toMatch(/pic\.style\.aspectRatio = `\$\{canvas\.width\} \/ \$\{canvas\.height\}`/);
  });

  it("今のページの線は、絵に沿って引く", () => {
    expect(rule('.thumb[aria-current="page"] .thumb-pic')).toMatch(/outline: var\(--border-mark\) solid var\(--line-strong\)/);
  });

  it("列は横に送らない", () => {
    expect(rule('.workspace[data-state="result"] .thumbs')).toMatch(/overflow-x: hidden/);
  });

  it("先頭から何枚という上限を置かない", () => {
    expect(main).not.toMatch(/MAX_THUMB_IMAGES/);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面の「3 片付ける → 4 読み直す」と同じ流れを、Worker を使わずに確かめる：
// 合成 PDF（fixtures/ の全部）を片付け（sanitize/）、片付けた PDF を検査の入口（src/inspect/inspect.ts）に最初から入れ直し、
// 残っている所の数を数える。片付けの報告は使わない。
// - パスワードが要る PDF は片付けない（refused）
// - それ以外は、読み直して残る所が 0 件、片付けられなかった所も 0 件（2026-11-04 に測った値。下がったら落ちる）

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizePdf } from "../sanitize/index.ts";
import { inspectAll } from "../src/inspect/inspect";
import { buildCleanView } from "../src/ui/clean-model";
import { buildView } from "../src/ui/model";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILES = ["p1", "p5", "p6", "p7", "p9"].flatMap((dir) =>
  readdirSync(path.join(ROOT, "fixtures", dir))
    .filter((f) => f.endsWith(".pdf"))
    .map((f) => `${dir}/${f}`),
);
const NEEDS_PASSWORD = new Set(["p5/p5-25-encrypted-user-password.pdf"]);

describe("片付けてから読み直す（合成 PDF の全部）", () => {
  it("合成 PDF がある", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it.each(FILES)("%s", async (rel) => {
    const bytes = new Uint8Array(readFileSync(path.join(ROOT, "fixtures", rel)));
    const before = buildView(await inspectAll(bytes));
    const r = await sanitizePdf(bytes);
    if (NEEDS_PASSWORD.has(rel)) {
      expect(r.status).toBe("error");
      return;
    }
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const after = buildView(await inspectAll(r.bytes));
    const c = buildCleanView({ before, after, removed: r.removed, notDone: r.notDone, decrypted: r.decrypted });
    expect({ left: c.left, notDone: c.notDone.length, verdict: c.verdict }).toEqual({ left: 0, notDone: 0, verdict: "clean" });
  });
});

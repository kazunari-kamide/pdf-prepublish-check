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
import { HEAVY_TIMEOUT } from "./helpers/timeout.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILES = ["p1", "p5", "p6", "p7", "p9"].flatMap((dir) =>
  readdirSync(path.join(ROOT, "fixtures", dir))
    .filter((f) => f.endsWith(".pdf"))
    .map((f) => `${dir}/${f}`),
);
const NEEDS_PASSWORD = new Set(["p5/p5-25-encrypted-user-password.pdf"]);
/**
 * 片付けがまだ消さない、分かっている残り（2026-11-05 に測った値）。
 * P11 フォームの値（rules/p11-forms）を画面の一覧に入れたので、ウィジェットの無い欄の値が、片付けたあとにも「残り」として出る。
 * 片付け（sanitize/）がフォームの値を消すようになったら、ここから外す（11/5 D の PR の「ほかの持ち場に頼みたいこと」）。
 */
const KNOWN_LEFT: Record<string, number> = {
  "p5/p5-07-form-value-changed.pdf": 1,
  "p5/p5-20-two-fields-changed.pdf": 2,
};

describe("片付けてから読み直す（合成 PDF の全部）", () => {
  it("合成 PDF がある", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it.each(FILES)("%s", { timeout: HEAVY_TIMEOUT }, async (rel) => {
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
    const known = KNOWN_LEFT[rel];
    if (known !== undefined) {
      expect({ left: c.left, notDone: c.notDone.length, verdict: c.verdict }).toEqual({ left: known, notDone: 0, verdict: "left" });
      expect(after.rows.every((row) => row.patternLabel.endsWith("（P11）"))).toBe(true);
      return;
    }
    expect({ left: c.left, notDone: c.notDone.length, verdict: c.verdict }).toEqual({ left: 0, notDone: 0, verdict: "clean" });
  });
});

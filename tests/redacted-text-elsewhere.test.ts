// SPDX-License-Identifier: AGPL-3.0-only
//
// 塗った下の字が、ほかの所に出ている（redacted-text-elsewhere）。合成 PDF の採点（tests/new-rules-cases.test.ts）のほかに、
// 「整える」のあとの読み直し（整える前に覚えた字で探す）と、字を返さない決まりを確かめる。中身はすべて架空。

import { describe, expect, it } from "vitest";
import { CASES } from "../eval/cases/redacted-text-elsewhere.ts";
import { detectRedactedTextElsewhere, normalize, type UnderProbe } from "../rules/redacted-text-elsewhere/index.ts";

const build = (id: string) => CASES.find((c) => c.id === id)!.build();

describe("redacted-text-elsewhere", () => {
  it("字は、includeText を頼んだときだけ返す", async () => {
    const r = await detectRedactedTextElsewhere(await build("rte-l01"));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.text).toBeUndefined();
    expect(r.findings[0]!.pages).toEqual([2]);
    expect(r.findings[0]!.where).toEqual(["page"]);
    const withText = await detectRedactedTextElsewhere(await build("rte-l01"), { includeText: true });
    expect(withText.findings[0]!.text).toBeTruthy();
  });

  it("整える前に覚えた字（probes）を、整えたあとの PDF で探す", async () => {
    let probes: UnderProbe[] = [];
    await detectRedactedTextElsewhere(await build("rte-l01"), { onProbes: (p) => (probes = p) });
    expect(probes).toHaveLength(1);
    // 整えたあとの形：四角の下の字は消えた（rte-c03 は、下に字の無い四角と、本文の地名）
    const after = await detectRedactedTextElsewhere(await build("rte-c03"), { probes });
    expect(after.findings.map((f) => [f.page, f.source])).toEqual([[1, "before"]]);
    // 覚えた字が無ければ、何も返さない
    expect((await detectRedactedTextElsewhere(await build("rte-c03"))).findings).toEqual([]);
  });

  it("正規化：全角・空白・塗りの記号をそろえる", () => {
    expect(normalize("Ｓａｋｕｒａ　ｇａｏｋａ ■12")).toBe("Sakuragaoka12");
  });

  it("壊れた PDF・空のファイルは error を返す（止まらない）", async () => {
    expect((await detectRedactedTextElsewhere(new Uint8Array())).status).toBe("error");
    expect((await detectRedactedTextElsewhere(new TextEncoder().encode("%PDF-1.7\nbroken"))).status).toBe("error");
  });
});

describe("redacted-text-elsewhere：整える（sanitizePdf）のあと", () => {
  it("四角の下の字は消えるが、ほかのページの同じ字は残るので、整える前に覚えた字で当たる", async () => {
    const { sanitizePdf } = await import("../sanitize/index.ts");
    const before = await build("rte-l01");
    let probes: UnderProbe[] = [];
    await detectRedactedTextElsewhere(before, { onProbes: (p) => (probes = p) });
    const s = await sanitizePdf(before);
    expect(s.status).toBe("ok");
    const bytes = (s as { bytes: Uint8Array }).bytes;
    // 整えたあとの PDF だけを見ると、四角の下の字が無いので、このルールは何も返さない（ここを止めるのが、覚えた字）
    expect((await detectRedactedTextElsewhere(bytes)).findings).toEqual([]);
    const after = await detectRedactedTextElsewhere(bytes, { probes });
    expect(after.findings.map((f) => [f.page, f.source, f.pages])).toEqual([[1, "before", [2]]]);
  });
});

describe("redacted-text-elsewhere：画面の検査（inspectAll）", () => {
  it("字の中身を頼む検査では、p6・p7 の報告を分け合い、1 行を出す。頼まない検査（コマンドの道具など）では、字を入れない", async () => {
    const { inspectAll } = await import("../src/inspect/inspect.ts");
    const bytes = await build("rte-l01");
    let probes: UnderProbe[] = [];
    const withContents = await inspectAll(bytes, undefined, undefined, { withContents: true, onUnderProbes: (p) => (probes = p) });
    const row = withContents.rules.find((r) => r.ruleId === "redacted-text-elsewhere")!;
    expect(row.status).toBe("ok");
    expect(row.items.map((i) => [i.page, i.confidence, i.severity])).toEqual([[1, "check", "high"]]);
    expect(row.items[0]!.content).toBeTruthy();
    expect(row.items[0]!.detail).toContain("2 ページの本文");
    expect(probes).toHaveLength(1);
    const plain = await inspectAll(bytes);
    const plainRow = plain.rules.find((r) => r.ruleId === "redacted-text-elsewhere")!;
    expect(plainRow.items).toHaveLength(1);
    expect(plainRow.items[0]!.content).toBeUndefined();
    // p6-text の結果は、分け合っても変わらない
    const p6a = withContents.rules.find((r) => r.ruleId === "p6-text")!.items.length;
    const p6b = plain.rules.find((r) => r.ruleId === "p6-text")!.items.length;
    expect(p6a).toBe(p6b);
  });
});

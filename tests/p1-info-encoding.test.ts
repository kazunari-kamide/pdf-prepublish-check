// SPDX-License-Identifier: AGPL-3.0-only
//
// 文書情報の値が、BOM のない Shift_JIS・UTF-8 で書かれていても正しく読めるか（p1-info 1.2.0、11/5 D の頼みの 11）。
// 対照：PDFDocEncoding の欧文の字（é・ü など）は、読み替えない。名前はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFHexString } from "pdf-lib";
import { decodeTextBytes, detectP1Info } from "../rules/p1-info/index.ts";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

describe("文書情報の字の読み方（BOM なしの日本語）", () => {
  it("Shift_JIS（山田太郎）を 4 字として読む", () => {
    expect(decodeTextBytes(hex("8E52936391BE9859"))).toEqual({ text: "山田太郎", encoding: "shift_jis" });
  });
  it("BOM なしの UTF-8（山田）を 2 字として読む", () => {
    expect(decodeTextBytes(hex("E5B1B1E794B0"))).toEqual({ text: "山田", encoding: "utf8" });
  });
  it("対照：PDFDocEncoding の欧文（résumé・café・Müller）は読み替えない", () => {
    for (const s of ["72E973756DE9", "636166E9", "4DFC6C6C6572"]) expect(decodeTextBytes(hex(s)).encoding).toBe("pdfdoc");
  });
  it("対照：ASCII だけの値は、そのまま PDFDocEncoding", () => {
    expect(decodeTextBytes(new TextEncoder().encode("Yamada"))).toEqual({ text: "Yamada", encoding: "pdfdoc" });
  });
  it("検出ルールの報告でも、字数が正しい", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage();
    doc.context.trailerInfo.Info = doc.context.register(doc.context.obj({ Author: PDFHexString.of("8E52936391BE9859") }));
    const r = await detectP1Info(new Uint8Array(await doc.save()));
    expect(r.findings).toEqual([{ pattern: "P1", key: "Author", group: "standard", chars: 4, encoding: "shift_jis" }]);
  });
});

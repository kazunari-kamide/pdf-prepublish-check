// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6（見せかけの黒塗り）の文字の層：暗号化された PDF を「暗号化」と返すことのテスト。
// pdf-lib 1.17.1 の EncryptedPDFError は instanceof で見分けられないため、1.1.0 までは「読めない」と返していた。
// テストの中で、本当に暗号化した小さな PDF を作る（tests/helpers/encrypted-pdf.mjs。fixtures/ は使わない）。

import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { detectP6Text } from "../rules/p6-text/index.ts";
import { makeEncryptedPdf } from "./helpers/encrypted-pdf.mjs";

describe("暗号化された PDF", () => {
  it("暗号化のしるし（trailer の /Encrypt）だけを付けた PDF は、encrypted と返す", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
    page.drawRectangle({ x: 15, y: 95, width: 120, height: 20, color: rgb(0, 0, 0) });
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: "Standard", V: 2, R: 3, Length: 128, P: -4 }));
    const r = await detectP6Text(new Uint8Array(await doc.save({ useObjectStreams: false })));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("encrypted");
    expect(r.findings).toHaveLength(0);
  });

  it("RC4 で暗号化した PDF（表の xref、利用者のパスワードは空）は、encrypted と返す", async () => {
    const r = await detectP6Text(makeEncryptedPdf());
    expect(r.error?.code).toBe("encrypted");
  });

  it("オブジェクトストリームごと暗号化した PDF も、読めないではなく encrypted と返す", async () => {
    const r = await detectP6Text(makeEncryptedPdf({ objectStream: true }));
    expect(r.error?.code).toBe("encrypted");
  });

  it("利用者のパスワードを付けて暗号化した PDF も、encrypted と返す", async () => {
    const r = await detectP6Text(makeEncryptedPdf({ userPassword: "user-secret" }));
    expect(r.error?.code).toBe("encrypted");
  });

  it("暗号化していない PDF は、これまでどおり調べる", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
    page.drawRectangle({ x: 15, y: 95, width: 120, height: 20, color: rgb(0, 0, 0) });
    const r = await detectP6Text(new Uint8Array(await doc.save({ useObjectStreams: false })));
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(1);
  });
});

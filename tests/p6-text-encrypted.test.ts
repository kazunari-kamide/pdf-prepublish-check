// SPDX-License-Identifier: AGPL-3.0-only
//
// 暗号化された PDF のテスト（検出ルール P6 の文字の層、P1 の文書情報、共通の読み込み rules/shared/load.ts）。
// - パスワードなしで開ける暗号化 PDF は、復号して中まで調べる（1.2.0 から。PR #16 の返事の 1）
// - パスワードが要る PDF・暗号化のしるしだけで中身の読めない PDF は、encrypted と返す
// テストの中で、本当に暗号化した小さな PDF を作る（tests/helpers/encrypted-pdf.mjs。fixtures/ は使わない）。
// 作った PDF は、PDF.js（別の実装）で開けることを確かめてある（PR の本文）。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFString, StandardFonts, rgb } from "pdf-lib";
import { detectP6Text } from "../rules/p6-text/index.ts";
import { detectP1Info } from "../rules/p1-info/index.ts";
import { loadPdf } from "../rules/shared/load.ts";
import { md5, rc4 } from "../rules/shared/primitives.ts";
import { makeEncryptedPdf } from "./helpers/encrypted-pdf.mjs";

const METHODS = ["rc4", "aesv2", "aes256r5", "aes256r6"] as const;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("MD5・RC4（自前）", () => {
  it("MD5 は RFC 1321 の例と同じ値を返す", () => {
    expect(hex(md5(new Uint8Array(0)))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(hex(md5(new TextEncoder().encode("abc")))).toBe("900150983cd24fb0d6963f7d28e17f72");
    // 56 バイト以上（ブロックが2つになる）
    expect(hex(md5(new TextEncoder().encode("12345678901234567890123456789012345678901234567890123456789012345678901234567890")))).toBe(
      "57edf4a22be3c955ac49da2e2107b67a",
    );
  });
  it("RC4 は、よく知られた例（鍵 Key、平文 Plaintext）と同じ値を返す", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(hex(rc4(enc("Key"), enc("Plaintext")))).toBe("bbf316e8d940af0ad3");
  });
});

describe("パスワードなしで開ける暗号化 PDF は、復号して中まで調べる", () => {
  for (const method of METHODS) {
    for (const objectStream of [false, true]) {
      it(`${method}${objectStream ? "（オブジェクトストリームごと）" : ""}：P6 の見せかけの黒塗りを見つける`, async () => {
        const r = await detectP6Text(makeEncryptedPdf({ method, objectStream }));
        expect(r.status).toBe("ok");
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0]!.chars).toBe(10);
        expect(r.findings[0]!.rect).toEqual([15, 95, 135, 115]);
        expect(r.decrypted?.failedObjects).toBe(0);
      });
      it(`${method}${objectStream ? "（オブジェクトストリームごと）" : ""}：P1 の文書情報（タイトル）を見つける`, async () => {
        const r = await detectP1Info(makeEncryptedPdf({ method, objectStream }));
        expect(r.status).toBe("ok");
        expect(r.findings.map((f) => f.key)).toEqual(["Title"]);
      });
    }
  }

  it("復号した中身の字は、暗号化していない同じ PDF と同じ（includeText で確かめる）", async () => {
    const r = await detectP6Text(makeEncryptedPdf({ method: "aes256r6", objectStream: true }), { includeText: true });
    expect(r.findings[0]!.text).toBe("Taro Yamada");
  });
});

describe("パスワードが要る・読めない暗号化は、encrypted と返す", () => {
  for (const method of METHODS) {
    it(`${method}：利用者のパスワードつき`, async () => {
      const bytes = makeEncryptedPdf({ method, userPassword: "user-secret" });
      const p6 = await detectP6Text(bytes);
      expect(p6.error?.code).toBe("encrypted");
      expect(p6.findings).toHaveLength(0);
      expect((await detectP1Info(bytes)).error?.code).toBe("encrypted");
      const l = await loadPdf(bytes);
      expect(l.status === "error" && l.reason).toBe("password_required");
    });
  }

  it("暗号化のしるし（/Encrypt）だけで、鍵の材料（/O・/U）がない PDF", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
    page.drawRectangle({ x: 15, y: 95, width: 120, height: 20, color: rgb(0, 0, 0) });
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: "Standard", V: 2, R: 3, Length: 128, P: -4 }));
    const r = await detectP6Text(new Uint8Array(await doc.save({ useObjectStreams: false })));
    expect(r.error?.code).toBe("encrypted");
    expect(r.findings).toHaveLength(0);
  });

  it("標準でないセキュリティハンドラ（公開鍵など）は、対応していないとして encrypted", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]);
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: "Adobe.PubSec", V: 4, R: 4 }));
    const l = await loadPdf(new Uint8Array(await doc.save({ useObjectStreams: false })));
    expect(l.status === "error" && l.reason).toBe("unsupported");
  });
});

describe("暗号化していない PDF は、これまでどおり", () => {
  it("復号の印（decrypted）を付けずに調べる", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
    page.drawRectangle({ x: 15, y: 95, width: 120, height: 20, color: rgb(0, 0, 0) });
    const r = await detectP6Text(new Uint8Array(await doc.save({ useObjectStreams: false })));
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(1);
    expect(r.decrypted).toBeUndefined();
  });

  it("文書情報に「/Encrypt」という字があるだけの PDF は、暗号化とみなさない", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([300, 200]);
    doc.context.trailerInfo.Info = doc.context.register(doc.context.obj({ Title: PDFString.of("/Encrypt /ObjStm") }));
    const bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
    expect(new TextDecoder("latin1").decode(bytes)).toContain("/Encrypt");
    const r = await detectP6Text(bytes);
    expect(r.status).toBe("ok");
    expect(r.decrypted).toBeUndefined();
    expect((await detectP1Info(bytes)).findings.map((f) => f.key)).toEqual(["Title"]);
  });
});

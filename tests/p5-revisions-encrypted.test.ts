// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P5（旧版の残存）の、暗号化した PDF のテスト（1.1.0）。
// tests/helpers/encrypted-pdf.mjs で、本当に暗号化した1版の PDF を作り、そのあとに増分更新を手で書き足す。
// 書き足す版では、ページの中身を新しい番号（10）に差し替える。前の中身（5。「Taro Yamada」を描く命令を暗号化したもの）は
// 根からたどれずに残る。復号できていなければ、字を描く命令は見つからないので、content としては出ない。

import { describe, expect, it } from "vitest";
import { makeEncryptedPdf, latin1 } from "./helpers/encrypted-pdf.mjs";
import { detectP5Revisions } from "../rules/p5-revisions/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function replaceContents(base: Uint8Array): Uint8Array {
  const t = latin1(base);
  const prev = Number([...t.matchAll(/startxref\s+(\d+)/g)].pop()![1]);
  const id = /\/ID\s*(\[[^\]]*\])/.exec(t)![1];
  let body = "\n";
  const off: Record<number, number> = {};
  const obj = (n: number, text: string) => {
    off[n] = base.length + body.length;
    body += `${n} 0 obj\n${text}\nendobj\n`;
  };
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 10 0 R >>");
  obj(10, "<< /Length 0 >>\nstream\n\nendstream");
  const xrefAt = base.length + body.length;
  body += `xref\n3 1\n${String(off[3]).padStart(10, "0")} 00000 n \n10 1\n${String(off[10]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size 11 /Root 1 0 R /Info 7 0 R /Encrypt 6 0 R /ID ${id} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const out = new Uint8Array(base.length + body.length);
  out.set(base);
  out.set(enc(body), base.length);
  return out;
}

const pick = (r: Awaited<ReturnType<typeof detectP5Revisions>>) => r.findings.map((f) => `${f.object}:${f.kind}:${f.where}`).sort();

describe("パスワードなしで開ける暗号化 PDF の前の版を復号する", () => {
  for (const method of ["rc4", "aesv2", "aes256r6"] as const) {
    for (const objectStream of [false, true]) {
      it(`${method}${objectStream ? "（オブジェクトストリーム）" : ""}：差し替えた前の中身を content・unreferenced として見つける`, async () => {
        const bytes = replaceContents(makeEncryptedPdf({ method, objectStream }));
        const r = await detectP5Revisions(bytes);
        expect(r.status).toBe("ok");
        expect(pick(r)).toEqual(["5:content:unreferenced"]);
        expect(r.decrypted?.failedObjects).toBe(0);
        // 書き直した前のページの辞書は骨組み（数えない）
        expect(r.notCounted).toContainEqual({ object: 3, kind: "structure", where: "superseded", reason: "structure" });
      });
    }
  }

  it("1版だけの暗号化 PDF では何も返さない（いまの版の中身を、前の版と取り違えない）", async () => {
    for (const objectStream of [false, true]) {
      const r = await detectP5Revisions(makeEncryptedPdf({ objectStream }));
      expect(r.status).toBe("ok");
      expect(r.findings).toEqual([]);
    }
  });

  it("利用者のパスワードが要る PDF は encrypted で止める（パスワードは試さない）", async () => {
    const r = await detectP5Revisions(replaceContents(makeEncryptedPdf({ userPassword: "secret" })));
    expect(r.status).toBe("error");
    expect(r.error!.code).toBe("encrypted");
    expect(r.findings).toEqual([]);
  });
});

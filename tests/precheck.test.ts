// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { precheck } from "../src/inspect/precheck";

const enc = (s: string) => new TextEncoder().encode(s);

describe("検査の前の確かめ", () => {
  it("PDF の印があれば、版を読む", () => {
    const r = precheck(enc("%PDF-1.7\n%âãÏÓ\n1 0 obj\n"));
    expect(r).toEqual({ ok: true, version: "1.7", byteLength: expect.any(Number) });
  });

  it("先頭に少しゴミがあっても、1024 バイト以内に印があれば読む", () => {
    const r = precheck(enc(" ".repeat(500) + "%PDF-2.0\n"));
    expect(r.ok && r.version).toBe("2.0");
  });

  it("1024 バイトより後ろにしか印がなければ、PDF ではないとする", () => {
    const r = precheck(enc(" ".repeat(2000) + "%PDF-1.4\n"));
    expect(r).toMatchObject({ ok: false, code: "not_pdf" });
  });

  it("空のファイルは止める", () => {
    expect(precheck(new Uint8Array(0))).toMatchObject({ ok: false, code: "empty" });
  });

  it("上限より大きいファイルは、中身を見ずに止める", () => {
    const r = precheck(enc("%PDF-1.7\n" + "x".repeat(100)), 50);
    expect(r).toMatchObject({ ok: false, code: "too_large" });
  });

  it("PDF でないファイル（画像など）は止める", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(precheck(png)).toMatchObject({ ok: false, code: "not_pdf" });
  });

  it("版の部分がおかしくても止まらず、「不明」とする", () => {
    const r = precheck(enc("%PDF-<script>"));
    expect(r).toMatchObject({ ok: true, version: "不明" });
  });

  it("版は数字と点だけを、4文字まで読む（長い文字列を画面に出さない）", () => {
    const r = precheck(enc("%PDF-1.7777777777"));
    expect(r.ok && r.version).toBe("1.77");
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P6：報告に「どの層を調べたか」（checkedLayers）を返すことのテスト（1.4.0 から）。
// 1.5.0 で画像の層を見るようになり、["text", "image"] になった。
// 画面は、この値に "image" がない間、「画像の下の中身は、読み直しではまだ調べていません」と添える。
// 採点用の合成 PDF は使わず、ここではテストの中で小さな PDF を作って確かめる。

import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { CHECKED_LAYERS, detectP6Text } from "../rules/p6-text/index.ts";
import { adaptP6Text } from "../eval/adapters/p6-text.ts";

async function coveredTextPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  page.drawText("Taro Yamada", { x: 20, y: 100, size: 12, font });
  page.drawRectangle({ x: 15, y: 95, width: 120, height: 20, color: rgb(0, 0, 0) });
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe("P6 の報告の checkedLayers（1.4.0 から）", () => {
  it("この版（1.5.0）が調べるのは、文字の層と画像の層", () => {
    expect(CHECKED_LAYERS).toEqual(["text", "image"]);
  });

  it("読めた PDF では、調べた層として CHECKED_LAYERS を返す", async () => {
    const report = await detectP6Text(await coveredTextPdf());
    expect(report.status).toBe("ok");
    expect(report.findings).toHaveLength(1);
    expect(report.checkedLayers).toEqual(["text", "image"]);
  });

  it("報告の値を書き換えても、ルールの CHECKED_LAYERS と次の報告は変わらない", async () => {
    const report = await detectP6Text(await coveredTextPdf());
    report.checkedLayers.pop();
    expect(CHECKED_LAYERS).toEqual(["text", "image"]);
    const again = await detectP6Text(await coveredTextPdf());
    expect(again.checkedLayers).toEqual(["text", "image"]);
  });

  it("空のファイル・読めないファイルでは、何も調べていないので空", async () => {
    const empty = await detectP6Text(new Uint8Array());
    expect(empty.status).toBe("error");
    expect(empty.checkedLayers).toEqual([]);
    const broken = await detectP6Text(new TextEncoder().encode("PDF ではない"));
    expect(broken.status).toBe("error");
    expect(broken.checkedLayers).toEqual([]);
  });

  it("検証器の形にそろえた報告（採点に使うもの）には入れない", async () => {
    const shaped = adaptP6Text(await detectP6Text(await coveredTextPdf()));
    expect(Object.keys(shaped).sort()).toEqual(["items", "skipped_pages", "status"]);
  });
});

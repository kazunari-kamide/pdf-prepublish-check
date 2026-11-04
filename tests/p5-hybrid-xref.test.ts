// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P5 1.2.1：Word の「ハイブリッド xref」（古い形の表＋/XRefStm の xref ストリーム）を、前の版の残りと誤らない（型の一覧の F01）。
// 表で「使っていない（f）」とした番号を、同じ版の xref ストリームが「オブジェクトストリームの中にある」と示す形。名前はすべて架空。

import { describe, expect, it } from "vitest";
import { detectP5Revisions } from "../rules/p5-revisions/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** 版が1つのハイブリッド xref の PDF を手で組む。strayText を渡すと、どこからも指されない文字列入りの辞書をオブジェクトストリームに足す */
function hybridPdf(opts: { strayText?: string } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const offsets: Record<number, number> = {};
  let len = 0;
  const push = (s: string | Uint8Array) => {
    const b = typeof s === "string" ? enc(s) : s;
    parts.push(b);
    len += b.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = len;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  push("%PDF-1.5\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 6 0 R >> /ExtGState << /GS1 7 0 R >> >> /Contents 4 0 R >>");
  const content = "BT /F1 12 Tf 40 250 Td (Meeting notes) Tj ET\n";
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
  const inner = ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Type /ExtGState /CA 1 >>"];
  if (opts.strayText) inner.push(`<< /Note (${opts.strayText}) >>`);
  let header = "";
  let body = "";
  inner.forEach((s, i) => {
    header += `${6 + i} ${body.length} `;
    body += s + "\n";
  });
  obj(5, `<< /Type /ObjStm /N ${inner.length} /First ${header.length} /Length ${header.length + body.length} >>\nstream\n${header}${body}endstream`);
  const last = 6 + inner.length; // xref ストリームの番号
  const rows: number[][] = [[0, 0, 65535]];
  for (const n of [1, 2, 3, 4, 5]) rows.push([1, offsets[n]!, 0]);
  inner.forEach((_, i) => rows.push([2, 5, i]));
  const xsAt = len;
  rows.push([1, xsAt, 0]);
  const data = new Uint8Array(rows.length * 7);
  rows.forEach(([t, f2, f3], i) => data.set([t!, (f2! >>> 24) & 255, (f2! >>> 16) & 255, (f2! >>> 8) & 255, f2! & 255, (f3! >>> 8) & 255, f3! & 255], i * 7));
  push(`${last} 0 obj\n<< /Type /XRef /Size ${last + 1} /W [1 4 2] /Root 1 0 R /Length ${data.length} >>\nstream\n`);
  push(data);
  push("\nendstream\nendobj\n");
  const xrefAt = len;
  const line = (o: number, g: number, t: string) => `${String(o).padStart(10, "0")} ${String(g).padStart(5, "0")} ${t} \n`;
  let table = `xref\n0 ${last + 1}\n` + line(0, 65535, "f");
  for (const n of [1, 2, 3, 4, 5]) table += line(offsets[n]!, 0, "n");
  for (let i = 0; i < inner.length; i++) table += line(0, 0, "f"); // オブジェクトストリームの中の番号は、表では「使っていない」
  table += line(xsAt, 0, "n");
  push(table);
  push(`trailer\n<< /Size ${last + 1} /Root 1 0 R /XRefStm ${xsAt} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("ハイブリッド xref（F01）", () => {
  it("対照：版が1つのハイブリッド xref は、前の版の残りも片付けで消せる残りも出さない", async () => {
    const r = await detectP5Revisions(hybridPdf());
    expect(r.status).toBe("ok");
    expect(r.revisions).toBe(1);
    expect(r.findings).toEqual([]);
    expect(r.notCounted).toEqual([]);
    expect(r.cleanupOnly.count).toBe(0);
  });

  it("同じ形でも、どこからも指されない文字列入りの辞書があれば、字数で数える（項目 5 と合わせて）", async () => {
    const r = await detectP5Revisions(hybridPdf({ strayText: "Old draft by Ichiro Suzuki" }));
    expect(r.findings.map((f) => `${f.kind}:${f.where}:${f.chars}`)).toEqual(["dict_text:unreferenced:26"]);
  });
});

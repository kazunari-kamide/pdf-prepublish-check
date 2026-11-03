// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P5（旧版の残存）のテスト。
// 採点に使う合成 PDF（fixtures/p5）は使わず、テストの中で小さな PDF を作り、増分更新を手で書き足して確かめる。名前はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { detectP5Revisions, hasTextOperators } from "../rules/p5-revisions/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

type Base = { bytes: Uint8Array; root: number; info: number | null; page: number; contents: number; size: number };

async function makeBase(useObjectStreams = false): Promise<Base> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 200]);
  page.drawText("Hello", { x: 10, y: 100, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  doc.setAuthor("Yamada Taro");
  const bytes = new Uint8Array(await doc.save({ useObjectStreams }));
  const t = latin1(bytes);
  return {
    bytes,
    root: doc.context.trailerInfo.Root!.toString().split(" ").map(Number)[0]!,
    info: Number(/\/Info (\d+) 0 R/.exec(t)?.[1] ?? NaN) || null,
    page: page.ref.objectNumber,
    contents: Number(/\/Contents \[?\s*(\d+) 0 R/.exec(t)?.[1]), // pdf-lib は /Contents を配列で書く
    size: Number(/\/Size (\d+)/.exec(t)?.[1] ?? doc.context.largestObjectNumber + 1),
  };
}

/** 増分更新を1つ書き足す。objects は書き直す・足すオブジェクト、free は「使っていない」と印をつける番号 */
function append(
  base: Uint8Array,
  opts: { objects?: Array<[number, string]>; free?: number[]; root: number; info?: number | null; size: number; after?: string },
): Uint8Array {
  const prev = Number([...latin1(base).matchAll(/startxref\s+(\d+)/g)].pop()![1]);
  let body = "\n";
  const entries: Array<[number, string]> = [];
  for (const [n, text] of opts.objects ?? []) {
    entries.push([n, `${String(base.length + body.length).padStart(10, "0")} 00000 n \n`]);
    body += `${n} 0 obj\n${text}\nendobj\n`;
  }
  for (const n of opts.free ?? []) entries.push([n, "0000000000 00001 f \n"]);
  entries.sort((a, b) => a[0] - b[0]);
  const xrefAt = base.length + body.length;
  body += "xref\n";
  for (const [n, line] of entries) body += `${n} 1\n${line}`;
  const info = opts.info ? ` /Info ${opts.info} 0 R` : "";
  body += `trailer\n<< /Size ${opts.size} /Root ${opts.root} 0 R${info} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  body += opts.after ?? "";
  const out = new Uint8Array(base.length + body.length);
  out.set(base);
  out.set(enc(body), base.length);
  return out;
}

const pick = (r: Awaited<ReturnType<typeof detectP5Revisions>>) => r.findings.map((f) => `${f.object}:${f.kind}:${f.where}`).sort();

describe("字を描く命令の目安", () => {
  it("Tj・TJ・'・\" を見つけ、ほかの命令や名前では反応しない", () => {
    expect(hasTextOperators("BT /F1 12 Tf (abc) Tj ET")).toBe(true);
    expect(hasTextOperators("BT [(a) -20 (b)] TJ ET")).toBe(true);
    expect(hasTextOperators("BT <0041> Tj ET")).toBe(true);
    expect(hasTextOperators("BT (abc) ' ET")).toBe(true);
    expect(hasTextOperators("0 0 10 10 re f /Tj0 Do")).toBe(false);
  });
});

describe("前の版が残っていない PDF", () => {
  it("増分更新のない PDF（xref の表）では何も返さない", async () => {
    const b = await makeBase();
    const r = await detectP5Revisions(b.bytes);
    expect(r.status).toBe("ok");
    expect(r.findings).toEqual([]);
    expect(r.revisions).toBe(1);
    expect(r.chainFallback).toBe(false);
  });

  it("xref ストリームとオブジェクトストリームで保存した PDF でも何も返さない", async () => {
    const b = await makeBase(true);
    const r = await detectP5Revisions(b.bytes);
    expect(r.status).toBe("ok");
    expect(r.findings).toEqual([]);
  });
});

describe("場所ごとに見つける", () => {
  it("同じ番号で書き直した前の文書情報は info・superseded（前の版の数も出す）", async () => {
    const b = await makeBase();
    const bytes = append(b.bytes, { objects: [[b.info!, "<< /Author (Somu-ka) >>"]], root: b.root, info: b.info, size: b.size });
    const r = await detectP5Revisions(bytes);
    expect(pick(r)).toEqual([`${b.info}:info:superseded`]);
    expect(r.findings[0]!.revision).toBe(1);
    expect(r.summary.previousInfo).toBe(1);
    expect(r.revisions).toBe(2);
  });

  it("新しい番号に差し替えた前の文書情報と中身は unreferenced", async () => {
    const b = await makeBase();
    const n = b.size;
    const bytes = append(b.bytes, {
      objects: [
        [n, "<< /Producer (x) >>"],
        [n + 1, "<< /Length 18 >>\nstream\n0 0 10 10 re f\n\nendstream"],
        [b.page, latin1(b.bytes).match(new RegExp(`\\n${b.page} 0 obj\\n([\\s\\S]*?)\\nendobj`))![1]!.replace(/\/Contents \[?\s*\d+ 0 R\s*\]?/, `/Contents ${n + 1} 0 R`)],
      ],
      root: b.root,
      info: n,
      size: n + 2,
    });
    const r = await detectP5Revisions(bytes);
    expect(pick(r)).toEqual([`${b.contents}:content:unreferenced`, `${b.info}:info:unreferenced`].sort());
    // 書き直した前のページの辞書は骨組み（数えない）
    expect(r.notCounted).toContainEqual({ object: b.page, kind: "structure", where: "superseded", reason: "structure" });
  });

  it("xref で「使っていない」と印をつけた前の中身は free", async () => {
    const b = await makeBase();
    const bytes = append(b.bytes, { free: [b.info!], root: b.root, info: null, size: b.size });
    const r = await detectP5Revisions(bytes);
    expect(pick(r)).toEqual([`${b.info}:info:free`]);
  });

  it("最後の %%EOF のあとに書き足された、xref に載っていない定義は orphan", async () => {
    const b = await makeBase();
    const stray = `\n${b.size} 0 obj\n<< /Length 22 >>\nstream\nBT (secret) Tj ET\n\nendstream\nendobj\n`;
    const bytes = new Uint8Array([...b.bytes, ...enc(stray)]);
    const r = await detectP5Revisions(bytes);
    expect(pick(r)).toEqual([`${b.size}:content:orphan`]);
    expect(r.findings[0]!.revision).toBeNull();
  });

  it("外した注釈：字があれば annotation、字がなければ数えない。フォームの値は form_value", async () => {
    const b = await makeBase();
    const n = b.size;
    const v1 = append(b.bytes, {
      objects: [
        [n, "<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (memo) >>"],
        [n + 1, "<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] >>"],
        [n + 2, "<< /FT /Tx /T (name) /V (Yamada) /Rect [0 0 10 10] >>"],
      ],
      root: b.root,
      info: b.info,
      size: n + 3,
    });
    // 次の版で、3つとも書き直す（字なし・値なし）→ 前の定義が superseded として残る
    const v2 = append(v1, {
      objects: [
        [n, "<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] >>"],
        [n + 2, "<< /FT /Tx /T (name) /Rect [0 0 10 10] >>"],
      ],
      root: b.root,
      info: b.info,
      size: n + 3,
    });
    const r = await detectP5Revisions(v2);
    const superseded = r.findings.filter((f) => f.where === "superseded").map((f) => `${f.object}:${f.kind}`).sort();
    expect(superseded).toEqual([`${n}:annotation`, `${n + 2}:form_value`]);
    // 根からたどれない今の定義は unreferenced だが、字・値がないので数えない
    expect(r.notCounted).toContainEqual({ object: n + 1, kind: "annotation", where: "unreferenced", reason: "annotation_without_text" });
    expect(r.findings.every((f) => !JSON.stringify(f).includes("Yamada"))).toBe(true);
  });
});

describe("壊れた・読めない入力で止まらない", () => {
  it("空のファイル・PDF でないもの", async () => {
    expect((await detectP5Revisions(new Uint8Array())).error!.code).toBe("empty");
    const r = await detectP5Revisions(enc("hello"));
    expect(r.findings).toEqual([]);
  });

  it("/Prev が自分を指す xref でも止まる", async () => {
    const b = await makeBase();
    const t = latin1(b.bytes);
    const at = Number([...t.matchAll(/startxref\s+(\d+)/g)].pop()![1]);
    const looped = enc(t.replace(/trailer\s*<</, `trailer\n<< /Prev ${at}`));
    const r = await detectP5Revisions(looped);
    expect(r.status).toBe("ok");
  });

  it("暗号化された PDF は encrypted で止める", async () => {
    const b = await makeBase();
    const t = latin1(b.bytes).replace(/trailer\s*<</, "trailer\n<< /Encrypt << /Filter /Standard >>");
    const r = await detectP5Revisions(enc(t));
    expect(r.status).toBe("error");
    expect(r.error!.code).toBe("encrypted");
  });
});

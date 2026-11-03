// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール P1（文書情報）のテスト。
// 採点に使う合成 PDF（fixtures/p1）は使わず、テストの中で小さな PDF を作って確かめる。名前はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { decodeTextBytes, detectP1Info } from "../rules/p1-info/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);

async function makePdf(fill: (doc: PDFDocument) => void, useObjectStreams = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([200, 200]);
  fill(doc);
  return new Uint8Array(await doc.save({ useObjectStreams }));
}

/** pdf-lib の文書情報の辞書（ない時は作る）。getInfoDict は型の上では private なので、型だけ変えて呼ぶ */
function infoDict(doc: PDFDocument): PDFDict {
  return (doc as unknown as { getInfoDict(): PDFDict }).getInfoDict();
}

/** 増分更新を1つ足す。新しい Info を足すか（info）、trailer から /Info をなくすか（info なし） */
function appendRevision(base: Uint8Array, opts: { info?: string; extraTrailer?: string }): Uint8Array {
  const text = new TextDecoder("latin1").decode(base);
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)![1]);
  const root = /\/Root (\d+ \d+ R)/.exec(text)![1];
  const size = Number(/\/Size (\d+)/.exec(text)![1]);
  let body = "\n";
  const offsets: number[] = [];
  let infoRef = "";
  if (opts.info !== undefined) {
    offsets.push(base.length + body.length);
    body += `${size} 0 obj\n${opts.info}\nendobj\n`;
    infoRef = ` /Info ${size} 0 R`;
  }
  const xrefAt = base.length + body.length;
  body += opts.info !== undefined ? `xref\n${size} 1\n${String(offsets[0]).padStart(10, "0")} 00000 n \n` : "xref\n0 0\n";
  body += `trailer\n<< /Size ${size + (opts.info !== undefined ? 1 : 0)} /Root ${root}${infoRef} /Prev ${prev}${opts.extraTrailer ?? ""} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const out = new Uint8Array(base.length + body.length);
  out.set(base);
  out.set(new TextEncoder().encode(body), base.length);
  return out;
}

describe("値の文字の読み分け", () => {
  it("UTF-16BE・UTF-16LE・UTF-8（BOM つき）・PDFDocEncoding を読み分ける", () => {
    expect(decodeTextBytes(new Uint8Array([0xfe, 0xff, 0x5c, 0x71]))).toEqual({ text: "山", encoding: "utf16be" });
    expect(decodeTextBytes(new Uint8Array([0xff, 0xfe, 0x71, 0x5c]))).toEqual({ text: "山", encoding: "utf16le" });
    expect(decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("山")]))).toEqual({ text: "山", encoding: "utf8" });
    expect(decodeTextBytes(enc("abc"))).toEqual({ text: "abc", encoding: "pdfdoc" });
  });

  it("UTF-16BE の中の言語のしるしを取り除く", () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x1b, 0x00, 0x6a, 0x00, 0x61, 0x00, 0x1b, 0x00, 0x41]);
    expect(decodeTextBytes(bytes).text).toBe("A");
  });
});

describe("いまの版の文書情報", () => {
  it("値のある欄を、値を出さずに返す。数えない欄は理由つきで返す", async () => {
    const bytes = await makePdf((doc) => {
      doc.setAuthor("山田太郎");
      doc.setTitle("会議資料");
      doc.setCreator("ワープロ");
      doc.setProducer("書き出しソフト");
      doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)));
      doc.setModificationDate(new Date(Date.UTC(2026, 0, 2)));
      infoDict(doc).set(PDFName.of("Trapped"), PDFName.of("False"));
    });
    const r = await detectP1Info(bytes);
    expect(r.status).toBe("ok");
    expect(r.hasInfo).toBe(true);
    expect(r.findings.map((f) => [f.key, f.group]).sort()).toEqual([
      ["Author", "standard"],
      ["Creator", "standard"],
      ["Title", "standard"],
    ]);
    expect(r.findings.find((f) => f.key === "Author")!.chars).toBe(4);
    expect(r.findings.every((f) => f.value === undefined)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("山田");
    expect(r.notCounted.map((n) => `${n.key}:${n.reason}`).sort()).toEqual([
      "CreationDate:date",
      "ModDate:date",
      "Producer:producer",
      "Trapped:trapped",
    ]);
    expect(r.previousInfo).toEqual({ revisions: 1, keys: 0, truncated: false });
  });

  it("includeValues のときだけ値を返す", async () => {
    const bytes = await makePdf((doc) => doc.setAuthor("山田太郎"));
    const r = await detectP1Info(bytes, { includeValues: true });
    expect(r.findings[0]!.value).toBe("山田太郎");
  });

  it("独自の欄（#xx を含む名前）を custom として返す。名前は解く", async () => {
    const bytes = await makePdf((doc) => {
      infoDict(doc).set(PDFName.of("Doc Owner"), PDFHexString.fromText("○○課"));
      infoDict(doc).set(PDFName.of("Company"), PDFString.of("Example Co."));
    });
    const r = await detectP1Info(bytes);
    expect(r.findings.map((f) => [f.key, f.group]).sort()).toEqual([
      ["Company", "custom"],
      ["Doc Owner", "custom"],
    ]);
  });

  it("空・空白だけ（全角の空白、UTF-16BE の空白、NUL を含む）の値は empty として数えない", async () => {
    const bytes = await makePdf((doc) => {
      const d = infoDict(doc);
      d.set(PDFName.of("Author"), PDFString.of(""));
      d.set(PDFName.of("Title"), PDFString.of("   "));
      d.set(PDFName.of("Subject"), PDFHexString.fromText("　 "));
      d.set(PDFName.of("Keywords"), PDFHexString.of("0000"));
    });
    const r = await detectP1Info(bytes);
    expect(r.findings).toEqual([]);
    expect(r.notCounted.map((n) => n.reason)).toEqual(["empty", "empty", "empty", "empty"]);
  });

  it("文書情報のない PDF では何も返さない", async () => {
    const bytes = await makePdf(() => {});
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("/Info"); // 欄を1つも入れなければ、pdf-lib は /Info を書かない
    const r = await detectP1Info(bytes);
    expect(r.status).toBe("ok");
    expect(r.hasInfo).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it("xref ストリームとオブジェクトストリームで保存した PDF も読む", async () => {
    const bytes = await makePdf((doc) => doc.setAuthor("山田太郎"), true);
    const r = await detectP1Info(bytes);
    expect(r.findings.map((f) => f.key)).toEqual(["Author"]);
  });
});

describe("増分更新（前の版）", () => {
  it("新しい版で作成者を書き換えたとき、いまの値を数え、前の版の欄は数だけ出す", async () => {
    const base = await makePdf((doc) => doc.setAuthor("山田太郎"));
    const bytes = appendRevision(base, { info: "<< /Author (Somu-ka) >>" });
    const r = await detectP1Info(bytes);
    expect(r.findings.map((f) => f.key)).toEqual(["Author"]);
    expect(r.findings[0]!.chars).toBe("Somu-ka".length);
    expect(r.previousInfo).toEqual({ revisions: 2, keys: 1, truncated: false });
  });

  it("新しい trailer に /Info がなければ、いまの版には文書情報がない（古い Info を使わない）", async () => {
    const base = await makePdf((doc) => doc.setAuthor("山田太郎"));
    const bytes = appendRevision(base, {});
    const r = await detectP1Info(bytes);
    expect(r.status).toBe("ok");
    expect(r.hasInfo).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.previousInfo.keys).toBe(1);
  });
});

describe("壊れた・読めない入力で止まらない", () => {
  it("空のファイル", async () => {
    const r = await detectP1Info(new Uint8Array());
    expect(r.status).toBe("error");
    expect(r.error!.code).toBe("empty");
  });

  it("PDF でないもの・途中で切れたもの", async () => {
    for (const bytes of [enc("hello"), (await makePdf((doc) => doc.setAuthor("A"))).subarray(0, 60)]) {
      const r = await detectP1Info(bytes);
      expect(r.findings).toEqual([]);
      if (r.status === "error") expect(["unreadable", "empty"]).toContain(r.error!.code);
    }
  });

  it("暗号化された PDF は encrypted で止める", async () => {
    const base = await makePdf((doc) => doc.setAuthor("山田太郎"));
    const bytes = appendRevision(base, { extraTrailer: " /Encrypt << /Filter /Standard >>" });
    const r = await detectP1Info(bytes);
    expect(r.status).toBe("error");
    expect(r.error!.code).toBe("encrypted");
  });
});

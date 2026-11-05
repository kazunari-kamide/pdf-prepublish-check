// SPDX-License-Identifier: AGPL-3.0-only
//
// 整える：プロパティを書き直す（sanitize/properties.ts、0.9.0 から）。PDF/A の印と電子署名を、整える前に知らせる。
// 書き出した PDF は、pdf-lib で開いた文書情報・XMP と、node:zlib で解いたすべてのストリームの両方で確かめる。
// 名前・団体名はすべて架空。

import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFString, type PDFContext } from "pdf-lib";
import { preflightTidy, sanitizePdf, type SanitizeResult } from "../sanitize/index.ts";
import { checkOldValues, encodings, decodeStrings, formatIsoDate, formatPdfDate, parseIsoDate, parsePdfDate } from "../sanitize/properties.ts";
import { decodeTextBytes } from "../rules/p1-info/index.ts";
import { addAnnot, hex, lit, newDoc, save, setCatalogXmp, setInfo, xmpPacket } from "../eval/cases/pdf.ts";

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");
const u16 = (s: string) => Array.from(s, (c) => String.fromCharCode(c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff)).join("");
const u8 = (s: string) => latin1(new TextEncoder().encode(s));

/** ファイルのバイト列と、Flate を解いたすべてのストリームの中身（latin1 の字） */
function allText(bytes: Uint8Array): string {
  const t = latin1(bytes);
  const parts = [t];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const start = m.index + m[0].length;
    const end = t.indexOf("endstream", start);
    if (end < 0) break;
    try {
      parts.push(latin1(inflateSync(bytes.subarray(start, end))));
    } catch {
      /* Flate でない */
    }
    re.lastIndex = end;
  }
  return parts.join("\n");
}
/** 古い値が、UTF-8・UTF-16BE・16 進（UTF-16BE）のどれの形でも残っていない */
function absent(bytes: Uint8Array, s: string) {
  const all = allText(bytes);
  const hexU16 = Array.from(u16(s), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  expect(all.includes(u8(s)), `UTF-8 の ${s}`).toBe(false);
  expect(all.includes(u16(s)), `UTF-16BE の ${s}`).toBe(false);
  expect(all.toLowerCase().includes(hexU16), `16 進の ${s}`).toBe(false);
}

async function open(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const info = ctx.lookup(ctx.trailerInfo.Info) as PDFDict | undefined;
  const infoRaw = (k: string) => {
    const v = info?.get(PDFName.of(k));
    const o = v instanceof PDFRef ? ctx.lookup(v) : v;
    return o instanceof PDFString || o instanceof PDFHexString ? o.asBytes() : null;
  };
  const infoText = (k: string) => {
    const b = infoRaw(k);
    return b ? decodeTextBytes(b).text : null;
  };
  const meta = ctx.lookup(doc.catalog.get(PDFName.of("Metadata")));
  const xmp = meta instanceof PDFRawStream ? new TextDecoder().decode(meta.contents) : null;
  return { doc, ctx, info, infoRaw, infoText, xmp };
}

function ok(r: SanitizeResult): Extract<SanitizeResult, { status: "ok" }> {
  if (r.status !== "ok") throw new Error(`${r.code}: ${r.message}`);
  return r;
}

const OLD_AUTHOR = "架空 太郎";
const OLD_TITLE = "見本の資料（第3版）";
const HISTORY = `<xmpMM:DocumentID>uuid:0f0e0d0c-aaaa-bbbb-cccc-000000000001</xmpMM:DocumentID>
<xmpMM:InstanceID>uuid:0f0e0d0c-aaaa-bbbb-cccc-000000000002</xmpMM:InstanceID>
<xmpMM:History><rdf:Seq><rdf:li rdf:parseType="Resource"><stEvt:action>saved</stEvt:action><stEvt:softwareAgent>架空エディター 9.9</stEvt:softwareAgent><stEvt:instanceID>xmp.iid:kakuu-old-instance</stEvt:instanceID></rdf:li></rdf:Seq></xmpMM:History>`;

/** 作成者・題・独自の欄のある文書情報と、履歴・独自の項目のある XMP（圧縮）を持つ PDF */
async function richPdf(opts: { xmpAuthor?: string; pdfa?: boolean; extraXmp?: string } = {}): Promise<Uint8Array> {
  const { doc } = await newDoc();
  setInfo(doc, {
    Title: hex(OLD_TITLE),
    Author: hex(OLD_AUTHOR),
    Producer: lit("Kakuu PDF Writer 1.0"),
    Creator: lit("Kakuu Word"),
    CreationDate: lit("D:20190401093000+09'00'"),
    ModDate: lit("D:20200102030405Z"),
    Company: hex("架空商事株式会社"),
  });
  const attrs = 'xmlns:kakuu="http://example.invalid/kakuu/1.0/"' + (opts.pdfa ? ' xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"' : "");
  const body = [
    `<dc:creator><rdf:Seq><rdf:li>${opts.xmpAuthor ?? OLD_AUTHOR}</rdf:li></rdf:Seq></dc:creator>`,
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${OLD_TITLE}</rdf:li></rdf:Alt></dc:title>`,
    "<pdf:Producer>Kakuu PDF Writer 1.0</pdf:Producer>",
    "<xmp:CreateDate>2019-04-01T09:30:00+09:00</xmp:CreateDate>",
    "<kakuu:Operator>架空 次郎</kakuu:Operator>",
    HISTORY,
    opts.pdfa ? "<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>" : "",
    opts.extraXmp ?? "",
  ].join("\n");
  setCatalogXmp(doc, xmpPacket(attrs, body), true);
  return save(doc);
}

describe("プロパティを書き直す：文書情報と XMP の両方に、同じ値", () => {
  it("作成者を日本語に書き直す。文書情報は UTF-16BE（BOM つき）、XMP は UTF-8。古い作成者は、どこにも残らない", async () => {
    const r = ok(await sanitizePdf(await richPdf(), { properties: { author: { set: "総務課" }, title: "keep" } }));
    const o = await open(r.bytes);
    const raw = o.infoRaw("Author")!;
    expect([raw[0], raw[1]]).toEqual([0xfe, 0xff]);
    expect(o.infoText("Author")).toBe("総務課");
    expect(o.infoText("Title")).toBe(OLD_TITLE);
    expect(o.xmp).toContain("<dc:creator><rdf:Seq><rdf:li>総務課</rdf:li></rdf:Seq></dc:creator>");
    expect(o.xmp).toContain(`<rdf:li xml:lang="x-default">${OLD_TITLE}</rdf:li>`);
    absent(r.bytes, OLD_AUTHOR);
    expect(r.properties?.find((p) => p.key === "author")).toEqual({ key: "author", action: "set", before: { info: true, xmp: true }, differed: false });
    expect(r.properties?.find((p) => p.key === "title")?.action).toBe("kept");
    expect(r.removed.find((x) => x.kind === "property_rewritten")?.count).toBe(1);
  });

  it("指定しなかった項目は消す。8 項目のほかの欄（独自の欄）も消す", async () => {
    const r = ok(await sanitizePdf(await richPdf(), { properties: { author: { set: "総務課" } } }));
    const o = await open(r.bytes);
    expect([...o.info!.keys()].map((k) => k.decodeText())).toEqual(["Author"]);
    absent(r.bytes, OLD_TITLE);
    absent(r.bytes, "架空商事株式会社");
    absent(r.bytes, "Kakuu PDF Writer 1.0");
    const actions = Object.fromEntries(r.properties!.map((p) => [p.key, p.action]));
    expect(actions).toEqual({ title: "removed", author: "set", subject: "absent", keywords: "absent", creator: "removed", producer: "removed", created: "removed", modified: "removed" });
    // 消した欄：8 項目のうち 5 個（タイトル・作成したソフト・PDF に変換したソフト・作成日・更新日）と、独自の欄 1 個
    expect(r.removed.find((x) => x.kind === "docinfo")?.count).toBe(6);
  });

  it("XMP の履歴・文書の番号・ほかのアプリの独自の項目は、作り直した XMP に残らない", async () => {
    const r = ok(await sanitizePdf(await richPdf(), { properties: { author: "keep", title: "keep", producer: "keep", created: "keep" } }));
    const o = await open(r.bytes);
    for (const s of ["xmpMM", "DocumentID", "InstanceID", "History", "stEvt", "kakuu", "架空 次郎", "架空エディター", "uuid:0f0e0d0c"]) expect(o.xmp, s).not.toContain(s);
    absent(r.bytes, "架空 次郎");
    absent(r.bytes, "xmp.iid:kakuu-old-instance");
    expect(o.infoText("Producer")).toBe("Kakuu PDF Writer 1.0");
    expect(o.xmp).toContain("<pdf:Producer>Kakuu PDF Writer 1.0</pdf:Producer>");
  });

  it("「そのまま」で文書情報と XMP が食い違っていたら、文書情報の値にそろえる（食い違いを報告に出す）", async () => {
    const r = ok(await sanitizePdf(await richPdf({ xmpAuthor: "見本 花子" }), { properties: { author: "keep" } }));
    const o = await open(r.bytes);
    expect(o.infoText("Author")).toBe(OLD_AUTHOR);
    expect(o.xmp).toContain(`<rdf:li>${OLD_AUTHOR}</rdf:li>`);
    absent(r.bytes, "見本 花子");
    expect(r.properties?.find((p) => p.key === "author")?.differed).toBe(true);
  });

  it("日付：「そのまま」は元の時差のまま、両方の形に書く。書き直しは字（時差つき）と Date の両方を受ける", async () => {
    const r = ok(await sanitizePdf(await richPdf(), { properties: { created: "keep", modified: { set: "2026-11-05T10:30:00+09:00" } } }));
    const o = await open(r.bytes);
    expect(o.infoText("CreationDate")).toBe("D:20190401093000+09'00'");
    expect(o.xmp).toContain("<xmp:CreateDate>2019-04-01T09:30:00+09:00</xmp:CreateDate>");
    expect(o.infoText("ModDate")).toBe("D:20261105103000+09'00'");
    expect(o.xmp).toContain("<xmp:ModifyDate>2026-11-05T10:30:00+09:00</xmp:ModifyDate>");
    absent(r.bytes, "D:20200102030405Z");

    const when = new Date(2026, 10, 5, 8, 0, 0);
    const r2 = ok(await sanitizePdf(await richPdf(), { properties: { created: { set: when } } }));
    const o2 = await open(r2.bytes);
    const tz = -when.getTimezoneOffset();
    const sign = tz < 0 ? "-" : "+";
    const hh = String(Math.floor(Math.abs(tz) / 60)).padStart(2, "0");
    const mm = String(Math.abs(tz) % 60).padStart(2, "0");
    const infoTz = tz === 0 ? "Z" : `${sign}${hh}'${mm}'`;
    const xmpTz = tz === 0 ? "Z" : `${sign}${hh}:${mm}`;
    expect(o2.infoText("CreationDate")).toBe(`D:20261105080000${infoTz}`);
    expect(o2.xmp).toContain(`<xmp:CreateDate>2026-11-05T08:00:00${xmpTz}</xmp:CreateDate>`);
  });

  it("ASCII の値は PDFDocEncoding（16 進）、かっこ・< & を含んでも読み戻せる", async () => {
    const title = "Report (draft) <v2> & notes";
    const r = ok(await sanitizePdf(await richPdf(), { properties: { title: { set: title }, keywords: { set: "予算, 令和8年度" } } }));
    const o = await open(r.bytes);
    expect(o.infoText("Title")).toBe(title);
    expect(o.infoRaw("Title")![0]).toBe("R".charCodeAt(0));
    expect(o.xmp).toContain("Report (draft) &lt;v2&gt; &amp; notes");
    expect(o.infoText("Keywords")).toBe("予算, 令和8年度");
    expect(o.xmp).toContain("<pdf:Keywords>予算, 令和8年度</pdf:Keywords>");
  });

  it("全部「消す」なら、文書情報も XMP も書かない", async () => {
    const r = ok(await sanitizePdf(await richPdf(), { properties: {} }));
    const o = await open(r.bytes);
    expect(o.info).toBeUndefined();
    expect(o.xmp).toBeNull();
    absent(r.bytes, OLD_AUTHOR);
  });

  it("properties を渡さないときは、今までどおり全部消し、報告に properties を付けない", async () => {
    const r = ok(await sanitizePdf(await richPdf()));
    const o = await open(r.bytes);
    expect(o.info).toBeUndefined();
    expect(o.xmp).toBeNull();
    expect(r.properties).toBeUndefined();
    expect(r.removed.find((x) => x.kind === "docinfo")?.count).toBe(7);
  });
});

describe("書き出したあとの読み直し：古い値が残っていたら止める", () => {
  it("古い作成者が、ほかの辞書の字に残っていれば properties_left（バイト列は返さない）", async () => {
    const { doc } = await newDoc();
    setInfo(doc, { Author: hex(OLD_AUTHOR) });
    // カタログの独自の欄に、同じ名前を入れておく（片付けでは外れない所）
    doc.catalog.set(PDFName.of("KakuuNote"), hex(OLD_AUTHOR));
    const r = await sanitizePdf(await save(doc), { properties: { author: { set: "総務課" } } });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.code).toBe("properties_left");
  });

  it("対照：短い古い値（PDF・Font）が、字の外（%PDF の頭・名前）にあっても止めない", async () => {
    const { doc } = await newDoc();
    setInfo(doc, { Title: lit("PDF"), Subject: lit("Font"), Author: hex(OLD_AUTHOR) });
    const r = await sanitizePdf(await save(doc), { properties: { author: { set: "総務課" } } });
    expect(r.status).toBe("ok");
  });

  it("同じ PDF でも、properties を渡さなければ今までどおり（読み直しはしない）", async () => {
    const { doc } = await newDoc();
    setInfo(doc, { Author: hex(OLD_AUTHOR) });
    doc.catalog.set(PDFName.of("KakuuNote"), hex(OLD_AUTHOR));
    expect((await sanitizePdf(await save(doc))).status).toBe("ok");
  });

  it("checkOldValues：圧縮した XMP・オブジェクトストリームの中・( ) の字のエスケープ・16 進の字でも見つける", async () => {
    const { doc } = await newDoc();
    setCatalogXmp(doc, xmpPacket("", "<dc:creator><rdf:Seq><rdf:li>架空 太郎</rdf:li></rdf:Seq></dc:creator>"), true);
    const inXmp = await checkOldValues(await save(doc), [OLD_AUTHOR]);
    expect(inXmp).toMatchObject({ found: 1, places: ["metadata"] });

    const d2 = await newDoc();
    d2.doc.catalog.set(PDFName.of("A"), lit("Kakuu \\(Old\\) Corp"));
    expect((await checkOldValues(await save(d2.doc), ["Kakuu (Old) Corp"])).found).toBe(1);

    const d3 = await newDoc();
    d3.doc.catalog.set(PDFName.of("A"), hex(OLD_AUTHOR));
    expect((await checkOldValues(await save(d3.doc, true), [OLD_AUTHOR])).places).toEqual(["object_stream"]);

    // 対照：ページの中身（字の命令）にある同じ字は探さない
    const d4 = await newDoc();
    const page = d4.pages[0]!;
    page.node.set(PDFName.of("Contents"), d4.ctx.register(d4.ctx.flateStream("BT (Kakuu Title) Tj ET")));
    expect((await checkOldValues(await save(d4.doc), ["Kakuu Title"])).found).toBe(0);
  });

  it("encodings・decodeStrings の部品", () => {
    expect(encodings("架空")).toEqual(expect.arrayContaining([u8("架空"), u16("架空")]));
    expect(decodeStrings("<</A <FEFF67B6> /B (x\\051y\\\\z)>>")).toBe(`þÿg¶\u0000x)y\\z`);
  });
});

describe("指定の形を確かめる（bad_properties）", () => {
  const cases: Array<[string, unknown]> = [
    ["知らない項目", { company: "keep" }],
    ["字でない値", { title: { set: 3 } }],
    ["長すぎる値", { title: { set: "あ".repeat(1001) } }],
    ["正しくない日付", { created: { set: "2026-13-40" } }],
    ["日付でない Date", { created: { set: new Date("x") } }],
    ["形が違う", { title: "rewrite" }],
    ["配列", []],
  ];
  for (const [name, properties] of cases) {
    it(name, async () => {
      const r = await sanitizePdf(await richPdf(), { properties: properties as never });
      expect(r.status).toBe("error");
      if (r.status === "error") expect(r.code).toBe("bad_properties");
    });
  }
  it("空の字の書き直しは「消す」と同じ。制御文字は外す", async () => {
    const r = ok(await sanitizePdf(await richPdf(), { properties: { title: { set: "  " }, author: { set: "総務\u0007課\n広報係" } } }));
    const o = await open(r.bytes);
    expect(o.infoText("Title")).toBeNull();
    expect(o.infoText("Author")).toBe("総務課 広報係");
    expect(r.properties?.find((p) => p.key === "title")?.action).toBe("removed");
  });
});

describe("日付の読み書き", () => {
  it("文書情報の形と XMP の形", () => {
    const d = parsePdfDate("D:20190401093000+09'00'")!;
    expect(formatIsoDate(d)).toBe("2019-04-01T09:30:00+09:00");
    expect(formatPdfDate(parseIsoDate("2020-01-02T03:04:05Z")!)).toBe("D:20200102030405Z");
    expect(formatPdfDate(parseIsoDate("2020-01-02T03:04:05-05:30")!)).toBe("D:20200102030405-05'30'");
    expect(parsePdfDate("D:2019")).toMatchObject({ y: 2019, mo: 1, d: 1, tz: null });
    expect(parsePdfDate("D:20191301")).toBeNull();
    expect(parseIsoDate("2026-11-05")).toMatchObject({ y: 2026, mo: 11, d: 5, h: 0, tz: null });
  });
});

describe("PDF/A の印（整える前に知らせ、外す・残すを選ぶ）", () => {
  it("preflightTidy が印と今の値を返す", async () => {
    const p = await preflightTidy(await richPdf({ pdfa: true }));
    expect(p.status).toBe("ok");
    if (p.status !== "ok") return;
    expect(p.pdfa).toEqual({ part: "2", conformance: "B" });
    expect(p.signatures).toBe(0);
    expect(p.properties.find((x) => x.key === "author")).toEqual({ key: "author", info: OLD_AUTHOR, xmp: OLD_AUTHOR, truncated: false });
    expect(p.properties.find((x) => x.key === "created")?.info).toBe("D:20190401093000+09'00'");
  });

  it("既定は外す（報告に pdfa_mark）", async () => {
    const r = ok(await sanitizePdf(await richPdf({ pdfa: true }), { properties: { title: "keep" } }));
    expect((await open(r.bytes)).xmp).not.toContain("pdfaid");
    expect(r.removed.some((x) => x.kind === "pdfa_mark")).toBe(true);
    expect(r.notDone.some((x) => x.reason === "pdfa_mark_kept")).toBe(false);
  });

  it("残すを選ぶと、新しい XMP に印を書き、「形式の決まりを満たさない恐れ」を出す", async () => {
    const r = ok(await sanitizePdf(await richPdf({ pdfa: true }), { properties: { title: "keep" }, pdfaMark: "keep" }));
    const xmp = (await open(r.bytes)).xmp!;
    expect(xmp).toContain("<pdfaid:part>2</pdfaid:part>");
    expect(xmp).toContain("<pdfaid:conformance>B</pdfaid:conformance>");
    expect(r.notDone.find((x) => x.reason === "pdfa_mark_kept")?.label).toContain("形式の決まりを満たさない恐れ");
  });

  it("properties を渡さずに残すを選ぶと、印だけの XMP を書く（文書情報は消す）", async () => {
    const r = ok(await sanitizePdf(await richPdf({ pdfa: true }), { pdfaMark: "keep" }));
    const o = await open(r.bytes);
    expect(o.info).toBeUndefined();
    expect(o.xmp).toContain("<pdfaid:part>2</pdfaid:part>");
    expect(o.xmp).not.toContain(OLD_AUTHOR);
  });

  it("印のない PDF では、どちらを選んでも何も出さない", async () => {
    const r = ok(await sanitizePdf(await richPdf(), { pdfaMark: "keep" }));
    expect(r.notDone.some((x) => x.reason === "pdfa_mark_kept")).toBe(false);
    expect(r.removed.some((x) => x.kind === "pdfa_mark")).toBe(false);
    expect((await open(r.bytes)).xmp).toBeNull();
  });
});

/** 署名した電子署名の欄（署名者の名前・見た目つき）と、文書の署名の決まり（/Perms） */
async function signedPdf(): Promise<Uint8Array> {
  const { doc, ctx, pages } = await newDoc();
  const sig = ctx.register(ctx.obj({ Type: "Sig", Filter: "Adobe.PPKLite", Name: hex("架空 花子"), Contents: PDFHexString.of("00"), ByteRange: [0, 10, 20, 30] } as never));
  const ap = ctx.register(ctx.stream("BT (Kakuu Hanako) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 30] }));
  const w = addAnnot(ctx, pages[0]!, { Subtype: "Widget", FT: "Sig", T: lit("sig1"), V: sig, Rect: [10, 10, 110, 40], AP: ctx.obj({ N: ap }) });
  doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [w], SigFlags: 3 }));
  doc.catalog.set(PDFName.of("Perms"), ctx.obj({ DocMDP: sig }));
  return save(doc);
}
const fieldOf = (ctx: PDFContext, doc: PDFDocument) => {
  const form = ctx.lookup(doc.catalog.get(PDFName.of("AcroForm"))) as PDFDict;
  const fields = ctx.lookup(form.get(PDFName.of("Fields"))) as PDFArray;
  return { form, field: ctx.lookup(fields.get(0)) as PDFDict };
};

describe("電子署名（整える前に知らせ、外す・残すを選ぶ）", () => {
  it("preflightTidy が署名の数を返す", async () => {
    const p = await preflightTidy(await signedPdf());
    expect(p.status === "ok" && p.signatures).toBe(1);
  });

  it("既定は外す：署名の値・見た目・/Perms・/SigFlags を外し、署名者の名前は残らない", async () => {
    const r = ok(await sanitizePdf(await signedPdf()));
    const { doc, ctx } = await open(r.bytes);
    const { form, field } = fieldOf(ctx, doc);
    expect(field.has(PDFName.of("V"))).toBe(false);
    expect(field.has(PDFName.of("AP"))).toBe(false);
    expect(form.has(PDFName.of("SigFlags"))).toBe(false);
    expect(doc.catalog.has(PDFName.of("Perms"))).toBe(false);
    absent(r.bytes, "架空 花子");
    expect(latin1(r.bytes)).not.toContain("Kakuu Hanako");
    expect(r.removed.find((x) => x.kind === "signature")?.count).toBe(1);
  });

  it("残すを選ぶと、署名はそのままにし、「署名は無効になります」を出す", async () => {
    const r = ok(await sanitizePdf(await signedPdf(), { signatures: "keep" }));
    const { doc, ctx } = await open(r.bytes);
    expect(fieldOf(ctx, doc).field.has(PDFName.of("V"))).toBe(true);
    expect(r.notDone.find((x) => x.reason === "signature_kept")?.label).toContain("署名は無効になります");
    expect(r.removed.some((x) => x.kind === "signature")).toBe(false);
  });

  it("署名のない PDF では何も出さない", async () => {
    const r = ok(await sanitizePdf(await richPdf()));
    expect(r.removed.some((x) => x.kind === "signature")).toBe(false);
    expect(r.notDone.some((x) => x.reason === "signature_kept")).toBe(false);
  });
});

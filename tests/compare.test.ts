// SPDX-License-Identifier: AGPL-3.0-only
//
// 2つの PDF の比べ（compare/）のテスト。
// 合成 PDF はテストの中で一から作る（名前・番号はすべて架空）。採点に使う合成 PDF（fixtures/）は読むだけで使う。

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { compareOutcome, comparePdfs, xmpProperties } from "../compare/index.ts";
import { sanitizePdf } from "../sanitize/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SECRET = "Kasou Hanako 090-0000-0000";
const OTHER = "Notice of the meeting";

type Build = {
  /** 名前の行を書くか */
  secret?: boolean;
  /** 名前の行の上に黒い四角を重ねるか */
  box?: boolean;
  /** 黒い四角のあとに、同じ字を白で描き直すか（上に見えている字） */
  redrawOnTop?: boolean;
  info?: Record<string, string>;
  xmp?: string;
  annots?: number;
  attach?: boolean;
};

async function makePdf(o: Build): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.drawText(OTHER, { x: 40, y: 250, size: 14, font });
  if (o.secret !== false) page.drawText(SECRET, { x: 40, y: 200, size: 14, font });
  if (o.box) page.drawRectangle({ x: 36, y: 194, width: 220, height: 22, color: rgb(0, 0, 0) });
  if (o.redrawOnTop) page.drawText(SECRET, { x: 40, y: 200, size: 14, font, color: rgb(1, 1, 1) });
  for (const [k, v] of Object.entries(o.info ?? {})) {
    if (k === "Title") doc.setTitle(v);
    else if (k === "Author") doc.setAuthor(v);
    else if (k === "Subject") doc.setSubject(v);
    else {
      // 独自の欄：文書情報の辞書に直接足す（pdf-lib に独自の欄を足す関数はない）
      const info = doc.context.lookup(doc.context.trailerInfo.Info);
      if (info instanceof PDFDict) info.set(PDFName.of(k), PDFString.of(v));
    }
  }
  if (o.xmp) {
    const stream = doc.context.stream(o.xmp, { Type: "Metadata", Subtype: "XML" });
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(stream));
  }
  if (o.annots) {
    const refs = [];
    for (let i = 0; i < o.annots; i++) {
      refs.push(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [10 + i * 20, 10, 30 + i * 20, 30], Contents: PDFString.of("memo") })));
    }
    page.node.set(PDFName.of("Annots"), doc.context.obj(refs));
  }
  if (o.attach) await doc.attach(new TextEncoder().encode("kasou,data\n1,2\n"), "list.csv", { mimeType: "text/csv" });
  return doc.save({ useObjectStreams: false });
}

const XMP = (creator: string) =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="KasouWriter 1.0">` +
  `<dc:creator><rdf:Seq><rdf:li>${creator}</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

describe("① 消したはずの字", () => {
  it("黒い四角を重ねただけ：元の字が、覆いの下に残っていると数と場所で返す（字の中身は返さない）", async () => {
    const r = await comparePdfs(await makePdf({}), await makePdf({ box: true }));
    expect(r.status).toBe("ok");
    const chars = [...SECRET.replace(/\s/g, "")].length;
    expect(r.text.remainingChars).toBe(chars);
    expect(r.text.pages[0]!.remaining).toHaveLength(1);
    expect(r.text.pages[0]!.remaining[0]!.cover).toBe("fill");
    expect(r.text.pages[0]!.remaining[0]!.rect).toEqual([36, 194, 256, 216]);
    expect(compareOutcome(r)).toEqual({ remaining: true, incomplete: false });
    expect(JSON.stringify(r)).not.toContain("Kasou");
    expect(JSON.stringify(r)).not.toContain("090");
  });

  it("字を消してから黒い四角を置いた（正しい墨消し）：残っていない。消えた字として数える", async () => {
    const r = await comparePdfs(await makePdf({}), await makePdf({ secret: false, box: true }));
    expect(r.text.remainingChars).toBe(0);
    expect(r.text.goneChars).toBe([...SECRET.replace(/\s/g, "")].length);
    expect(compareOutcome(r)).toEqual({ remaining: false, incomplete: false });
  });

  it("対照：同じ PDF どうし（覆いなし）では、何も残っていない", async () => {
    const pdf = await makePdf({});
    const r = await comparePdfs(pdf, pdf);
    expect(r.text.remainingChars).toBe(0);
    expect(r.text.goneChars).toBe(0);
  });

  it("対照：覆いのあとに同じ字を描き直したもの（上に見えている字）は、残っていると数えない", async () => {
    const r = await comparePdfs(await makePdf({}), await makePdf({ box: true, redrawOnTop: true }));
    expect(r.text.remainingChars).toBe(0);
    expect(r.text.goneChars).toBe(0);
  });

  it("覆いと関係なく書き換えた字は、消えた字（goneChars）として数える", async () => {
    const r = await comparePdfs(await makePdf({}), await makePdf({ secret: false }));
    expect(r.text.goneChars).toBe([...SECRET.replace(/\s/g, "")].length);
    expect(r.text.remainingChars).toBe(0);
  });

  it("ページの数が違うときは、比べなかったページがあると返す", async () => {
    const a = await PDFDocument.load(await makePdf({}));
    a.addPage([400, 300]);
    const r = await comparePdfs(await a.save(), await makePdf({}));
    expect(r.text.unmatchedPages).toBe(1);
    expect(compareOutcome(r).incomplete).toBe(true);
  });

  it("読めないファイルは、どちらの側かとともにエラーを返す", async () => {
    const r = await comparePdfs(await makePdf({}), new TextEncoder().encode("not a pdf"));
    expect(r.status).toBe("error");
    expect(r.error?.side).toBe("after");
    expect(compareOutcome(r).incomplete).toBe(true);
  });
});

describe("② 文書情報と XMP", () => {
  it("欄ごとの違いを、欄の名前と字数だけで返す（値は返さない）", async () => {
    const before = await makePdf({ info: { Title: "Kasou report", Author: "Kasou Taro", Subject: "same subject", KasouCustom: "x" } });
    const after = await makePdf({ info: { Title: "Public report", Subject: "same subject", Keywords: "k" } });
    const r = await comparePdfs(before, after);
    const by = new Map(r.info.fields.map((f) => [f.key, f]));
    expect(by.get("Author")?.change).toBe("removed");
    expect(by.get("Title")?.change).toBe("changed");
    expect(by.get("Subject")?.change).toBe("same");
    expect(by.get("Keywords")?.change).toBe("added");
    // 独自の欄は、名前も出さない
    expect(r.info.fields.filter((f) => f.key === null)).toEqual([{ key: null, change: "removed", beforeChars: 1, afterChars: null }]);
    const s = JSON.stringify(r);
    for (const v of ["Kasou", "Public report", "KasouCustom"]) expect(s).not.toContain(v);
  });

  it("XMP の項目の違い（作成者が消えた・作成したソフトは同じ）", async () => {
    const before = await makePdf({ xmp: XMP("Kasou Taro") });
    const after = await makePdf({ xmp: XMP("") });
    const r = await comparePdfs(before, after);
    expect(r.xmp.before).toBe(2);
    expect(r.xmp.after).toBe(2);
    const by = new Map(r.xmp.fields.map((f) => [f.name, f.change]));
    expect(by.get("dc:creator")).toBe("changed");
    expect(by.get("xmp:CreatorTool")).toBe("same");
    expect(JSON.stringify(r)).not.toContain("Kasou");
  });

  it("XMP を外したら、公開する側は「なし」", async () => {
    const r = await comparePdfs(await makePdf({ xmp: XMP("Kasou Taro") }), await makePdf({}));
    expect(r.xmp.after).toBeNull();
    expect(r.xmp.fields.every((f) => f.change === "removed")).toBe(true);
  });

  it("XMP の項目の読み取り：直下の要素と属性だけを項目にし、入れ子の中は1つの項目の中身にする", () => {
    const m = xmpProperties(XMP("A"));
    expect([...m.keys()].sort()).toEqual(["dc:creator", "xmp:CreatorTool"]);
  });
});

describe("③ 数の違い", () => {
  it("注釈と添付ファイルの数", async () => {
    const r = await comparePdfs(await makePdf({ annots: 3, attach: true }), await makePdf({}));
    expect(r.counts.annotations).toEqual({ before: 3, after: 0 });
    expect(r.counts.attachments).toEqual({ before: 1, after: 0 });
    expect(r.counts.revisions).toEqual({ before: 1, after: 1 });
  });
});

describe("片付けの前と後（合成 PDF fixtures/ を読むだけで使う）", () => {
  const dir = path.join(ROOT, "fixtures", "p6");
  // 字の層の見せかけの黒塗り（p6-t*）。正解データで、字の層の漏れが入っているもの
  const files = readdirSync(dir).filter((f) => /^p6-t\d+.*\.pdf$/.test(f));

  it("自分自身と比べると、覆いの下の字が残っていると返し、片付けたあとと比べると 0 字になる", async () => {
    let selfRemaining = 0;
    let afterRemaining = 0;
    let withRemaining = 0;
    for (const f of files) {
      const bytes = new Uint8Array(readFileSync(path.join(dir, f)));
      const self = await comparePdfs(bytes, bytes);
      selfRemaining += self.text.remainingChars;
      if (self.text.remainingChars > 0) withRemaining++;
      const s = await sanitizePdf(bytes.slice());
      if (s.status !== "ok") continue;
      const after = await comparePdfs(bytes, s.bytes);
      afterRemaining += after.text.remainingChars;
    }
    // 数は PR の本文に書く（測った値）
    console.log(`compare：p6-t* ${files.length} 個のうち、自分自身と比べて残りありと返した ${withRemaining} 個（${selfRemaining} 字）、片付けたあと ${afterRemaining} 字`);
    expect(withRemaining).toBeGreaterThan(0);
    expect(afterRemaining).toBe(0);
  });

  it("前の版の残りがある PDF を片付けると、版の数が減る", async () => {
    const p5 = path.join(ROOT, "fixtures", "p5");
    const f = readdirSync(p5).find((x) => x.endsWith(".pdf") && x.startsWith("p5-01"))!;
    const bytes = new Uint8Array(readFileSync(path.join(p5, f)));
    const s = await sanitizePdf(bytes.slice());
    expect(s.status).toBe("ok");
    if (s.status !== "ok") return;
    const r = await comparePdfs(bytes, s.bytes);
    expect(r.counts.revisions.before!).toBeGreaterThan(1);
    expect(r.counts.revisions.after).toBe(1);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 今の Office（formats/office.ts）のテスト。合成のファイルはテストの中で一から作る（tests/helpers/formats-samples.ts。中身は架空）。
// 隠しのあるものと、何も残っていない対照（誤検知しないこと）の両方を見る。

import { describe, expect, it } from "vitest";
import { inspectFormat, type FormatReport } from "../formats/index.ts";
import { readZip } from "../formats/zip.ts";
import { walkXml } from "../formats/xml.ts";
import { FAKE_NAME, FAKE_NAME_JA, FAKE_PATH, asciiTag, docx, jpeg, para, pptx, rationalTag, run, tiff, xlsx, zip } from "./helpers/formats-samples.ts";

const types = (r: FormatReport) => r.findings.map((f) => f.type).sort();
const find = (r: FormatReport, type: string) => r.findings.find((f) => f.type === type);
const noLeak = (r: FormatReport, ...values: string[]) => {
  const s = JSON.stringify(r);
  for (const v of [FAKE_NAME, FAKE_NAME_JA, "kasou-taro", ...values]) expect(s).not.toContain(v);
};

describe("docx", () => {
  it("対照：何も残っていない文書は、何も返さない", async () => {
    const r = await inspectFormat(docx());
    expect(r.format).toBe("docx");
    expect(r.findings).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("作成者・最後に保存した人・会社名・独自のプロパティ（値は返さない）", async () => {
    const r = await inspectFormat(docx({ props: { creator: FAKE_NAME, lastModifiedBy: FAKE_NAME_JA, title: "Kasou plan", company: "Kasou Co.", custom: { KasouKey: "K-0001" } } }));
    expect(types(r)).toEqual(["office.custom_property", "office.organization", "office.person", "office.person", "office.property"]);
    expect(r.findings.filter((f) => f.type === "office.person").map((f) => f.title)).toEqual([
      "プロパティの「作成者」に値が入っています",
      "プロパティの「最後に保存した人」に値が入っています",
    ]);
    noLeak(r, "Kasou plan", "Kasou Co.", "K-0001", "KasouKey");
  });

  it("変更履歴：削除した字の数と、段落の番号", async () => {
    const body = [
      para(run("Name: ")),
      `<w:p><w:del w:id="1" w:author="${FAKE_NAME}"><w:r><w:delText>${FAKE_NAME}</w:delText></w:r></w:del><w:ins w:id="2" w:author="${FAKE_NAME}"><w:r><w:t>X</w:t></w:r></w:ins></w:p>`,
    ];
    const r = await inspectFormat(docx({ body }));
    const f = find(r, "office.tracked_changes")!;
    expect(f.severity).toBe("high");
    expect(f.detail).toBe("削除 1 か所（11字）／挿入 1 か所（1字）");
    expect(f.where).toBe("段落 2");
    noLeak(r);
  });

  it("隠し文字：字に直接つけたものと、隠す設定の文字のスタイル", async () => {
    const body = [para(run("Visible"), run(FAKE_NAME, "<w:vanish/>")), para(run("090-0000-0000", '<w:rStyle w:val="HiddenStyle"/>')), para(run("shown", '<w:vanish w:val="0"/>'))];
    const styles = `<w:style w:type="character" w:styleId="HiddenStyle"><w:rPr><w:vanish/></w:rPr></w:style>`;
    const r = await inspectFormat(docx({ body, styles }));
    const f = find(r, "office.hidden_text")!;
    expect(f.detail).toBe(`${FAKE_NAME.replace(/\s/g, "").length + 13}字`);
    expect(f.where).toBe("段落 1・段落 2");
    noLeak(r, "090-0000-0000");
  });

  it("見せかけの黒塗り：黒い蛍光ペン・網掛けの上の黒い字。白い字", async () => {
    const body = [
      para(run(FAKE_NAME, '<w:color w:val="000000"/><w:highlight w:val="black"/>')),
      para(run("090-0000-0000", '<w:color w:val="111111"/><w:shd w:val="clear" w:color="auto" w:fill="000000"/>')),
      para(run("secret", '<w:color w:val="FFFFFF"/>')),
    ];
    const r = await inspectFormat(docx({ body }));
    expect(find(r, "office.fake_redaction")!.where).toBe("段落 1・段落 2");
    expect(find(r, "office.same_color_text")!.detail).toBe("6字");
    noLeak(r, "090-0000-0000");
  });

  it("対照：黒い蛍光ペンの上の、色を自動にした字（Word は白で表示する）と、黄色の蛍光ペンは数えない", async () => {
    const body = [para(run("visible", '<w:highlight w:val="black"/>')), para(run("marked", '<w:color w:val="000000"/><w:highlight w:val="yellow"/>'))];
    const r = await inspectFormat(docx({ body }));
    expect(r.findings).toEqual([]);
  });

  it("コメント（書いた人の数だけ。名前は返さない）", async () => {
    const r = await inspectFormat(docx({ comments: [{ author: FAKE_NAME, text: "check" }, { author: FAKE_NAME, text: "ok" }, { author: "Kasou Jiro", text: "?" }] }));
    expect(find(r, "office.comments")!.detail).toBe("3 件・書いた人 2 人");
    noLeak(r, "Kasou Jiro");
  });

  it("ひな形の場所・手元のファイルへのリンク（ウェブのリンクは数えない）", async () => {
    const r = await inspectFormat(docx({ attachedTemplate: "file:///" + FAKE_PATH, links: ["file:///C:/Users/kasou-taro/Desktop/list.xlsx", "https://example.invalid/"], props: { template: FAKE_PATH } }));
    expect(find(r, "office.template_path")).toBeTruthy();
    const link = find(r, "office.external_link")!;
    expect(link.detail).toBe("手元のファイルへのリンク 1／使った人のフォルダを含むもの 1");
    noLeak(r, "list.xlsx", "template.dotx");
  });

  it("埋め込まれたファイル（中の Office も調べる）と、中の写真の GPS", async () => {
    const inner = xlsx({ props: { creator: FAKE_NAME } });
    const photo = jpeg({ exif: tiff({ ifd0: [asciiTag(0x0110, "K")], gps: [rationalTag(2, [35, 1, 0, 1, 0, 1]), rationalTag(4, [139, 1, 0, 1, 0, 1])] }) });
    const r = await inspectFormat(docx({ embeddings: { "Microsoft_Excel_Worksheet.xlsx": inner, "oleObject1.bin": new Uint8Array(10) }, media: { "image1.jpeg": photo, "image2.png": new Uint8Array(8) } }));
    expect(find(r, "office.embedded")!.detail).toMatch(/^2 個／\.xlsx 1・\.bin 1／/);
    const nested = r.findings.find((f) => f.type === "office.person")!;
    expect(nested.where).toBe("埋め込まれたファイル 1 個目");
    const gps = find(r, "image.gps")!;
    expect(gps.severity).toBe("high");
    expect(gps.where).toBe("中の画像 1 個目");
    noLeak(r, "Microsoft_Excel_Worksheet");
  });

  it("本文の上の濃い図形", async () => {
    const shape =
      `<w:p><w:r><w:drawing><wp:anchor xmlns:wp="x" behindDoc="0"><a:graphic xmlns:a="y"><a:graphicData><wps:wsp xmlns:wps="z"><wps:spPr><a:solidFill><a:srgbClr val="000000"/></a:solidFill></wps:spPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
    const behind = shape.replace('behindDoc="0"', 'behindDoc="1"');
    const r = await inspectFormat(docx({ body: [para(run("Name")), shape, behind] }));
    expect(find(r, "office.cover_shape")!.detail).toBe("1 個");
    expect(find(r, "office.cover_shape")!.where).toBe("段落 2");
  });
});

describe("xlsx", () => {
  const STYLES =
    `<fonts count="3"><font/><font><color rgb="FF000000"/></font><font><color rgb="FFFFFFFF"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF000000"/></patternFill></fill></fills>` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode=";;;"/></numFmts>` +
    `<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="0" fontId="1" fillId="2"/><xf numFmtId="0" fontId="2" fillId="0"/><xf numFmtId="164" fontId="0" fillId="0"/></cellXfs>`;

  it("対照：何も残っていないブックは、何も返さない", async () => {
    const r = await inspectFormat(xlsx({ styles: STYLES }));
    expect(r.format).toBe("xlsx");
    expect(r.findings).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("隠したシート（シートの名前は返さない）と、隠した行・列", async () => {
    const r = await inspectFormat(xlsx({ sheets: [{ cells: [{ ref: "A1", value: "x" }] }, { state: "hidden", hiddenRows: [3, 4], hiddenCols: [[2, 4]] }, { state: "veryHidden" }] }));
    const s = find(r, "office.hidden_sheet")!;
    expect(s.detail).toBe("2 枚／うち 1 枚は、ふつうの操作では再表示できない形（中身は取り出せます）");
    expect(s.where).toBe("2 枚目のシート・3 枚目のシート");
    expect(find(r, "office.hidden_rows")!.detail).toBe("行 2・列 3");
    noLeak(r, "Sheet2");
  });

  it("見せかけの黒塗り（黒い塗りの黒い字）・白い字・;;; の書式を、セルの番地で返す", async () => {
    const cells = [
      { ref: "B2", value: FAKE_NAME, s: 1 },
      { ref: "B3", value: "090-0000-0000", s: 2 },
      { ref: "B4", value: "12345", s: 3 },
      { ref: "B5", value: "normal", s: 0 },
    ];
    const r = await inspectFormat(xlsx({ styles: STYLES, sheets: [{ cells }] }));
    expect(find(r, "office.fake_redaction")!.where).toBe("1 枚目のシート B2");
    expect(find(r, "office.same_color_text")!.where).toBe("1 枚目のシート B3");
    expect(find(r, "office.hidden_value")!.where).toBe("1 枚目のシート B4");
    noLeak(r, "090-0000-0000", "12345");
  });

  it("コメント・外のブック・共有ブックの変更履歴", async () => {
    const r = await inspectFormat(xlsx({ comments: 2, externalLink: "file:///C:/Users/kasou-taro/Desktop/budget.xlsx", revisions: true }));
    expect(find(r, "office.comments")!.detail).toBe("2 件・書いた人 1 人");
    expect(find(r, "office.external_link")!.detail).toBe("外のブック 1／使った人のフォルダを含むもの 1");
    expect(find(r, "office.tracked_changes")!.severity).toBe("high");
    noLeak(r, "budget");
  });
});

describe("pptx", () => {
  it("対照：何も残っていないスライドは、何も返さない", async () => {
    const r = await inspectFormat(pptx());
    expect(r.format).toBe("pptx");
    expect(r.findings).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("表示しないスライドと、発表者のメモ（スライドの番号つき）", async () => {
    const r = await inspectFormat(pptx({ slides: [{ shapes: [] }, { hidden: true, notes: `${FAKE_NAME} will explain` }] }));
    expect(find(r, "office.hidden_slide")!.where).toBe("2 枚目のスライド");
    expect(find(r, "office.notes")!.detail).toBe("スライド 1 枚・22字");
    expect(find(r, "office.notes")!.where).toBe("2 枚目のスライド");
    noLeak(r);
  });

  it("字のある図形の上に重ねた黒い図形・字と同じ色の図形・スライドの外の字", async () => {
    const shapes = [
      { x: 50, y: 100, w: 300, h: 40, text: FAKE_NAME },
      { x: 60, y: 105, w: 200, h: 30, fill: "000000" },
      { x: 50, y: 200, w: 300, h: 40, text: "090-0000-0000", fill: "000000", textColor: "000000" },
      { x: 2000, y: 50, w: 100, h: 40, text: "memo" },
    ];
    const r = await inspectFormat(pptx({ slides: [{ shapes }] }));
    expect(find(r, "office.cover_shape")!.where).toBe("1 枚目のスライド（左から 60 pt・上から 105 pt）");
    expect(find(r, "office.fake_redaction")!.detail).toBe("13字");
    expect(find(r, "office.off_slide_text")!.detail).toBe("4字");
    noLeak(r, "090-0000-0000");
  });

  it("対照：字の下に敷いた濃い図形（字より先に描いたもの）と、黒地に白い字は数えない", async () => {
    const shapes = [
      { x: 50, y: 100, w: 300, h: 40, fill: "000000" },
      { x: 60, y: 105, w: 200, h: 30, text: "Title" },
      { x: 50, y: 200, w: 300, h: 40, text: "Label", fill: "000000", textColor: "FFFFFF" },
    ];
    const r = await inspectFormat(pptx({ slides: [{ shapes }] }));
    expect(r.findings).toEqual([]);
  });

  it("コメントと、グループにした図形は調べていないと知らせる", async () => {
    const r = await inspectFormat(pptx({ comments: 3, slides: [{ shapes: [], group: true }] }));
    expect(find(r, "office.comments")!.detail).toBe("3 件・書いた人 1 人");
    expect(r.notices.map((n) => n.kind)).toEqual(["partial"]);
  });
});

describe("入れ物と、細工されたファイル", () => {
  it("今の Office でない ZIP・古い Office は、調べられなかったと知らせる", async () => {
    const r = await inspectFormat(zip({ "a.txt": "x" }));
    expect(r.notices[0]!.unchecked).toBe(true);
    const cfb = await inspectFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
    expect(cfb.format).toBe("cfb");
    expect(cfb.notices[0]!.unchecked).toBe(true);
  });

  it("壊れた ZIP", async () => {
    const good = docx();
    const r = await inspectFormat(good.slice(0, good.length - 30));
    expect(r.notices[0]!.unchecked).toBe(true);
  });

  it("小さく見せかけて大きく膨らむ部分は、上限で止めて「調べていない」と知らせる", async () => {
    const big = "<w:p>" + "a".repeat(70 * 1024 * 1024) + "</w:p>";
    const bytes = docx({ body: [big] });
    expect(bytes.length).toBeLessThan(1024 * 1024);
    const r = await inspectFormat(bytes);
    expect(r.notices.some((n) => n.kind === "too_large" && n.unchecked)).toBe(true);
  }, 60_000);

  it("圧縮しない ZIP も読む", () => {
    const z = readZip(zip({ "word/document.xml": "<x/>" }, { store: true }));
    expect("entries" in z && z.entries.size).toBe(1);
  });

  it("XML の DOCTYPE の実体を広げない", () => {
    const xml = `<!DOCTYPE x [<!ENTITY a "${"A".repeat(10)}"><!ENTITY b "&a;&a;&a;">]><root><t>&b;</t></root>`;
    const seen: string[] = [];
    walkXml(xml, { text: (t) => seen.push(t) });
    expect(seen.join("")).toBe("&b;");
  });
});

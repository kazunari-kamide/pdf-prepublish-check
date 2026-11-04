// SPDX-License-Identifier: AGPL-3.0-only
//
// 新しい検出ルール（p2-xmp・p8-annot 1.1.0・p9-attach 1.1.0 の中身・p10-exif・p11-forms・p12-actions）の、
// 字数・大きさ・ページ・値を返さないことなど、鍵だけでは見えない所を確かめる。

import { describe, expect, it } from "vitest";
import { detectP2Xmp } from "../rules/p2-xmp/index.ts";
import { detectP8Annot } from "../rules/p8-annot/index.ts";
import { inspectAttachments, textChars } from "../rules/p9-attach/inner.ts";
import { detectP10Exif, readExif } from "../rules/p10-exif/index.ts";
import { detectP11Forms } from "../rules/p11-forms/index.ts";
import { detectP12Actions } from "../rules/p12-actions/index.ts";
import * as p2 from "../eval/cases/p2.ts";
import * as p8 from "../eval/cases/p8.ts";
import * as p9i from "../eval/cases/p9-inner.ts";
import * as p10 from "../eval/cases/p10.ts";
import * as p11 from "../eval/cases/p11.ts";
import * as p12 from "../eval/cases/p12.ts";
import type { Case } from "../eval/cases/pdf.ts";
import { buildExifTiff, tinyJpeg } from "../eval/cases/pdf.ts";

const pdf = (cases: Case[], id: string) => cases.find((c) => c.id === id)!.build();
const NOT_PDF = new TextEncoder().encode("PDF ではない");

describe("P8 1.1.0", () => {
  it("隠しの注釈の見た目の中の字を数える（DRAFT Yamada 0123 → 空白を除いて 15 字）。値は返さない", async () => {
    const r = await detectP8Annot(await pdf(p8.CASES, "p8-l04"));
    expect(r.findings).toEqual([{ pattern: "P8", field: "AP", hidden: true, chars: 15, annotations: 1, pages: [1] }]);
    expect(r.hiddenAnnotations).toBe(1);
  });
  it("includeValues のときだけ、見た目の中の字も返す", async () => {
    const r = await detectP8Annot(await pdf(p8.CASES, "p8-l05"), { includeValues: true });
    expect(r.findings[0]!.value).toBe("SuzukiHanako");
  });
});

describe("P2 文書全体の XMP", () => {
  it("圧縮ありを読み、圧縮していたことを返す。値は返さない", async () => {
    const r = await detectP2Xmp(await pdf(p2.CASES, "p2-l02"));
    expect(r.xmp?.compressed).toBe(true);
    expect(r.findings.every((f) => f.value === undefined)).toBe(true);
    expect(r.findings.find((f) => f.field === "pdf:Author")?.chars).toBe(11);
  });
  it("履歴の出来事の数と、パスはユーザーのフォルダの名前の字数", async () => {
    const r = await detectP2Xmp(await pdf(p2.CASES, "p2-l03"));
    expect(r.findings.find((f) => f.kind === "history")?.events).toBe(3);
    expect(r.findings.find((f) => f.kind === "path")).toMatchObject({ pattern: "P4", chars: 6 });
  });
  it("決まり文句とアカウント名は notCounted に回す", async () => {
    const r = await detectP2Xmp(await pdf(p2.CASES, "p2-c02"));
    expect(r.notCounted.map((n) => n.reason).sort()).toEqual(["account", "generic"]);
  });
  it("空・PDF でないもの", async () => {
    expect((await detectP2Xmp(new Uint8Array())).error?.code).toBe("empty");
    expect((await detectP2Xmp(NOT_PDF)).error?.code).toBe("unreadable");
  });
});

describe("P12 JavaScript・開いたときの動作", () => {
  it("JavaScript の字数を返す（中身は返さない）。ストリームの JavaScript も数える", async () => {
    const r = await detectP12Actions(await pdf(p12.CASES, "p12-l02"));
    expect(r.findings).toEqual([{ pattern: "P12", kind: "javascript", where: "open_action", trigger: null, page: null, count: 1, chars: 18 }]);
  });
  it("自動の動作の引き金（WP）とページを返す", async () => {
    const r3 = await detectP12Actions(await pdf(p12.CASES, "p12-l03"));
    expect(r3.findings.find((f) => f.where === "document_aa")?.trigger).toBe("WP");
    const r4 = await detectP12Actions(await pdf(p12.CASES, "p12-l04"));
    expect(r4.findings[0]).toMatchObject({ where: "page_aa", trigger: "O", page: 1 });
  });
  it("ふつうのリンクは notCounted に数える", async () => {
    const r = await detectP12Actions(await pdf(p12.CASES, "p12-c02"));
    expect(r.notCounted).toEqual({ goto: 1, named: 1, link: 1 });
  });
});

describe("P11 フォームの値", () => {
  it("字数とページ。値も欄の名前も返さない", async () => {
    const r = await detectP11Forms(await pdf(p11.CASES, "p11-l01"));
    expect(r.findings).toEqual([{ pattern: "P11", visibility: "visible", fieldType: "text", chars: 4, page: 1 }]);
  });
  it("チェックボックスは字数 0、ウィジェットの無い欄はページなし", async () => {
    const r3 = await detectP11Forms(await pdf(p11.CASES, "p11-l03"));
    expect(r3.findings.find((f) => f.fieldType === "button")?.chars).toBe(0);
    const r2 = await detectP11Forms(await pdf(p11.CASES, "p11-l02"));
    expect(r2.findings[0]!.page).toBeNull();
  });
  it("数えなかった値の数", async () => {
    const r = await detectP11Forms(await pdf(p11.CASES, "p11-c01"));
    expect(r.notCounted).toMatchObject({ empty: 2, off: 1 });
    const r2 = await detectP11Forms(await pdf(p11.CASES, "p11-c02"));
    expect(r2.notCounted).toMatchObject({ signature: 1, defaultOnly: 1 });
  });
});

describe("P9 添付ファイルの中身", () => {
  it("Shift_JIS の文字のファイルの字数（架空の名簿 → 5 字）", async () => {
    const inner = await inspectAttachments(await pdf(p9i.CASES, "p9i-l02"), p9i.DETECTORS);
    expect(inner.find((i) => i.kind === "text")?.chars).toBe(5);
  });
  it("入れ子の深さを返し、深さの上限を超えた PDF は調べない", async () => {
    const bytes = await pdf(p9i.CASES, "p9i-l03");
    const inner = await inspectAttachments(bytes, p9i.DETECTORS);
    expect(inner[0]!.inner?.[0]).toMatchObject({ kind: "pdf", depth: 2, counts: { P1: 1 } });
    const shallow = await inspectAttachments(bytes, p9i.DETECTORS, { maxDepth: 1 });
    expect(shallow[0]!.inner?.[0]?.kind).toBe("too_deep");
  });
  it("調べる添付の数の上限", async () => {
    const inner = await inspectAttachments(await pdf(p9i.CASES, "p9i-l02"), p9i.DETECTORS, { budget: { files: 1 } });
    expect(inner.map((i) => i.kind)).toContain("not_checked");
  });
  it("UTF-8 の BOM と空白は字数に入れない", () => {
    expect(textChars(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x20, 0x62, 0x0a]))).toBe(2);
  });
});

describe("P10 画像の Exif", () => {
  it("縮小画像の大きさ（バイト）と、画像を置いたページを返す", async () => {
    const r = await detectP10Exif(await pdf(p10.CASES, "p10-l03"));
    expect(r.findings).toEqual([{ pattern: "P10", kind: "thumbnail", field: "IFD1", object: expect.any(Number), pages: [1], chars: 0, bytes: tinyJpeg().length }]);
    expect(r).toMatchObject({ jpegImages: 1, withExif: 1 });
  });
  it("リトルエンディアン（II）の Exif も読む", () => {
    // ビッグエンディアンで作った TIFF を、手で II に直すのは手間なので、最小の II の TIFF を直接書く（Artist = "Ab"）
    const le = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x3b, 0x01, 2, 0, 3, 0, 0, 0, 0x41, 0x62, 0, 0, 0, 0, 0, 0]);
    expect(readExif(le)).toEqual([{ kind: "person", field: "Artist", chars: 2, value: "Ab" }]);
  });
  it("壊れた Exif（範囲の外を指す）は、例外を返してルールは limits に出す", () => {
    const t = buildExifTiff({ ifd0: [{ tag: 0x013b, type: 2, value: "Long Name Here" }] });
    expect(() => readExif(t.subarray(0, 20))).toThrow();
  });
});

// ---------------------------------------------------------------- 後半（11/5 D の頼みの 7〜11）

import { detectAltText } from "../rules/alt-text/index.ts";
import { detectExtras, xfaDataChars } from "../rules/extras/index.ts";
import { detectFontGlyphs } from "../rules/font-glyphs/index.ts";
import { detectP4Paths, findPaths } from "../rules/p4-paths/index.ts";
import * as alt from "../eval/cases/alt-text.ts";
import * as ext from "../eval/cases/extras.ts";
import * as fg from "../eval/cases/font-glyphs.ts";
import * as p4 from "../eval/cases/p4.ts";

describe("しおりの題・代わりの文字", () => {
  it("同じ字の /ActualText は sameText に数え、出さない", async () => {
    const r = await detectAltText(await pdf(alt.CASES, "alt-c01"));
    expect(r.notCounted.sameText).toBe(2);
  });
  it("しおりの題の数と字数（入れ子もたどる）", async () => {
    const r = await detectAltText(await pdf(alt.CASES, "alt-l03"));
    expect(r.findings).toEqual([{ pattern: "P7", kind: "outline", where: "outlines", pages: [], count: 2, chars: 8 }]);
  });
  it("食い違いのページと字数", async () => {
    const r = await detectAltText(await pdf(alt.CASES, "alt-l01"));
    expect(r.findings[0]).toMatchObject({ kind: "actual_text_diff", pages: [1], count: 1, chars: 14 });
  });
});

describe("P4 ファイルパス・内部ホスト名", () => {
  it("ユーザーの名前・サーバーの名前の字数。値は返さない", async () => {
    const r = await detectP4Paths(await pdf(p4.CASES, "p4-l02"));
    expect(r.findings).toEqual([{ pattern: "P4", kind: "server", where: "annotation", places: 1, chars: 10 }]);
  });
  it("findPaths：Mac のユーザーのフォルダ・smb・file の共有フォルダ", () => {
    expect(findPaths("/Users/yamada/Desktop/a.pdf").map((h) => [h.kind, h.chars])).toEqual([["user_path", 6]]);
    expect(findPaths("smb://kakuu-nas/share").map((h) => h.kind)).toEqual(["server"]);
    expect(findPaths("file://kakuu-fs/share/a.doc").map((h) => h.kind)).toEqual(["server"]);
  });
  it("findPaths の対照：https の公開のサイト・時刻・相対パス", () => {
    expect(findPaths("https://www.example.jp/ 10:30 ../a.pdf C言語")).toEqual([]);
  });
});

describe("ページの縮小画像・XFA・C2PA", () => {
  it("縮小画像のページと大きさ", async () => {
    const r = await detectExtras(await pdf(ext.CASES, "ext-l01"));
    expect(r.thumbnails).toEqual([{ pattern: "P5", page: 2, width: 30, height: 20, bytes: 600 }]);
  });
  it("XFA の入力した値の字数（タグを除く）", async () => {
    const r = await detectExtras(await pdf(ext.CASES, "ext-l02"));
    expect(r.notices).toEqual([{ kind: "xfa", dataChars: 4, checked: true }]);
    expect(xfaDataChars("<xfa:datasets><a>ab c</a></xfa:datasets>")).toBe(3);
  });
});

describe("書体に残った字形", () => {
  it("余った字の形の数（描いた字・記号の少しの余りは出さない）", async () => {
    const r = await detectFontGlyphs(await pdf(fg.CASES, "fg-l01"));
    expect(r.findings[0]).toMatchObject({ pattern: "P7", leftover: 5, used: 4 });
    const c = await detectFontGlyphs(await pdf(fg.CASES, "fg-c02"));
    expect(c).toMatchObject({ findings: [], belowThreshold: 1 });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// 写真（formats/image.ts）のテスト。合成のファイルはテストの中で一から作る（tests/helpers/formats-samples.ts。中身は架空）。
// 隠しのあるものと、何も残っていない対照（誤検知しないこと）の両方を見る。

import { describe, expect, it } from "vitest";
import { detectFormat, inspectFormat, type FormatReport } from "../formats/index.ts";
import { readExif } from "../formats/exif.ts";
import { FAKE_NAME, XMP, asciiTag, heic, iptc, jpeg, png, rationalTag, tiff, webp } from "./helpers/formats-samples.ts";

const types = (r: FormatReport) => r.findings.map((f) => f.type).sort();
const sev = (r: FormatReport, type: string) => r.findings.find((f) => f.type === type)?.severity;
const GPS = { gps: [rationalTag(0x0002, [35, 1, 0, 1, 0, 1]), asciiTag(0x0001, "N"), rationalTag(0x0004, [139, 1, 0, 1, 0, 1]), asciiTag(0x0003, "E")] };
const noLeak = (r: FormatReport) => {
  const s = JSON.stringify(r);
  expect(s).not.toContain(FAKE_NAME);
  expect(s).not.toContain("Kasou");
};

describe("形式の見分け", () => {
  it("先頭のバイトで見分ける", () => {
    expect(detectFormat(jpeg())).toBe("jpeg");
    expect(detectFormat(png())).toBe("png");
    expect(detectFormat(webp())).toBe("webp");
    expect(detectFormat(heic())).toBe("heic");
    expect(detectFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("cfb");
    expect(detectFormat(new TextEncoder().encode("%PDF-1.7\n"))).toBe("pdf");
    expect(detectFormat(new TextEncoder().encode("plain text"))).toBe("unknown");
  });
});

describe("JPEG", () => {
  it("撮った場所（GPS）は高", async () => {
    const r = await inspectFormat(jpeg({ exif: tiff(GPS) }));
    expect(types(r)).toEqual(["image.gps"]);
    expect(sev(r, "image.gps")).toBe("high");
  });

  it("撮った人・説明・機種の欄を、種類だけで返す（値は返さない）", async () => {
    const exif = tiff({
      ifd0: [asciiTag(0x010f, "KasouCam"), asciiTag(0x0110, "K-100"), asciiTag(0x013b, FAKE_NAME), asciiTag(0x010e, "Kasou house front")],
      exif: [asciiTag(0x9003, "2026:01:02 03:04:05"), asciiTag(0xa431, "SN-0000-1111")],
    });
    const r = await inspectFormat(jpeg({ exif }));
    expect(types(r)).toEqual(["image.exif_device", "image.exif_person", "image.exif_text"]);
    expect(r.findings.find((f) => f.type === "image.exif_person")!.detail).toBe("撮った人・カメラの番号");
    noLeak(r);
  });

  it("EXIF の中の縮小画像：本体と同じ形なら中、形が違えば高（切り取る前の写真かもしれない）", async () => {
    const same = await inspectFormat(jpeg({ width: 640, height: 480, exif: tiff({ ifd0: [], thumbnail: jpeg({ width: 160, height: 120 }) }) }));
    expect(sev(same, "image.thumbnail")).toBe("medium");
    expect(same.findings[0]!.detail).toContain("見本 160×120");
    const cropped = await inspectFormat(jpeg({ width: 400, height: 400, exif: tiff({ ifd0: [], thumbnail: jpeg({ width: 160, height: 90 }) }) }));
    expect(sev(cropped, "image.thumbnail")).toBe("high");
    // 縦横を入れ替えただけ（向きの違い）は、形が違うとはみなさない
    const rotated = await inspectFormat(jpeg({ width: 480, height: 640, exif: tiff({ ifd0: [], thumbnail: jpeg({ width: 160, height: 120 }) }) }));
    expect(sev(rotated, "image.thumbnail")).toBe("medium");
  });

  it("XMP（作成者・編集の履歴）と IPTC（撮った人）", async () => {
    const xmp = XMP(`<dc:creator><rdf:Seq><rdf:li>${FAKE_NAME}</rdf:li></rdf:Seq></dc:creator><xmpMM:History><rdf:Seq><rdf:li>edit</rdf:li></rdf:Seq></xmpMM:History>`);
    const r = await inspectFormat(jpeg({ xmp, iptc: iptc([[80, FAKE_NAME], [120, "Kasou caption"]]) }));
    expect(types(r)).toEqual(["image.iptc", "image.xmp"]);
    expect(r.findings.find((f) => f.type === "image.xmp")!.detail).toBe("項目 2 個／人をたどれる項目 1 個／編集の履歴あり");
    expect(r.findings.find((f) => f.type === "image.iptc")!.detail).toBe("項目 2 個／撮った人・連絡先などの項目あり");
    noLeak(r);
  });

  it("XMP の中の GPS も、撮った場所として高", async () => {
    const r = await inspectFormat(jpeg({ xmp: XMP(`<exif:GPSLatitude>35,0.0N</exif:GPSLatitude>`) }));
    expect(sev(r, "image.gps")).toBe("high");
  });

  it("対照：記録のない JPEG は、何も返さない", async () => {
    const r = await inspectFormat(jpeg());
    expect(r.findings).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("対照：中身が空の欄（空白だけ）は数えない", async () => {
    const r = await inspectFormat(jpeg({ exif: tiff({ ifd0: [asciiTag(0x013b, "   "), asciiTag(0x010e, "")] }) }));
    expect(r.findings).toEqual([]);
  });

  it("壊れた JPEG は、調べられなかった所として知らせる", async () => {
    const good = jpeg({ exif: tiff(GPS) });
    const broken = good.slice(0, 12);
    const r = await inspectFormat(broken);
    expect(r.notices.some((n) => n.unchecked)).toBe(true);
  });

  it("IFD が自分を指し返しても止まる", () => {
    const t = tiff({ ifd0: [asciiTag(0x013b, FAKE_NAME)] });
    // IFD0 の次の IFD の指し先を、IFD0 自身にする
    const n = t[8]! | (t[9]! << 8);
    const nextAt = 8 + 2 + n * 12;
    t.set([8, 0, 0, 0], nextAt);
    const s = readExif(t);
    expect(s.person).toEqual(["撮った人"]);
  });
});

describe("PNG", () => {
  it("eXIf の GPS・文字の欄・XMP・zTXt", async () => {
    const r = await inspectFormat(
      png({ exif: tiff(GPS), text: [["Author", FAKE_NAME], ["KasouKey", "x"]], ztext: [["Comment", "Kasou memo"]], xmp: XMP(`<dc:creator><rdf:Seq><rdf:li>${FAKE_NAME}</rdf:li></rdf:Seq></dc:creator>`) }),
    );
    expect(types(r)).toEqual(["image.gps", "image.png_text", "image.xmp"]);
    expect(r.findings.find((f) => f.type === "image.png_text")!.detail).toBe("Author・Comment／独自の欄 1 個");
    noLeak(r);
  });

  it("16進の字で書いた EXIF（Raw profile type exif）も読む", async () => {
    const r = await inspectFormat(png({ rawExifHex: tiff(GPS) }));
    expect(sev(r, "image.gps")).toBe("high");
  });

  it("対照：記録のない PNG は、何も返さない", async () => {
    const r = await inspectFormat(png());
    expect(r.findings).toEqual([]);
    expect(r.notices).toEqual([]);
  });
});

describe("WebP", () => {
  it("EXIF と XMP", async () => {
    const r = await inspectFormat(webp({ exif: tiff({ ifd0: [asciiTag(0x013b, FAKE_NAME)], ...GPS }), xmp: XMP(`<xmp:CreatorTool>KasouEditor</xmp:CreatorTool>`) }));
    expect(types(r)).toEqual(["image.exif_person", "image.gps", "image.xmp"]);
    expect(sev(r, "image.xmp")).toBe("low");
    noLeak(r);
  });

  it("対照：記録のない WebP は、何も返さない", async () => {
    const r = await inspectFormat(webp());
    expect(r.findings).toEqual([]);
  });
});

describe("HEIC", () => {
  it("記録の項目が有ると知らせ、中身は調べていないと知らせる", async () => {
    const r = await inspectFormat(heic({ exifItem: true }));
    expect(types(r)).toEqual(["image.heic_meta"]);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.unchecked).toBe(true);
  });

  it("対照：記録の項目がなくても、中身は調べていないと知らせる（見つからない、とは言わない）", async () => {
    const r = await inspectFormat(heic());
    expect(r.findings).toEqual([]);
    expect(r.notices[0]!.unchecked).toBe(true);
  });
});

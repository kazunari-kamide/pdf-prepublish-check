// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルール：見える文字の個人情報（rules/pii）のテスト。
// 採点に使う合成 PDF（fixtures/pii）は使わず、テストの中で小さな PDF を作る。日本語の字は、ToUnicode だけを持つ書体の辞書を手で作って描く
// （字の形は要らない。ルールは字の中身と幅だけを読む）。名前・番号はすべて架空。

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, type PDFRef } from "pdf-lib";
import { detectPii, findPiiInContent, findPiiInText, countsOnly } from "../rules/pii/index.ts";
import {
  isLuhnValid,
  isOrganizationName,
  isValidCorporateNumber,
  isValidMyNumber,
  normalize,
  numericView,
  parseNumber,
  scanLine,
} from "../rules/pii/patterns.ts";

// ---------------------------------------------------------------- 小さな PDF を作る道具

type Line = { text: string; x: number; y: number; size?: number; vertical?: boolean };

const hex4 = (n: number) => n.toString(16).padStart(4, "0").toUpperCase();

/** 使う字に 2 バイトのコードを割り当て、ToUnicode を持つ Type0 の書体を作る */
function makeFont(doc: PDFDocument, chars: string[], vertical: boolean, withToUnicode = true): { ref: PDFRef; encode(s: string): string } {
  const ctx = doc.context;
  const codes = new Map<string, number>();
  chars.forEach((c, i) => codes.set(c, 0x0100 + i));
  const bf = [...codes].map(([c, code]) => {
    const u = [...c].map((ch) => hex4(ch.codePointAt(0)!)).join("");
    return `<${hex4(code)}> <${u}>`;
  });
  const chunks: string[] = [];
  for (let i = 0; i < bf.length; i += 100) chunks.push(`${Math.min(100, bf.length - i)} beginbfchar\n${bf.slice(i, i + 100).join("\n")}\nendbfchar`);
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n${chunks.join("\n")}\nendcmap CMapName currentdict /CMap defineresource pop end end`;
  const desc = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "TestCJK", Flags: 4, FontBBox: [0, -120, 1000, 880], Ascent: 880, Descent: -120, ItalicAngle: 0, CapHeight: 700, StemV: 80 }));
  const cid = ctx.register(
    ctx.obj({ Type: "Font", Subtype: "CIDFontType2", BaseFont: "TestCJK", CIDSystemInfo: { Registry: ctx.obj("Adobe"), Ordering: ctx.obj("Identity"), Supplement: 0 }, FontDescriptor: desc, DW: 1000 }),
  );
  const dict: Record<string, unknown> = { Type: "Font", Subtype: "Type0", BaseFont: "TestCJK", Encoding: vertical ? "Identity-V" : "Identity-H", DescendantFonts: [cid] };
  if (withToUnicode) dict.ToUnicode = ctx.register(ctx.stream(cmap));
  const ref = ctx.register(ctx.obj(dict as never));
  return { ref, encode: (s) => [...s].map((c) => hex4(codes.get(c)!)).join("") };
}

/** 行の並びから、1ページ（または複数ページ）の PDF を作る */
async function makePdf(pages: Line[][], opts: { toUnicode?: boolean; form?: Line[]; rotate?: number; cm?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const all = [...pages.flat(), ...(opts.form ?? [])];
  const chars = [...new Set(all.flatMap((l) => [...l.text]))];
  const h = makeFont(doc, chars, false, opts.toUnicode !== false);
  const v = makeFont(doc, chars, true, opts.toUnicode !== false);
  const ops = (lines: Line[]) =>
    lines.map((l) => `BT /${l.vertical ? "FV" : "FH"} ${l.size ?? 10} Tf 1 0 0 1 ${l.x} ${l.y} Tm <${(l.vertical ? v : h).encode(l.text)}> Tj ET`).join("\n");
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    const res: Record<string, unknown> = { Font: { FH: h.ref, FV: v.ref } };
    let content = opts.cm ? `q ${opts.cm} cm
${ops(lines)}
Q` : ops(lines);
    if (opts.rotate) page.node.set(PDFName.of("Rotate"), doc.context.obj(opts.rotate));
    if (opts.form) {
      const form = doc.context.register(
        doc.context.stream(ops(opts.form), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 595, 842], Resources: { Font: { FH: h.ref, FV: v.ref } } }),
      );
      res.XObject = { X1: form };
      content += "\nq 1 0 0 1 0 -100 cm /X1 Do Q";
    }
    page.node.set(PDFName.of("Resources"), doc.context.obj(res as never));
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(content)));
  }
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

const types = (s: string) => scanLine(s).hits.map((h) => `${h.type}:${s.slice(h.start, h.end)}:${h.confidence}`);

// ---------------------------------------------------------------- 番号の確かめ・字のそろえ方

describe("番号の確かめ", () => {
  it("マイナンバーの検査用の数字", () => {
    expect(isValidMyNumber("482910375622")).toBe(true);
    expect(isValidMyNumber("482910375623")).toBe(false);
    expect(isValidMyNumber("48291037562")).toBe(false);
  });
  it("法人番号の検査用の数字（最初の1けた）", () => {
    expect(isValidCorporateNumber("9702918364055")).toBe(true);
    expect(isValidCorporateNumber("8702918364055")).toBe(false);
  });
  it("カード番号（Luhn）", () => {
    expect(isLuhnValid("4980021377654324")).toBe(true);
    expect(isLuhnValid("4980021377654325")).toBe(false);
  });
  it("全角の数字・記号を半角に、漢数字を数字に（長さは変えない）", () => {
    expect(normalize("０９０－１２")).toBe("090-12");
    expect(numericView(normalize("〇九〇―四八"))).toBe("090-48");
    expect(numericView("〇九〇―四八").length).toBe(6);
    expect(parseNumber("六十二")).toBe(62);
    expect(parseNumber("十二")).toBe(12);
    expect(parseNumber("二十")).toBe(20);
    expect(parseNumber("元")).toBe(1);
  });
});

// ---------------------------------------------------------------- 1行の判定

describe("1行の判定：見つけるもの", () => {
  it("氏名：前の語のあと（高）、役職のあと・「様」の前（確認）", () => {
    expect(types("氏名：朝霧 澄香")).toEqual(["name:朝霧 澄香:high"]);
    expect(types("会長 宵町 律")).toEqual(["name:宵町 律:check"]);
    expect(types("波戸崎 葵 様")).toEqual(["name:波戸崎 葵:check"]);
    expect(types("担当者 霜月")).toEqual(["name:霜月:check"]);
  });
  it("名字の終わりが「部」「村」でも、団体名と取り違えない", () => {
    expect(types("阿部 様")).toEqual(["name:阿部:check"]);
    expect(types("氏名 中村 灯")).toEqual(["name:中村 灯:high"]);
    expect(isOrganizationName("阿部")).toBe(false);
    expect(isOrganizationName("総務部")).toBe(true);
    expect(isOrganizationName("みどり市")).toBe(true);
  });
  it("電話：携帯（全角・漢数字も）・自宅は高、区切りのない並びは前の語があるときだけ", () => {
    expect(types("携帯：０９０－０２７４－１８８３")).toEqual(["phone:０９０－０２７４－１８８３:high"]);
    expect(types("〇九〇―〇四八一―二三三七")).toEqual(["phone:〇九〇―〇四八一―二三三七:high"]);
    expect(types("TEL 08006273915")).toEqual(["phone:08006273915:high"]);
    expect(types("番号 08006273915")).toEqual([]);
    expect(types("自宅 0467-08-2093")).toEqual(["phone:0467-08-2093:high"]);
  });
  it("080 の携帯を、0800 のフリーダイヤルと取り違えない", () => {
    expect(types("080-0627-3915")).toEqual(["phone:080-0627-3915:high"]);
    expect(scanLine("0800-123-456").excluded.map((e) => e.reason)).toEqual(["free_dial"]);
  });
  it("マイナンバー：前の語があれば高、4けたずつの区切りだけなら確認", () => {
    expect(types("個人番号 4829 1037 5622")).toEqual(["my_number:4829 1037 5622:high"]);
    expect(types("6194-0728-3511")).toEqual(["my_number:6194-0728-3511:check"]);
  });
  it("生年月日：和暦・漢数字・「生まれ」", () => {
    expect(types("生年月日 平成3年4月18日")).toEqual(["birth_date:平成3年4月18日:high"]);
    expect(types("昭和六十二年五月三日生")).toEqual(["birth_date:昭和六十二年五月三日:high"]);
    expect(types("1990年7月2日生まれ")).toEqual(["birth_date:1990年7月2日:high"]);
    expect(types("誕生日 H5.11.23")).toEqual(["birth_date:H5.11.23:high"]);
  });
  it("住所・口座・メール・カード", () => {
    expect(types("住所 架空県みどり市あおば町1丁目2番3号")).toEqual(["address:架空県みどり市あおば町1丁目2番3号:high"]);
    expect(types("普通 5091736")).toEqual(["bank_account:5091736:high"]);
    expect(types("個人のメール ritsu@kakuu.test")).toEqual(["email:ritsu@kakuu.test:high"]);
    // 例示用のドメインでも、記入例の印がなければ候補にする（確からしさは「確認」まで。0.1.1）
    expect(types("Mail: hinata.kasumi@example.jp")).toEqual(["email:hinata.kasumi@example.jp:check"]);
    expect(types("個人のメール hinata@example.com")).toEqual(["email:hinata@example.com:check"]);
    expect(types("カード 4980 0213 7765 4324")).toEqual(["card_number:4980 0213 7765 4324:high"]);
  });
});

describe("1行の判定：誤検知しないもの（対照）", () => {
  const none = (s: string) => expect(scanLine(s).hits, s).toEqual([]);
  it("役職名だけ・団体名・見出しの語", () => {
    none("委員長");
    none("担当：総務課");
    none("担当 企画課 内線 2381");
    none("氏名 住所 電話番号");
    none("関係者各位");
    none("利用者様へのお知らせ");
    none("同氏の発言");
  });
  it("見本の値・記入例の行", () => {
    none("氏名 山田太郎");
    none("住所 〇〇県〇〇市〇〇町1-2-3");
    none("記入例 電話 090-0481-2337");
    none("sample@example.com");
    none("記入例 kogure.minato@example.jp");
    none("電話 000-0000-0000");
  });
  it("団体の代表電話・FAX・問い合わせ先・所在地", () => {
    none("代表電話 0123-08-7710");
    none("FAX 0123-08-7711");
    none("お問い合わせ 総務課 0123-08-7712");
    none("所在地 架空県みどり市中央1-1-1");
    none("お問い合わせ info@kakuu.test");
  });
  it("日付・時刻・条文の番号・図番（F03：カード番号や電話番号と誤らない）", () => {
    none("作成日 2026-11-05");
    none("作成日 20261105");
    none("作成日：令和7年11月5日");
    none("記録番号 202611051303");
    none("記録 2026 1105 1230 0001");
    none("第12条第3項第4号");
    none("図番 03-1105-2026");
    none("受付時間 09:00-17:00");
  });
  it("法人番号・合わない 12 けた・16 けたの途中", () => {
    none("法人番号 9702918364055");
    none("受付番号 730581642091");
    none("テスト用 4111 1111 1111 1111");
    expect(scanLine("法人番号 9702918364055").excluded.map((e) => e.reason)).toContain("corporate_number");
  });
});

// ---------------------------------------------------------------- PDF から

describe("PDF から探す", () => {
  it("横書き：型・ページ・箱・確からしさを返し、字の中身は返さない", async () => {
    const pdf = await makePdf([[{ text: "氏名：朝霧澄香", x: 100, y: 700 }, { text: "携帯 090-0274-1883", x: 100, y: 680 }]]);
    const r = await detectPii(pdf);
    expect(r.status).toBe("ok");
    expect(r.findings.map((f) => [f.type, f.confidence, f.page, f.chars])).toEqual([
      ["name", "high", 1, 4],
      ["phone", "high", 1, 13],
    ]);
    // 氏名の箱：「氏名：」の3字ぶん右から 4 字（1字 10pt）
    const name = r.findings[0]!;
    expect(name.rect[0]).toBeCloseTo(130, 0);
    expect(name.rect[2]).toBeCloseTo(170, 0);
    expect(name.rect[1]).toBeCloseTo(698.8, 0);
    expect(name.rect[3]).toBeCloseTo(708.8, 0);
    const json = JSON.stringify(r);
    expect(json).not.toContain("朝霧");
    expect(json).not.toContain("0274");
    expect(r.counts).toMatchObject({ total: 2, high: 2, check: 0 });
  });

  it("includeText を渡したときだけ、見つけた字そのものを 1 件ごとに返す（渡さないときは text がない）", async () => {
    const pdf = await makePdf([[{ text: "氏名：朝霧澄香", x: 100, y: 700 }, { text: "携帯 090-0274-1883", x: 100, y: 680 }]]);
    const withText = await detectPii(pdf, { includeText: true });
    expect(withText.findings.map((f) => [f.type, f.text])).toEqual([
      ["name", "朝霧澄香"],
      ["phone", "090-0274-1883"],
    ]);
    // 中身のほかは、渡さないときと同じ
    const plain = await detectPii(pdf);
    expect(withText.findings.map(({ text: _t, ...rest }) => rest)).toEqual(plain.findings);
    expect(plain.findings.every((f) => !("text" in f))).toBe(true);
    expect(JSON.stringify(await detectPii(pdf, { includeText: false }))).not.toContain("朝霧");
    // 件数だけの形（記録に使う）には、渡しても中身が入らない
    expect(JSON.stringify(countsOnly(withText))).not.toContain("朝霧");
  });

  it("includeText：縦書き・表の欄で見つけた字も、その範囲の字を返す", async () => {
    const vertical = await detectPii(await makePdf([[{ text: "電話　〇九〇―〇四八一―二三三七", x: 500, y: 780, vertical: true }]]), { includeText: true });
    expect(vertical.findings.map((f) => f.text)).toEqual(["〇九〇―〇四八一―二三三七"]);
    const table = await detectPii(
      await makePdf([[{ text: "氏名", x: 100, y: 700 }, { text: "朝霧澄香", x: 100, y: 680 }]]),
      { includeText: true },
    );
    expect(table.findings.filter((f) => f.type === "name").map((f) => f.text)).toEqual(["朝霧澄香"]);
  });

  it("縦書き（Identity-V）：列として読み、箱は縦長", async () => {
    const pdf = await makePdf([[{ text: "電話　〇九〇―〇四八一―二三三七", x: 500, y: 780, vertical: true }]]);
    const r = await detectPii(pdf);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0]!;
    expect(f.type).toBe("phone");
    expect(f.vertical).toBe(true);
    expect(f.rect[0]).toBeCloseTo(495, 0);
    expect(f.rect[2]).toBeCloseTo(505, 0);
    expect(f.rect[3]).toBeCloseTo(780 - 30, 0);
    expect(f.rect[1]).toBeCloseTo(780 - 30 - 130, 0);
  });

  it("表：列の見出し（氏名・住所・電話番号・生年月日）の下の欄を、その型として見る", async () => {
    const row = (y: number, cells: string[]) => cells.map((text, i) => ({ text, x: [60, 160, 340, 480][i]!, y, size: 8 })); // このテストの書体は数字も 1em 幅なので、欄を広めにあける
    const pdf = await makePdf([
      [
        ...row(760, ["氏名", "住所", "電話番号", "生年月日"]),
        ...row(745, ["朝霧澄香", "みどり市あおば町1-2-3", "0255-07-3146", "平成3年4月18日"]),
        ...row(730, ["宵町律", "そらの町うみべ12番地5", "080-0627-3915", "昭和62年5月3日"]),
      ],
    ]);
    const r = await detectPii(pdf);
    const got = r.findings.map((f) => `${f.type}:${f.confidence}:${f.basis}`).sort();
    expect(got).toEqual(
      [
        "name:high:column_header",
        "name:high:column_header",
        "address:high:column_header",
        "address:high:column_header",
        "phone:high:column_header",
        "phone:high:pattern",
        "birth_date:high:column_header",
        "birth_date:high:column_header",
      ].sort(),
    );
  });

  it("表：横向きの表（/Rotate と回した中身。画面では横書き）でも、列の見出しの下の欄を、その型として見る（0.1.7 から）", async () => {
    const row = (y: number, cells: string[]) => cells.map((text, i) => ({ text, x: [60, 160, 340, 480][i]!, y, size: 8 }));
    const table = [
      ...row(560, ["氏名", "住所", "電話番号", "生年月日"]),
      ...row(545, ["朝霧澄香", "みどり市あおば町1-2-3", "0255-07-3146", "平成3年4月18日"]),
      ...row(530, ["宵町律", "そらの町うみべ12番地5", "080-0627-3915", "昭和62年5月3日"]),
    ];
    const summary = async (opts: { rotate?: number; cm?: string }) =>
      (await detectPii(await makePdf([table], opts))).findings.map((f) => `${f.type}:${f.confidence}:${f.basis}:${f.vertical}`).sort();
    const flat = await summary({});
    expect(flat.filter((s) => s.endsWith(":column_header:false"))).toHaveLength(7);
    // 縦長の紙に /Rotate 90・270・180 をかけ、中身を逆に回して描く（表計算ソフトの横向きの印刷など）
    for (const opts of [
      { rotate: 90, cm: "0 1 -1 0 595 0" },
      { rotate: 270, cm: "0 -1 1 0 0 842" },
      { rotate: 180, cm: "-1 0 0 -1 595 842" },
    ]) {
      expect(await summary(opts), `Rotate ${opts.rotate}`).toEqual(flat);
    }
    // 箱はページの既定の座標のまま（/Rotate 90 では、名前の箱は縦に長い）
    const r90 = await detectPii(await makePdf([table], { rotate: 90, cm: "0 1 -1 0 595 0" }));
    for (const f of r90.findings.filter((f) => f.type === "name")) expect(f.rect[3] - f.rect[1]).toBeGreaterThan(f.rect[2] - f.rect[0]);
  });

  it("部品（Form XObject）の中の字も読む", async () => {
    const pdf = await makePdf([[{ text: "本文", x: 100, y: 700 }]], { form: [{ text: "生年月日 平成3年4月18日", x: 100, y: 600 }] });
    const r = await detectPii(pdf);
    expect(r.findings.map((f) => f.type)).toEqual(["birth_date"]);
    expect(r.findings[0]!.rect[1]).toBeLessThan(510); // 部品を cm で 100 下げた所
  });

  it("2ページ目だけにあるものは 2 ページとして返す", async () => {
    const pdf = await makePdf([[{ text: "報告書", x: 100, y: 700 }], [{ text: "氏名 霜月灯", x: 100, y: 700 }]]);
    const r = await detectPii(pdf);
    expect(r.pages).toBe(2);
    expect(r.findings.map((f) => f.page)).toEqual([2]);
  });

  it("字の中身を引けない書体（ToUnicode なし）は、探せなかったページとして知らせる", async () => {
    const pdf = await makePdf([[{ text: "氏名 朝霧澄香", x: 100, y: 700 }]], { toUnicode: false });
    const r = await detectPii(pdf);
    expect(r.findings).toEqual([]);
    expect(r.unreadable.pages).toEqual([1]);
    expect(r.unreadable.glyphs).toBeGreaterThan(0);
  });

  it("命令の数が上限を超えたページは省いたページとして返し、ほかのページは調べる", async () => {
    const pdf = await makePdf([[{ text: "氏名 朝霧澄香", x: 100, y: 700 }], [{ text: "氏名 宵町律", x: 100, y: 700 }]]);
    const r = await detectPii(pdf, { settings: { maxOperations: 3 } });
    expect(r.skippedPages.map((s) => s.reason)).toEqual(["too_many_operations", "too_many_operations"]);
    expect(r.findings).toEqual([]);
  });

  it("壊れた PDF は止まらずに error を返す", async () => {
    const r = await detectPii(new TextEncoder().encode("%PDF-1.7\nこわれた"));
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("unreadable");
  });

  it("件数だけの形（場所・中身を含まない）", async () => {
    const pdf = await makePdf([[{ text: "氏名：朝霧澄香", x: 100, y: 700 }]]);
    const c = countsOnly(await detectPii(pdf));
    expect(c.counts.byType.name).toEqual({ high: 1, check: 0 });
    expect(JSON.stringify(c)).not.toMatch(/rect|朝霧/);
  });
});

// ---------------------------------------------------------------- 前の版から呼ぶ入口（P5 の側）

describe("前の版の中身から探す入口", () => {
  it("findPiiInContent：描く命令の列と資源の辞書から、型ごとの件数だけを返す", async () => {
    const pdf = await makePdf([[{ text: "氏名 朝霧澄香", x: 100, y: 700 }, { text: "個人番号 4829 1037 5622", x: 100, y: 680 }]]);
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    const page = doc.getPages()[0]!;
    const content = (doc.context.lookup(page.node.get(PDFName.of("Contents"))) as unknown as { getContents(): Uint8Array }).getContents();
    const r = findPiiInContent(doc.context, content, page.node.Resources());
    expect(r.status).toBe("ok");
    expect(r.counts.total).toBe(2);
    expect(r.counts.byType.name.high).toBe(1);
    expect(r.counts.byType.my_number.high).toBe(1);
    expect(JSON.stringify(r)).not.toContain("朝霧");
  });
  it("findPiiInText：場所のない字（改行で行に分ける）", () => {
    const r = findPiiInText("氏名：朝霧 澄香\n担当：総務課\n携帯 090-0274-1883");
    expect(r.counts.total).toBe(2);
    expect(r.excluded.organization).toBe(1);
  });
});

// ---------------------------------------------------------------- 速さ（100 ページ）

describe("速さ", () => {
  it("100 ページ（1ページ 60 行、表と文の混ざったもの）を、決めた時間の中で調べ終える", async () => {
    const page = (n: number): Line[] => {
      const lines: Line[] = [{ text: "氏名", x: 60, y: 800 }, { text: "電話番号", x: 300, y: 800 }];
      for (let i = 0; i < 30; i++) {
        lines.push({ text: `霜月灯${i % 10}`, x: 60, y: 780 - i * 12, size: 8 });
        lines.push({ text: `090-0${(1000 + n * 30 + i) % 10000}`.padEnd(13, "7").slice(0, 8) + "-2337", x: 300, y: 780 - i * 12, size: 8 });
      }
      for (let i = 0; i < 28; i++) lines.push({ text: "第3条第2項の規定により、令和7年11月5日までに報告する。", x: 60, y: 400 - i * 12, size: 8 });
      return lines;
    };
    const pdf = await makePdf(Array.from({ length: 100 }, (_, n) => page(n)));
    const started = performance.now();
    const r = await detectPii(pdf);
    const ms = performance.now() - started;
    console.log(`100 ページ：${Math.round(ms)} ms、候補 ${r.counts.total} 件`);
    expect(r.pages).toBe(100);
    expect(r.counts.byType.phone.high).toBe(3000);
    expect(ms).toBeLessThan(30_000);
  }, 60_000);

  it("100 ページ（1ページ 75 行 × 40 字 ＝ 3,000 字の詰まった文）", async () => {
    const sentence = "本市では、令和7年度の計画に基づき、第3条第2項の規定により市民の皆様へお知らせします。";
    const page = (): Line[] => Array.from({ length: 75 }, (_, i) => ({ text: sentence.slice(0, 40), x: 40, y: 810 - i * 10.5, size: 7 }));
    const pdf = await makePdf(Array.from({ length: 100 }, () => page()));
    const started = performance.now();
    const r = await detectPii(pdf);
    const ms = performance.now() - started;
    console.log(`100 ページ（30 万字）：${Math.round(ms)} ms、候補 ${r.counts.total} 件`);
    expect(r.counts.total).toBe(0);
    expect(ms).toBeLessThan(30_000);
  }, 60_000);
});

// 2026-11-06：誤検知 3 種の直し（合成の見本。名前・団体名・住所はすべて架空）
describe("誤検知の直し（2026-11-06）", () => {
  it("a. 会議録の発言の頭を、役職の語のあとの名前として拾わない", () => {
    expect(types("○委員長 次に議案の説明を求めます。")).toEqual([]);
    expect(types("○議長 ただいまから本日の会議を開きます。")).toEqual([]);
    expect(types("委員 質問します。")).toEqual([]);
    expect(types("申請者 次のとおり申請します")).toEqual([]);
    // 名前はこれまでどおり見つける（助詞 1 字は外す。かなの名前は外さない）
    expect(types("委員長 朝霧律子は")).toEqual(["name:朝霧律子:check"]);
    expect(types("会長 宵町 律")).toEqual(["name:宵町 律:check"]);
    expect(types("申請者 宵町まこと")).toEqual(["name:宵町まこと:high"]);
    expect(types("保護者 宵町とも")).toEqual(["name:宵町とも:high"]);
    expect(types("氏名：朝霧 律子（あさぎり りつこ）")).toEqual(["name:朝霧 律子:high"]);
  });

  it("c. 横向きの表（/Rotate と回した中身）の住所を「縦書き」としない", async () => {
    const line = { text: "住所 架空県架空郡架空町大字1856-7", x: 40, y: 500 };
    // 表計算ソフトの横向きの印刷によくある形：縦長の紙に /Rotate 90、中身を 90 度回して描く（画面では横書き）
    for (const [rotate, cm] of [
      [90, "0 1 -1 0 595 0"],
      [270, "0 -1 1 0 0 842"],
    ] as const) {
      const r = await detectPii(await makePdf([[line]], { rotate, cm }));
      expect(r.findings.map((f) => [f.type, f.vertical])).toEqual([["address", false]]);
    }
    // 回していない横書きも、縦書きとしない
    const flat = await detectPii(await makePdf([[line]]));
    expect(flat.findings.map((f) => [f.type, f.vertical])).toEqual([["address", false]]);
    // 本当の縦書き（Identity-V）は、これまでどおり縦書き
    const v = await detectPii(await makePdf([[{ ...line, x: 500, y: 800, vertical: true }]]));
    expect(v.findings.map((f) => [f.type, f.vertical])).toEqual([["address", true]]);
  });
});

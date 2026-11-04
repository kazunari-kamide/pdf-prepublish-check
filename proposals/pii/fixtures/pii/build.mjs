// SPDX-License-Identifier: AGPL-3.0-only
//
// 見える文字の個人情報（rules/pii）の合成 PDF と正解データを作る。
//   node fixtures/pii/build.mjs        （案の段階では node proposals/pii/fixtures/pii/build.mjs）
// 書き出す先は、このスクリプトと同じフォルダ。
// - 名前・住所・番号はすべて架空。地名は「架空県みどり市」のように、実在しない名前にする。
//   電話番号は、実際には割り当てられない形にする（市内局番・携帯の番号の4けた目を 0 で始める）。
//   マイナンバー・カード番号は、検査用の数字だけを合わせた、手で決めた並び。
// - 字のフォントは BIZ UDゴシック（SIL Open Font License 1.1）。P6 の合成 PDF と同じファイル（fixtures/p6/fonts/）を読み、使う字だけを埋め込む。
// - 縦書きは、同じフォントの辞書を写して、CMap を Identity-V にしたもの。
// - 日時も乱数も使わないので、何度作っても同じバイト列になる。
//
// 正解データ（<名前>.expected.json）の形は README.md。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFNumber, PDFOperator, rgb } from "pdf-lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** リポジトリの根元（package.json のあるフォルダ）。案のフォルダからでも、移したあとでも同じフォントを読むため */
function repoRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, "package.json"))) return d;
    if (path.dirname(d) === d) throw new Error("リポジトリの根元が見つからない");
  }
}
const FONT_PATH = path.join(repoRoot(HERE), "fixtures", "p6", "fonts", "BIZUDGothic-Regular.ttf");
const PAGE = [595, 842];
const SIZE = 11;
// 字の箱の上下（BIZ UDゴシックの外枠。1em に対する割合）
const ASC = 0.879;
const DESC = -0.12;

// ---------- フォントの字のデータを 4 バイトの区切りにそろえる ----------
// @pdf-lib/fontkit 1.1.1 は、字を絞ったフォントが小さいとき、位置の表（loca）を「2で割った値」で書くため、
// 奇数バイトの字があると、そのあとの字の形がずれる。埋め込む前に、字ごとのデータの長さを 4 の倍数にしておく（字の形は変えない）。
function alignGlyphs(src) {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const count = dv.getUint16(4);
  const dir = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    dir.push({ tag: String.fromCharCode(...src.subarray(at, at + 4)), offset: dv.getUint32(at + 8), length: dv.getUint32(at + 12) });
  }
  const table = (tag) => dir.find((t) => t.tag === tag);
  const head = table("head");
  const long = dv.getInt16(head.offset + 50) === 1;
  const glyphs = dv.getUint16(table("maxp").offset + 4);
  const loca = table("loca");
  const glyf = table("glyf");
  const at = (i) => (long ? dv.getUint32(loca.offset + i * 4) : dv.getUint16(loca.offset + i * 2) * 2);
  const up4 = (n) => Math.ceil(n / 4) * 4;
  let size = 0;
  for (let i = 0; i < glyphs; i++) size += up4(at(i + 1) - at(i));
  const glyfData = new Uint8Array(size);
  const locaData = new Uint8Array((glyphs + 1) * 4);
  const lv = new DataView(locaData.buffer);
  let pos = 0;
  for (let i = 0; i < glyphs; i++) {
    lv.setUint32(i * 4, pos);
    glyfData.set(src.subarray(glyf.offset + at(i), glyf.offset + at(i + 1)), pos);
    pos += up4(at(i + 1) - at(i));
  }
  lv.setUint32(glyphs * 4, pos);
  const tables = dir
    .filter((t) => t.tag !== "DSIG")
    .map((t) => {
      if (t.tag === "glyf") return { tag: t.tag, data: glyfData };
      if (t.tag === "loca") return { tag: t.tag, data: locaData };
      const data = src.slice(t.offset, t.offset + t.length);
      if (t.tag === "head") {
        const hv = new DataView(data.buffer);
        hv.setUint32(8, 0);
        hv.setInt16(50, 1);
      }
      return { tag: t.tag, data };
    });
  const sum = (bytes) => {
    const p = new Uint8Array(up4(bytes.length));
    p.set(bytes);
    const v = new DataView(p.buffer);
    let s = 0;
    for (let i = 0; i < p.length; i += 4) s = (s + v.getUint32(i)) >>> 0;
    return s;
  };
  const headerLen = 12 + tables.length * 16;
  const out = new Uint8Array(headerLen + tables.reduce((s, t) => s + up4(t.data.length), 0));
  const ov = new DataView(out.buffer);
  ov.setUint32(0, dv.getUint32(0));
  ov.setUint16(4, tables.length);
  const e = Math.floor(Math.log2(tables.length));
  ov.setUint16(6, 2 ** e * 16);
  ov.setUint16(8, e);
  ov.setUint16(10, tables.length * 16 - 2 ** e * 16);
  let off = headerLen;
  let headAt = 0;
  tables.forEach((t, i) => {
    const d = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[d + k] = t.tag.charCodeAt(k);
    ov.setUint32(d + 4, sum(t.data));
    ov.setUint32(d + 8, off);
    ov.setUint32(d + 12, t.data.length);
    out.set(t.data, off);
    if (t.tag === "head") headAt = off;
    off += up4(t.data.length);
  });
  ov.setUint32(headAt + 8, (0xb1b0afba - sum(out)) >>> 0);
  return out;
}

const fontBytes = alignGlyphs(new Uint8Array(readFileSync(FONT_PATH)));
const r2 = (b) => b.map((v) => Math.round(v * 100) / 100);
const countChars = (s) => [...s].filter((c) => c.trim() !== "").length;
const op = (name, ...args) => PDFOperator.of(name, args.map((a) => (typeof a === "number" ? PDFNumber.of(a) : a)));

// ---------- 合成 PDF を1つ作る道具 ----------
class Fixture {
  constructor(name, description) {
    this.name = name;
    this.description = description;
    this.leaks = [];
    this.negatives = [];
    this.vertical = [];
  }
  async init(pages = 1) {
    this.doc = await PDFDocument.create({ updateMetadata: false });
    this.doc.registerFontkit(fontkit);
    this.font = await this.doc.embedFont(fontBytes, { subset: true });
    for (let i = 0; i < pages; i++) this.doc.addPage(PAGE);
    this.pages = this.doc.getPages();
    return this;
  }
  width(s, size = SIZE) {
    return this.font.widthOfTextAtSize(s, size);
  }
  /**
   * 横書きの1行。parts は字の並びか、{ t, leak: [型, 確からしさ] } か、{ t, neg: 種類 }。
   * 全体を1度に描き、印をつけた部分の箱を正解に入れる（前後の空白は箱に入れない）。
   */
  line(page, x, y, parts, size = SIZE) {
    const list = parts.map((p) => (typeof p === "string" ? { t: p } : p));
    const all = list.map((p) => p.t).join("");
    this.pages[page - 1].drawText(all, { x, y, size, font: this.font, color: rgb(0, 0, 0) });
    let pre = "";
    for (const p of list) {
      const x0 = x + this.width(pre, size);
      const lead = p.t.length - p.t.trimStart().length;
      const body = p.t.trim();
      const bx0 = x0 + this.width(p.t.slice(0, lead), size);
      const rect = r2([bx0, y + DESC * size, bx0 + this.width(body, size), y + ASC * size]);
      this.mark(page, p, rect, body);
      pre += p.t;
    }
  }
  /** 縦書きの1列。x は列の中心、y は列の上端。全角の字だけを使う（1字 = 1em で下へ進む） */
  column(page, x, y, parts, size = SIZE) {
    const list = parts.map((p) => (typeof p === "string" ? { t: p } : p));
    const all = list.map((p) => p.t).join("");
    this.vertical.push({ page, ops: [op("BT"), op("Tf", PDFName.of("FV"), size), op("Tm", 1, 0, 0, 1, x, y), op("Tj", this.font.encodeText(all)), op("ET")] });
    let k = 0;
    for (const p of list) {
      const n = [...p.t].length;
      const rect = r2([x - size / 2, y - (k + n) * size, x + size / 2, y - k * size]);
      this.mark(page, p, rect, p.t);
      k += n;
    }
  }
  mark(page, p, rect, body) {
    if (p.leak) {
      const [type, confidence] = p.leak;
      this.leaks.push({ id: `${this.name}#${this.leaks.length + 1}`, type, page, rect, confidence, chars: countChars(body) });
    } else if (p.neg) {
      this.negatives.push({ id: `${this.name}#n${this.negatives.length + 1}`, kind: p.neg, page, rect });
    }
  }
  async save() {
    if (this.vertical.length) {
      // 字を全部集めたあとで、フォントを埋め込み、その辞書を写して縦書き用（Identity-V）にする
      await this.font.embed();
      const ctx = this.doc.context;
      const vdict = ctx.lookup(this.font.ref).clone(ctx);
      vdict.set(PDFName.of("Encoding"), PDFName.of("Identity-V"));
      const vref = ctx.register(vdict);
      for (const v of this.vertical) {
        const page = this.pages[v.page - 1];
        page.node.setFontDictionary(PDFName.of("FV"), vref);
        page.pushOperators(...v.ops);
      }
    }
    const bytes = await this.doc.save({ useObjectStreams: false });
    const expected = {
      file: `${this.name}.pdf`,
      description: this.description,
      pages: this.pages.length,
      leaks: this.leaks,
      negatives: this.negatives,
    };
    writeFileSync(path.join(HERE, `${this.name}.pdf`), bytes);
    writeFileSync(path.join(HERE, `${this.name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
    return { bytes, expected };
  }
}

const L = (t, type, confidence = "high") => ({ t, leak: [type, confidence] });
const NG = (t, kind) => ({ t, neg: kind });

// ---------- 合成 PDF ----------
const builds = [];
const def = (name, description, pages, f) => builds.push({ name, description, pages, f });

def("pii-01-name-label", "前の語（氏名・フリガナ・申請者）のあとの氏名。担当の課・役職名・見出しだけの行は対照", 1, (x) => {
  x.line(1, 60, 760, ["申請書"]);
  x.line(1, 60, 720, ["氏名：", L("朝霧 澄香", "name")]);
  x.line(1, 60, 696, ["フリガナ：", L("アサギリ スミカ", "name")]);
  x.line(1, 60, 672, ["申請者 ", L("波戸崎葵", "name")]);
  x.line(1, 60, 648, ["会長 ", L("宵町 律", "name", "check")]);
  x.line(1, 60, 600, ["担当：", NG("総務課", "organization")]);
  x.line(1, 60, 576, [NG("議長", "role")]);
  x.line(1, 60, 552, ["作成者：", NG("企画政策部", "organization")]);
  x.line(1, 60, 528, ["氏名 ", NG("住所", "heading"), " 電話番号"]);
  // 伏せたことを示す語（P6 の合成 PDF にかけて見つかった誤検知の型。2026-11-04）
  x.line(1, 60, 504, ["氏名：", NG("非公開", "placeholder")]);
  x.line(1, 60, 480, ["代表者 ", NG("記載省略", "placeholder")]);
});

def("pii-02-honorific", "「様」「殿」「さん」の前の氏名（確認）。各位・利用者様・役職の様は対照", 1, (x) => {
  x.line(1, 60, 760, [L("波戸崎 葵", "name", "check"), " 様"]);
  x.line(1, 60, 736, ["拝啓 ", L("宵町律", "name", "check"), "殿"]);
  x.line(1, 60, 712, ["当日は", L("霜月", "name", "check"), "さんが案内します。"]);
  x.line(1, 60, 664, [NG("関係者各位", "honorific_group")]);
  x.line(1, 60, 640, [NG("利用者様", "honorific_group"), "へのお知らせ"]);
  x.line(1, 60, 616, [NG("市長様", "role")]);
  x.line(1, 60, 592, [NG("同氏", "honorific_group"), "の発言によれば"]);
  x.line(1, 60, 568, [NG("お客様", "honorific_group"), "窓口"]);
});

def("pii-03-table", "表：見出し（氏名・住所・電話番号・生年月日）の下の欄。見出しの行と記入例の行は対照", 1, (x) => {
  const cols = [60, 150, 380, 490];
  const row = (y, cells) => cells.forEach((c, i) => x.line(1, cols[i], y, [c], 9));
  row(760, [NG("氏名", "heading"), NG("住所", "heading"), NG("電話番号", "heading"), NG("生年月日", "heading")]);
  row(740, [L("朝霧 澄香", "name"), L("架空県みどり市あおば町1丁目2番3号", "address"), L("090-0481-2337", "phone"), L("平成3年4月18日", "birth_date")]);
  row(720, [L("宵町 律", "name"), L("架空県みどり市ひかり台4-7-2", "address"), L("080-0627-3915", "phone"), L("昭和62年5月3日", "birth_date")]);
  row(700, [L("波戸崎 葵", "name"), L("架空県そらの町うみべ12番地5", "address"), L("0255-07-3146", "phone"), L("2001年10月9日", "birth_date")]);
  row(680, [NG("記入例 山田太郎", "sample"), NG("〇〇県〇〇市〇〇町1-2-3", "sample"), NG("000-0000-0000", "sample"), NG("令和元年1月1日", "sample")]);
});

def("pii-04-vertical", "縦書き：氏名・住所（漢数字）・電話（漢数字）。日付・条文の番号・役職の列は対照", 1, (x) => {
  x.column(1, 520, 780, ["氏名　", L("宵町　律", "name")]);
  x.column(1, 496, 780, ["住所　", L("架空県みどり市あおば町三丁目十二番五号", "address")]);
  x.column(1, 472, 780, ["電話　", L("〇九〇―〇四八一―二三三七", "phone")]);
  x.column(1, 448, 780, ["作成日　", NG("令和七年十一月五日", "date")]);
  x.column(1, 424, 780, [NG("第十二条第三項第四号", "article_number"), "による"]);
  x.column(1, 400, 780, [NG("委員長", "role"), "あいさつ"]);
});

def("pii-05-phone", "電話番号：携帯・自宅（全角の数字も）。団体の代表電話・FAX・フリーダイヤル・日付・時刻は対照", 1, (x) => {
  x.line(1, 60, 760, ["携帯：", L("０９０－０２７４－１８８３", "phone")]);
  x.line(1, 60, 736, ["自宅電話 ", L("0467-08-2093", "phone")]);
  x.line(1, 60, 712, ["緊急連絡先 ", L("(0123)08-4719", "phone")]);
  x.line(1, 60, 664, ["代表電話 ", NG("0123-08-7710", "office_phone")]);
  x.line(1, 60, 640, ["FAX ", NG("0123-08-7711", "office_phone")]);
  x.line(1, 60, 616, ["お問い合わせ 総務課 ", NG("0123-08-7712", "office_phone")]);
  x.line(1, 60, 592, ["フリーダイヤル ", NG("0120-08-3412", "free_dial")]);
  x.line(1, 60, 568, ["作成日 ", NG("2026-11-05", "date")]);
  x.line(1, 60, 544, ["受付時間 ", NG("09:00-17:00", "time")]);
  x.line(1, 60, 520, ["郵便番号 ", NG("〒000-0000", "sample")]);
});

def("pii-06-my-number", "マイナンバー：検査用の数字の合う 12 けた。法人番号・合わない 12 けた・日時の並び・見本は対照", 1, (x) => {
  x.line(1, 60, 760, ["個人番号：", L("4829 1037 5622", "my_number")]);
  x.line(1, 60, 736, ["番号 ", L("6194-0728-3511", "my_number", "check")]);
  x.line(1, 60, 688, ["法人番号 ", NG("9702918364055", "corporate_number")]);
  x.line(1, 60, 664, ["受付番号 ", NG("730581642091", "invalid_check_digit")]);
  x.line(1, 60, 640, ["処理日時 ", NG("202611051303", "date")]);
  x.line(1, 60, 616, ["個人番号（記入例） ", NG("1234 5678 9018", "sample")]);
});

def("pii-07-bank-account", "口座番号：「口座番号」「普通」のあとの 7 けた、ゆうちょの記号・番号。文書番号・会員番号は対照", 1, (x) => {
  x.line(1, 60, 760, ["振込口座 みどり銀行 本店 普通預金 口座番号 ", L("3820417", "bank_account", "check")]);
  x.line(1, 60, 736, ["本人の口座 普通 ", L("5091736", "bank_account")]);
  x.line(1, 60, 712, ["ゆうちょ銀行 記号 ", L("10480 番号 27319485", "bank_account")]);
  x.line(1, 60, 664, ["文書番号 ", NG("第4810273号", "document_number")]);
  x.line(1, 60, 640, ["会員番号 ", NG("2093817", "member_number")]);
});

def("pii-08-birth-date", "生年月日：前の語・「生まれ」「生」のつく日付（和暦・漢数字も）。作成日・施行日・会議の日時は対照", 1, (x) => {
  x.line(1, 60, 760, ["生年月日：", L("平成3年4月18日", "birth_date")]);
  x.line(1, 60, 736, [L("昭和六十二年五月三日", "birth_date"), "生"]);
  x.line(1, 60, 712, [L("1990年7月2日", "birth_date"), "生まれ"]);
  x.line(1, 60, 688, ["誕生日 ", L("H5.11.23", "birth_date")]);
  x.line(1, 60, 640, ["作成日：", NG("令和7年11月5日", "date")]);
  x.line(1, 60, 616, ["施行日 ", NG("2026年4月1日", "date")]);
  x.line(1, 60, 592, ["会議の日時 ", NG("令和7年11月12日", "date"), " 午後2時"]);
  x.line(1, 60, 568, ["平成", NG("31年4月30日", "date"), "まで有効"]);
});

def("pii-09-email", "メールアドレス：個人らしいもの。団体の窓口・見本のアドレスは対照", 1, (x) => {
  x.line(1, 60, 760, ["連絡先 ", L("asagiri.sumika@mail.kakuu.test", "email", "check")]);
  x.line(1, 60, 736, ["個人のメール ", L("ritsu-yoimachi@kakuu.test", "email")]);
  x.line(1, 60, 688, ["お問い合わせ ", NG("info@kakuu.test", "office_email")]);
  x.line(1, 60, 664, ["総務課 ", NG("soumu-ka@kakuu.test", "office_email")]);
  x.line(1, 60, 640, ["例：", NG("sample@example.com", "sample")]);
  // 例示用のドメイン（example.jp など）でも、記入例の印がなければ漏れとして数える（架空の資料は例示用のドメインで作るため。2026-11-05）
  x.line(1, 60, 616, ["Mail: ", L("hinata.kasumi@example.jp", "email", "check")]);
  x.line(1, 60, 592, ["記入例 ", NG("kogure.minato@example.jp", "sample")]);
});

def("pii-10-address", "住所：前の語つき（高）と、文の中の住所（確認）。団体の所在地・会場・条文・見本・番地だけは対照", 1, (x) => {
  x.line(1, 60, 760, ["住所：", L("架空県みどり市あおば町1丁目2番3号", "address")]);
  x.line(1, 60, 736, ["送付先 ", L("架空県そらの町うみべ12番地5", "address")]);
  x.line(1, 60, 712, ["当時は", L("みどり市ひかり台4丁目7番", "address", "check"), "に住んでいた。"]);
  x.line(1, 60, 664, ["所在地：", NG("架空県みどり市中央1-1-1", "office_address")]);
  x.line(1, 60, 640, ["会場 ", NG("みどり市民ホール（みどり市中央2-3-4）", "office_address")]);
  x.line(1, 60, 616, ["規則", NG("第12条第3項第4号", "article_number"), "による"]);
  x.line(1, 60, 592, ["住所：", NG("〇〇県〇〇市〇〇町1-2-3", "sample")]);
  x.line(1, 60, 568, [NG("3丁目", "partial_address"), "の交差点"]);
});

def("pii-11-sample-form", "様式の記入例：見本の名前・番号だけ（全部が対照）", 1, (x) => {
  x.line(1, 60, 780, ["【記入例】"]);
  x.line(1, 60, 750, ["氏名 ", NG("山田 太郎", "sample")]);
  x.line(1, 60, 726, ["住所 ", NG("〇〇県〇〇市〇〇町1-2-3", "sample")]);
  x.line(1, 60, 702, ["電話 ", NG("000-0000-0000", "sample")]);
  x.line(1, 60, 678, ["生年月日 ", NG("令和元年1月1日", "sample"), "（記入例）"]);
  x.line(1, 60, 654, ["メール ", NG("taro@example.com", "sample")]);
  x.line(1, 60, 630, ["氏名 ", NG("〇〇 〇〇", "sample")]);
});

def("pii-12-plain-document", "ふつうの文書（個人情報なし）：見出し・条文・日付・金額・ページ番号（全部が対照）", 1, (x) => {
  x.line(1, 60, 780, [NG("令和7年度 事業計画", "heading")]);
  x.line(1, 60, 756, ["第1条 この規則は、", NG("令和7年4月1日", "date"), "から施行する。"]);
  x.line(1, 60, 732, ["予算額 ", NG("1,234,560円", "amount"), "（前年度比 ", NG("103.5%", "amount"), "）"]);
  x.line(1, 60, 708, ["第2条第1項第3号の規定により、市町村は報告する。"]);
  x.line(1, 60, 684, ["対象：", NG("市内在住の方", "heading"), "（", NG("18歳以上", "amount"), "）"]);
  x.line(1, 60, 660, ["申込期間 ", NG("2026/11/05", "date"), "〜", NG("2026/12/04", "date")]);
  x.line(1, 60, 636, ["担当 ", NG("企画課", "organization"), " 内線 ", NG("2381", "extension")]);
  x.line(1, 280, 40, [NG("- 3 -", "page_number")]);
});

def("pii-13-card-number", "カード番号：4 けたずつの 16 けた（Luhn と番号の頭が合うもの）。日時の並び・見本の番号は対照", 1, (x) => {
  x.line(1, 60, 760, ["カード番号 ", L("4980 0213 7765 4324", "card_number")]);
  x.line(1, 60, 736, ["お支払い ", L("5358-1046-2987-1036", "card_number", "check")]);
  x.line(1, 60, 688, ["記録 ", NG("2026 1105 1230 0001", "date")]);
  x.line(1, 60, 664, ["テスト用 ", NG("4111 1111 1111 1111", "sample")]);
});

def("pii-14-dates-and-numbers", "日付などの数字の並び（F03）：カード番号・電話番号・マイナンバーと誤らないこと（全部が対照）", 1, (x) => {
  x.line(1, 60, 760, ["作成日 ", NG("20261105", "date")]);
  x.line(1, 60, 736, ["更新 ", NG("2026/11/05 13:30", "date")]);
  x.line(1, 60, 712, ["記録番号 ", NG("202611051303", "date")]);
  x.line(1, 60, 688, ["版 ", NG("R7.11.5", "date")]);
  x.line(1, 60, 664, ["期間 ", NG("2026-11-05〜2026-12-04", "date")]);
  x.line(1, 60, 640, ["件数 ", NG("012345", "count")]);
  x.line(1, 60, 616, ["図番 ", NG("03-1105-2026", "drawing_number")]);
});

def("pii-15-two-pages", "2ページ目にだけ氏名と携帯電話。1ページ目は個人情報なし", 2, (x) => {
  x.line(1, 60, 760, [NG("報告書", "heading")]);
  x.line(1, 60, 736, ["第3条第2項により報告する。"]);
  x.line(2, 60, 760, ["氏名：", L("霜月 灯", "name")]);
  x.line(2, 60, 736, ["携帯 ", L("070-0318-6624", "phone")]);
});

def("pii-16-label-cell", "表：左の欄に見出し、右の欄（大きくあけた所）に値。見出しだけの行は対照", 1, (x) => {
  const cell = (y, label, value) => {
    x.line(1, 60, y, [label]);
    x.line(1, 200, y, [value]);
  };
  cell(760, "氏　名", L("朝霧 澄香", "name"));
  cell(736, "住　所", L("架空県みどり市あおば町1丁目2番3号", "address"));
  cell(712, "電話番号", L("080-0627-3915", "phone"));
  cell(688, "生年月日", L("平成3年4月18日", "birth_date"));
  cell(664, "備考", NG("特になし", "heading"));
});

// ---------- 作る ----------
for (const f of readdirSync(HERE)) if (/^pii-.*\.(pdf|expected\.json)$/.test(f)) unlinkSync(path.join(HERE, f));
const hashes = [];
const index = [
  "# 見える文字の個人情報（rules/pii）の合成 PDF",
  "",
  "`build.mjs` が書く一覧。名前・住所・番号はすべて架空。字のフォントは BIZ UDゴシック（`fixtures/p6/fonts/OFL.txt`）。",
  "",
  "| ファイル | 内容 | 漏れ | 対照 |",
  "|---|---|---|---|",
];
for (const b of builds) {
  const x = await new Fixture(b.name, b.description).init(b.pages);
  b.f(x);
  const { bytes, expected } = await x.save();
  hashes.push(`${createHash("sha256").update(bytes).digest("hex")}  ${b.name}.pdf`);
  index.push(`| ${b.name}.pdf | ${b.description} | ${expected.leaks.length} | ${expected.negatives.length} |`);
}
writeFileSync(path.join(HERE, "hashes.txt"), hashes.join("\n") + "\n");
writeFileSync(path.join(HERE, "index.md"), index.join("\n") + "\n");
console.log(`${builds.length} 個の合成 PDF を作った（${HERE}）`);

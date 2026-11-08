// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査のページの「気づきにくい見本」（2 つ目の見本）を作る。中身はすべて架空（手順と中身は demo/subtle-sample/README.md）。
//
//   node demo/subtle-sample/build.mjs
//
// 期間中に足した 3 つの型と、見た目では分からないもの 2 つを、1 つの架空の書類（4 ページ）に入れる。
// - 1 ページ目（スキャン）：通知書。宛先を黒く塗ったが、すぐ上の郵便のバーコードのような記号は塗られずに残る（barcode-scan）
// - 2・3 ページ目（スキャン）：同じ書式の申請書 2 枚。2 ページ目は氏名と電話番号を塗ったが、3 ページ目は電話番号だけを塗り、氏名を塗り忘れた（cross-page-redaction）
// - 4 ページ目（字の層のある会議録）：候補地の地名を黒い四角で塗ったが、下に字が残り、同じ地名が下の段落に塗られずに出る（p6-text と redacted-text-elsewhere）
// - 文書情報の作成者に人の名前が入っている（p1-info）。前の版の文書情報（題が「下書き」のもの）がファイルの中に残っている（p5-revisions）
//
// スキャンのページは、@napi-rs/canvas で字を画素に描き、灰色・Flate の画像にする（外の道具・通信は使わない）。
// 書体は、リポジトリの design/fonts/source/ の Noto Sans JP（SIL Open Font License 1.1）。端末の書体に頼らない。
// fixtures/ には入れない（採点に使う場所のため）。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, rgb } from "pdf-lib";
import subsetFont from "subset-font";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");
const FONT = path.join(ROOT, "design", "fonts", "source", "NotoSansJP[wght].ttf");

export const OUT = "subtle-sample.pdf";
/** A4（pt）。スキャンは 1pt あたり 2 点（144dpi） */
export const PAGE = { width: 595, height: 842 };
const PX = 2;

/**
 * 架空の字（画面やテストで使う）。実在の団体・人・住所ではない（実在しないことは、すべての市区町村・町名・人名と照らしてはいない）。
 * 画面に頭の 2 字が出る値（作成者・4 ページ目の地名）は、最初の画面で読み終えている書体の字だけにする。
 * 読んでいない切れ端の字だと、PDF を入れたあとに同じサイトへ書体を取りに行き、確かめ（npm run check:browser）の「0 件」に反するため
 */
export const FICTION = {
  city: "白樺野市",
  author: "花田 春子",
  /** 4 ページ目で塗った地名（同じ字が、下の段落にも塗られずに出る） */
  place: "空見台二丁目の市有地",
  /** 3 ページ目で塗り忘れた氏名 */
  name3: "星野 葵",
};

/** 黒く塗った所（pt・上が 0）。テストで位置を確かめる */
export const BOXES = {
  p1Address: { x: 56, y: 136, w: 250, h: 50 },
  // 2 ページ目は氏名と電話番号を塗り、3 ページ目は電話番号だけを塗った（氏名を塗り忘れた）。
  // 住所は、どちらのページも塗っていない（cross-page-redaction は、相手のページで 50pt の中に黒い四角があるか、同じ大きさの黒い四角があると当たりにしないため、塗る欄を離し、電話番号の四角を短くした）
  p2: [
    { x: 166, y: 236, w: 300, h: 26 }, // 氏名
    { x: 166, y: 316, w: 124, h: 26 }, // 電話番号
  ],
  p3: [
    { x: 166, y: 316, w: 124, h: 26 }, // 電話番号（氏名は塗り忘れ）
  ],
};

GlobalFonts.registerFromPath(FONT, "NotoJP");

/** 1 ページのスキャンを描く。draw は pt の座標で描く。返すのは灰色の画素 */
function scan(draw) {
  const W = PAGE.width * PX;
  const H = PAGE.height * PX;
  const c = createCanvas(W, H);
  const x = c.getContext("2d");
  x.fillStyle = "rgb(244,242,236)";
  x.fillRect(0, 0, W, H);
  x.scale(PX, PX);
  x.fillStyle = "rgb(40,40,40)";
  x.strokeStyle = "rgb(40,40,40)";
  x.textBaseline = "alphabetic";
  const t = (s, px, py, size = 10.5, weight = 400) => {
    x.font = `${weight} ${size}px NotoJP`;
    x.fillText(s, px, py);
  };
  const line = (x0, y0, x1, y1, w = 0.8) => {
    x.lineWidth = w;
    x.beginPath();
    x.moveTo(x0, y0);
    x.lineTo(x1, y1);
    x.stroke();
  };
  const box = (b) => {
    x.fillStyle = "rgb(18,18,18)";
    x.fillRect(b.x, b.y, b.w, b.h);
    x.fillStyle = "rgb(40,40,40)";
  };
  draw({ t, line, box, x });
  const rgba = x.getImageData(0, 0, W, H).data;
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
  return gray;
}

/** 架空の 4 種の高さの記号（意味のある値を表していない）。高さ 10pt の長い線・上の 7pt・下の 7pt・中の 3.5pt */
function bars(x, n, cx, cy) {
  for (let i = 0; i < n; i++) {
    const k = (i * 7 + (i >> 2)) % 4;
    const [top, h] = [[-5, 10], [-5, 7], [-2, 7], [-1.75, 3.5]][k];
    x.fillRect(cx + i * 3.5, cy + top, 1.5, h);
  }
}

const NOTICE = () =>
  scan(({ t, line, box, x }) => {
    t(`${FICTION.city} 福祉課`, 56, 60, 11, 500);
    t("令和8年10月1日", 450, 60);
    bars(x, 60, 58, 124);
    // 宛先（あとで黒く塗る。下の画素は塗りつぶされて残らない）
    t("〒000-0000", 60, 152);
    t(`${FICTION.city}空見台二丁目4番地の1`, 60, 167);
    t(`${FICTION.author} 様`, 60, 181, 11);
    box(BOXES.p1Address);
    t("審査結果のお知らせ", 220, 260, 16, 700);
    const body = [
      "先日お申し込みいただいた生活支援資金の貸付について、審査の結果をお知らせします。",
      "審査会での審議の結果、次のとおり貸し付けることに決まりました。",
      "貸付の手続きは、同封の書類をご確認のうえ、11月14日までに福祉課の窓口でお済ませください。",
    ];
    body.forEach((s, i) => t(s, 56, 300 + i * 20));
    line(56, 370, 540, 370);
    [["貸付の金額", "300,000円"], ["返済の方法", "12回の分割（毎月の末日）"], ["担当", "福祉課 生活支援係"]].forEach(([a, b], i) => {
      t(a, 66, 392 + i * 24);
      t(b, 186, 392 + i * 24);
      line(56, 400 + i * 24, 540, 400 + i * 24, 0.5);
    });
    t("この通知は架空の見本です。実在の市・人・住所ではありません。", 56, 800, 8);
  });

/** 同じ書式の申請書。values は欄の中身、boxes は黒く塗る所 */
const FORM = (values, boxes) =>
  scan(({ t, line, box }) => {
    t("生活支援資金 貸付申請書", 200, 80, 16, 700);
    t(`${FICTION.city}長 様`, 56, 130);
    t("次のとおり、生活支援資金の貸付を申し込みます。", 56, 160);
    line(56, 190, 540, 190);
    const labels = ["申請日", "氏名", "住所", "電話番号", "申請の理由"];
    labels.forEach((l, i) => {
      const y = 190 + i * 40;
      t(l, 100, y + 28);
      t(values[i], 172, y + 28);
      line(56, y + 40, 540, y + 40);
    });
    line(56, 190, 56, 390);
    line(160, 190, 160, 390);
    line(540, 190, 540, 390);
    const notes = [
      "注意：記入した内容は、貸付の審査のためにだけ使います。",
      "　　　審査の結果は、申請した日から1か月ほどで、郵便でお知らせします。",
      "　　　書類に誤りがあったときは、福祉課の窓口までお知らせください。",
    ];
    notes.forEach((s, i) => t(s, 56, 430 + i * 20, 9.5));
    for (const b of boxes) box(b);
    t("この申請書は架空の見本です。実在の市・人・住所ではありません。", 56, 800, 8);
  });

/** 灰色の画素を、ページ全面の画像にして足す */
function addScan(doc, gray) {
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const img = doc.context.flateStream(gray, { Type: "XObject", Subtype: "Image", Width: PAGE.width * PX, Height: PAGE.height * PX, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
  page.node.setXObject(PDFName.of("Im0"), doc.context.register(img));
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(`q ${PAGE.width} 0 0 ${PAGE.height} 0 0 cm /Im0 Do Q`)));
}

/** 4 ページ目：字の層のある会議録の抜粋。地名の上に黒い四角を重ねただけ（下に字が残る）。同じ地名が下の段落に出る */
const MINUTES_LINES = [
  "第4回 用地検討会 会議録（抜粋）",
  "1 候補地の選定について",
  "事務局から、新しい集会所の候補地として、",
  FICTION.place,
  "を説明した。",
  "委員から、広さと道の幅について質問があり、事務局が答えた。",
  "2 現地調査の報告",
  `委員2名が${FICTION.place}を見て、道の幅は足りていると報告した。`,
  "3 次の予定",
  "次の検討会で、候補地を1つに決める。",
  "この会議録は架空の見本です。実在の市・人・場所ではありません。",
];

async function addMinutes(doc) {
  // pdf-lib（fontkit）の切り出しは、可変の書体（Noto Sans JP の wght）を正しく扱えず、字が欠けて描かれた。
  // 先に subset-font（harfbuzz）で、使う字だけ・太さ 400 の固定の TrueType にしてから、切り出さずに埋め込む
  const ttf = await subsetFont(readFileSync(FONT), [...new Set(MINUTES_LINES.join(""))].join(""), { targetFormat: "truetype", variationAxes: { wght: 400 } });
  const font = await doc.embedFont(ttf, { subset: false });
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const top = (y) => PAGE.height - y;
  const have = new Set(MINUTES_LINES.join(""));
  const t = (s, x, y, size = 10.5) => {
    // 書体に入れた字（MINUTES_LINES）の外の字は、描くと欠ける。足し忘れを止める
    for (const ch of s) if (!have.has(ch)) throw new Error(`MINUTES_LINES に無い字：${ch}`);
    page.drawText(s, { x, y: top(y), size, font, color: rgb(0.1, 0.1, 0.1) });
  };
  t("第4回 用地検討会 会議録（抜粋）", 170, 70, 15);
  t("1 候補地の選定について", 56, 120, 12);
  const lead = "事務局から、新しい集会所の候補地として、";
  t(lead, 56, 150);
  const leadW = font.widthOfTextAtSize(lead, 10.5);
  t(FICTION.place, 56 + leadW, 150);
  const placeW = font.widthOfTextAtSize(FICTION.place, 10.5);
  t("を説明した。", 56 + leadW + placeW, 150);
  t("委員から、広さと道の幅について質問があり、事務局が答えた。", 56, 172);
  t("2 現地調査の報告", 56, 220, 12);
  t(`委員2名が${FICTION.place}を見て、道の幅は足りていると報告した。`, 56, 250);
  t("3 次の予定", 56, 300, 12);
  t("次の検討会で、候補地を1つに決める。", 56, 330);
  t("この会議録は架空の見本です。実在の市・人・場所ではありません。", 56, 800, 8);
  // 地名の上に黒い四角を重ねる（字のあと）
  page.drawRectangle({ x: 56 + leadW - 2, y: top(150) - 3.5, width: placeW + 4, height: 15, color: rgb(0, 0, 0) });
  return { leadW, placeW };
}

/** 前の版の文書情報を残すため、文書情報だけを書き直した版を、ファイルの末尾に足す（増分の更新） */
function appendInfoRevision(bytes, infoRef, rootRef, size, info) {
  const text = Buffer.from(bytes).toString("latin1");
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)[1]);
  const hex = (s) => `<FEFF${Buffer.from(s, "utf16le").swap16().toString("hex").toUpperCase()}>`;
  const body = `<< ${Object.entries(info).map(([k, v]) => `/${k} ${hex(v)}`).join(" ")} >>`;
  const obj = `${infoRef.objectNumber} 0 obj\n${body}\nendobj\n`;
  const start = bytes.length + 1;
  const objBuf = Buffer.from(`\n${obj}`, "latin1");
  const xrefAt = bytes.length + objBuf.length;
  const xref = `xref\n${infoRef.objectNumber} 1\n${String(start).padStart(10, "0")} 00000 n \ntrailer\n<< /Size ${size} /Root ${rootRef} /Info ${infoRef.objectNumber} 0 R /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.concat([Buffer.from(bytes), objBuf, Buffer.from(xref, "latin1")]));
}

export async function build() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  addScan(doc, NOTICE());
  addScan(doc, FORM(["令和8年9月2日", FICTION.author, `${FICTION.city}空見台二丁目4番地の1`, "000-0000-0000", "収入が減ったため"], BOXES.p2));
  addScan(doc, FORM(["令和8年9月5日", FICTION.name3, `${FICTION.city}月影町3番地`, "000-0000-0001", "医療費がかさんだため"], BOXES.p3));
  await addMinutes(doc);
  // 1 つ目の版：題が「下書き」。作成者に人の名前
  doc.setTitle("審査会資料（下書き・花田さん確認用）");
  doc.setAuthor(FICTION.author);
  const v1 = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  const infoRef = doc.context.trailerInfo.Info;
  const rootRef = doc.context.trailerInfo.Root;
  // 2 つ目の版：題だけを直す（作成者はそのまま）。前の版の題はファイルの中に残る
  return appendInfoRevision(v1, infoRef, `${rootRef.objectNumber} 0 R`, doc.context.largestObjectNumber + 1, { Title: "審査会資料", Author: FICTION.author });
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("build.mjs")) {
  const bytes = await build();
  writeFileSync(path.join(HERE, OUT), bytes);
  console.log(OUT, bytes.length, "bytes");
}

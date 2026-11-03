// SPDX-License-Identifier: AGPL-3.0-only
//
// P5（旧版の残存）の合成 PDF と正解データを作る。
//   node fixtures/p5/build.mjs
// オブジェクトの番号を決めて正解に書くため、PDF は pdf-lib を使わず、ここで手で書く（小さな書き手）。
// 増分更新は、元のバイト列のあとに、変えたオブジェクトと新しい xref と trailer を書き足す。
// 名前・団体はすべて架空（山田太郎、○○市、○○課 など）。日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- 小さな書き手 ----------

/** PDF の文字列：UTF-16BE（BOM つき）の 16 進 */
const u16 = (s) => {
  const out = [0xfe, 0xff];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c > 0xffff) {
      const v = c - 0x10000;
      out.push(0xd8 | (v >> 18), (v >> 10) & 0xff, 0xdc | ((v >> 8) & 3), v & 0xff);
    } else out.push(c >> 8, c & 0xff);
  }
  return `<${Buffer.from(out).toString("hex").toUpperCase()}>`;
};
const lit = (s) => `(${s.replace(/[\\()]/g, (m) => "\\" + m)})`;

/** ストリームのオブジェクト（中身は Flate で圧縮する） */
const stream = (dict, data) => ({ dict, data: deflateSync(Buffer.from(data, "latin1"), { level: 9 }) });

function objBytes(num, gen, body) {
  if (typeof body === "string") return Buffer.from(`${num} ${gen} obj\n${body}\nendobj\n`, "latin1");
  const dict = body.dict.replace(/>>\s*$/, ` /Length ${body.data.length}${body.filtered === false ? "" : body.dict.includes("/Filter") ? "" : " /Filter /FlateDecode"} >>`);
  return Buffer.concat([Buffer.from(`${num} ${gen} obj\n${dict}\nstream\n`, "latin1"), body.data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
}

/**
 * 1つの版を書く。base（前の版のバイト列）があれば、そのあとに書き足す（増分更新）。
 * objects：{ 番号: 中身 }。free：「使っていない」と印をつける番号。trailer：Root・Info などの文字列。
 * xrefStream：xref をストリームで書く（番号 xrefNum）。objstm：{ num, members: [番号…] } のとき、その番号をオブジェクトストリームに入れる
 */
function writeRevision({ base = null, objects, free = [], size, trailer, xrefStream = false, xrefNum, objstm = null }) {
  const parts = [];
  let at = 0;
  if (base) {
    parts.push(Buffer.from(base));
    at = base.length;
    parts.push(Buffer.from("\n", "latin1"));
    at += 1;
  } else {
    const head = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1");
    parts.push(head);
    at = head.length;
  }
  const entries = new Map(); // 番号 → { type, a, b }
  const inStm = new Set(objstm?.members ?? []);
  for (const [k, body] of Object.entries(objects)) {
    const num = Number(k);
    if (inStm.has(num)) continue;
    const b = objBytes(num, 0, body);
    entries.set(num, { type: 1, a: at, b: 0 });
    parts.push(b);
    at += b.length;
  }
  if (objstm) {
    let header = "";
    let bodyText = "";
    objstm.members.forEach((n) => {
      header += `${n} ${Buffer.byteLength(bodyText, "latin1")} `;
      bodyText += objects[n] + "\n";
    });
    const first = Buffer.byteLength(header + "\n", "latin1");
    const b = objBytes(objstm.num, 0, stream(`<< /Type /ObjStm /N ${objstm.members.length} /First ${first} >>`, header + "\n" + bodyText));
    entries.set(objstm.num, { type: 1, a: at, b: 0 });
    parts.push(b);
    at += b.length;
    objstm.members.forEach((n, i) => entries.set(n, { type: 2, a: objstm.num, b: i }));
  }
  for (const n of free) entries.set(n, { type: 0, a: 0, b: 1 });
  const prev = base ? lastStartXref(base) : null;
  const xrefAt = at;
  if (!xrefStream) {
    const nums = [...entries.keys()].sort((x, y) => x - y);
    let x = "xref\n";
    if (!base) x += "0 1\n0000000000 65535 f \n";
    for (const n of nums) {
      const e = entries.get(n);
      x += `${n} 1\n${String(e.type === 1 ? e.a : 0).padStart(10, "0")} ${String(e.type === 0 ? 1 : 0).padStart(5, "0")} ${e.type === 0 ? "f" : "n"} \n`;
    }
    x += `trailer\n<< /Size ${size} ${trailer}${prev !== null ? ` /Prev ${prev}` : ""} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    parts.push(Buffer.from(x, "latin1"));
  } else {
    entries.set(xrefNum, { type: 1, a: xrefAt, b: 0 });
    const nums = [...entries.keys()].sort((x, y) => x - y);
    if (!base) nums.unshift(0);
    const rows = [];
    const index = [];
    for (const n of nums) {
      const e = n === 0 && !entries.has(0) ? { type: 0, a: 0, b: 65535 } : entries.get(n);
      rows.push(e.type, (e.a >>> 24) & 0xff, (e.a >>> 16) & 0xff, (e.a >>> 8) & 0xff, e.a & 0xff, (e.b >> 8) & 0xff, e.b & 0xff);
      index.push(n, 1);
    }
    const data = Buffer.from(rows);
    const dict = `<< /Type /XRef /Size ${size} /W [1 4 2] /Index [${index.join(" ")}] ${trailer}${prev !== null ? ` /Prev ${prev}` : ""} /Length ${data.length} >>`;
    parts.push(Buffer.from(`${xrefNum} 0 obj\n${dict}\nstream\n`, "latin1"), data, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, "latin1"));
  }
  return new Uint8Array(Buffer.concat(parts));
}

function lastStartXref(bytes) {
  const s = Buffer.from(bytes).toString("latin1");
  return Number(/startxref\s+(\d+)/.exec(s.slice(s.lastIndexOf("startxref")))[1]);
}

// ---------- 部品 ----------

const content = (text, x = 40, y = 250) => stream("<< >>", `BT /F1 12 Tf ${x} ${y} Td ${lit(text)} Tj ET\n`);
const CATALOG = (extra = "") => `<< /Type /Catalog /Pages 2 0 R${extra} >>`;
const PAGES = (kids = "3 0 R", n = 1) => `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
const PAGE = (contents = "4 0 R", extra = "") =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /Font << /F1 5 0 R >> >> /Contents ${contents}${extra} >>`;
const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
const INFO = (fields) => `<< ${Object.entries(fields).map(([k, v]) => `/${k} ${v}`).join(" ")} >>`;
const PRODUCER = lit("Example PDF Library 1.0");
const XMP = (who) =>
  stream("<< /Type /Metadata /Subtype /XML >>", `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${who}</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`);
const IMAGE = (g) => stream("<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 >>", String.fromCharCode(g, g, g, g));
const annotText = (contents, author) => `<< /Type /Annot /Subtype /Text /Rect [40 40 60 60] /Contents ${u16(contents)} /T ${u16(author)} >>`;
const annotLink = () => `<< /Type /Annot /Subtype /Link /Rect [80 40 160 60] /A << /S /URI /URI (https://example.com/) >> >>`;
const field = (name, value) => `<< /FT /Tx /T ${lit(name)} /V ${u16(value)} >>`;
const embedded = (text) => stream("<< /Type /EmbeddedFile /Subtype /text#2Fcsv >>", text);
const filespec = (name, ef) => `<< /Type /Filespec /F ${lit("list.csv")} /UF ${u16(name)} /EF << /F ${ef} 0 R >> >>`;

/** 1ページの基本の形（1〜5、6 は文書情報） */
const basic = (over = {}) => ({ 1: CATALOG(), 2: PAGES(), 3: PAGE(), 4: content("Base document"), 5: FONT, ...over });

// ---------- 合成 PDF の一覧 ----------
// leaks：[番号, 種類, 場所]。negatives：[番号, 種類, 場所]（残っているが漏れでないもの）

const CASES = [
  {
    name: "p5-01-info-overwritten",
    description: "増分更新で、文書情報（同じ番号）の作成者を個人名から課の名前に書き直した",
    make() {
      const v1 = writeRevision({ objects: basic({ 6: INFO({ Author: u16("山田太郎"), Producer: PRODUCER }) }), size: 7, trailer: "/Root 1 0 R /Info 6 0 R" });
      return writeRevision({ base: v1, objects: { 6: INFO({ Author: u16("○○市○○課"), Producer: PRODUCER }) }, size: 7, trailer: "/Root 1 0 R /Info 6 0 R" });
    },
    leaks: [[6, "info", "superseded"]],
    negatives: [],
  },
  {
    name: "p5-02-info-new-number",
    description: "増分更新で、文書情報を新しい番号に差し替えた（前の文書情報は、どこからも指されずに残る）",
    make() {
      const v1 = writeRevision({ objects: basic({ 6: INFO({ Author: u16("佐藤花子"), Title: u16("○○計画（内部）") }) }), size: 7, trailer: "/Root 1 0 R /Info 6 0 R" });
      return writeRevision({ base: v1, objects: { 7: INFO({ Producer: lit("Example Cleaner 1.0") }) }, size: 8, trailer: "/Root 1 0 R /Info 7 0 R" });
    },
    leaks: [[6, "info", "unreferenced"]],
    negatives: [],
  },
  {
    name: "p5-03-content-replaced",
    description: "増分更新で、ページの中身を新しい番号のものに差し替えた（前の中身の字が残る）",
    make() {
      const v1 = writeRevision({ objects: basic({ 4: content("Applicant: Taro Yamada, tel 000-1234-5678") }), size: 6, trailer: "/Root 1 0 R" });
      return writeRevision({ base: v1, objects: { 3: PAGE("7 0 R"), 7: content("Applicant: (withheld)") }, size: 8, trailer: "/Root 1 0 R" });
    },
    leaks: [[4, "content", "unreferenced"]],
    negatives: [[3, "structure", "superseded"]],
  },
  {
    name: "p5-04-content-overwritten",
    description: "増分更新で、ページの中身を同じ番号のまま書き直した",
    make() {
      const v1 = writeRevision({ objects: basic({ 4: content("Amount: 1,234,567 yen") }), size: 6, trailer: "/Root 1 0 R" });
      return writeRevision({ base: v1, objects: { 4: content("Amount: (see attachment)") }, size: 6, trailer: "/Root 1 0 R" });
    },
    leaks: [[4, "content", "superseded"]],
    negatives: [],
  },
  {
    name: "p5-05-annotation-removed",
    description: "増分更新で、校閲のコメント（注釈）をページから外した（注釈そのものは残る）",
    make() {
      const v1 = writeRevision({ objects: basic({ 3: PAGE("4 0 R", " /Annots [7 0 R]"), 7: annotText("ここは公開前に削除", "鈴木一郎") }), size: 8, trailer: "/Root 1 0 R" });
      return writeRevision({ base: v1, objects: { 3: PAGE() }, size: 8, trailer: "/Root 1 0 R" });
    },
    leaks: [[7, "annotation", "unreferenced"]],
    negatives: [[3, "structure", "superseded"]],
  },
  {
    name: "p5-06-attachment-freed",
    description: "増分更新で、添付を名前の木から外し、xref で「使っていない」と印をつけた（中身のバイト列は残る）",
    make() {
      const v1 = writeRevision({
        objects: basic({ 1: CATALOG(` /Names << /EmbeddedFiles << /Names [${u16("名簿.csv")} 8 0 R] >> >>`), 8: filespec("名簿.csv", 9), 9: embedded("name,address\nTaro Yamada,1-2-3\n") }),
        size: 10,
        trailer: "/Root 1 0 R",
      });
      return writeRevision({ base: v1, objects: { 1: CATALOG() }, free: [8, 9], size: 10, trailer: "/Root 1 0 R" });
    },
    leaks: [[9, "embedded_file", "free"]],
    negatives: [[8, "filespec", "free"], [1, "structure", "superseded"]],
  },
  {
    name: "p5-07-form-value-changed",
    description: "増分更新で、フォームの欄の値を書き直した（前の値が残る）",
    make() {
      const v1 = writeRevision({ objects: basic({ 1: CATALOG(" /AcroForm << /Fields [7 0 R] >>"), 7: field("applicant", "山田太郎") }), size: 8, trailer: "/Root 1 0 R" });
      return writeRevision({ base: v1, objects: { 7: field("applicant", "記入例") }, size: 8, trailer: "/Root 1 0 R" });
    },
    leaks: [[7, "form_value", "superseded"]],
    negatives: [],
  },
  {
    name: "p5-08-annotation-added",
    description: "増分更新で、注釈を足しただけ（消したものはない。前の版のページの辞書が残るだけ）",
    make() {
      const v1 = writeRevision({ objects: basic(), size: 6, trailer: "/Root 1 0 R" });
      return writeRevision({ base: v1, objects: { 3: PAGE("4 0 R", " /Annots [6 0 R]"), 6: annotText("確認しました", "○○課") }, size: 7, trailer: "/Root 1 0 R" });
    },
    leaks: [],
    negatives: [[3, "structure", "superseded"]],
  },
  {
    name: "p5-09-xref-stream-info",
    description: "xref ストリームとオブジェクトストリームで保存した PDF を、xref ストリームで増分更新し、文書情報を書き直した",
    make() {
      const v1 = writeRevision({
        objects: basic({ 6: INFO({ Author: u16("高橋次郎"), Producer: PRODUCER }) }),
        objstm: { num: 7, members: [1, 2, 3, 5, 6] },
        xrefStream: true,
        xrefNum: 8,
        size: 9,
        trailer: "/Root 1 0 R /Info 6 0 R",
      });
      return writeRevision({ base: v1, objects: { 6: INFO({ Producer: PRODUCER }) }, xrefStream: true, xrefNum: 9, size: 10, trailer: "/Root 1 0 R /Info 6 0 R" });
    },
    leaks: [[6, "info", "superseded"]],
    negatives: [],
  },
  {
    name: "p5-10-single-revision-stray",
    description: "増分更新のない PDF に、どこからも指されていない小さな辞書がある（中身はない）",
    make() {
      return writeRevision({ objects: basic({ 6: "<< /Example 1 >>" }), size: 7, trailer: "/Root 1 0 R" });
    },
    leaks: [],
    negatives: [[6, "structure", "unreferenced"]],
  },
  {
    name: "p5-11-metadata-replaced",
    description: "増分更新で、XMP を新しい番号のものに差し替えた（前の XMP の作成者が残る）",
    make() {
      const v1 = writeRevision({ objects: basic({ 1: CATALOG(" /Metadata 7 0 R"), 7: XMP("Hanako Sato") }), size: 8, trailer: "/Root 1 0 R" });
      return writeRevision({ base: v1, objects: { 1: CATALOG(" /Metadata 8 0 R"), 8: XMP("Example Section") }, size: 9, trailer: "/Root 1 0 R" });
    },
    leaks: [[7, "metadata", "unreferenced"]],
    negatives: [[1, "structure", "superseded"]],
  },
  {
    name: "p5-12-image-replaced",
    description: "増分更新で、ページの画像を差し替えた（前の画像が残る）",
    make() {
      const page = (img, cont) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /XObject << /Im1 ${img} 0 R >> >> /Contents ${cont} 0 R >>`;
      const draw = stream("<< >>", "q 100 0 0 100 40 100 cm /Im1 Do Q\n");
      const v1 = writeRevision({ objects: { 1: CATALOG(), 2: PAGES(), 3: page(7, 4), 4: draw, 7: IMAGE(40) }, size: 8, trailer: "/Root 1 0 R" });
      return writeRevision({ base: v1, objects: { 3: page(8, 4), 8: IMAGE(200) }, size: 9, trailer: "/Root 1 0 R" });
    },
    leaks: [[7, "image", "unreferenced"]],
    negatives: [[3, "structure", "superseded"]],
  },
  {
    name: "p5-13-orphan-object",
    description: "最後の %%EOF のあとに、xref に載っていないオブジェクト（字を描く中身）が書き足されている",
    make() {
      const v1 = writeRevision({ objects: basic(), size: 6, trailer: "/Root 1 0 R" });
      const orphan = objBytes(9, 0, content("Draft: Ichiro Suzuki"));
      // startxref は末尾 2048 バイトの中にあればよいので、小さなオブジェクトを足しても読める
      return new Uint8Array(Buffer.concat([Buffer.from(v1), orphan]));
    },
    leaks: [[9, "content", "orphan"]],
    negatives: [],
  },
  {
    name: "p5-14-info-producer-only",
    description: "増分更新で文書情報を差し替えたが、前の文書情報は作成ソフト名と日付だけ（漏れでない）",
    make() {
      const v1 = writeRevision({ objects: basic({ 6: INFO({ Producer: PRODUCER, CreationDate: lit("D:20261101090000+09'00'") }) }), size: 7, trailer: "/Root 1 0 R /Info 6 0 R" });
      return writeRevision({ base: v1, objects: { 7: INFO({ Producer: lit("Example PDF Library 2.0") }) }, size: 8, trailer: "/Root 1 0 R /Info 7 0 R" });
    },
    leaks: [],
    negatives: [[6, "info", "unreferenced"]],
  },
  {
    name: "p5-15-three-revisions",
    description: "増分更新を2回して、作成者を2回書き直した（前の定義が2つ残る）",
    make() {
      const v1 = writeRevision({ objects: basic({ 6: INFO({ Author: u16("中村四郎") }) }), size: 7, trailer: "/Root 1 0 R /Info 6 0 R" });
      const v2 = writeRevision({ base: v1, objects: { 6: INFO({ Author: u16("小林五郎") }) }, size: 7, trailer: "/Root 1 0 R /Info 6 0 R" });
      return writeRevision({ base: v2, objects: { 6: INFO({ Author: u16("○○課") }) }, size: 7, trailer: "/Root 1 0 R /Info 6 0 R" });
    },
    leaks: [[6, "info", "superseded"], [6, "info", "superseded"]],
    negatives: [],
  },
  {
    name: "p5-16-attachment-unreferenced",
    description: "増分更新で添付を名前の木から外しただけ（xref にはまだ載っている。P9 で数えるので P5 では数えない）",
    make() {
      const v1 = writeRevision({
        objects: basic({ 1: CATALOG(` /Names << /EmbeddedFiles << /Names [${u16("見積.csv")} 8 0 R] >> >>`), 8: filespec("見積.csv", 9), 9: embedded("item,price\nA,1000\n") }),
        size: 10,
        trailer: "/Root 1 0 R",
      });
      return writeRevision({ base: v1, objects: { 1: CATALOG() }, size: 10, trailer: "/Root 1 0 R" });
    },
    leaks: [],
    negatives: [[9, "embedded_file", "unreferenced"], [8, "filespec", "unreferenced"], [1, "structure", "superseded"]],
  },
  {
    name: "p5-17-two-pages-replaced",
    description: "2ページとも、中身を新しい番号のものに差し替えた",
    make() {
      const page = (cont) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /Font << /F1 5 0 R >> >> /Contents ${cont} 0 R >>`;
      const v1 = writeRevision({
        objects: { 1: CATALOG(), 2: PAGES("3 0 R 6 0 R", 2), 3: page(4), 4: content("Page 1: Saburo Ito"), 5: FONT, 6: page(7), 7: content("Page 2: Shiro Nakamura") },
        size: 8,
        trailer: "/Root 1 0 R",
      });
      return writeRevision({ base: v1, objects: { 3: page(8), 6: page(9), 8: content("Page 1"), 9: content("Page 2") }, size: 10, trailer: "/Root 1 0 R" });
    },
    leaks: [[4, "content", "unreferenced"], [7, "content", "unreferenced"]],
    negatives: [[3, "structure", "superseded"], [6, "structure", "superseded"]],
  },
  {
    name: "p5-18-three-annotations-removed",
    description: "増分更新で、コメントの注釈を3つまとめて外した",
    make() {
      const v1 = writeRevision({
        objects: basic({ 3: PAGE("4 0 R", " /Annots [7 0 R 8 0 R 9 0 R]"), 7: annotText("要確認", "山本七郎"), 8: annotText("金額を直す", "山本七郎"), 9: annotText("非公開", "加藤八郎") }),
        size: 10,
        trailer: "/Root 1 0 R",
      });
      return writeRevision({ base: v1, objects: { 3: PAGE() }, size: 10, trailer: "/Root 1 0 R" });
    },
    leaks: [[7, "annotation", "unreferenced"], [8, "annotation", "unreferenced"], [9, "annotation", "unreferenced"]],
    negatives: [[3, "structure", "superseded"]],
  },
  {
    name: "p5-19-content-freed",
    description: "増分更新で中身を差し替え、前の中身に xref で「使っていない」と印をつけた",
    make() {
      const v1 = writeRevision({ objects: basic({ 4: content("Internal memo: Goro Kobayashi") }), size: 6, trailer: "/Root 1 0 R" });
      return writeRevision({ base: v1, objects: { 3: PAGE("6 0 R"), 6: content("Memo") }, free: [4], size: 7, trailer: "/Root 1 0 R" });
    },
    leaks: [[4, "content", "free"]],
    negatives: [[3, "structure", "superseded"]],
  },
  {
    name: "p5-20-two-fields-changed",
    description: "増分更新で、フォームの欄2つの値を書き直した",
    make() {
      const v1 = writeRevision({
        objects: basic({ 1: CATALOG(" /AcroForm << /Fields [7 0 R 8 0 R] >>"), 7: field("name", "渡辺六郎"), 8: field("address", "○○市1-2-3") }),
        size: 9,
        trailer: "/Root 1 0 R",
      });
      return writeRevision({ base: v1, objects: { 7: field("name", "（記入例）"), 8: field("address", "（記入例）") }, size: 9, trailer: "/Root 1 0 R" });
    },
    leaks: [[7, "form_value", "superseded"], [8, "form_value", "superseded"]],
    negatives: [],
  },
  {
    name: "p5-21-link-removed",
    description: "増分更新で、字のないリンクの注釈を外した（字がないので漏れでない）",
    make() {
      const v1 = writeRevision({ objects: basic({ 3: PAGE("4 0 R", " /Annots [7 0 R]"), 7: annotLink() }), size: 8, trailer: "/Root 1 0 R" });
      return writeRevision({ base: v1, objects: { 3: PAGE() }, size: 8, trailer: "/Root 1 0 R" });
    },
    leaks: [],
    negatives: [[7, "annotation", "unreferenced"], [3, "structure", "superseded"]],
  },
];

// ---------- 書き出し ----------

for (const f of readdirSync(HERE)) {
  if (/^p5-.*\.(pdf|expected\.json)$/.test(f)) unlinkSync(path.join(HERE, f));
}
const rows = [];
const hashes = [];
let totalLeaks = 0;
let totalNeg = 0;
for (const c of CASES) {
  const bytes = c.make();
  const file = `${c.name}.pdf`;
  writeFileSync(path.join(HERE, file), bytes);
  const expected = {
    file,
    description: c.description,
    leaks: c.leaks.map(([object, kind, where], i) => ({ id: `${c.name}#L${i + 1}`, pattern: "P5", object, kind, where })),
    negatives: c.negatives.map(([object, kind, where], i) => ({ id: `${c.name}#N${i + 1}`, object, kind, where })),
  };
  writeFileSync(path.join(HERE, `${c.name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  hashes.push(`${sha}  ${file}`);
  rows.push(`| ${file} | ${c.description} | ${c.leaks.length} | ${c.negatives.length} | \`${sha.slice(0, 16)}\` |`);
  totalLeaks += c.leaks.length;
  totalNeg += c.negatives.length;
}
writeFileSync(path.join(HERE, "hashes.txt"), hashes.join("\n") + "\n");
writeFileSync(
  path.join(HERE, "index.md"),
  `# P5（旧版の残存）の合成 PDF の一覧

\`node fixtures/p5/build.mjs\` で作り直せる。日時も乱数も使わないので、作り直しても SHA-256 は変わらない。
名前・団体はすべて架空。

- 合成 PDF：${CASES.length} 個
- 漏れ（検出率の分母）：${totalLeaks} 件
- 漏れでないもの（誤検知率の分母）：${totalNeg} 件

| ファイル | 何を再現しているか | 漏れ | 漏れでない | SHA-256（先頭16桁） |
|---|---|---|---|---|
${rows.join("\n")}
`,
);
console.log(`合成 PDF ${CASES.length} 個、漏れ ${totalLeaks} 件、漏れでないもの ${totalNeg} 件`);

// SPDX-License-Identifier: AGPL-3.0-only
//
// テスト用：本当に暗号化した、小さな合成 PDF を作る（標準のセキュリティハンドラ、V2・R3、RC4 128 ビット）。
// PDF 1.7（ISO 32000-1）§7.6.3 のアルゴリズム 2・3・5 のとおりに作る。ライブラリは足さず、Node の MD5 と自前の RC4 を使う。
// 利用者のパスワードは空（開くときにパスワードを聞かれない形。役所の PDF でよくある「印刷・編集の禁止」だけの暗号化）。
//
// 中身：1ページ。「Taro Yamada」（架空の名前）を書き、その上に黒い四角を重ねた見せかけの黒塗り。
// objectStream: true のときは、ページなどをオブジェクトストリームに入れ、xref ストリームで書く。

import { createHash } from "node:crypto";

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const md5 = (...parts) => {
  const h = createHash("md5");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

/** RC4（暗号化と復号は同じ処理） */
export function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const padPassword = (pw) => {
  const b = new TextEncoder().encode(pw).slice(0, 32);
  const out = new Uint8Array(32);
  out.set(b, 0);
  out.set(PAD.subarray(0, 32 - b.length), b.length);
  return out;
};

const xorKey = (key, i) => key.map((b) => b ^ i);
const le32 = (n) => Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
const hex = (b) => Buffer.from(b).toString("hex");

function computeKeys(ownerPw, userPw, P, id0) {
  // アルゴリズム 3：O
  let h = md5(padPassword(ownerPw));
  for (let i = 0; i < 50; i++) h = md5(h);
  const okey = h.subarray(0, 16);
  let O = rc4(okey, padPassword(userPw));
  for (let i = 1; i <= 19; i++) O = rc4(xorKey(okey, i), O);
  // アルゴリズム 2：文書の鍵
  h = md5(padPassword(userPw), O, le32(P), id0);
  for (let i = 0; i < 50; i++) h = md5(h.subarray(0, 16));
  const key = h.subarray(0, 16);
  // アルゴリズム 5：U
  let U = rc4(key, md5(PAD, id0));
  for (let i = 1; i <= 19; i++) U = rc4(xorKey(key, i), U);
  const U32 = new Uint8Array(32);
  U32.set(U, 0);
  return { O, U: U32, key };
}

/** アルゴリズム 1：オブジェクトごとの鍵 */
const objectKey = (key, num, gen) =>
  md5(key, Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff])).subarray(0, 16);

const latin1 = (b) => Buffer.from(b).toString("latin1");

/**
 * @param {{ objectStream?: boolean, ownerPassword?: string, userPassword?: string }} [opts]
 * @returns {Uint8Array}
 */
export function makeEncryptedPdf(opts = {}) {
  const ownerPw = opts.ownerPassword ?? "owner-secret";
  const userPw = opts.userPassword ?? "";
  const P = -3904; // 印刷・変更・コピーなどを禁止（ビットの組み合わせ。例）
  const id0 = md5(new TextEncoder().encode("omamori-test-encrypted-fixed-id"));
  const { O, U, key } = computeKeys(ownerPw, userPw, P, id0);
  const enc = (num, data) => rc4(objectKey(key, num, 0), data);

  const content = new TextEncoder().encode("BT /F1 12 Tf 20 100 Td (Taro Yamada) Tj ET\n0 g 15 95 120 20 re f\n");
  const title = enc(7, new TextEncoder().encode("Test document"));
  const encryptDict = `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O <${hex(O)}> /U <${hex(U)}> >>`;
  const id = `[<${hex(id0)}> <${hex(id0)}>]`;

  const small = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    4: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  };
  const chunks = [];
  let size = 0;
  const offsets = {};
  const push = (s) => {
    const b = typeof s === "string" ? Buffer.from(s, "latin1") : Buffer.from(s);
    chunks.push(b);
    size += b.length;
  };
  const obj = (num, body) => {
    offsets[num] = size;
    push(`${num} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  };
  const streamObj = (num, dict, data) => {
    offsets[num] = size;
    push(`${num} 0 obj\n${dict.replace(/>>$/, ` /Length ${data.length} >>`)}\nstream\n`);
    push(data);
    push("\nendstream\nendobj\n");
  };

  push("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n");
  if (!opts.objectStream) {
    for (const [n, body] of Object.entries(small)) obj(Number(n), body);
    streamObj(5, "<< >>", enc(5, content));
    obj(6, encryptDict);
    obj(7, `<< /Title <${hex(title)}> >>`);
    const xrefAt = size;
    let x = "xref\n0 8\n0000000000 65535 f \n";
    for (let n = 1; n <= 7; n++) x += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    push(x);
    push(`trailer\n<< /Size 8 /Root 1 0 R /Info 7 0 R /Encrypt 6 0 R /ID ${id} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  } else {
    // オブジェクトストリーム（8）に 1〜4 を入れる。ストリーム全体を 8 の鍵で暗号化する（中の文字列は個別に暗号化しない）
    let headerPart = "";
    let bodyPart = "";
    for (const [n, body] of Object.entries(small)) {
      headerPart += `${n} ${bodyPart.length} `;
      bodyPart += body + "\n";
    }
    const objstm = new TextEncoder().encode(headerPart + "\n" + bodyPart);
    const first = Buffer.byteLength(headerPart + "\n", "latin1");
    streamObj(5, "<< >>", enc(5, content));
    obj(6, encryptDict);
    obj(7, `<< /Title <${hex(title)}> >>`);
    streamObj(8, `<< /Type /ObjStm /N 4 /First ${first} >>`, enc(8, objstm));
    // xref ストリーム（9）。暗号化しない（決まり）
    const xrefAt = size;
    const rows = [];
    const row = (t, a, b) => rows.push(t, (a >> 24) & 0xff, (a >> 16) & 0xff, (a >> 8) & 0xff, a & 0xff, b);
    row(0, 0, 255);
    for (let n = 1; n <= 4; n++) row(2, 8, n - 1);
    for (const n of [5, 6, 7, 8]) row(1, offsets[n], 0);
    row(1, xrefAt, 0);
    const xdata = Uint8Array.from(rows);
    offsets[9] = xrefAt;
    push(`9 0 obj\n<< /Type /XRef /Size 10 /W [1 4 1] /Root 1 0 R /Info 7 0 R /Encrypt 6 0 R /ID ${id} /Length ${xdata.length} >>\nstream\n`);
    push(xdata);
    push(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export { latin1 };

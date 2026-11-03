// SPDX-License-Identifier: AGPL-3.0-only
//
// 検証器 P5 のための復号（利用者のパスワードが空の暗号化だけ）。PR #21 の返事の 5。
// 標準のセキュリティハンドラ（/Filter /Standard）の、次の形を解く。ライブラリは足さず、Node の crypto（MD5・SHA-2・AES）と自前の RC4 で書く。
//   V1・V2（R2・R3）        RC4（40〜128 ビット）
//   V4（R4）                 暗号化の決まり（/CF）ごとに RC4（/V2）か AES-128（/AESV2）。/Identity は暗号化なし
//   V5（R5・R6）             AES-256（/AESV3）
// 手順は ISO 32000-1 §7.6（アルゴリズム 1・2・4・5・6）と ISO 32000-2 §7.6.4.3（アルゴリズム 2.A・2.B・11）。
// 利用者のパスワードが要る PDF は解かない（password_required）。検査器と同じく、パスワードを試したり推したりしない。
// 検査器（src/）・検出ルール（rules/）の復号は読んでいない（独立のため）。

import { createDecipheriv, createCipheriv, createHash } from "node:crypto";

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const digest = (alg, ...parts) => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const md5 = (...parts) => digest("md5", ...parts);
const le32 = (n) => Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const equalBytes = (a, b, n) => {
  if (a.length < n || b.length < n) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** RC4（暗号化と復号は同じ処理） */
export function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/** AES-CBC の復号。先頭 16 バイトが IV。詰め物（PKCS#5）が壊れていれば、外さずに返す */
function aesCbcDecrypt(key, data) {
  // IV だけ（中身が空）なら空。長さが 16 の倍数でなければ、読める所（16 の倍数）まで解く
  if (data.length <= 16) return new Uint8Array(0);
  const iv = data.subarray(0, 16);
  const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16);
  if (body.length === 0) return new Uint8Array(0);
  const alg = key.length === 32 ? "aes-256-cbc" : "aes-128-cbc";
  const d = createDecipheriv(alg, key, iv);
  d.setAutoPadding(false);
  const out = new Uint8Array(Buffer.concat([d.update(body), d.final()]));
  const p = out.length ? out[out.length - 1] : 0;
  if (p >= 1 && p <= 16 && p <= out.length && out.subarray(out.length - p).every((b) => b === p)) return out.subarray(0, out.length - p);
  return out;
}

/** 空のパスワードを 32 バイトに詰めたもの（アルゴリズム 2 の a。空なので PAD そのもの） */
const PADDED_EMPTY = PAD;

// ---------- R2〜R4（アルゴリズム 2・4・5・6） ----------

function keyR4(enc) {
  const n = enc.R === 2 ? 5 : Math.max(5, Math.min(16, Math.floor((enc.Length || 40) / 8)));
  const parts = [PADDED_EMPTY, enc.O.subarray(0, 32), le32(enc.P), enc.id0];
  if (enc.R >= 4 && enc.EncryptMetadata === false) parts.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff]));
  let h = md5(...parts);
  if (enc.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.subarray(0, n);
}

/** 空のパスワードで開けるか（アルゴリズム 6：U を作って比べる） */
function userPasswordIsEmptyR4(enc, key) {
  if (enc.R === 2) return equalBytes(rc4(key, PAD), enc.U, 32);
  let x = rc4(key, md5(PAD, enc.id0));
  for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
  return equalBytes(x, enc.U, 16);
}

// ---------- R5・R6（アルゴリズム 2.A・2.B・11） ----------

/** アルゴリズム 2.B（R6 のハッシュ）。R5 は SHA-256 だけ */
function hashR6(password, salt, udata) {
  let k = digest("sha256", password, salt, udata);
  let e = new Uint8Array(0);
  let i = 0;
  while (i < 64 || e[e.length - 1] > i - 32) {
    const one = new Uint8Array(password.length + k.length + udata.length);
    one.set(password, 0);
    one.set(k, password.length);
    one.set(udata, password.length + k.length);
    const k1 = new Uint8Array(one.length * 64);
    for (let r = 0; r < 64; r++) k1.set(one, r * one.length);
    const c = createCipheriv("aes-128-cbc", k.subarray(0, 16), k.subarray(16, 32));
    c.setAutoPadding(false);
    e = new Uint8Array(Buffer.concat([c.update(k1), c.final()]));
    // 先頭 16 バイトを 128 ビットの数とみた 3 の余り。256 は 3 で割ると 1 余るので、各バイトの和の余りと同じ
    let sum = 0;
    for (let b = 0; b < 16; b++) sum += e[b];
    k = digest(["sha256", "sha384", "sha512"][sum % 3], e);
    i++;
    if (i > 2000) throw new Error("R6 のハッシュが終わらない");
  }
  return k.subarray(0, 32);
}
const hashV5 = (enc, password, salt, udata) => (enc.R >= 6 ? hashR6(password, salt, udata) : digest("sha256", password, salt, udata));

function keyV5(enc) {
  const empty = new Uint8Array(0);
  const U = enc.U;
  if (U.length < 48 || !enc.UE || enc.UE.length < 32) return null;
  // 空のパスワードで U の確かめの塩（32〜39）から作ったハッシュが、U の先頭 32 バイトと合うか
  if (!equalBytes(hashV5(enc, empty, U.subarray(32, 40), empty), U, 32)) return null;
  const k = hashV5(enc, empty, U.subarray(40, 48), empty);
  const d = createDecipheriv("aes-256-cbc", k, new Uint8Array(16));
  d.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([d.update(enc.UE.subarray(0, 32)), d.final()]));
}

// ---------- 入口 ----------

const num = (v) => (v?.t === "num" ? v.v : undefined);
const name = (v) => (v?.t === "name" ? v.v : undefined);
const bytes = (v) => (v?.t === "str" ? v.v : undefined);

/**
 * 暗号化の辞書と trailer の /ID から、復号の道具を作る。
 * @param {Map<string, any>} dict  暗号化の辞書（p9-pdfbytes.mjs の parseValue の形の Map）
 * @param {Uint8Array|null} id0    trailer の /ID の1つめ
 * @returns {{ ok: true, method: string, decryptString(num, gen, bytes): Uint8Array, decryptStream(num, gen, bytes, streamDict): Uint8Array }
 *          | { ok: false, reason: "password_required" | "unsupported" }}
 */
export function makeDecryptor(dict, id0) {
  if (!(dict instanceof Map)) return { ok: false, reason: "unsupported" };
  if (name(dict.get("Filter")) !== "Standard") return { ok: false, reason: "unsupported" };
  const enc = {
    V: num(dict.get("V")) ?? 0,
    R: num(dict.get("R")) ?? 0,
    // 鍵の長さ（ビット）。V4 で書いていなければ 128（AES-128 と RC4 128 ビットの決まりの値）
    Length: num(dict.get("Length")) ?? (num(dict.get("V")) === 4 ? 128 : 40),
    P: num(dict.get("P")) ?? 0,
    O: bytes(dict.get("O")),
    U: bytes(dict.get("U")),
    UE: bytes(dict.get("UE")),
    EncryptMetadata: dict.get("EncryptMetadata")?.t === "bool" ? dict.get("EncryptMetadata").v : true,
    id0: id0 ?? new Uint8Array(0),
  };
  if (!enc.O || !enc.U) return { ok: false, reason: "unsupported" };

  // 文字列とストリームに使う方式（none・rc4・aesv2・aesv3）
  let strMethod, stmMethod;
  const cfMethod = (cfName) => {
    if (!cfName || cfName === "Identity") return "none";
    const cf = dict.get("CF")?.t === "dict" ? dict.get("CF").v.get(cfName) : undefined;
    const cfm = cf?.t === "dict" ? name(cf.v.get("CFM")) : undefined;
    if (cfm === "V2") return "rc4";
    if (cfm === "AESV2") return "aesv2";
    if (cfm === "AESV3") return "aesv3";
    if (cfm === "None" || cfm === undefined) return "none";
    return null;
  };
  if (enc.V === 1 || enc.V === 2) strMethod = stmMethod = "rc4";
  else if (enc.V === 4 || enc.V === 5) {
    strMethod = cfMethod(name(dict.get("StrF")));
    stmMethod = cfMethod(name(dict.get("StmF")));
    if (strMethod === null || stmMethod === null) return { ok: false, reason: "unsupported" };
  } else return { ok: false, reason: "unsupported" };

  let fileKey;
  if (enc.V === 5) {
    if (enc.R !== 5 && enc.R !== 6) return { ok: false, reason: "unsupported" };
    fileKey = keyV5(enc);
    if (!fileKey) return { ok: false, reason: "password_required" };
  } else {
    if (enc.R < 2 || enc.R > 4) return { ok: false, reason: "unsupported" };
    fileKey = keyR4(enc);
    if (!userPasswordIsEmptyR4(enc, fileKey)) return { ok: false, reason: "password_required" };
  }

  // アルゴリズム 1：オブジェクトごとの鍵（R5・R6 は文書の鍵をそのまま使う）
  const objectKey = (n, g, aes) => {
    const parts = [fileKey, Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, g & 0xff, (g >> 8) & 0xff])];
    if (aes) parts.push(Uint8Array.from([0x73, 0x41, 0x6c, 0x54])); // "sAlT"
    return md5(...parts).subarray(0, Math.min(fileKey.length + 5, 16));
  };
  const run = (method, n, g, data) => {
    if (method === "none") return data;
    if (method === "rc4") return rc4(objectKey(n, g, false), data);
    if (method === "aesv2") return aesCbcDecrypt(objectKey(n, g, true), data);
    return aesCbcDecrypt(fileKey, data); // aesv3
  };
  return {
    ok: true,
    method: `V${enc.V}/R${enc.R}/${stmMethod}`,
    decryptString: (n, g, data) => run(strMethod, n, g, data),
    decryptStream: (n, g, data, streamDict) => {
      // XMP を暗号化しない決まり（/EncryptMetadata false）のときの XMP と、xref ストリームは、そのまま
      const type = streamDict instanceof Map ? name(streamDict.get("Type")) : undefined;
      if (type === "XRef") return data;
      if (type === "Metadata" && enc.EncryptMetadata === false) return data;
      return run(stmMethod, n, g, data);
    },
  };
}

/** 値の中の文字列を、すべて復号した写しを返す（辞書・配列の中もたどる） */
export function decryptValue(value, decryptString, n, g, depth = 0) {
  if (!value || depth > 64) return value;
  if (value.t === "str") return { ...value, v: decryptString(n, g, value.v) };
  if (value.t === "dict") {
    const m = new Map();
    for (const [k, v] of value.v) m.set(k, decryptValue(v, decryptString, n, g, depth + 1));
    return { t: "dict", v: m };
  }
  if (value.t === "array") return { t: "array", v: value.v.map((x) => decryptValue(x, decryptString, n, g, depth + 1)) };
  return value;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// パスワードなしで開ける暗号化 PDF（利用者のパスワードが空。印刷・編集の禁止だけをかけたもの）を、検査のために復号する。
// 標準のセキュリティハンドラ（/Filter /Standard）の、次の形に対応する（ISO 32000-1 §7.6、ISO 32000-2 §7.6.4）。
//   V1・V2（RC4、R2・R3）、V4（RC4 または AES-128。R4）、V5（AES-256。R5・R6）
// 利用者のパスワードが空でない PDF は復号しない（パスワードは聞かない。検査器はパスワードを扱わない）。
// MD5 と RC4 は自前（primitives.ts）、AES と SHA-2 はブラウザ・Node の Web Crypto を使う。ライブラリは足さない。
//
// 復号は pdf-lib の文脈（PDFContext）の中で行う。ファイルを書き換えて保存するためではなく、検査で中を読むためだけに使う。

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  PDFBool,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { md5, rc4 } from "./primitives.ts";

export type CryptMethod = "rc4" | "aesv2" | "aesv3" | "identity";

export type EncryptionSummary = {
  filter: string;
  v: number;
  r: number;
  /** 鍵の長さ（ビット） */
  keyBits: number;
  /** ストリーム・文字列の暗号の方式 */
  streams: CryptMethod;
  strings: CryptMethod;
};

export type DecryptResult =
  | { ok: true; summary: EncryptionSummary; failedObjects: number }
  | { ok: false; reason: "password_required" | "unsupported" | "broken"; summary?: Partial<EncryptionSummary> };

/** 名前の型を、同じ長さの別名にしておいたオブジェクトストリーム（load.ts が読み込む前に置き換える） */
export const MASKED_OBJSTM = "ObjStX";

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const MAX_DEPTH = 64;

const subtle = (): typeof globalThis.crypto.subtle => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("Web Crypto がない");
  return s;
};

function bytesOf(o: PDFObject | undefined): Uint8Array | null {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.asBytes();
  return null;
}

function numOf(o: PDFObject | undefined, fallback: number): number {
  return o instanceof PDFNumber ? o.asNumber() : fallback;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const le32 = (n: number) => Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

/** Web Crypto に渡すため、ArrayBuffer を持つ写しにする */
const ab = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

async function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", ab(key), { name: "AES-CBC" }, false, ["decrypt"]);
  return new Uint8Array(await subtle().decrypt({ name: "AES-CBC", iv: ab(iv) }, k, ab(data)));
}

async function aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  // Web Crypto は必ず埋め草（PKCS#7）を足す。data が 16 の倍数なら、最後の1ブロックが埋め草だけなので、それを捨てる
  const k = await subtle().importKey("raw", ab(key), { name: "AES-CBC" }, false, ["encrypt"]);
  const out = new Uint8Array(await subtle().encrypt({ name: "AES-CBC", iv: ab(iv) }, k, ab(data)));
  return out.subarray(0, data.length);
}

/** 埋め草のない AES-256-CBC の復号（IV は 0）。UE・OE を解くのに使う。Web Crypto が埋め草を求めるので、埋め草だけのブロックを足して解く */
async function aesCbcDecryptNoPad(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const last = data.subarray(data.length - 16);
  // C' = AES(K, last XOR 0x10…)。CBC で IV＝last、平文＝0x10×16 を暗号化した最初のブロックがそれになる
  const extra = (await aesCbcEncryptNoPad(key, last, new Uint8Array(16).fill(16))).subarray(0, 16);
  return aesCbcDecrypt(key, new Uint8Array(16), concat(data, extra));
}

async function sha(name: "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest(name, ab(data)));
}

/** ISO 32000-2 のアルゴリズム 2.B（R6 のハッシュ）。パスワードは空なので、パスワードの部分は 0 バイト */
async function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Uint8Array> {
  let k = await sha("SHA-256", concat(password, salt, udata));
  for (let i = 0; ; i++) {
    const k1 = concat(password, k, udata);
    const rep = new Uint8Array(k1.length * 64);
    for (let j = 0; j < 64; j++) rep.set(k1, j * k1.length);
    const e = await aesCbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), rep);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j]!;
    const which = sum % 3;
    k = await sha(which === 0 ? "SHA-256" : which === 1 ? "SHA-384" : "SHA-512", e);
    // 64 回以上回し、最後の E の最後のバイトが「回した回数 − 32」以下になったら止める
    const rounds = i + 1;
    if (rounds >= 64 && e[e.length - 1]! <= rounds - 32) break;
    if (i > 1000) throw new Error("R6 のハッシュが終わらない");
  }
  return k.subarray(0, 32);
}

type Handler = {
  summary: EncryptionSummary;
  key: Uint8Array;
  encryptMetadata: boolean;
};

function methodOf(enc: PDFDict, filterName: string | undefined, v: number): CryptMethod | null {
  if (v === 1 || v === 2) return "rc4";
  if (v !== 4 && v !== 5) return null;
  if (!filterName || filterName === "Identity") return "identity";
  const cf = enc.lookup(PDFName.of("CF"));
  const f = cf instanceof PDFDict ? cf.lookup(PDFName.of(filterName)) : undefined;
  const cfm = f instanceof PDFDict ? f.lookup(PDFName.of("CFM")) : undefined;
  const m = cfm instanceof PDFName ? cfm.decodeText() : "None";
  if (m === "V2") return "rc4";
  if (m === "AESV2") return "aesv2";
  if (m === "AESV3") return "aesv3";
  if (m === "None") return "identity";
  return null;
}

/** 空のパスワードで開けるかを確かめ、文書の鍵を出す。開けなければ理由を返す */
async function openHandler(context: PDFContext, enc: PDFDict): Promise<Handler | { fail: "password_required" | "unsupported" | "broken" }> {
  const filter = enc.lookup(PDFName.of("Filter"));
  const filterName = filter instanceof PDFName ? filter.decodeText() : "";
  if (filterName !== "Standard") return { fail: "unsupported" };
  const v = numOf(enc.lookup(PDFName.of("V")), 0);
  const r = numOf(enc.lookup(PDFName.of("R")), 0);
  const O = bytesOf(enc.lookup(PDFName.of("O")));
  const U = bytesOf(enc.lookup(PDFName.of("U")));
  const P = numOf(enc.lookup(PDFName.of("P")), 0) | 0;
  const em = enc.lookup(PDFName.of("EncryptMetadata"));
  const encryptMetadata = !(em instanceof PDFBool) || em.asBoolean();
  if (!O || !U) return { fail: "broken" };
  const nameOf = (k: string) => {
    const x = enc.lookup(PDFName.of(k));
    return x instanceof PDFName ? x.decodeText() : undefined;
  };
  const streams = methodOf(enc, nameOf("StmF"), v);
  const strings = methodOf(enc, nameOf("StrF"), v);
  if (!streams || !strings) return { fail: "unsupported" };

  if (r === 5 || r === 6) {
    if (U.length < 48) return { fail: "broken" };
    const UE = bytesOf(enc.lookup(PDFName.of("UE")));
    if (!UE || UE.length < 32) return { fail: "broken" };
    const empty = new Uint8Array(0);
    const check = r === 5 ? await sha("SHA-256", U.subarray(32, 40)) : await hash2B(empty, U.subarray(32, 40), empty);
    if (!equalBytes(check.subarray(0, 32), U.subarray(0, 32))) return { fail: "password_required" };
    const ik = r === 5 ? await sha("SHA-256", U.subarray(40, 48)) : await hash2B(empty, U.subarray(40, 48), empty);
    const key = await aesCbcDecryptNoPad(ik.subarray(0, 32), UE.subarray(0, 32));
    return { key, encryptMetadata, summary: { filter: filterName, v, r, keyBits: 256, streams, strings } };
  }

  if (r < 2 || r > 4) return { fail: "unsupported" };
  const keyBits = v === 1 ? 40 : numOf(enc.lookup(PDFName.of("Length")), 40);
  const n = r === 2 ? 5 : Math.max(5, Math.min(16, Math.floor(keyBits / 8)));
  const idArr = context.trailerInfo.ID;
  const idObj = idArr instanceof PDFArray ? idArr.lookup(0) : undefined;
  const id0 = bytesOf(idObj) ?? new Uint8Array(0);
  // アルゴリズム 2（パスワードは空なので、埋め草だけ）
  let h = md5(PAD, O.subarray(0, 32), le32(P), id0, r >= 4 && !encryptMetadata ? Uint8Array.from([0xff, 0xff, 0xff, 0xff]) : new Uint8Array(0));
  if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  const key = h.subarray(0, n);
  // 利用者のパスワードの確かめ（アルゴリズム 4・5）
  if (r === 2) {
    if (!equalBytes(rc4(key, PAD), U.subarray(0, 32))) return { fail: "password_required" };
  } else {
    let x = rc4(key, md5(PAD, id0));
    for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
    if (!equalBytes(x.subarray(0, 16), U.subarray(0, 16))) return { fail: "password_required" };
  }
  return { key, encryptMetadata, summary: { filter: filterName, v, r, keyBits: n * 8, streams, strings } };
}

/** オブジェクトごとの鍵（アルゴリズム 1）。AES-256 は文書の鍵をそのまま使う */
function objectKey(h: Handler, method: CryptMethod, ref: PDFRef): Uint8Array {
  if (method === "aesv3") return h.key;
  const num = ref.objectNumber;
  const gen = ref.generationNumber;
  const extra = Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
  const salt = method === "aesv2" ? Uint8Array.from([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0);
  return md5(h.key, extra, salt).subarray(0, Math.min(16, h.key.length + 5));
}

async function decryptBytes(h: Handler, method: CryptMethod, ref: PDFRef, data: Uint8Array): Promise<Uint8Array> {
  if (method === "identity") return data;
  const k = objectKey(h, method, ref);
  if (method === "rc4") return rc4(k, data);
  // AES：先頭 16 バイトが IV
  if (data.length < 16) return new Uint8Array(0);
  if (data.length === 16) return new Uint8Array(0);
  return aesCbcDecrypt(k, data.subarray(0, 16), data.subarray(16));
}

/** 辞書・配列の中の文字列を、その場で復号する */
async function decryptStringsIn(h: Handler, ref: PDFRef, obj: PDFObject, depth: number, failed: { n: number }): Promise<PDFObject> {
  if (depth > MAX_DEPTH) return obj;
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try {
      const plain = await decryptBytes(h, h.summary.strings, ref, obj.asBytes());
      return PDFHexString.of(Array.from(plain, (b) => b.toString(16).padStart(2, "0")).join(""));
    } catch {
      failed.n++;
      return obj;
    }
  }
  if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) {
      const nv = await decryptStringsIn(h, ref, v, depth + 1, failed);
      if (nv !== v) obj.set(k, nv);
    }
    return obj;
  }
  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const v = obj.get(i);
      const nv = await decryptStringsIn(h, ref, v, depth + 1, failed);
      if (nv !== v) obj.set(i, nv);
    }
  }
  return obj;
}

/**
 * 文脈の中のすべての文字列・ストリームを、その場で復号する。
 * 返したあと、trailer の /Encrypt は外してある。名前を置き換えておいたオブジェクトストリームは、/Type を /ObjStm に戻してある
 * （開くのは呼ぶ側。load.ts）。
 */
export async function decryptContext(context: PDFContext): Promise<DecryptResult & { objectStreams?: PDFRef[] }> {
  const encRef = context.trailerInfo.Encrypt;
  const enc = encRef ? context.lookup(encRef) : undefined;
  if (!(enc instanceof PDFDict)) return { ok: false, reason: "broken" };
  let h: Handler | { fail: "password_required" | "unsupported" | "broken" };
  try {
    h = await openHandler(context, enc);
  } catch {
    return { ok: false, reason: "broken" };
  }
  if ("fail" in h) return { ok: false, reason: h.fail };
  const handler = h;
  const failed = { n: 0 };
  const objectStreams: PDFRef[] = [];
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (encRef instanceof PDFRef && ref === encRef) continue;
    if (obj instanceof PDFRawStream) {
      const type = obj.dict.lookup(PDFName.of("Type"));
      const typeName = type instanceof PDFName ? type.decodeText() : "";
      if (typeName === "XRef") continue; // xref ストリームは暗号化しない決まり
      await decryptStringsIn(handler, ref, obj.dict, 0, failed);
      if (typeName === "Metadata" && !handler.encryptMetadata) continue;
      try {
        const plain = await decryptBytes(handler, handler.summary.streams, ref, obj.contents);
        const dict = obj.dict;
        if (typeName === MASKED_OBJSTM) {
          dict.set(PDFName.of("Type"), PDFName.of("ObjStm"));
          objectStreams.push(ref);
        }
        context.assign(ref, PDFRawStream.of(dict, plain));
      } catch {
        failed.n++;
      }
    } else if (obj instanceof PDFDict || obj instanceof PDFArray) {
      await decryptStringsIn(handler, ref, obj, 0, failed);
    } else if (obj instanceof PDFString || obj instanceof PDFHexString) {
      context.assign(ref, await decryptStringsIn(handler, ref, obj, 0, failed));
    }
  }
  delete (context.trailerInfo as { Encrypt?: PDFObject }).Encrypt;
  return { ok: true, summary: handler.summary, failedObjects: failed.n, objectStreams };
}

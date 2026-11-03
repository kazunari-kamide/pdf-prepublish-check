// SPDX-License-Identifier: AGPL-3.0-only
//
// 検出ルールが PDF を読み込む入口（rules/p6-text・rules/p1-info で共通）。
// - 暗号化されていない PDF：そのまま pdf-lib で読む。
// - パスワードなしで開ける暗号化 PDF：復号して読む（decrypt.ts）。返す doc は、復号した中身を、暗号化のない PDF として
//   書き出して読み直したもの。オブジェクトの番号は元のまま。
// - パスワードが要る・対応していない暗号化：encrypted を返す（中身は読まない）。
//
// pdf-lib 1.17.1 の EncryptedPDFError は instanceof で見分けられないので、暗号化を気にせずに読み、isEncrypted で見分ける。
// 暗号化されたオブジェクトストリームは、pdf-lib が読み込みの時点で開こうとして壊れる（中のオブジェクトが消える）。
// そのため、暗号化された PDF は、オブジェクトストリームの型の名前（/ObjStm）を同じ長さの別名に置き換えてから読む。
// 置き換えるのは読み込みのための写しだけで、利用者のファイルは変えない。

import { PDFDocument, PDFName, PDFObjectStreamParser, PDFRawStream, PDFWriter, type PDFRef } from "pdf-lib";
import { MASKED_OBJSTM, decryptContext, type EncryptionSummary } from "./decrypt.ts";

export type LoadedPdf =
  | {
      status: "ok";
      doc: PDFDocument;
      /** 復号して読んだときだけ。どの暗号化だったか */
      decrypted: (EncryptionSummary & { failedObjects: number }) | null;
    }
  | { status: "error"; code: "unreadable" | "encrypted"; reason?: "password_required" | "unsupported" | "broken" };

const LOAD_OPTIONS = { updateMetadata: false, throwOnInvalidObject: false, ignoreEncryption: true } as const;
const ENCRYPT = new TextEncoder().encode("/Encrypt");
const OBJSTM = new TextEncoder().encode("/ObjStm");
const TYPE = PDFName.of("Type");

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const isDelimiter = (c: number | undefined) =>
  c === undefined || c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00 ||
  c === 0x2f || c === 0x3e || c === 0x3c || c === 0x5b || c === 0x5d || c === 0x28 || c === 0x29 || c === 0x25;

/** 名前 /ObjStm を、同じ長さの別名に置き換えた写し（位置がずれないので、xref はそのまま使える） */
function maskObjectStreams(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  const repl = new TextEncoder().encode("/" + MASKED_OBJSTM);
  for (let at = indexOf(out, OBJSTM); at >= 0; at = indexOf(out, OBJSTM, at + OBJSTM.length)) {
    if (isDelimiter(out[at + OBJSTM.length])) out.set(repl, at);
  }
  return out;
}

export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  // 暗号化の印がなければ、ふつうに読む
  if (indexOf(bytes, ENCRYPT) < 0) {
    try {
      const doc = await PDFDocument.load(bytes, LOAD_OPTIONS);
      if (!doc.isEncrypted) return { status: "ok", doc, decrypted: null };
    } catch {
      return { status: "error", code: "unreadable" };
    }
  }

  let masked: PDFDocument;
  try {
    masked = await PDFDocument.load(maskObjectStreams(bytes), LOAD_OPTIONS);
  } catch {
    return { status: "error", code: "unreadable" };
  }
  if (!masked.isEncrypted) {
    // 「/Encrypt」の文字はあったが、暗号化ではなかった。置き換えない写しで読み直す
    try {
      return { status: "ok", doc: await PDFDocument.load(bytes, LOAD_OPTIONS), decrypted: null };
    } catch {
      return { status: "error", code: "unreadable" };
    }
  }

  const ctx = masked.context;
  const r = await decryptContext(ctx);
  if (!r.ok) return { status: "error", code: "encrypted", reason: r.reason };
  try {
    // 復号したオブジェクトストリームを開いて、中のオブジェクトを文脈に入れる
    for (const ref of r.objectStreams ?? []) {
      const st = ctx.lookup(ref);
      if (st instanceof PDFRawStream) await PDFObjectStreamParser.forStream(st).parseIntoContext();
      ctx.delete(ref as PDFRef);
    }
    // xref ストリームは、書き出すときに要らない（新しく xref の表を書く）
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.lookup(TYPE)?.toString() === "/XRef") ctx.delete(ref);
    }
    const plain = await PDFWriter.forContext(ctx, 50).serializeToBuffer();
    const doc = await PDFDocument.load(plain, LOAD_OPTIONS);
    if (doc.isEncrypted) return { status: "error", code: "encrypted", reason: "broken" };
    return { status: "ok", doc, decrypted: { ...r.summary, failedObjects: r.failedObjects } };
  } catch {
    return { status: "error", code: "encrypted", reason: "broken" };
  }
}


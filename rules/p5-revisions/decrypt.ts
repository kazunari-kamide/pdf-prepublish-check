// SPDX-License-Identifier: AGPL-3.0-only
//
// P5 の検出ルールで、前の版の定義も復号する（PR #24 の返事の 1）。
// 復号そのものは共通の部品（rules/shared/decrypt.ts の decryptContext）を使い、このファイルでは書かない。
// decryptContext は「1つの文脈の中のオブジェクト全部」を解く作りなので、書き留めた定義を、同じ番号が重ならない組に分け、
// 組ごとに読み捨ての文脈に入れて解き、解けた中身を定義に戻す。オブジェクトの鍵は、その定義の番号と世代から作られる。
//
// オブジェクトストリームは、暗号化されたまま pdf-lib に開かせると壊れる。そのため、読む前に /ObjStm の名前を
// 同じ長さの別名（MASKED_OBJSTM）に置き換えておき（maskObjectStreams）、解いてからこのファイルで開く（expandObjectStream）。

import { PDFContext, PDFDict, PDFName, PDFNumber, PDFObjectParser, PDFRawStream, PDFRef, decodePDFRawStream, type PDFObject } from "pdf-lib";
import { MASKED_OBJSTM, decryptContext, type DecryptResult } from "../shared/decrypt.ts";

const OBJSTM = new TextEncoder().encode("/ObjStm");
const REPL = new TextEncoder().encode("/" + MASKED_OBJSTM);
const ENCRYPT = new TextEncoder().encode("/Encrypt");

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

export function hasEncryptMarker(bytes: Uint8Array): boolean {
  return indexOf(bytes, ENCRYPT) >= 0;
}

/** 名前 /ObjStm を同じ長さの別名に置き換えた写し（位置がずれないので、xref はそのまま使える）。利用者のファイルは変えない */
export function maskObjectStreams(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  for (let at = indexOf(out, OBJSTM); at >= 0; at = indexOf(out, OBJSTM, at + OBJSTM.length)) {
    if (isDelimiter(out[at + OBJSTM.length])) out.set(REPL, at);
  }
  return out;
}

export const isMaskedObjStm = (o: PDFObject) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Type")) === PDFName.of(MASKED_OBJSTM);

export type Decryptable = { num: number; gen: number; obj: PDFObject };

/**
 * 定義を復号する。encrypt は trailer の /Encrypt の値（参照か辞書）と、その参照の先の辞書。id は trailer の /ID。
 * 解けた中身は、それぞれの d.obj を置き換える（辞書・配列の中の文字列はその場で書き換わる）。
 * 返す値：失敗（パスワードが要るなど）なら DecryptResult の失敗。成功なら、解けなかったオブジェクトの数。
 */
export async function decryptDefinitions(
  defs: Decryptable[],
  encrypt: { entry: PDFObject; dict: PDFDict },
  id: PDFObject | undefined,
): Promise<{ ok: true; failedObjects: number; summary: Extract<DecryptResult, { ok: true }>["summary"] } | Extract<DecryptResult, { ok: false }>> {
  // 同じ番号・世代が重ならない組に分ける（k 番目に出てきた定義を k 番目の組に）
  const layers: Decryptable[][] = [];
  const seen = new Map<string, number>();
  for (const d of defs) {
    const key = `${d.num} ${d.gen}`;
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    (layers[k] ??= []).push(d);
  }
  let failedObjects = 0;
  let summary: Extract<DecryptResult, { ok: true }>["summary"] | null = null;
  const encRef = encrypt.entry instanceof PDFRef ? encrypt.entry : null;
  for (const layer of layers.length ? layers : [[]]) {
    const scratch = PDFContext.create();
    if (encRef) scratch.assign(encRef, encrypt.dict);
    scratch.trailerInfo = { Root: undefined, Info: undefined, ID: id, Encrypt: encRef ?? encrypt.dict } as unknown as typeof scratch.trailerInfo;
    const refs: Array<[Decryptable, PDFRef]> = [];
    for (const d of layer) {
      if (encRef && d.num === encRef.objectNumber && d.gen === encRef.generationNumber) continue; // 暗号化の辞書は解かない
      const ref = PDFRef.of(d.num, d.gen);
      scratch.assign(ref, d.obj);
      refs.push([d, ref]);
    }
    const r = await decryptContext(scratch);
    if (!r.ok) return r;
    summary = r.summary;
    failedObjects += r.failedObjects;
    for (const [d, ref] of refs) {
      const o = scratch.lookup(ref);
      if (o) d.obj = o;
    }
  }
  return { ok: true, failedObjects, summary: summary! };
}

/** 置き換えておいた名前を、/ObjStm に戻す（暗号化していない版のオブジェクトストリーム） */
export function unmaskObjectStream(o: PDFObject) {
  if (isMaskedObjStm(o)) (o as PDFRawStream).dict.set(PDFName.of("Type"), PDFName.of("ObjStm"));
}

/** オブジェクトストリームを開き、中の定義を返す（復号はしてあること）。読めない所は飛ばす */
export function expandObjectStream(stream: PDFRawStream, limit: number): Array<{ num: number; gen: number; obj: PDFObject }> {
  const out: Array<{ num: number; gen: number; obj: PDFObject }> = [];
  const n = stream.dict.get(PDFName.of("N"));
  const first = stream.dict.get(PDFName.of("First"));
  if (!(n instanceof PDFNumber) || !(first instanceof PDFNumber)) return out;
  let data: Uint8Array;
  try {
    data = decodePDFRawStream(stream).decode();
  } catch {
    return out;
  }
  const head = new TextDecoder("latin1").decode(data.subarray(0, first.asNumber()));
  const nums = head.trim().split(/\s+/).map(Number);
  const ctx = PDFContext.create();
  for (let i = 0; i < Math.min(n.asNumber(), limit) && 2 * i + 1 < nums.length; i++) {
    const num = nums[2 * i]!;
    const off = nums[2 * i + 1]!;
    if (!Number.isFinite(num) || !Number.isFinite(off)) break;
    try {
      const obj = PDFObjectParser.forBytes(data.subarray(first.asNumber() + off), ctx).parseObject();
      out.push({ num, gen: 0, obj });
    } catch {
      // 読めない定義は飛ばす
    }
  }
  return out;
}

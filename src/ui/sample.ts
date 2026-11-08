// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vite/client" />
//
// 見本の PDF（11/5 B の 4）。画面から1回押すだけで、検査を試せるようにする。
// - 中身は合成したテスト用 PDF（fixtures/p6/p6-t01-rect-over-name.pdf）を、手を加えずにそのまま使う。日本語・架空の内容
//   （架空の氏名と住所の上に黒い四角を重ねただけの申請書。文書情報にも値が入っている）。
// - ビルドのときに JavaScript の中へ data: の URL として埋め込む（?inline）。取りに行く通信は作らない（CLAUDE.md §2-1）。
//   data: の URL は取りに行かず、base64 を atob でほどく。（テストの型の確かめでも ?inline の型が要るので、上で vite/client を読む）

import sampleDataUrl from "../../fixtures/p6/p6-t01-rect-over-name.pdf?inline";
// 気づきにくい見本（2026-11-08）：期間中に足した 3 つの型（黒塗りのそばの記号・同じ書式のページの塗り残し・塗った字がほかの所に出ている）と、
// 作成者の名前・前の版の文書情報を入れた、架空の 4 ページの書類。作り方は demo/subtle-sample/（build.mjs・README.md）。同じく埋め込む
import subtleDataUrl from "../../demo/subtle-sample/subtle-sample.pdf?inline";

/** 見本の PDF のファイル名（画面に出す。架空） */
export const SAMPLE_NAME = "見本_申請書（架空）.pdf";
/** 気づきにくい見本のファイル名（画面に出す。架空） */
export const SUBTLE_SAMPLE_NAME = "見本_審査会資料（架空）.pdf";

/** data: の URL（base64）を、バイト列にほどく。形が違えば null */
export function decodeDataUrl(url: string): Uint8Array | null {
  const m = /^data:[^,;]*(?:;[^,;]*)*;base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m) return null;
  const bin = atob(m[1]!);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 見本の PDF。kind が "subtle" なら気づきにくい見本、ほかは基本の見本 */
export function sampleFile(kind: "basic" | "subtle" = "basic"): File | null {
  const bytes = decodeDataUrl(kind === "subtle" ? subtleDataUrl : sampleDataUrl);
  const name = kind === "subtle" ? SUBTLE_SAMPLE_NAME : SAMPLE_NAME;
  return bytes ? new File([bytes as Uint8Array<ArrayBuffer>], name, { type: "application/pdf" }) : null;
}

/**
 * アドレスの query が「?sample=1」を含むか（サービス紹介のページから、見本を開いたまま検査のページへ来るため）。
 * 値が 1 のときだけ。ほかの値・ほかの query は無視する。
 */
export function wantsSample(search: string): boolean {
  return new URLSearchParams(search).get("sample") === "1";
}

/** アドレスから sample だけを外した、同じページの場所（再読み込みで何度も読まないように。history.replaceState に渡す） */
export function withoutSample(pathname: string, search: string, hash: string): string {
  const q = new URLSearchParams(search);
  q.delete("sample");
  const rest = q.toString();
  return `${pathname}${rest ? `?${rest}` : ""}${hash}`;
}

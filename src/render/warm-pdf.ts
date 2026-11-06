// SPDX-License-Identifier: AGPL-3.0-only
//
// 部品を先に読み込むための、小さな架空の PDF（2026-11-06 本人が決定：画面の表示が終わってから、処理に要る部品を全部読み込む）。
// 8×8 の CCITT（G4）と JPEG 2000 の画像を 1 つずつ描いただけの 1 ページ（1,177 バイト。.tmp で PIL を使って作った）。
// PDF.js にこれを 1 回解かせると、CCITT・JBIG2・JPEG 2000 を解く部品（/pdfjs/…/wasm/）を、PDF を入れる前に読み込める。

const WARM_PDF_BASE64 =
  "JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAxNiA4XSAvUmVzb3VyY2VzIDw8IC9YT2JqZWN0IDw8IC9BIDUgMCBSIC9CIDYgMCBSID4+ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDQ5ID4+CnN0cmVhbQpxIDggMCAwIDggMCAwIGNtIC9BIERvIFEgcSA4IDAgMCA4IDggMCBjbSAvQiBEbyBRCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvWE9iamVjdCAvU3VidHlwZSAvSW1hZ2UgL1dpZHRoIDggL0hlaWdodCA4IC9Db2xvclNwYWNlIC9EZXZpY2VHcmF5IC9CaXRzUGVyQ29tcG9uZW50IDEgL0ZpbHRlciAvQ0NJVFRGYXhEZWNvZGUgL0RlY29kZVBhcm1zIDw8IC9LIC0xIC9Db2x1bW5zIDggL1Jvd3MgOCAvQmxhY2tJczEgZmFsc2UgPj4gL0xlbmd0aCAxNiA+PgpzdHJlYW0KI40UPsjnZHdgthbW4AIAIAplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKPDwgL1R5cGUgL1hPYmplY3QgL1N1YnR5cGUgL0ltYWdlIC9XaWR0aCA4IC9IZWlnaHQgOCAvQ29sb3JTcGFjZSAvRGV2aWNlR3JheSAvQml0c1BlckNvbXBvbmVudCA4IC9GaWx0ZXIgL0pQWERlY29kZSAvTGVuZ3RoIDIxOCA+PgpzdHJlYW0KAAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAACAAAAAgAAQcHAAAAAAAPY29scgEAAAAAABEAAACNanAyY/9P/1EAKQAAAAAACAAAAAgAAAAAAAAAAAAAAAgAAAAIAAAAAAAAAAAAAQcBAf9SAAwAAAABAAMEBAAB/1wADUBASEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAAEgAB/5OAgICA/9kKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDkgMDAwMDAgbiAKMDAwMDAwMDM0OCAwMDAwMCBuIAowMDAwMDAwNTkyIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNyAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKOTc0CiUlRU9GCg==";

/** 温めるための PDF のバイト列（呼ぶたびに新しい写しを返す。PDF.js が渡し切るため） */
export function warmPdfBytes(): Uint8Array {
  const bin = atob(WARM_PDF_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PDF.js の形のうち、温めるのに使うところだけ */
type PdfjsForWarm = {
  getDocument(src: Record<string, unknown>): { promise: Promise<{ getPage(n: number): Promise<{ getOperatorList(): Promise<unknown> }> }>; destroy(): Promise<void> };
};

/**
 * PDF.js に、温めるための PDF の画像を 1 回解かせる（ページの命令の一覧を作らせると、画像も解く）。
 * 失敗しても止めない（温めは、なくても検査はできる。その場合は、PDF を入れたあとに部品を読む）
 */
export async function warmPdfjs(lib: PdfjsForWarm, options: Record<string, unknown>): Promise<boolean> {
  const task = lib.getDocument({ data: warmPdfBytes(), ...options });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    await page.getOperatorList();
    return true;
  } catch {
    return false;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

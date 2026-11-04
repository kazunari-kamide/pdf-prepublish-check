// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする（11/5 B の 9）ための【仮のつなぎ】。片付けの redact（C が作る）がまだ main にないため、
// 利用者が選んだ所に、墨消しの注釈（/Redact。まだ適用していないもの）を足すだけにする。
// 片付け（sanitize/ の sanitizePdf）は、適用していない墨消しの注釈を見つけると、その下の字を消し、画像を塗り、
// 黒い四角を描き込んで、注釈を外す（sanitize/content.ts の scanAnnotations・applyRedactionBoxes）。それをそのまま使う。
// C の redact が main に入ったら、この関数の中を、それを呼ぶ形に置き換える（呼ぶ側の形は変えない）。
//
// - 暗号化された PDF には足さない（注釈を足して書き出すと、暗号の扱いがずれるため）。断って、理由を返す。
// - 選んだ所の数とページの範囲に上限をかける。

import { PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { MAX_REDACT_AREAS, type RedactArea } from "./areas";

export { MAX_REDACT_AREAS, type RedactArea };

export type AddRedactResult = { status: "ok"; bytes: Uint8Array; added: number } | { status: "refused"; message: string };

export async function addRedactAreas(bytes: Uint8Array, areas: RedactArea[]): Promise<AddRedactResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false, ignoreEncryption: true });
  } catch {
    return { status: "refused", message: "PDF を読めなかったため、自分で選んだ所を黒塗りできません。" };
  }
  if (doc.isEncrypted) return { status: "refused", message: "暗号化された PDF では、自分で選んだ所の黒塗りは、まだできません。" };
  const pages = doc.getPages();
  let added = 0;
  for (const a of areas.slice(0, MAX_REDACT_AREAS)) {
    const page = pages[a.page - 1];
    const [x0, y0, x1, y1] = a.rect;
    if (!page || ![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
    const annot = doc.context.obj({
      Type: "Annot",
      Subtype: "Redact",
      Rect: [x0, y0, x1, y1],
      IC: [0, 0, 0],
      F: PDFNumber.of(4),
    });
    const ref = doc.context.register(annot);
    const existing = page.node.Annots();
    if (existing) existing.push(ref);
    else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
    added++;
  }
  // 足したものを、片付けにそのまま渡す（片付けが、前の版も含めて1つの版に書き直す）
  return { status: "ok", bytes: await doc.save({ useObjectStreams: false }), added };
}

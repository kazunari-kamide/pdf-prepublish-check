// SPDX-License-Identifier: AGPL-3.0-only
//
// ページの形（見える範囲と回転）を読む。Worker の中で使う。
// 読み込みは検出ルールと同じ入口（rules/shared/load.ts）を使い、暗号化の扱いもそろえる。

import { loadPdf } from "../../rules/shared/load.ts";
import type { PageBox, Rect } from "./report.ts";

/** 画面に描くページの数の上限。超えた分は描かない（一覧には出る） */
export const MAX_DRAWN_PAGES = 2000;

function intersect(a: Rect, b: Rect): Rect {
  const r: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[2] > r[0] && r[3] > r[1] ? r : a;
}

function normalizeRotate(n: number): PageBox["rotate"] {
  const r = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  return r as PageBox["rotate"];
}

export async function readPageBoxes(bytes: Uint8Array): Promise<PageBox[] | null> {
  const loaded = await loadPdf(bytes);
  if (loaded.status !== "ok") return null;
  try {
    const pages = loaded.doc.getPages().slice(0, MAX_DRAWN_PAGES);
    return pages.map((p, i) => {
      const mb = p.getMediaBox();
      const cb = p.getCropBox();
      const media: Rect = [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height];
      const crop: Rect = [cb.x, cb.y, cb.x + cb.width, cb.y + cb.height];
      const ok = media.every(Number.isFinite) && media[2] > media[0] && media[3] > media[1];
      const view: Rect = ok ? intersect(media, crop) : [0, 0, 612, 792];
      return { page: i + 1, view, rotate: normalizeRotate(p.getRotation().angle) };
    });
  } catch {
    return null;
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// build.mjs の型（tests/demo-scan-minutes.test.ts が読む値だけ）

export declare const IMAGE: { width: number; height: number };
export declare const PAGE: { width: number; height: number };
export declare const OUT: { pdf: string; pdfMarked: string; image: string; imageMarked: string; boxes: string };
export declare const REDACTED: { name: string; address: string; reason: string };
export interface PixelBox {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export declare function padBox(b: PixelBox): PixelBox;
export declare function toPdfRect(b: PixelBox): [number, number, number, number];

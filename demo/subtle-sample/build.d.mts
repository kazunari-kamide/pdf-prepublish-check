// SPDX-License-Identifier: AGPL-3.0-only
// build.mjs の型（tests/demo-subtle-sample.test.ts が読む）

type Rect = { x: number; y: number; w: number; h: number };

export declare const OUT: string;
export declare const PAGE: { width: number; height: number };
export declare const FICTION: { city: string; author: string; place: string; name3: string };
export declare const BOXES: { p1Address: Rect; p2: Rect[]; p3: Rect[] };
export declare function build(): Promise<Uint8Array>;

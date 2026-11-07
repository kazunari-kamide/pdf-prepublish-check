// SPDX-License-Identifier: AGPL-3.0-only
//
// 新しい型の合成 PDF の一覧と、検出ルールの報告を鍵にそろえる変換。
// tests/new-rules-cases.test.ts と eval/new-rules.ts の両方で使う。

import { detectP8Annot } from "../../rules/p8-annot/index.ts";
import type { Case } from "./pdf.ts";
import * as p8 from "./p8.ts";
import * as p2 from "./p2.ts";
import { detectP2Xmp } from "../../rules/p2-xmp/index.ts";
import * as p12 from "./p12.ts";
import { detectP12Actions } from "../../rules/p12-actions/index.ts";
import * as p11 from "./p11.ts";
import { detectP11Forms } from "../../rules/p11-forms/index.ts";
import * as p9i from "./p9-inner.ts";
import { inspectAttachments } from "../../rules/p9-attach/inner.ts";
import * as p10 from "./p10.ts";
import { detectP10Exif } from "../../rules/p10-exif/index.ts";
import * as p4 from "./p4.ts";
import { detectP4Paths } from "../../rules/p4-paths/index.ts";
import * as alt from "./alt-text.ts";
import { detectAltText } from "../../rules/alt-text/index.ts";
import * as ext from "./extras.ts";
import { detectExtras } from "../../rules/extras/index.ts";
import * as fg from "./font-glyphs.ts";
import { detectFontGlyphs } from "../../rules/font-glyphs/index.ts";
import * as p3 from "./p3.ts";
import { detectP3Orgs } from "../../rules/p3-orgs/index.ts";
import * as pp from "./p2-parts.ts";
import { detectP2Parts } from "../../rules/p2-parts/index.ts";
import * as ui from "./unused-images.ts";
import { detectUnusedImages } from "../../rules/unused-images/index.ts";
import * as p7i from "./p7-images.ts";
import * as p6v from "./p6-vector.ts";
import * as fgc from "./font-glyphs-cff.ts";
import { detectFontGlyphsCff } from "../../rules/font-glyphs-cff/index.ts";

export type TypeCases = {
  /** 型の番号と、画面の名前 */
  pattern: string;
  label: string;
  ruleId: string;
  cases: Case[];
  /** 検出ルールを呼び、報告を鍵の並びにする */
  keys(bytes: Uint8Array): Promise<string[]>;
};

export const TYPES: TypeCases[] = [
  { pattern: "P8", label: "注釈", ruleId: "p8-annot", cases: p8.CASES, keys: async (b) => p8.keysOf(await detectP8Annot(b)) },
  { pattern: "P2", label: "文書全体の XMP", ruleId: "p2-xmp", cases: p2.CASES, keys: async (b) => p2.keysOf(await detectP2Xmp(b)) },
  { pattern: "P12", label: "JavaScript・開いたときの動作", ruleId: "p12-actions", cases: p12.CASES, keys: async (b) => p12.keysOf(await detectP12Actions(b)) },
  { pattern: "P11", label: "フォームの値", ruleId: "p11-forms", cases: p11.CASES, keys: async (b) => p11.keysOf(await detectP11Forms(b)) },
  { pattern: "P9", label: "添付ファイルの中身", ruleId: "p9-attach（inner）", cases: p9i.CASES, keys: async (b) => p9i.keysOf(await inspectAttachments(b, p9i.DETECTORS)) },
  { pattern: "P10", label: "画像の Exif", ruleId: "p10-exif", cases: p10.CASES, keys: async (b) => p10.keysOf(await detectP10Exif(b)) },
  { pattern: "P4", label: "ファイルパス・内部ホスト名", ruleId: "p4-paths", cases: p4.CASES, keys: async (b) => p4.keysOf(await detectP4Paths(b)) },
  { pattern: "P7", label: "しおりの題・代わりの文字", ruleId: "alt-text", cases: alt.CASES, keys: async (b) => alt.keysOf(await detectAltText(b)) },
  { pattern: "P5", label: "ページの縮小画像・XFA・C2PA", ruleId: "extras", cases: ext.CASES, keys: async (b) => ext.keysOf(await detectExtras(b)) },
  { pattern: "P7", label: "書体に残った字形", ruleId: "font-glyphs", cases: fg.CASES, keys: async (b) => fg.keysOf(await detectFontGlyphs(b)) },
  { pattern: "P3", label: "他組織名の混入", ruleId: "p3-orgs", cases: p3.CASES, keys: async (b) => p3.keysOf(await detectP3Orgs(b)) },
  { pattern: "P2", label: "部品の XMP・アプリのデータ", ruleId: "p2-parts", cases: pp.CASES, keys: async (b) => pp.keysOf(await detectP2Parts(b)) },
  { pattern: "P5", label: "描かれていない画像", ruleId: "unused-images", cases: ui.CASES, keys: async (b) => ui.keysOf(await detectUnusedImages(b)) },
  { pattern: "P7", label: "見えない所に置いた画像", ruleId: "p7-hidden（画像）", cases: p7i.CASES, keys: async (b) => p7i.keysOf(await p7i.detect(b)) },
  { pattern: "P6", label: "白い注釈の下の図形", ruleId: "p6-text（図形の層）", cases: p6v.CASES, keys: async (b) => p6v.keysOf(await p6v.detect(b)) },
  { pattern: "P7", label: "CFF の書体に残った字形", ruleId: "font-glyphs-cff", cases: fgc.CASES, keys: async (b) => fgc.keysOf(await detectFontGlyphsCff(b)) },
];

export type Score = {
  pattern: string;
  label: string;
  /** 隠しの数（すべての合成 PDF の、返すべき鍵の数）と、そのうち返した数 */
  expected: number;
  found: number;
  /** 返すべきでない鍵を返した数（誤検知）と、対照の合成 PDF のうち、誤検知が1つでもあった数 */
  extra: number;
  controls: number;
  controlsWithExtra: number;
  failures: Array<{ id: string; missed: string[]; extra: string[] }>;
};

/** 鍵を1対1で結ぶ。残った返すべき鍵が見逃し、残った返した鍵が誤検知 */
export function compare(expected: string[], got: string[]): { missed: string[]; extra: string[] } {
  const rest = [...got];
  const missed: string[] = [];
  for (const e of expected) {
    const i = rest.indexOf(e);
    if (i >= 0) rest.splice(i, 1);
    else missed.push(e);
  }
  return { missed, extra: rest };
}

export async function scoreType(t: TypeCases): Promise<Score> {
  const s: Score = { pattern: t.pattern, label: t.label, expected: 0, found: 0, extra: 0, controls: 0, controlsWithExtra: 0, failures: [] };
  for (const c of t.cases) {
    const got = await t.keys(await c.build());
    const { missed, extra } = compare(c.leaks, got);
    s.expected += c.leaks.length;
    s.found += c.leaks.length - missed.length;
    s.extra += extra.length;
    if (c.kind === "control") {
      s.controls++;
      if (extra.length) s.controlsWithExtra++;
    }
    if (missed.length || extra.length) s.failures.push({ id: c.id, missed, extra });
  }
  return s;
}

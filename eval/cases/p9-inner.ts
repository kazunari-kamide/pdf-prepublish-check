// SPDX-License-Identifier: AGPL-3.0-only
//
// P9（添付ファイル）の中身の合成 PDF。鍵は「中身の種類:中で見つけた型（並べたもの）」。文字のファイルは「text」。
// 中の PDF にかける検出ルールは DETECTORS（文書情報・文書全体の XMP・注釈・フォーム・JavaScript）。

import { detectP1Info } from "../../rules/p1-info/index.ts";
import { detectP2Xmp } from "../../rules/p2-xmp/index.ts";
import { detectP8Annot } from "../../rules/p8-annot/index.ts";
import { detectP11Forms } from "../../rules/p11-forms/index.ts";
import { detectP12Actions } from "../../rules/p12-actions/index.ts";
import type { InnerDetector, P9Inner } from "../../rules/p9-attach/inner.ts";
import { addAnnot, hex, newDoc, save, setInfo, type Case } from "./pdf.ts";

export const DETECTORS: InnerDetector[] = [
  async (b) => (await detectP1Info(b)).findings,
  async (b) => (await detectP2Xmp(b)).findings,
  async (b) => (await detectP8Annot(b)).findings,
  async (b) => (await detectP11Forms(b)).findings,
  async (b) => (await detectP12Actions(b)).findings,
];

export const keysOf = (inner: P9Inner[]) =>
  inner.map((i) => (i.kind === "pdf" ? `pdf:${Object.keys(i.counts ?? {}).sort().join(",")}` : i.kind));

async function pdfWithAuthor(name: string): Promise<Uint8Array> {
  const { doc } = await newDoc();
  setInfo(doc, { Author: hex(name) });
  return save(doc);
}

async function cleanPdf(): Promise<Uint8Array> {
  const { doc } = await newDoc();
  return save(doc);
}

export const CASES: Case[] = [
  {
    id: "p9i-l01",
    kind: "leak",
    description: "添付の PDF の文書情報に、作成者",
    leaks: ["pdf:P1"],
    async build() {
      const { doc } = await newDoc();
      await doc.attach(await pdfWithAuthor("山田太郎"), "inner.pdf", { mimeType: "application/pdf" });
      return save(doc);
    },
  },
  {
    id: "p9i-l02",
    kind: "leak",
    description: "添付の PDF に隠した注釈と、Shift_JIS の文字のファイル",
    leaks: ["pdf:P8", "text"],
    async build() {
      const inner = await newDoc();
      addAnnot(inner.ctx, inner.pages[0]!, { Subtype: "Text", Contents: hex("内部のメモ"), F: 2 });
      const { doc } = await newDoc();
      await doc.attach(await save(inner.doc), "a.pdf", { mimeType: "application/pdf" });
      // 「架空の名簿」を Shift_JIS で書いたバイト列
      const sjis = new Uint8Array([0x89, 0xcb, 0x8b, 0xf3, 0x82, 0xcc, 0x96, 0xbc, 0x95, 0xeb, 0x0d, 0x0a]);
      await doc.attach(sjis, "list.txt", { mimeType: "text/plain" });
      return save(doc);
    },
  },
  {
    id: "p9i-l03",
    kind: "leak",
    description: "入れ子：添付の PDF の中の添付の PDF に、作成者（外の添付の数に足す。中の添付そのものも P9 として数える）",
    leaks: ["pdf:P1,P9"],
    async build() {
      const middle = await newDoc();
      await middle.doc.attach(await pdfWithAuthor("Suzuki"), "deep.pdf", { mimeType: "application/pdf" });
      const { doc } = await newDoc();
      await doc.attach(await save(middle.doc), "middle.pdf", { mimeType: "application/pdf" });
      return save(doc);
    },
  },
  {
    id: "p9i-l04",
    kind: "leak",
    description: "UTF-8 の CSV（種類の名前なし、拡張子だけ）",
    leaks: ["text"],
    async build() {
      const { doc } = await newDoc();
      await doc.attach(new TextEncoder().encode("氏名,番号\n架空花子,0001\n"), "x.csv");
      return save(doc);
    },
  },
  {
    id: "p9i-c01",
    kind: "control",
    description: "何も残っていない PDF の添付（中で何も見つけない）",
    leaks: ["pdf:"],
    async build() {
      const { doc } = await newDoc();
      await doc.attach(await cleanPdf(), "clean.pdf", { mimeType: "application/pdf" });
      return save(doc);
    },
  },
  {
    id: "p9i-c02",
    kind: "control",
    description: "画像（PNG の見出し）の添付は、文字のファイルとして数えない",
    leaks: ["other"],
    async build() {
      const { doc } = await newDoc();
      await doc.attach(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), "p.png", { mimeType: "image/png" });
      return save(doc);
    },
  },
];

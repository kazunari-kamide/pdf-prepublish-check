// SPDX-License-Identifier: AGPL-3.0-only
//
// 自分で黒塗りする（sanitize/redact.ts）の採点。合成 PDF（tests/helpers/redact-pdfs.ts。中身はすべて架空）を場面ごとに黒塗りし、
// 保存の前の読み直し（選んだ場所の確かめ・作品の検査・検証器 P6）で残りを数える。
//
//   npm run eval:redact（Vitest で tests/redact-eval.test.ts から呼ぶ。作品の検査 src/inspect は Vite の読み方で書かれていて、そのままの Node では読めないため）
//
// 数えるもの：
//   - 黒塗りできた場面（ok）と、保存させなかった場面（blocked）。期待どおりかどうか
//   - 消した字・塗った画素・外した注釈と欄
//   - 読み直しの残り（確かめごと）。ok の場面では 0 件であること
//   - 見せかけの黒塗り（黒い四角を重ねただけ）を、同じ確かめにかけたときに見つけた残り（確かめが空振りしていないこと）
// 字の中身はログに出さない（件数だけ）。

import { PDFDict, PDFName, PDFString } from "pdf-lib";
import { redact, type RedactArea, type RedactOptions } from "../sanitize/index.ts";
import { checkAreas } from "../sanitize/redact-check.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";
import { allChecks } from "../tests/helpers/redact-checks.ts";
import { appendRevision, buildPdf, imageFlate, imageJpeg, latinAt, scanPixels, textAt } from "../tests/helpers/redact-pdfs.ts";

type Case = { name: string; build: () => Promise<Uint8Array>; areas: RedactArea[]; expect: "ok" | "blocked"; options?: RedactOptions };

const LINE = () => textAt(50, 200, "氏名見本花子") + textAt(50, 170, "電話番号〇一二三");
const NAME: RedactArea = { page: 1, rect: [75, 195, 121, 215] };
const IMG: RedactArea = { page: 1, rect: [150, 80, 250, 120] };
const DRAW = "q 200 0 0 100 100 50 cm /Im1 Do Q\n";

const CASES: Case[] = [
  { name: "字の上", build: () => buildPdf(() => ({ pages: [{ content: LINE() }] })), areas: [NAME], expect: "ok" },
  { name: "字の一部だけが掛かる所", build: () => buildPdf(() => ({ pages: [{ content: LINE() }] })), areas: [{ page: 1, rect: [96, 195, 99, 215] }], expect: "ok" },
  {
    name: "表の中",
    build: () => buildPdf(() => ({
      pages: [{ content: "0 G 1 w 50 100 m 350 100 l 50 140 m 350 140 l 50 180 m 350 180 l 50 100 m 50 180 l 150 100 m 150 180 l 350 100 m 350 180 l S\n" + textAt(60, 155, "氏名") + textAt(160, 155, "見本太郎") + textAt(160, 115, "東西町一丁目") }],
    })),
    areas: [{ page: 1, rect: [152, 142, 348, 178] }], expect: "ok",
  },
  { name: "縦書き", build: () => buildPdf(() => ({ pages: [{ content: textAt(300, 250, "氏名見本花子", "/V1") }] })), areas: [{ page: 1, rect: [290, 178.5, 310, 225] }], expect: "ok" },
  { name: "スキャンの画像（Flate）", build: () => buildPdf((d) => ({ pages: [{ content: DRAW, images: [imageFlate(d.context, 200, 100, 1, scanPixels(200, 100))] }] })), areas: [IMG], expect: "ok" },
  { name: "スキャンの画像（JPEG・画像の道具あり）", build: () => buildPdf(async (d) => ({ pages: [{ content: DRAW, images: [await imageJpeg(d.context, 200, 100)] }] })), areas: [IMG], expect: "ok", options: { codec: createNodeImageCodec() } },
  { name: "スキャンの画像（JPEG・画像の道具なし）", build: () => buildPdf(async (d) => ({ pages: [{ content: DRAW, images: [await imageJpeg(d.context, 200, 100)] }] })), areas: [IMG], expect: "blocked" },
  {
    name: "注釈の上",
    build: () => buildPdf(() => ({ pages: [{ content: LINE(), annots: [{ Subtype: "Square", Rect: [76, 190, 120, 220], Contents: PDFString.of("MEMO"), IC: [1, 1, 0], F: 4 }] }] })),
    areas: [NAME], expect: "ok",
  },
  {
    name: "フォームの欄",
    build: () => buildPdf(() => ({
      pages: [{ content: latinAt(50, 250, "Name"), annots: [{ Subtype: "Widget", FT: "Tx", T: PDFString.of("name"), V: PDFString.of("MIHON"), Rect: [100, 240, 250, 265], F: 4 }] }],
      acroForm: (ctx, widgets) => (ctx.lookup(ctx.trailerInfo.Root) as PDFDict).set(PDFName.of("AcroForm"), ctx.obj({ Fields: widgets })),
    })),
    areas: [{ page: 1, rect: [110, 245, 200, 260] }], expect: "ok",
  },
  { name: "前の版のある PDF", build: async () => appendRevision(await buildPdf(() => ({ pages: [{ content: latinAt(50, 100, "OLD-0000") + LINE() }] })), LINE()), areas: [NAME], expect: "ok" },
  {
    name: "ページに直接埋め込んだ画像",
    build: () => buildPdf(() => ({ pages: [{ content: "q 100 0 0 50 100 100 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\xff\x00 EI Q\n" + textAt(100, 120, "見本") }] })),
    areas: [{ page: 1, rect: [100, 100, 200, 150] }], expect: "blocked",
  },
  { name: "対照：何も選ばない", build: () => buildPdf(() => ({ pages: [{ content: LINE() }] })), areas: [], expect: "ok" },
  { name: "対照：字のない所", build: () => buildPdf(() => ({ pages: [{ content: LINE() }] })), areas: [{ page: 1, rect: [250, 50, 350, 100] }], expect: "ok" },
];

export async function runRedactEval(log: (line: string) => void = console.log): Promise<{ cases: number; asExpected: number; leftInOk: number; fake: Record<string, number> }> {
  let asExpected = 0;
  let leftInOk = 0;
  const totals = { text: 0, pixels: 0, annots: 0, fields: 0, unicode: 0 };
  for (const c of CASES) {
    const r = await redact(await c.build(), c.areas, { checks: allChecks, ...c.options });
    if (r.status === "error") {
      log(`× ${c.name}：開けませんでした（${r.code}）`);
      continue;
    }
    const sum = (k: string) => r.removed.filter((x) => x.kind === k).reduce((s, x) => s + x.count, 0);
    const t = { text: sum("redacted_text"), pixels: sum("redacted_pixels"), annots: sum("redacted_annotation"), fields: sum("redacted_field"), unicode: sum("font_unicode") };
    for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += t[k];
    const left = r.status === "blocked" ? r.leftovers : [];
    const byCheck = new Map<string, number>();
    for (const l of left) byCheck.set(l.check, (byCheck.get(l.check) ?? 0) + 1);
    const good = r.status === c.expect;
    if (good) asExpected++;
    if (r.status === "ok") leftInOk += left.length;
    log(
      `${good ? "○" : "×"} ${c.name}：${r.status === "ok" ? "保存できる" : "保存させない"}（期待：${c.expect === "ok" ? "保存できる" : "保存させない"}）` +
      `　字 ${t.text}・画素 ${t.pixels}・注釈 ${t.annots}・欄 ${t.fields}・対応表 ${t.unicode}` +
      (left.length ? `　残り ${[...byCheck].map(([k, n]) => `${k} ${n}`).join("・")}` : ""),
    );
  }

  // 確かめが空振りしていないこと：見せかけの黒塗り（黒い四角を重ねただけ）を、同じ確かめにかける
  const fake = await buildPdf((d) => ({
    pages: [{ content: LINE() + "0 g 75 195 46 20 re f\n" + DRAW + "0 g 150 80 100 40 re f\n", images: [imageFlate(d.context, 200, 100, 1, scanPixels(200, 100))] }],
  }));
  const fakeLeft = [...(await checkAreas(fake, [NAME, IMG]))];
  for (const ch of allChecks) fakeLeft.push(...(await ch.run(fake, [NAME, IMG])));
  const fakeBy = new Map<string, number>();
  for (const l of fakeLeft) fakeBy.set(l.check, (fakeBy.get(l.check) ?? 0) + 1);

  log("");
  log(`まとめ：場面 ${CASES.length} 個のうち、期待どおり ${asExpected} 個。保存できた場面の読み直しの残り ${leftInOk} 件`);
  log(`　消したもの：字 ${totals.text} 字・画素 ${totals.pixels} 個・注釈 ${totals.annots} 個・欄 ${totals.fields} 個・字の対応表 ${totals.unicode} 字分`);
  log(`　見せかけの黒塗りでの確かめ：${["area", "rules", "verifier"].map((k) => `${k} ${fakeBy.get(k) ?? 0} 件`).join("・")}（0 件の確かめがあれば、その確かめは空振り）`);
  return { cases: CASES.length, asExpected, leftInOk, fake: Object.fromEntries(fakeBy) };
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// ファイルを小さくする（sanitize/compress.ts）の測定。前後の大きさと、読み直しで残りが増えないことを測る（npm run eval:compress）。
//   1. 合成 PDF の場面（tests/helpers/compress-pdfs.ts）を、片付けてから、3 つの設定で小さくする
//   2. 黒塗りしたスキャン（redact）を小さくし、黒く塗った所が塗られたままか（選んだ場所の確かめ）も見る
//   3. 前からの合成 PDF（fixtures/ の全部）を片付けてから、既定の設定で小さくする
// 確かめは、作品の検査（全部のルール）と検証器 P6（tests/helpers/redact-checks.ts）。
// src/ の検査を読み込むので、Node だけでは動かない（Vitest から回す。tests/compress-eval.test.ts）。

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { COMPRESS_DPI, COMPRESS_QUALITY, compress, redact, sanitizePdf } from "../sanitize/index.ts";
import { createNodeImageCodec } from "../sanitize/node/image-codec.ts";
import { checkAreas } from "../sanitize/redact-check.ts";
import { allChecks } from "../tests/helpers/redact-checks.ts";
import { A4, SCENES, a4px, scanGray } from "../tests/helpers/compress-pdfs.ts";
import { buildPdf, imageFlate } from "../tests/helpers/redact-pdfs.ts";

export const SETTINGS_TO_TRY = [
  { maxDpi: 200, jpegQuality: 0.85 },
  { maxDpi: 150, jpegQuality: 0.75 },
  { maxDpi: 100, jpegQuality: 0.6 },
] as const;

const kb = (n: number) => `${(n / 1024).toLocaleString("ja-JP", { maximumFractionDigits: 0 })} KB`;
const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;

export type CompressEval = {
  scenes: number;
  asExpected: number;
  blocked: number;
  increased: number;
  redactedLeft: number;
  edgeLeft: number;
  fixtures: Array<{ maxDpi: number; jpegQuality: number; files: number; changed: number; blocked: number; before: number; after: number }>;
};

export async function runCompressEval(log: (line: string) => void = console.log): Promise<CompressEval> {
  const codec = createNodeImageCodec();
  let asExpected = 0;
  let blocked = 0;
  let increased = 0;

  // 1. 合成 PDF の場面
  log("場面ごと（片付けたあとの大きさ → 小さくしたあと。設定は 細かさ dpi／JPEG の質）");
  for (const s of SCENES) {
    const cleaned = await sanitizePdf(await s.make(), { codec });
    if (cleaned.status !== "ok") {
      log(`× ${s.name}：片付けられませんでした`);
      continue;
    }
    const cells: string[] = [];
    let good = true;
    for (const opt of SETTINGS_TO_TRY) {
      const r = await compress(cleaned.bytes, { codec, ...opt, checks: allChecks });
      if (r.status === "error") {
        cells.push(`${opt.maxDpi}／${opt.jpegQuality}：エラー（${r.code}）`);
        good = false;
        continue;
      }
      if (r.status === "blocked") {
        blocked++;
        increased += r.increased.length;
        good = false;
        cells.push(`${opt.maxDpi}／${opt.jpegQuality}：保存させない（増えた残り ${r.increased.length} 種類）`);
        continue;
      }
      if (r.changed !== s.expectChanged) good = false;
      cells.push(`${opt.maxDpi}／${opt.jpegQuality}：${kb(r.sizeAfter)}（${pct(r.sizeAfter, r.sizeBefore)}）`);
    }
    if (good) asExpected++;
    log(`${good ? "○" : "×"} ${s.name}：${kb(cleaned.bytes.length)} → ${cells.join("、")}`);
  }

  // 2. 黒塗りしたスキャンを小さくする
  const [w, h] = a4px(300);
  const area = { page: 1, rect: [100, 500, 400, 560] as [number, number, number, number] };
  const scan = await buildPdf((doc) => ({ pages: [{ size: A4, content: `q ${A4[0]} 0 0 ${A4[1]} 0 0 cm /Im1 Do Q\n`, images: [imageFlate(doc.context, w, h, 1, scanGray(w, h, 21))] }] }));
  const red = await redact(scan, [area], { codec, checks: allChecks });
  let redactedLeft = 0;
  let edgeLeft = 0;
  if (red.status !== "ok") {
    log(`× 黒塗りしたスキャン：黒塗りが通りませんでした（${red.status}）`);
    redactedLeft = -1;
  } else {
    const r = await compress(red.bytes, { codec, checks: allChecks });
    if (r.status !== "ok") {
      log(`× 黒塗りしたスキャン：小さくできませんでした（${r.status}）`);
      redactedLeft = -1;
    } else {
      // 縮めると、箱の縁の画素（縮めたあとの 1 画素ぶん）は、箱の中の黒と箱の外の紙の色が混ざる（箱の外は、もともと見えている所）。
      // そのため、縁を含めた数と、縁（縮めたあとの 1 画素 ＝ 72 / dpi ポイント）を除いた内側の数を、両方出す。合否は内側で見る
      const count = async (m: number) =>
        (await checkAreas(r.bytes, [{ page: 1, rect: [area.rect[0] + m, area.rect[1] + m, area.rect[2] - m, area.rect[3] - m] }], { codec })).reduce((n, l) => n + l.count, 0);
      edgeLeft = await count(0);
      redactedLeft = await count(72 / 150);
      log(
        `${redactedLeft === 0 ? "○" : "×"} 黒塗りしたスキャン（300dpi の A4）：${kb(r.sizeBefore)} → ${kb(r.sizeAfter)}（${pct(r.sizeAfter, r.sizeBefore)}）。` +
        `黒く塗った所の、塗られていない画素：縁を除いた内側 ${redactedLeft} 個（縁を含めると ${edgeLeft} 個。縁は箱の外の紙の色が混ざった画素）`,
      );
    }
  }

  // 3. 前からの合成 PDF。既定の設定と、いちばん強い設定（画像が小さくても縮めるので、読み直しの確かめが働く）の 2 つ
  const root = path.resolve(import.meta.dirname, "..");
  const cleanedAll: Array<{ rel: string; bytes: Uint8Array }> = [];
  for (const dir of ["p1", "p5", "p6", "p7", "p9"]) {
    for (const name of readdirSync(path.join(root, "fixtures", dir)).filter((x) => x.endsWith(".pdf"))) {
      const cleaned = await sanitizePdf(new Uint8Array(readFileSync(path.join(root, "fixtures", dir, name))), { codec });
      if (cleaned.status === "ok") cleanedAll.push({ rel: `${dir}/${name}`, bytes: cleaned.bytes });
    }
  }
  const fixtures: CompressEval["fixtures"] = [];
  for (const opt of [{ maxDpi: COMPRESS_DPI.default, jpegQuality: COMPRESS_QUALITY.default }, { maxDpi: COMPRESS_DPI.min, jpegQuality: COMPRESS_QUALITY.min }]) {
    const f = { ...opt, files: 0, changed: 0, blocked: 0, before: 0, after: 0 };
    for (const { rel, bytes } of cleanedAll) {
      const r = await compress(bytes, { codec, ...opt, checks: allChecks });
      f.files++;
      f.before += bytes.length;
      if (r.status === "blocked") {
        f.blocked++;
        f.after += bytes.length;
        log(`× ${rel}（${opt.maxDpi}／${opt.jpegQuality}）：小さくしたあとの読み直しで残りが増えた（${r.increased.map((i) => `${i.check}/${i.kind}${i.pattern ? `/${i.pattern}` : ""} ${i.before}→${i.after}`).join("・")}）`);
        continue;
      }
      if (r.status === "error") {
        f.after += bytes.length;
        continue;
      }
      if (r.changed) f.changed++;
      f.after += r.sizeAfter;
    }
    fixtures.push(f);
    log(`前からの合成 PDF（片付けたもの）${f.files} 個・${opt.maxDpi}／${opt.jpegQuality}：合計 ${kb(f.before)} → ${kb(f.after)}（${pct(f.after, f.before)}）。画像を書き直した PDF ${f.changed} 個、保存させなかった PDF ${f.blocked} 個`);
  }
  log(`まとめ：場面 ${SCENES.length} 個のうち、期待どおり ${asExpected} 個。読み直しで保存させなかった ${blocked} 回`);
  return { scenes: SCENES.length, asExpected, blocked, increased, redactedLeft, edgeLeft, fixtures };
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// 合成 PDF（fixtures/<型>/）を片付け（sanitize/）にかけ、片付けた PDF をフォルダに書き出す。
// そのあと、型ごとの採点（eval/<型>.ts --sanitized <フォルダ>）を回せば、「片付けたあとに残る情報」を測れる。
//
//   npm run eval:sanitize                         5つの型（p6・p1・p9・p5・p7）すべてを片付けて、採点まで回す
//   npm run eval:sanitize -- p6 p7                 型を選ぶ
//   npm run eval:sanitize -- --out <フォルダ>       書き出す先（既定は .tmp/sanitized。型ごとに <フォルダ>/<型>/）
//   npm run eval:sanitize -- --no-score            片付けるだけで、採点しない
//
// 採点は、いつもどおり npm run eval:p6 -- --sanitized .tmp/sanitized/p6 でも回せる（同じもの）。
// 書き出した PDF の中身・取り除いた字は、ログに出さない（件数だけ）。

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sanitizePdf } from "../sanitize/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const TYPES = ["p6", "p1", "p9", "p5", "p7"] as const;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const outRoot = path.resolve(argValue("--out") ?? path.join(ROOT, ".tmp", "sanitized"));
  const score = !process.argv.includes("--no-score");
  const picked = process.argv.slice(2).filter((a) => (TYPES as readonly string[]).includes(a));
  const types = picked.length ? picked : [...TYPES];
  let failed = false;

  for (const type of types) {
    const dir = path.join(ROOT, "fixtures", type);
    const out = path.join(outRoot, type);
    mkdirSync(out, { recursive: true });
    const files = readdirSync(dir).filter((f) => f.endsWith(".pdf")).sort();
    const summary: Array<Record<string, unknown>> = [];
    let ok = 0, errors = 0, notDone = 0;
    const started = Date.now();
    for (const f of files) {
      const t0 = Date.now();
      const r = await sanitizePdf(new Uint8Array(readFileSync(path.join(dir, f))));
      if (r.status === "ok") {
        writeFileSync(path.join(out, f), r.bytes);
        ok++;
        notDone += r.notDone.length;
        summary.push({
          file: f, status: "ok", ms: Date.now() - t0,
          removed: r.removed.map((x) => ({ pattern: x.pattern, kind: x.kind, count: x.count, page: x.page, rect: x.rect, reason: x.reason })),
          notDone: r.notDone.map((x) => ({ pattern: x.pattern, reason: x.reason, page: x.page })),
        });
      } else {
        errors++;
        summary.push({ file: f, status: "error", code: r.code, ms: Date.now() - t0 });
      }
    }
    writeFileSync(path.join(out, "_summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(`片付け：${type}　合成 PDF ${files.length} 個（片付けた ${ok} 個、開けなかった ${errors} 個、片付けられなかった所 ${notDone} 件）　${((Date.now() - started) / 1000).toFixed(1)} 秒`);

    if (score) {
      const r = spawnSync(process.execPath, [path.join(ROOT, "eval", `${type}.ts`), "--sanitized", out], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const lines = (r.stdout || "").split(/\r?\n/);
      for (const l of lines) if (l.startsWith("片付けたあとに残る情報")) console.log(`  ${l}`);
      if (!lines.some((l) => l.startsWith("片付けたあとに残る情報"))) {
        console.log(r.stdout);
        console.log(r.stderr);
        failed = true;
      }
      if (lines.some((l) => l.startsWith("片付けたあとに残る情報") && l.includes("満たさない"))) failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.main) await main();

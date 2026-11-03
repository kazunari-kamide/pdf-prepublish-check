#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// run-baseline.mjs の生の結果を、型ごとに「検証器と同じ形」の <合成PDFの名前>.json にする（手順と決まりは ADAPTER.md）。
//   node baseline/one_prompt/to-reports.mjs [--out <run-baseline.mjs と同じ書き出し先>]
// 書き出し：<out>/reports/p1/、p1-high-mid/、p9/、p6/。P5・P7 は、その版の出力から形を作れないので書かない（扱えない）。
// その版が出したものだけを写す。出していない位置・種類・理由を、推して足さない。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const i = process.argv.indexOf("--out");
const OUT = path.resolve(i >= 0 ? process.argv[i + 1] : path.join(ROOT, ".tmp", "one-prompt"));
const RAW = path.join(OUT, "raw");
const REPORTS = path.join(OUT, "reports");
const ADAPTER = { name: "1回の指示で作った版（baseline/one_prompt/to-reports.mjs で写したもの）", version: "1" };

const readRaw = (type) =>
  existsSync(path.join(RAW, type))
    ? readdirSync(path.join(RAW, type)).filter((f) => f.endsWith(".json")).sort().map((f) => ({ base: f.replace(/\.json$/, ""), raw: JSON.parse(readFileSync(path.join(RAW, type, f), "utf8")) }))
    : [];
const write = (dir, base, obj) => {
  mkdirSync(path.join(REPORTS, dir), { recursive: true });
  writeFileSync(path.join(REPORTS, dir, `${base}.json`), JSON.stringify(obj, null, 2) + "\n");
};
/** 開けなかったとき。パスワードの窓が出ていれば encrypted、そうでなければ unreadable */
const errorOf = (raw) => ({ code: raw.passwordPrompts > 0 ? "encrypted" : "unreadable", message: raw.timeout ? "時間切れ" : raw.status || raw.exception || "開けなかった" });
const nonSpace = (s) => [...String(s ?? "")].filter((c) => c.trim() !== "").length;
const round2 = (b) => b.map((v) => Math.round(v * 100) / 100);
/** 描画の座標（画素）→ ページの既定の座標（ポイント）。viewport の変換の逆 */
function toPdfRect(poly, t) {
  const det = t[0] * t[3] - t[1] * t[2];
  const inv = (x, y) => {
    const dx = x - t[4], dy = y - t[5];
    return [(t[3] * dx - t[2] * dy) / det, (-t[1] * dx + t[0] * dy) / det];
  };
  const pts = poly.map(([x, y]) => inv(x, y));
  return round2([Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]);
}

rmSync(REPORTS, { recursive: true, force: true });
const notes = [];

// ---------- P1（文書情報） ----------
// その版は Info を pdf.js で読み、Author と独自の項目を「要確認」、Title・Subject・Keywords・Creator・Producer を「参考」として出す。
// p1/        ：出した欄すべて（参考も含む）
// p1-high-mid/：「要対応」「要確認」として出した欄だけ（Author と独自の項目）
{
  const SHOWN_INFO = ["Title", "Subject", "Keywords", "Creator", "Producer"]; // 参考として出す欄
  for (const { base, raw } of readRaw("p1")) {
    const shape = (items) => ({ verifier: ADAPTER, checked: ["P1"], status: "ok", items, not_counted: [], previous_info: 0 });
    if (!raw.ok) {
      const e = { verifier: ADAPTER, checked: ["P1"], status: "error", error: errorOf(raw), items: [], not_counted: [], previous_info: 0 };
      write("p1", base, e);
      write("p1-high-mid", base, e);
      continue;
    }
    const rows = raw.metaRows ?? [];
    const item = (key, value) => ({ pattern: "P1", key, where: "current", chars: nonSpace(String(value).trim()) });
    const mid = [];
    const info = [];
    for (const [k, v] of rows) {
      if (k === "Author") mid.push(item(k, v));
      else if (k.startsWith("Custom: ")) mid.push(item(k.slice("Custom: ".length), v));
      else if (SHOWN_INFO.includes(k)) info.push(item(k, v));
    }
    write("p1", base, shape([...mid, ...info]));
    write("p1-high-mid", base, shape(mid));
  }
}

// ---------- P9（添付ファイル） ----------
// その版は、名前の木の添付（pdf.js の getAttachments）と、ページの添付ファイルの注釈を出す。/AF やどこからも指されていない中身は見ない。
for (const { base, raw } of readRaw("p9")) {
  if (!raw.ok) {
    write("p9", base, { verifier: ADAPTER, checked: ["P9"], status: "error", error: errorOf(raw), items: [] });
    continue;
  }
  const items = (raw.attachments ?? []).map((a) => ({ pattern: "P9", where: "names", name: a.filename, name_chars: nonSpace(a.filename) }));
  for (const p of raw.pages ?? []) {
    for (const a of p.annots ?? []) {
      if (a.subtype === "FileAttachment" && a.file) items.push({ pattern: "P9", where: "annotation", page: p.n, name: a.file.filename, name_chars: nonSpace(a.file.filename) });
    }
  }
  write("p9", base, { verifier: ADAPTER, checked: ["P9"], status: "ok", items });
}

// ---------- P6（見せかけの黒塗り） ----------
// その版の「黒塗りの下に文字」（dark）を字の層、「画像の上に黒い図形」（image）を画像の層として写す。位置はその版の印（marks）の箱。
// 覆っているものの種類は出さないので cover は "unknown"（照らし合わせには使わない）。
// 「適用されていない墨消し注釈」は、その版の出力に位置がないので写さない（数だけを数える）。
{
  let unpositionedRedact = 0, flatMarks = 0;
  for (const { base, raw } of readRaw("p6")) {
    if (!raw.ok) {
      write("p6", base, { verifier: ADAPTER, checked: ["P6"], status: "error", error: errorOf(raw), items: [], skipped_pages: [] });
      continue;
    }
    const items = [];
    const skipped = [];
    for (const p of raw.pages ?? []) {
      if (p.error) { skipped.push({ page: p.n, reason: "unreadable_page" }); continue; }
      const t = raw.vps?.find((v) => v.n === p.n)?.transform;
      if (!t) { skipped.push({ page: p.n, reason: "unreadable_page" }); continue; }
      let d = 0;
      for (const m of p.marks ?? []) {
        if (m.kind === "dark") {
          items.push({ pattern: "P6", layer: "text", cover: "unknown", page: p.n, rect: toPdfRect(m.poly, t), remaining: { chars: nonSpace(p.dark?.[d]?.text) } });
          d++;
        } else if (m.kind === "image") {
          items.push({ pattern: "P6", layer: "image", cover: "unknown", page: p.n, rect: toPdfRect(m.poly, t), remaining: {} });
        } else if (m.kind === "flat") flatMarks++;
      }
    }
    if ((raw.findings ?? []).some((f) => f.title.startsWith("適用されていない墨消し注釈"))) unpositionedRedact++;
    write("p6", base, { verifier: ADAPTER, checked: ["P6"], status: "ok", items, skipped_pages: skipped });
  }
  notes.push(`P6：位置がないので写さなかった「適用されていない墨消し注釈」の報告がある PDF ${unpositionedRedact} 個。P6 でない「見えない文字」の印 ${flatMarks} 個（写さない）`);
}

// ---------- P5・P7（写せない。出したものの数だけを数える） ----------
{
  let files = 0, withRev = 0, lines = 0, failed = 0;
  for (const { raw } of readRaw("p5")) {
    files++;
    if (!raw.ok) { failed++; continue; }
    const f = (raw.findings ?? []).find((x) => x.title.startsWith("過去の版"));
    if (f) { withRev++; lines += f.items.length; }
  }
  notes.push(`P5：扱えない（オブジェクトの番号・種類・場所を出さない）。参考：${files} 個中、「過去の版」を出した PDF ${withRev} 個（差分の行 ${lines} 行）、開けなかった PDF ${failed} 個`);
}
{
  let files = 0, flat = 0, off = 0, tiny = 0;
  for (const { raw } of readRaw("p7")) {
    files++;
    for (const p of raw.pages ?? []) { flat += p.flat?.length ?? 0; off += p.off?.length ?? 0; tiny += p.tiny?.length ?? 0; }
  }
  notes.push(`P7：扱えない（見えない理由を区別しない。ページの外・小さい字は位置を出さない）。参考：${files} 個で、見えない文字 ${flat} 件・ページの外 ${off} 件・小さい字 ${tiny} 件を出した`);
}

for (const d of readdirSync(REPORTS)) console.log(`${d}：${readdirSync(path.join(REPORTS, d)).length} 個を ${path.relative(ROOT, path.join(REPORTS, d))} に書いた`);
for (const n of notes) console.log(n);

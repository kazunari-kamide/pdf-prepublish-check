// SPDX-License-Identifier: AGPL-3.0-only
//
// 見ないで作るテスト集（blind）の採点：npm run eval:blind
//
// - 型の説明だけから作った合成 PDF（fixtures/blind/。まだ移していなければ proposals/blind/fixtures/blind/）を、
//   画面と同じルールの一覧（src/inspect/rules.ts の RULES）に通し、型ごとの合否表（検出・誤検知・お知らせ）を出す。
// - 隠しのある PDF は片付け（sanitize/ の sanitizePdf）にかけ、出来上がった PDF をゼロから読んで、
//   仕込んだ目印の字・覆いの下の画素が残っているかを数える（片付けの報告も RULES の結果も使わない）。
// - 検出ルールのコード（rules/）と eval/adapters/ は読まない・import しない（ルールの作り方に合わせないため）。
// - 表は Markdown と JSON で書く（夜にもう一度動かして比べるため）。字の中身は表に入れない（数・型・ページだけ）。
//
// 使い方：node eval/blind/run.ts [--dir <テスト集のフォルダ>] [--out <書き出すフォルダ>] [--no-sanitize]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { inflateSync, constants as zc } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "../../src/inspect/rules.ts";
import type { RuleResult } from "../../src/inspect/report.ts";
import { sanitizePdf } from "../../sanitize/index.ts";
import { createNodeImageCodec } from "../../sanitize/node/image-codec.ts";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---- 期待値の形 ----
type Kind = "leak" | "control" | "notice" | "unchecked";
type Expect = {
  patterns?: string[] | null;
  level?: "high" | "check" | "any";
  page?: number;
  maxItems?: number;
  also?: string[];
  forbid?: string[] | null;
  forbidNotice?: boolean;
};
type Residual = { markers?: string[]; image?: { w: number; h: number; region: { x: number; y: number; w: number; h: number } } } | null;
type Case = { id: string; type: string; kind: Kind; about: string; file: string; expect: Expect; residual: Residual };
type TypeMeta = { id: string; title: string; plan: string };
type Expected = { types: TypeMeta[]; skipped: { id: string; why: string }[]; cases: Case[] };

// ---- 引数 ----
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dirArg = opt("--dir");
const candidates = [path.join(root, "fixtures/blind"), path.join(root, "proposals/blind/fixtures/blind")];
const dir = dirArg ? path.resolve(dirArg) : candidates.find((d) => existsSync(path.join(d, "expected.json")));
if (!dir) {
  console.error("テスト集が見つかりません（fixtures/blind か proposals/blind/fixtures/blind）。先に node <そのフォルダ>/build.mjs を動かしてください。");
  process.exit(1);
}
const outDir = path.resolve(opt("--out") ?? path.join(root, ".tmp/blind"));
const doSanitize = !args.includes("--no-sanitize");
const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as Expected;

// ---- RULES にかける ----
type Found = { pattern: string; severity: string; page: number | null };
type RunOut = { items: Found[]; notices: string[]; errors: string[]; versions: Record<string, string> };

async function runRules(bytes: Uint8Array): Promise<RunOut> {
  const out: RunOut = { items: [], notices: [], errors: [], versions: {} };
  for (const rule of RULES) {
    let r: RuleResult;
    try {
      r = await rule.run(bytes.slice());
    } catch (e) {
      out.errors.push(`${rule.id}:throw`);
      void e;
      continue;
    }
    out.versions[r.ruleId] = r.ruleVersion;
    if (r.status === "error") out.errors.push(r.ruleId);
    for (const it of r.items) out.items.push({ pattern: it.pattern, severity: it.severity, page: it.page });
    for (const n of r.notices) out.notices.push(n.kind);
  }
  return out;
}

// ---- 判定 ----
type Verdict = {
  pass: boolean;
  /** 期待した型で見つかった数 */
  hits: number;
  /** 期待と違う型で出た項目の型（隠しのある PDF のとき） */
  otherPatterns: string[];
  /** 深刻度が期待と合ったか（level が any のときは null） */
  severityOk: boolean | null;
  why: string;
};

const isCheck = (s: string) => s === "medium" || s === "low";
const noticeKinds = (n: string[]) => n.filter((k) => k !== "decrypted");

function judge(c: Case, r: RunOut): Verdict {
  const e = c.expect;
  if (c.kind === "control") {
    const bad = r.items.filter((it) => (e.forbid ? e.forbid.includes(it.pattern) : true));
    const badNotice = e.forbidNotice ? noticeKinds(r.notices) : [];
    const pass = bad.length === 0 && badNotice.length === 0 && r.errors.length === 0;
    const why = [
      bad.length ? `誤検知 ${bad.length} 件（${[...new Set(bad.map((b) => b.pattern))].join("・")}）` : "",
      badNotice.length ? `お知らせ ${badNotice.length} 件（${[...new Set(badNotice)].join("・")}）` : "",
      r.errors.length ? `ルールのエラー（${r.errors.join("・")}）` : "",
    ]
      .filter(Boolean)
      .join("、");
    return { pass, hits: 0, otherPatterns: [], severityOk: null, why: why || "出なかった" };
  }
  if (c.kind === "unchecked") {
    const n = r.notices.filter((k) => k === "partial" || k === "skipped_pages");
    const pass = r.errors.length > 0 || n.length > 0;
    return { pass, hits: r.errors.length + n.length, otherPatterns: [], severityOk: null, why: pass ? `調べられないと出た（エラー ${r.errors.length}、お知らせ ${n.length}）` : "調べられないと出なかった" };
  }
  const want = (it: Found) => (e.patterns ? e.patterns.includes(it.pattern) : true) && (e.page === undefined || it.page === null || it.page === e.page);
  const hitsList = r.items.filter(want);
  const other = [...new Set(r.items.filter((it) => !want(it)).map((it) => it.pattern))];
  if (c.kind === "notice") {
    const ns = noticeKinds(r.notices);
    const pass = ns.length > 0 || hitsList.length > 0;
    return {
      pass,
      hits: ns.length + hitsList.length,
      otherPatterns: other,
      severityOk: null,
      why: pass ? `お知らせ ${ns.length}、項目 ${hitsList.length}` : `出なかった${other.length ? `（別の型：${other.join("・")}）` : ""}`,
    };
  }
  let pass = hitsList.length > 0;
  let why = pass ? `${hitsList.length} 件` : `見逃し${other.length ? `（別の型で出た：${other.join("・")}）` : ""}`;
  if (pass && e.maxItems !== undefined && hitsList.length > e.maxItems) {
    pass = false;
    why = `${hitsList.length} 件に分かれた（${e.maxItems} 件以下にまとめてほしい）`;
  }
  let severityOk: boolean | null = null;
  if (hitsList.length && e.level && e.level !== "any") {
    severityOk = hitsList.some((it) => (e.level === "high" ? it.severity === "high" : isCheck(it.severity)));
  }
  return { pass, hits: hitsList.length, otherPatterns: other, severityOk, why };
}

// ---- 片付けたあとの残り（出来上がった PDF をゼロから読む） ----

/** ファイルの中のストリームを、できるかぎり展開して返す（Flate だけ。壊れていても途中まで） */
function streamsOf(buf: Buffer): { dict: string; data: Buffer; inflated: Buffer | null }[] {
  const s = buf.toString("latin1");
  const out: { dict: string; data: Buffer; inflated: Buffer | null }[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const dictStart = s.lastIndexOf("obj", m.index);
    const dict = s.slice(dictStart >= 0 ? dictStart : Math.max(0, m.index - 600), m.index);
    let data = buf.subarray(start, end);
    while (data.length && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) data = data.subarray(0, data.length - 1);
    let inflated: Buffer | null = null;
    if (/\/FlateDecode/.test(dict) || /\/Fl\b/.test(dict)) {
      try {
        inflated = inflateSync(data, { finishFlush: zc.Z_SYNC_FLUSH });
      } catch {
        inflated = null;
      }
    }
    out.push({ dict, data, inflated });
    re.lastIndex = end;
  }
  return out;
}

function markerForms(m: string): Buffer[] {
  const ascii = Buffer.from(m, "latin1");
  const u16 = Buffer.alloc(m.length * 2);
  for (let i = 0; i < m.length; i++) u16.writeUInt16BE(m.charCodeAt(i), i * 2);
  const forms = [ascii, u16];
  for (const b of [ascii, u16]) {
    forms.push(Buffer.from(b.toString("hex").toUpperCase(), "latin1"));
    forms.push(Buffer.from(b.toString("hex"), "latin1"));
  }
  return forms;
}

async function textOf(bytes: Uint8Array): Promise<string> {
  try {
    // pdfjs-dist 6 には isEvalSupported がない。字を取り出すだけなので、書体は読み込まない
    const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const doc = await task.promise;
    let t = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const tc = await p.getTextContent();
      for (const it of tc.items) if ("str" in it) t += it.str;
      t += "\n";
    }
    const meta = await doc.getMetadata().catch(() => null);
    if (meta) t += JSON.stringify(meta.info ?? {});
    await task.destroy();
    return t;
  } catch {
    return "";
  }
}

type ResidualOut = { markersLeft: number; markersTotal: number; image: "left" | "clean" | "unmeasured" | null };

async function measureResidual(bytes: Uint8Array, res: NonNullable<Residual>): Promise<ResidualOut> {
  const buf = Buffer.from(bytes);
  const streams = streamsOf(buf);
  const hay = [buf, ...streams.map((s) => s.inflated).filter((x): x is Buffer => x !== null)];
  const text = res.markers?.length ? await textOf(bytes) : "";
  let left = 0;
  for (const m of res.markers ?? []) {
    const forms = markerForms(m);
    const inBytes = hay.some((h) => forms.some((f) => h.includes(f)));
    if (inBytes || text.includes(m)) left++;
  }
  let image: ResidualOut["image"] = null;
  if (res.image) {
    const { w, h, region } = res.image;
    let measured = false;
    let found = false;
    for (const s of streams) {
      if (!/\/Subtype\s*\/Image/.test(s.dict)) continue;
      const W = Number(/\/Width\s+(\d+)/.exec(s.dict)?.[1]);
      const H = Number(/\/Height\s+(\d+)/.exec(s.dict)?.[1]);
      if (W !== w || H !== h) continue;
      const comps = /\/DeviceRGB/.test(s.dict) ? 3 : /\/DeviceCMYK/.test(s.dict) ? 4 : 1;
      const px = /\/Filter/.test(s.dict) ? s.inflated : s.data;
      if (!px || px.length < w * h * comps || !/\/BitsPerComponent\s+8/.test(s.dict)) continue;
      measured = true;
      let dark = 0;
      let light = 0;
      for (let y = region.y; y < region.y + region.h; y++)
        for (let x = region.x; x < region.x + region.w; x++) {
          const v = px[(y * w + x) * comps] ?? 0;
          if (v < 100) dark++;
          else if (v > 160) light++;
        }
      const n = region.w * region.h;
      // 字の模様（濃い所と明るい所が混ざる）が残っていれば「残り」。黒一色・白一色に塗られていれば片付いた
      if (dark > n * 0.03 && light > n * 0.03) found = true;
    }
    image = found ? "left" : measured ? "clean" : "unmeasured";
  }
  return { markersLeft: left, markersTotal: res.markers?.length ?? 0, image };
}

// ---- 動かす ----
type CaseOut = {
  id: string;
  type: string;
  kind: Kind;
  pass: boolean;
  why: string;
  hits: number;
  otherPatterns: string[];
  severityOk: boolean | null;
  found: Found[];
  notices: string[];
  errors: string[];
  sanitize?: { status: string; notDone: number; markersLeft: number; markersTotal: number; image: ResidualOut["image"]; itemsAfter: number } | null;
};

const codec = createNodeImageCodec();
const results: CaseOut[] = [];
const versions: Record<string, string> = {};
for (const c of expected.cases) {
  const bytes = new Uint8Array(readFileSync(path.join(dir, c.file)));
  const r = await runRules(bytes);
  Object.assign(versions, r.versions);
  const v = judge(c, r);
  const row: CaseOut = { id: c.id, type: c.type, kind: c.kind, ...v, found: r.items, notices: r.notices, errors: r.errors, sanitize: null };
  if (doSanitize && c.kind === "leak" && c.residual) {
    try {
      const s = await sanitizePdf(bytes.slice(), { codec });
      if (s.status === "ok") {
        const m = await measureResidual(s.bytes, c.residual);
        const after = await runRules(s.bytes);
        row.sanitize = { status: "ok", notDone: s.notDone.length, ...m, itemsAfter: after.items.length };
      } else {
        row.sanitize = { status: s.code, notDone: 0, markersLeft: 0, markersTotal: 0, image: null, itemsAfter: 0 };
      }
    } catch {
      row.sanitize = { status: "throw", notDone: 0, markersLeft: 0, markersTotal: 0, image: null, itemsAfter: 0 };
    }
  }
  results.push(row);
}

// ---- 型ごとにまとめる ----
type TypeRow = {
  type: string;
  title: string;
  plan: string;
  verdict: "合" | "否";
  leak: [number, number];
  control: [number, number];
  notice: [number, number] | null;
  unchecked: [number, number] | null;
  severity: [number, number] | null;
  residual: [number, number] | null;
  notes: string[];
};
const skipped = new Set(expected.skipped.map((s) => s.id));
const typeRows: TypeRow[] = [];
for (const t of expected.types) {
  if (skipped.has(t.id)) continue;
  const rs = results.filter((r) => r.type === t.id);
  if (!rs.length) continue;
  const of = (k: Kind) => rs.filter((r) => r.kind === k);
  const pair = (k: Kind): [number, number] => [of(k).filter((r) => r.pass).length, of(k).length];
  const leak = pair("leak");
  const ctl = of("control");
  const fp: [number, number] = [ctl.filter((r) => !r.pass).length, ctl.length];
  const notice = of("notice").length ? pair("notice") : null;
  const unchecked = of("unchecked").length ? pair("unchecked") : null;
  const sev = of("leak").filter((r) => r.severityOk !== null);
  const san = of("leak").filter((r) => r.sanitize && r.sanitize.status === "ok");
  const leftCases = san.filter((r) => (r.sanitize?.markersLeft ?? 0) > 0 || r.sanitize?.image === "left");
  const notes: string[] = [];
  for (const r of rs) if (!r.pass) notes.push(`${r.id.replace(`${t.id.toLowerCase()}-`, "")}：${r.why}`);
  for (const r of of("leak")) if (r.sanitize && r.sanitize.status !== "ok") notes.push(`${r.id.replace(`${t.id.toLowerCase()}-`, "")}：片付け ${r.sanitize.status}`);
  const allPass = rs.every((r) => r.pass);
  typeRows.push({
    type: t.id,
    title: t.title,
    plan: t.plan,
    verdict: allPass ? "合" : "否",
    leak,
    control: fp,
    notice,
    unchecked,
    severity: sev.length ? [sev.filter((r) => r.severityOk).length, sev.length] : null,
    residual: san.length ? [leftCases.length, san.length] : null,
    notes,
  });
}

// ---- 書き出す ----
let commit = "不明";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  /* git がないときは書かない */
}
const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const sum = (f: (r: TypeRow) => [number, number] | null): [number, number] =>
  typeRows.reduce<[number, number]>((a, r) => {
    const v = f(r);
    return v ? [a[0] + v[0], a[1] + v[1]] : a;
  }, [0, 0]);
const total = {
  types: typeRows.length,
  typesPass: typeRows.filter((r) => r.verdict === "合").length,
  leak: sum((r) => r.leak),
  control: sum((r) => r.control),
  notice: sum((r) => r.notice),
  unchecked: sum((r) => r.unchecked),
  residual: sum((r) => r.residual),
  sanitizeNotOk: results.filter((r) => r.sanitize && r.sanitize.status !== "ok").length,
};

mkdirSync(outDir, { recursive: true });
const json = { date, commit, set: path.relative(root, dir).replace(/\\/g, "/"), rules: versions, total, types: typeRows, cases: results, skipped: expected.skipped };
writeFileSync(path.join(outDir, "report.json"), JSON.stringify(json, null, 2) + "\n");

const f = (p: [number, number] | null) => (p ? `${p[0]}/${p[1]}` : "—");
let md = `# 見ないで作るテスト集の合否表\n\n`;
md += `- 測った日：${date}（コミット ${commit}）\n- テスト集：\`${json.set}\`（${expected.cases.length} 個の PDF、${typeRows.length} の型）\n`;
md += `- ルール：${Object.entries(versions).map(([k, v]) => `${k} ${v}`).join("、")}\n`;
md += `- 合の型：**${total.typesPass}/${total.types}**。検出 ${f(total.leak)}、誤検知 ${f(total.control)}（対照のうち出てはいけない型が出た数）、お知らせ ${f(total.notice)}、調べられない ${f(total.unchecked)}\n`;
md += `- 片付けたあとに残った（隠しのある PDF のうち、目印の字か覆いの下の画素が残った数／測った数）：${f(total.residual)}。片付けが ok にならなかった：${total.sanitizeNotOk}\n\n`;
md += `見方：検出＝隠しのある PDF のうち、期待した型で出た数。誤検知＝対照のうち、出てはいけない型が出た数。深刻度＝期待が「高」か「確認」の PDF のうち、深刻度が合った数。残り＝片付けたあとに、目印の字か覆いの下の画素が残った数。合＝その型の PDF がすべて期待どおり。\n\n`;
md += `| 型 | 説明 | 予定 | 合否 | 検出 | 誤検知 | お知らせ | 調べられない | 深刻度 | 片付け後の残り | 落ちた所 |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of typeRows)
  md += `| ${r.type} | ${r.title.replace(/\|/g, "｜")} | ${r.plan} | ${r.verdict} | ${f(r.leak)} | ${f(r.control)} | ${f(r.notice)} | ${f(r.unchecked)} | ${f(r.severity)} | ${f(r.residual)} | ${r.notes.join("<br>").replace(/\|/g, "｜")} |\n`;
md += `\n## 作らなかった型\n\n| 型 | 理由 |\n|---|---|\n`;
for (const s of expected.skipped) md += `| ${s.id} | ${s.why} |\n`;
writeFileSync(path.join(outDir, "report.md"), md);

console.log(`合の型 ${total.typesPass}/${total.types}、検出 ${f(total.leak)}、誤検知 ${f(total.control)}、お知らせ ${f(total.notice)}、調べられない ${f(total.unchecked)}、片付け後の残り ${f(total.residual)}`);
console.log(`書き出した：${path.relative(root, path.join(outDir, "report.md"))}、${path.relative(root, path.join(outDir, "report.json"))}`);

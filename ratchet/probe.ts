// SPDX-License-Identifier: AGPL-3.0-only
//
// PDF 1 件の「構造の要約」を作る（下読みに渡すデータ）。値は伏せ、欄の名前・種類・数・長さだけにする。
// - 今のルールの判定は、コマンドの道具（cli/omamori.ts check）の結果から、型・深刻度・見出し・ページだけを取る。
// - 構造は pdf-lib で数える：文書情報の欄（名前と字数）、カタログの欄、名前の木、フォームの欄の数、ページごとの注釈・画像・書体の数、
//   オブジェクトの種類ごとの数、増分更新の数、XMP の要素の名前（値は取らない）、レイヤー、暗号化。
// - 墨消しの手がかり（ratchet/redaction.ts）は、ページを画像にするので別の子のプロセスで数え、打ち切っても構造の要約は残す。
// - 壊れた・巨大な・細工した PDF でも止まらないように、呼ぶ側が子のプロセスで動かし、時間で打ち切る（runProbe）。
//
// 子のプロセスとして：node ratchet/probe.ts <PDF のパス>   → 標準出力に JSON を 1 つ

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import type { RedactionClues } from "./redaction.ts";

export type Probe = {
  bytes: number;
  pdfVersion: string | null;
  encrypted: boolean;
  /** %%EOF の数（2 以上なら増分更新の跡） */
  eofCount: number;
  info: Array<{ key: string; length: number }>;
  catalogKeys: string[];
  nameTrees: string[];
  acroFormFields: number;
  ocgCount: number;
  xmp: { bytes: number; elements: string[] } | null;
  pages: number;
  pageSummary: Array<{ page: number; contentBytes: number; annots: Record<string, number>; xobjects: Record<string, number>; fonts: number }>;
  objectTypes: Record<string, number>;
  /** 今のルールの判定（コマンドの道具の結果から、型・深刻度・見出し・ページだけ） */
  rules: { stage: string | null; items: Array<{ pattern: string; ruleId: string; severity: string; title: string; page: number | null }> };
  /** 墨消しの手がかり（ratchet/redaction.ts。数と形だけ）。調べられなければ failed */
  redaction: RedactionClues | { failed: string } | null;
  notes: string[];
};

const MAX_PAGES_DETAIL = 30;
const MAX_LIST = 60;
const cap = (s: string, n = 40) => (s.length > n ? s.slice(0, n) + "…" : s);
const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
const nameOf = (v: unknown) => (v instanceof PDFName ? v.decodeText() : null);

function countEof(buf: Uint8Array): number {
  let n = 0;
  const pat = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
  outer: for (let i = 0; i + pat.length <= buf.length; i++) {
    for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
    n++;
  }
  return n;
}

/** XMP の要素の名前だけを集める（prefix:name の形。値・属性の値は取らない） */
export function xmpElementNames(xml: string): string[] {
  const set = new Set<string>();
  for (const m of xml.matchAll(/<([A-Za-z][\w.-]*:[\w.-]+)[\s/>]/g)) {
    set.add(cap(m[1]!, 60));
    if (set.size >= MAX_LIST) break;
  }
  return [...set].sort();
}

export async function probeStructure(bytes: Uint8Array): Promise<Omit<Probe, "rules" | "redaction">> {
  const notes: string[] = [];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  const pdfVersion = /%PDF-(\d\.\d)/.exec(head)?.[1] ?? null;
  const eofCount = countEof(bytes);
  const base = {
    bytes: bytes.length, pdfVersion, encrypted: false, eofCount, info: [], catalogKeys: [], nameTrees: [], acroFormFields: 0,
    ocgCount: 0, xmp: null, pages: 0, pageSummary: [], objectTypes: {}, notes,
  } as Omit<Probe, "rules" | "redaction">;
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    notes.push("pdf-lib で読めなかった");
    return base;
  }
  const ctx = doc.context;
  base.encrypted = doc.isEncrypted;
  const deref = (v: unknown) => (v instanceof PDFRef ? ctx.lookup(v) : v);

  const info = deref(ctx.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const [k, v] of info.entries()) {
      const val = deref(v) as any;
      const length = typeof val?.decodeText === "function" ? [...String(val.decodeText())].length : String(val ?? "").length;
      base.info.push({ key: cap(k.decodeText()), length });
    }
  }
  const cat = doc.catalog;
  base.catalogKeys = cat.keys().map((k) => cap(k.decodeText())).slice(0, MAX_LIST);
  const names = deref(cat.get(PDFName.of("Names")));
  if (names instanceof PDFDict) base.nameTrees = names.keys().map((k) => cap(k.decodeText()));
  const acro = deref(cat.get(PDFName.of("AcroForm")));
  if (acro instanceof PDFDict) {
    const f = deref(acro.get(PDFName.of("Fields")));
    if (f instanceof PDFArray) base.acroFormFields = f.size();
  }
  const ocp = deref(cat.get(PDFName.of("OCProperties")));
  if (ocp instanceof PDFDict) {
    const o = deref(ocp.get(PDFName.of("OCGs")));
    if (o instanceof PDFArray) base.ocgCount = o.size();
  }
  const meta = deref(cat.get(PDFName.of("Metadata")));
  if (meta instanceof PDFRawStream) {
    try {
      const raw = meta.getContents();
      const filter = meta.dict.get(PDFName.of("Filter"));
      if (!filter) base.xmp = { bytes: raw.length, elements: xmpElementNames(new TextDecoder().decode(raw)) };
      else base.xmp = { bytes: raw.length, elements: [] }, notes.push("XMP が圧縮されていて、要素の名前は数えていない");
    } catch {
      notes.push("XMP を読めなかった");
    }
  }

  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    if (!d) continue;
    const t = nameOf(d.get(PDFName.of("Type")));
    const st = nameOf(d.get(PDFName.of("Subtype")));
    if (t || st) inc(base.objectTypes, cap(`${t ?? "-"}/${st ?? "-"}`, 60));
  }

  const pages = doc.getPages();
  base.pages = pages.length;
  pages.slice(0, MAX_PAGES_DETAIL).forEach((p, i) => {
    const s = { page: i + 1, contentBytes: 0, annots: {} as Record<string, number>, xobjects: {} as Record<string, number>, fonts: 0 };
    try {
      const c = deref(p.node.get(PDFName.of("Contents")));
      const streams = c instanceof PDFArray ? c.asArray().map(deref) : [c];
      for (const st of streams) if (st instanceof PDFRawStream) s.contentBytes += st.getContents().length;
      const an = deref(p.node.get(PDFName.of("Annots")));
      if (an instanceof PDFArray) for (const a of an.asArray()) {
        const ad = deref(a);
        if (ad instanceof PDFDict) inc(s.annots, nameOf(ad.get(PDFName.of("Subtype"))) ?? "?");
      }
      const res = deref(p.node.Resources?.() ?? p.node.get(PDFName.of("Resources")));
      if (res instanceof PDFDict) {
        const xo = deref(res.get(PDFName.of("XObject")));
        if (xo instanceof PDFDict) for (const [, v] of xo.entries()) {
          const x = deref(v);
          if (x instanceof PDFStream) inc(s.xobjects, nameOf(x.dict.get(PDFName.of("Subtype"))) ?? "?");
        }
        const fo = deref(res.get(PDFName.of("Font")));
        if (fo instanceof PDFDict) s.fonts = fo.keys().length;
      }
    } catch {
      notes.push(`${i + 1} ページ目の一部を数えられなかった`);
    }
    base.pageSummary.push(s);
  });
  if (pages.length > MAX_PAGES_DETAIL) notes.push(`ページの詳しい数は、はじめの ${MAX_PAGES_DETAIL} ページだけ`);
  return base;
}

/** コマンドの道具の JSON から、型・深刻度・見出し・ページだけを取る（rect・detail・中身は取らない） */
export function summarizeCli(j: any): Probe["rules"] {
  const f = j?.files?.[0];
  if (!f) return { stage: null, items: [] };
  const items = (Array.isArray(f.items) ? f.items : []).slice(0, MAX_LIST).map((it: any) => ({
    pattern: String(it.pattern ?? ""),
    ruleId: String(it.ruleId ?? ""),
    severity: String(it.severity ?? ""),
    title: cap(String(it.title ?? ""), 80),
    page: typeof it.page === "number" ? it.page : null,
  }));
  return { stage: typeof f.stage === "string" ? f.stage : null, items };
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function runNode(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--max-old-space-size=2048", ...args], { cwd: root, windowsHide: true });
    let stdout = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.resume();
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, timedOut });
    });
  });
}

/** 1 件を、子のプロセスで調べる。時間を超えたら打ち切り、「調べきれなかった」と書く（省いたことを隠さない） */
export async function runProbe(path: string, timeoutMs = 120_000, opts: { rules?: boolean } = {}): Promise<Probe | { failed: string }> {
  const s = await runNode([join(here, "probe.ts"), path], timeoutMs);
  if (s.timedOut) return { failed: "構造を数えるのに時間がかかりすぎた" };
  let structure: Omit<Probe, "rules" | "redaction">;
  try {
    structure = JSON.parse(s.stdout);
  } catch {
    return { failed: "構造を数えられなかった" };
  }
  // 墨消しの手がかりは、別の子のプロセスで数える（画像にするので重い。打ち切っても、構造の要約は残す）
  const r = await runNode([join(here, "redaction.ts"), path], timeoutMs);
  let redaction: Probe["redaction"] = null;
  if (r.timedOut) redaction = { failed: "墨消しの手がかりを数えるのに時間がかかりすぎた" };
  else {
    try {
      redaction = JSON.parse(r.stdout);
    } catch {
      redaction = { failed: "墨消しの手がかりを数えられなかった" };
    }
  }
  if (opts.rules === false) return { ...structure, rules: { stage: null, items: [] }, redaction };
  const c = await runNode([join(root, "cli/omamori.ts"), "check", "--format", "json", "--fail-on", "never", "--timeout", String(Math.floor(timeoutMs / 1000)), path], timeoutMs + 10_000);
  let rules: Probe["rules"] = { stage: null, items: [] };
  if (c.timedOut) structure.notes.push("今のルールの判定が時間内に終わらなかった");
  else {
    try {
      rules = summarizeCli(JSON.parse(c.stdout));
    } catch {
      structure.notes.push("今のルールの判定を読めなかった");
    }
  }
  return { ...structure, rules, redaction };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = process.argv[2];
  const out = await probeStructure(new Uint8Array(readFileSync(p!)));
  process.stdout.write(JSON.stringify(out));
}

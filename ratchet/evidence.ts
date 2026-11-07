// SPDX-License-Identifier: AGPL-3.0-only
//
// 歯止めの「根拠の実物で当たるか」（docs/ratchet.md §3.4。2026-11-07 本人の承認）。
// 合成の見本だけで確かめると、見本と同じ描き方（PDF の線）にしか当たらないルールでも通ってしまう
// （#177 は根拠 5 件・束で 0 件、3 回目の barcode-redact は実物 53 件で 0 件だった）。
// そこで、候補が根拠にした実物の PDF に、候補の作業の木の検査器をかけ、書いたルールの報告が出た件数を数える。
//
// 守り（ここで初めて、Claude が書いたコードを実物の PDF の上で動かすため）：
//   - かける前に、変えたファイルに通信・子のプロセスなどの字があれば、かけずに止める（forbiddenInDiff）。
//   - Node の権限の仕組み（--permission）で、読める所を作業の木・node_modules・その 1 件だけにする。書き込みと子のプロセスは許さない。
//     Node 24 の権限の仕組みは通信を止めないので、通信は上の字の確かめで止める。
//   - 束の PDF は元の場所から読むだけで、作業の木には写さない。1 件ずつ時間で打ち切る。
// 外に出すのは件数だけ（根拠 N 件のうち M 件）。パス・ファイル名・報告の中身は返さない。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { listPdfs, sha256File } from "./bundle.ts";
import type { Probe } from "./probe.ts";

/** PDF 1 件の、根拠の手がかりの形（数だけ） */
export type DocShape = {
  /** ページの半分以上が画像のページ（スキャンなど） */
  image: boolean;
  pages: number;
  imagePages: number;
  boxesOnImage: number;
  boxesOnDrawn: number;
  barsOnImage: number;
  barsOnDrawn: number;
  maskRuns: number;
};

/** 根拠の全部の形（ルール書きの段に渡す。数だけ） */
export type EvidenceShape = {
  total: number;
  /** 手がかりを数えられなかった件数 */
  unknown: number;
  imageDocs: number;
  drawnDocs: number;
  boxes: { onImagePages: number; onDrawnPages: number };
  barsNearBoxes: { onImagePages: number; onDrawnPages: number };
  maskRunDocs: number;
};

/** 下読みの手がかり（probe）から、1 件の形を取る。数えられなければ null */
export function docShape(p: Pick<Probe, "redaction"> | { failed: string }): DocShape | null {
  if ("failed" in p) return null;
  const r = p.redaction;
  if (!r || "failed" in r) return null;
  const pages = r.pagesTotal;
  const imagePages = r.imagePages ?? 0;
  const s: DocShape = { image: pages > 0 && imagePages * 2 >= pages, pages, imagePages, boxesOnImage: 0, boxesOnDrawn: 0, barsOnImage: 0, barsOnDrawn: 0, maskRuns: r.maskRuns.runs };
  for (const pg of r.pages) {
    const img = pg.source === "image";
    if (img) (s.boxesOnImage += pg.boxes.length), (s.barsOnImage += pg.nearby.length);
    else (s.boxesOnDrawn += pg.boxes.length), (s.barsOnDrawn += pg.nearby.length);
  }
  return s;
}

export function shapeOf(docs: Array<DocShape | null>): EvidenceShape {
  const known = docs.filter((d): d is DocShape => !!d);
  const sum = (f: (d: DocShape) => number) => known.reduce((a, d) => a + f(d), 0);
  return {
    total: docs.length,
    unknown: docs.length - known.length,
    imageDocs: known.filter((d) => d.image).length,
    drawnDocs: known.filter((d) => !d.image).length,
    boxes: { onImagePages: sum((d) => d.boxesOnImage), onDrawnPages: sum((d) => d.boxesOnDrawn) },
    barsNearBoxes: { onImagePages: sum((d) => d.barsOnImage), onDrawnPages: sum((d) => d.barsOnDrawn) },
    maskRunDocs: known.filter((d) => d.maskRuns > 0).length,
  };
}

/**
 * 候補（判断の段）が挙げた根拠の番号を確かめる。その回に下読みした番号だけを受け付ける。
 * 空になったら、同じ型の番号の疑いを出した番号を使う（反証の段に渡す根拠と同じ決め方）。
 */
export function evidenceIdsFor(c: { pattern: string; evidenceIds?: string[] }, read: Set<string>, suspicions: Array<{ id: string; pattern: string }>): string[] {
  const named = [...new Set((c.evidenceIds ?? []).filter((id) => read.has(id)))];
  if (named.length) return named.sort();
  return [...new Set(suspicions.filter((s) => s.pattern === c.pattern && read.has(s.id)).map((s) => s.id))].sort();
}

/** 根拠の実物にかける前の、変えたファイルの字の確かめ。止める理由（ファイルの場所と字の種類）を返す。空なら良い */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, "fetch"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bsendBeacon\b/, "sendBeacon"],
  [/\bEventSource\b/, "EventSource"],
  [/\bRTCPeerConnection\b/, "RTCPeerConnection"],
  [/\bimportScripts\b/, "importScripts"],
  [/["'`]node:[\w/]+["'`]/, "node: の読み込み"],
  [/(?:from|require\s*\(|import\s*\()\s*["'`](?:https?|http2|net|tls|dgram|dns|child_process|cluster|worker_threads|inspector|vm|fs|os|process|module)(?:\/[\w/]*)?["'`]/, "Node の部品の読み込み"],
  [/\bimport\s*\(\s*(?!["'])/, "形の決まらない import()"],
  [/\brequire\s*\(/, "require"],
  [/\beval\s*\(/, "eval"],
  [/\bnew\s+Function\s*\(/, "new Function"],
  [/\bprocess\s*\.\s*(?:binding|dlopen|env)\b/, "process の中"],
  [/\bglobalThis\s*\[/, "globalThis[...]"],
  [/["'`](?:[^"'`\n]*\/)?(?:eval|tests|proposals)\/[^"'`\n]*["'`]/, "検査器の外のフォルダの読み込み"],
];

/** 検査器のコードとして読まれうるファイル（テスト・案・合成 PDF を作る eval/ は検査器に入らないので見ない。読み込んだら上で止める） */
const isInspectorCode = (p: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(p) && !/^(?:tests|proposals|eval)\//.test(p);

export function forbiddenInDiff(root: string, entries: Array<{ status: string; path: string }>, read: (p: string) => string = (p) => readFileSync(p, "utf8")): string[] {
  const out: string[] = [];
  for (const { status, path } of entries) {
    const p = path.replaceAll("\\", "/");
    if (status[0] === "D" || !isInspectorCode(p)) continue;
    let text: string;
    try {
      text = read(join(root, p));
    } catch {
      out.push(`${p}（読めない）`);
      continue;
    }
    // 説明の注（行の頭からの // と /* */）は外して見る。行の後ろの注は外さない（字を注の後ろに隠せないように、多めに止める）
    const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
    for (const [re, what] of FORBIDDEN) if (re.test(code)) out.push(`${p}（${what}）`);
  }
  return out;
}

export type EvidenceHits = { total: number; hit: number; failed: number };

/** 子のプロセスを動かす部品（テストでは偽物に差し替える） */
export type RunCheck = (args: { node: string; argv: string[]; cwd: string; timeoutMs: number }) => { status: number | null; stdout: string };

export const realRunCheck: RunCheck = ({ node, argv, cwd, timeoutMs }) => {
  const r = spawnSync(node, argv, { cwd, encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "" };
};

/** 権限の仕組みで絞った、検査器の起動の引数（読めるのは作業の木・node_modules の実体・その 1 件だけ。書き込み・子のプロセスは無し） */
export function permissionArgv(candDir: string, file: string, timeoutSec: number): string[] {
  const nm = join(candDir, "node_modules");
  let real = nm;
  try {
    real = realpathSync(nm);
  } catch { /* 無ければそのまま */ }
  const reads = [...new Set([candDir, nm, real, file])];
  return [
    "--permission",
    // 検査器は 1 件ごとに Worker で動かす（cli/run.ts）。Worker も同じ権限の中で動く
    "--allow-worker",
    "--no-warnings",
    ...reads.map((p) => `--allow-fs-read=${p}`),
    join(candDir, "cli/omamori.ts"), "check", "--format", "json", "--fail-on", "never", "--timeout", String(timeoutSec), file,
  ];
}

/** 根拠の実物に、候補の作業の木の検査器をかけて、ruleIds の報告が出た件数を数える */
export function hitsOnEvidence(opts: { candDir: string; files: string[]; ruleIds: string[]; timeoutSec?: number; run?: RunCheck }): EvidenceHits {
  const t = opts.timeoutSec ?? 120;
  const run = opts.run ?? realRunCheck;
  const want = new Set(opts.ruleIds.filter(Boolean));
  let hit = 0;
  let failed = 0;
  for (const f of opts.files) {
    const r = run({ node: process.execPath, argv: permissionArgv(opts.candDir, f, t), cwd: opts.candDir, timeoutMs: (t + 30) * 1000 });
    let items: Array<{ ruleId?: unknown }> | null = null;
    try {
      const j = JSON.parse(r.stdout);
      if (Array.isArray(j?.files?.[0]?.items)) items = j.files[0].items;
    } catch { /* 下で数える */ }
    if (!items) {
      failed++;
      continue;
    }
    if (items.some((x) => want.has(String(x.ruleId ?? "")))) hit++;
  }
  return { total: opts.files.length, hit, failed };
}

/** 歯止めの理由（件数だけ）。当たれば null */
export function evidenceReason(h: EvidenceHits): string | null {
  if (h.total === 0) return "根拠の実物が見つからない（根拠 0 件）";
  if (h.hit > 0) return null;
  if (h.failed === h.total) return `根拠の実物で確かめられなかった（根拠 ${h.total} 件のうち ${h.failed} 件で検査器が止まった）`;
  return `根拠の実物で当たらない（根拠 ${h.total} 件のうち 0 件${h.failed ? `。検査器が止まった ${h.failed} 件を含む` : ""}）`;
}

/** sha256 の一覧のファイル（1 行に 1 つ。# から後と空の行は無視）。形の違う行は数だけ返す */
export function readShaList(file: string): { shas: string[]; bad: number } {
  const shas: string[] = [];
  let bad = 0;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const l = raw.replace(/#.*/, "").trim().toLowerCase();
    if (!l) continue;
    if (/^[0-9a-f]{64}$/.test(l)) shas.push(l);
    else bad++;
  }
  return { shas: [...new Set(shas)], bad };
}

/**
 * sha256 から、束のフォルダ（と、一覧のファイルと同じフォルダ）の PDF を探す。採点用の実データは除く。
 * 返すパスは、この回の中でだけ使う（画面・記録・PR には出さない）。
 */
export function resolveShas(shas: string[], dirs: string[], exclude: Set<string>): { files: string[]; missing: number; excluded: number } {
  const want = new Set(shas);
  const found = new Map<string, string>();
  for (const d of dirs) {
    if (!d || !existsSync(d)) continue;
    for (const p of listPdfs(d)) {
      if (found.size === want.size) break;
      const h = sha256File(p);
      if (want.has(h) && !exclude.has(h) && !found.has(h)) found.set(h, p);
    }
  }
  const excluded = shas.filter((h) => exclude.has(h)).length;
  return { files: [...found.values()], missing: shas.length - found.size - excluded, excluded };
}

/** 一覧のファイルと同じフォルダ（下調べの PDF を置いてよい所） */
export const listDir = (file: string) => dirname(file);

/** 根拠の番号（evidenceIds）の無い、前の形の候補の JSON に、空の番号を足す（人が渡す候補の JSON を受け付けるため） */
export function withEvidenceIds<T>(j: T): T {
  const list = (j as { candidates?: unknown })?.candidates;
  if (Array.isArray(list)) for (const c of list) if (c && typeof c === "object" && !("evidenceIds" in c)) (c as Record<string, unknown>).evidenceIds = [];
  return j;
}

/**
 * 前の回の記録（summary.json と pr-N.md）から、反証を通った候補を作り直す（--from-run）。
 * 古い回の記録には id・fixturePlan・evidenceIds が無いので、id は c1…、fixturePlan は pr-N.md の「作った合成 PDF」の行から取る。
 */
export function candidatesFromRun(summary: any, prBody: (n: number) => string | null): Array<Record<string, unknown>> {
  const judged: any[] = Array.isArray(summary?.candidates) ? summary.candidates : [];
  const kept = judged.filter((c) => c && c.keep === true);
  return kept.map((c, i) => {
    const body = prBody(i + 1) ?? "";
    const plan = /^- 作った合成 PDF：(.*)$/m.exec(body)?.[1]?.trim() ?? "";
    return {
      id: String(c.id ?? `c${i + 1}`).slice(0, 40),
      pattern: String(c.pattern ?? ""),
      title: String(c.title ?? ""),
      nearestRule: String(c.nearestRule ?? ""),
      whyMissed: String(c.whyMissed ?? ""),
      evidenceCount: Number.isInteger(c.evidenceCount) ? c.evidenceCount : 0,
      fixturePlan: String(c.fixturePlan ?? plan).slice(0, 600),
      evidenceIds: Array.isArray(c.evidenceIds) ? c.evidenceIds.map(String) : [],
    };
  });
}

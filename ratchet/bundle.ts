// SPDX-License-Identifier: AGPL-3.0-only
//
// 束を選ぶ（docs/ratchet.md §3.1）。
// - 読むのは、環境変数で渡されたフォルダの中の PDF だけ。新しく取りに行かない。
// - 採点用の実データ（sha256 の一覧）を、束を作る前に除く。
// - 並べる順は sha256 の順（ファイル名に頼らない）。読んだ sha256 を記録して、同じものを二度読まない。
//   途中で止まったら、次は止まった束の残りから始める。
// - 外に出す名前は b01・b02… の番号だけ。パスとファイル名は、記録のフォルダ（リポジトリの外）の中にだけ置く。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BundleItem = { id: string; sha256: string; path: string; bytes: number };

export type State = {
  /** 読み終えた sha256 */
  done: string[];
  /** 進めている束（止まったときに続きから始める） */
  current: { runId: string; items: Array<{ id: string; sha256: string }> } | null;
};

const STATE_FILE = "state.json";

export function loadState(stateDir: string): State {
  const f = join(stateDir, STATE_FILE);
  if (!existsSync(f)) return { done: [], current: null };
  const j = JSON.parse(readFileSync(f, "utf8"));
  return { done: Array.isArray(j.done) ? j.done : [], current: j.current ?? null };
}

export function saveState(stateDir: string, s: State): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, STATE_FILE), JSON.stringify(s, null, 1));
}

/** フォルダの中の PDF を集める（下のフォルダも見る。リンクはたどらない） */
export function listPdfs(dir: string, maxFiles = 100_000): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out.length >= maxFiles) return;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.pdf$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** 除く sha256 の一覧を読む（1 行に 1 つ。# から後と空の行は無視） */
export function readExclude(file: string | null): Set<string> {
  if (!file) return new Set();
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const set = new Set<string>();
  for (const l of lines) {
    const h = l.replace(/#.*/, "").trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(h)) set.add(h);
  }
  return set;
}

export type Selection = {
  runId: string;
  items: BundleItem[];
  /** 数だけ（記録用） */
  counts: { inCorpus: number; excluded: number; alreadyRead: number; remaining: number; resumed: boolean };
};

/**
 * 次の束を選ぶ。止まった束があれば、その残りを先に使う。
 * maxBytes を超える PDF は束に入れず、読んだことにする（数だけ記録。中身は開かない）。
 */
export function selectBundle(opts: {
  corpus: string;
  exclude: Set<string>;
  state: State;
  size: number;
  runId: string;
  maxBytes?: number;
}): Selection {
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  const files = listPdfs(opts.corpus);
  const byHash = new Map<string, { path: string; bytes: number }>();
  let excluded = 0;
  for (const p of files) {
    const bytes = statSync(p).size;
    const h = sha256File(p);
    if (opts.exclude.has(h)) {
      excluded++;
      continue;
    }
    if (!byHash.has(h)) byHash.set(h, { path: p, bytes });
  }
  const done = new Set(opts.state.done);
  const items: BundleItem[] = [];
  let resumed = false;
  // 止まった束の残り
  if (opts.state.current) {
    for (const it of opts.state.current.items) {
      const f = byHash.get(it.sha256);
      if (f && !done.has(it.sha256)) {
        items.push({ id: it.id, sha256: it.sha256, ...f });
        resumed = true;
      }
    }
  }
  const runId = resumed ? opts.state.current!.runId : opts.runId;
  const taken = new Set(items.map((i) => i.sha256));
  const rest = [...byHash.keys()].filter((h) => !done.has(h) && !taken.has(h)).sort();
  for (const h of rest) {
    if (items.length >= opts.size) break;
    const f = byHash.get(h)!;
    if (f.bytes > maxBytes) continue;
    items.push({ id: "", sha256: h, ...f });
  }
  // 番号は束の中の順で振り直さない（続きから始めたときも同じ番号のまま）
  let n = 0;
  const used = new Set(items.map((i) => i.id).filter(Boolean));
  for (const it of items) {
    if (it.id) continue;
    do n++;
    while (used.has(`b${String(n).padStart(2, "0")}`));
    it.id = `b${String(n).padStart(2, "0")}`;
    used.add(it.id);
  }
  const alreadyRead = [...byHash.keys()].filter((h) => done.has(h)).length;
  return {
    runId,
    items,
    counts: { inCorpus: files.length, excluded, alreadyRead, remaining: rest.length, resumed },
  };
}

/** 束を始めたことを記録する（止まったら続きから始めるため） */
export function markStarted(state: State, sel: Selection): State {
  return { ...state, current: { runId: sel.runId, items: sel.items.map(({ id, sha256 }) => ({ id, sha256 })) } };
}

/** 1 件読み終えたことを記録する */
export function markDone(state: State, sha256: string): State {
  const done = state.done.includes(sha256) ? state.done : [...state.done, sha256];
  const current = state.current && state.current.items.every((i) => done.includes(i.sha256)) ? null : state.current;
  return { done, current };
}

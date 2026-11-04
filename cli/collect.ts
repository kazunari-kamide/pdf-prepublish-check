// SPDX-License-Identifier: AGPL-3.0-only
//
// 渡されたファイル・フォルダから、調べるファイルを集める。
// - フォルダは中までたどる。拡張子で選ぶ（ファイルを直接渡したときは、拡張子を問わず調べる）
// - リンク（シンボリックリンク・ジャンクション）はたどらない（同じ所を何度も回る・思わぬ場所を読むのを避ける）
// - 数の上限を超えたら、そこで止めて知らせる

import { lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const MAX_FILES = 10_000;

export type Collected = { files: string[]; missing: string[]; truncated: boolean };

export function collectFiles(inputs: string[], extensions: readonly string[]): Collected {
  const files: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const add = (p: string) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return;
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    seen.add(key);
    files.push(p);
  };
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (truncated) return;
      const p = path.join(dir, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (name === "node_modules" || name === ".git") continue;
        walk(p);
      } else if (st.isFile() && extensions.includes(path.extname(name).toLowerCase())) {
        add(p);
      }
    }
  };
  for (const input of inputs) {
    let st;
    try {
      st = statSync(input);
    } catch {
      missing.push(input);
      continue;
    }
    if (st.isDirectory()) walk(input);
    else if (st.isFile()) add(input);
    else missing.push(input);
  }
  return { files, missing, truncated };
}

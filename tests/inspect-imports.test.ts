// SPDX-License-Identifier: AGPL-3.0-only
//
// コマンドの道具（cli/）は、画面の検査のコード（src/inspect/）を Node でそのまま読む。
// Node は拡張子を補わないので、src/inspect/ の相対の import には .ts を付ける（H の頼み。PR #49）。

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("src/inspect/ の相対の import", () => {
  it("どれも .ts まで書く", () => {
    const bad: string[] = [];
    for (const f of readdirSync("src/inspect").filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(`src/inspect/${f}`, "utf8");
      for (const m of text.matchAll(/(?:from\s+|import\()\s*"(\.{1,2}\/[^"]+)"/g)) {
        if (!m[1]!.endsWith(".ts")) bad.push(`${f}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("Node で、読み込みのフックなしに読める（Vitest の読み込みを通さず、別の node で確かめる）", () => {
    const code = 'const m = await import("./src/inspect/inspect.ts"); const p = await import("./src/inspect/precheck.ts"); process.stdout.write(typeof m.inspectAll + " " + typeof p.precheck);';
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    expect(out).toBe("function function");
  });
});

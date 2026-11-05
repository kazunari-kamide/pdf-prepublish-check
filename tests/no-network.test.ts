// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査器のコードが、外と通信する仕組みを使っていないことを確かめる（CLAUDE.md §2-1）。
// 文字で探すだけの目安で、すべての経路を見つけられるわけではない。CSP（csp.ts）と合わせて守る。

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (/\.(ts|js|mjs|html|css)$/.test(name)) out.push(p);
  }
  return out;
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ["fetch", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["RTCPeerConnection", /\bRTCPeerConnection\b/],
  ["importScripts", /\bimportScripts\s*\(/],
  ["外部の URL", /https?:\/\/(?!www\.w3\.org\/)/],
  ["innerHTML", /\.(innerHTML|outerHTML)\b|insertAdjacentHTML/],
  ["eval", /\beval\s*\(|new\s+Function\s*\(/],
];

describe("通信しない", () => {
  const files = [...listFiles(path.join(ROOT, "src")), ...listFiles(path.join(ROOT, "rules")), path.join(ROOT, "check.html")];

  it("調べるファイルがある", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const [label, re] of FORBIDDEN) {
    it(`${label} を使っていない`, () => {
      const hits = files.filter((f) => re.test(readFileSync(f, "utf8")));
      expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
    });
  }
});

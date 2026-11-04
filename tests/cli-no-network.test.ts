// SPDX-License-Identifier: AGPL-3.0-only
//
// コマンドの道具（cli/）・2つの PDF の比べ（compare/）・PDF 以外の形式（formats/）が、外と通信する仕組みを使っていないことを確かめる
// （CLAUDE.md §2-1）。文字で探すだけの目安で、すべての経路を見つけられるわけではない。
// tests/no-network.test.ts（画面とルール）と同じ考え方に、Node の通信の部品（node:http など）と、ほかのプログラムを動かす部品を足した。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** 出力の SARIF に書く文字（読み込みはしない）。SARIF の決まりの場所と、公式の URL だけ */
const ALLOWED_URLS = ["https://json.schemastore.org/sarif-2.1.0.json", "https://omamoripdf.com/"];

const FORBIDDEN: Array<[string, RegExp]> = [
  ["fetch", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["RTCPeerConnection", /\bRTCPeerConnection\b/],
  ["Node の通信の部品", /["']node:(http|https|http2|net|tls|dgram|dns)["']|["'](http|https|http2|net|tls|dgram|dns)["']/],
  ["ほかのプログラムを動かす部品", /["'](node:)?child_process["']/],
  ["外部の URL", /https?:\/\/[^\s"'`)]+/],
  ["innerHTML", /\.(innerHTML|outerHTML)\b|insertAdjacentHTML/],
  ["eval", /\beval\s*\(|new\s+Function\s*\(/],
];

describe("cli・compare・formats は通信しない", () => {
  const files = ["cli", "compare", "formats"].flatMap((d) => listFiles(path.join(ROOT, d)));

  it("調べるファイルがある", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const [label, re] of FORBIDDEN) {
    it(`${label} を使っていない`, () => {
      const hits = files.filter((f) => {
        let text = readFileSync(f, "utf8");
        if (label === "外部の URL") for (const u of ALLOWED_URLS) text = text.split(u).join("");
        return re.test(text);
      });
      expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
    });
  }
});

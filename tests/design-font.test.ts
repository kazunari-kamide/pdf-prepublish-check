// SPDX-License-Identifier: AGPL-3.0-only
//
// 同梱の書体（design/fonts/README.md）の決まりを確かめる。作り直して1バイトも違わないかは npm run fonts:check（10 秒ほどかかるので、ここでは見ない）。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("同梱の書体", () => {
  it("元のファイルは、README に書いた SHA-256 のもの", () => {
    const readme = read("design/fonts/README.md").toString("utf8");
    for (const f of ["NotoSansJP[wght].ttf", "OFL.txt", "METADATA.pb"]) {
      expect(readme).toContain(sha(read(`design/fonts/source/${f}`)));
    }
  });

  it("配る書体の横に、元と同じライセンスの文（SIL OFL 1.1）を置く", () => {
    const lic = read("src/assets/fonts/OFL.txt");
    expect(sha(lic)).toBe(sha(read("design/fonts/source/OFL.txt")));
    expect(lic.toString("utf8")).toContain("SIL Open Font License, Version 1.1");
  });

  it("配る書体は README に書いたもので、WOFF2 の形", () => {
    const woff2 = read("src/assets/fonts/NotoSansJP-subset.woff2");
    expect(woff2.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(read("design/fonts/README.md").toString("utf8")).toContain(sha(woff2));
  });

  it("画面は、同梱の書体を自分のサイトから読み、書体の決まりの最初に置く", () => {
    const css = read("src/style.css").toString("utf8");
    const face = css.match(/@font-face\s*{[^}]*font-family:\s*"([^"]+)";[^}]*src:\s*url\("([^"]+)"\)/);
    expect(face).not.toBeNull();
    expect(face![2]).toBe("./assets/fonts/NotoSansJP-subset.woff2");
    expect(face![2]).not.toMatch(/^https?:|^\/\//);
    const tokens = read("design/tokens.css").toString("utf8");
    expect(tokens).toMatch(new RegExp(`--font-body:\\s*"${face![1]}",`));
  });
});

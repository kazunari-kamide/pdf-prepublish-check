// SPDX-License-Identifier: AGPL-3.0-only
//
// 同梱の書体（design/fonts/README.md）の決まりを確かめる。作り直して1バイトも違わないかは npm run fonts:check（10 秒ほどかかるので、ここでは見ない）。

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error JS のモジュール（型の宣言はない）
import { chunkRanges, EXTRA, notoChunks, parseUnicodeRange, shiftJisChars } from "../design/fonts/chars.mjs";
// @ts-expect-error JS のモジュール（型の宣言はない）
import { charsOf, isSkipped, isWorkerBundle, listedUiChars, withoutTables } from "../design/fonts/ui-chars.mjs";

const read = (p: string) => readFileSync(p);
const ROOT = path.resolve(import.meta.dirname, "..");
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
    const readme = read("design/fonts/README.md").toString("utf8");
    const files = readdirSync(path.join(ROOT, "src/assets/fonts")).filter((f) => /^NotoSansJP-.*\.woff2$/.test(f));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const woff2 = read(`src/assets/fonts/${f}`);
      expect(woff2.subarray(0, 4).toString("latin1"), f).toBe("wOF2");
      expect(readme, f).toContain(sha(woff2));
    }
  });

  it("画面は、同梱の書体を自分のサイトから読み、書体の決まりの最初に置く", () => {
    // @font-face は design/fonts.css にだけ書き、検査のページ（src/style.css）はそれを読む（2026-11-05 夜。サイトのページと共通）
    expect(read("src/style.css").toString("utf8")).toContain('@import "../design/fonts.css";');
    const css = read("design/fonts.css").toString("utf8");
    const faces = [...css.matchAll(/@font-face\s*{[^}]*font-family:\s*"([^"]+)";[^}]*src:\s*url\("([^"]+)"\)[^}]*font-weight:\s*([\d ]+);/g)].map((m) => ({ family: m[1]!, url: m[2]!, weight: m[3]!.trim() }));
    // 本文の書体は、画面の字の塊（ui）と、残りの字の塊（r01〜）に分ける（2026-11-06 案 A）
    const chunks: { id: string; chars: string }[] = notoChunks(listedUiChars());
    expect(chunks[0]!.id).toBe("ui");
    expect(faces).toEqual([
      ...chunks.map((c) => ({ family: "Noto Sans JP Omamori", url: `../src/assets/fonts/NotoSansJP-${c.id}.woff2`, weight: "400 700" })),
      { family: "Zen Maru Gothic Omamori", url: "../src/assets/fonts/zen-maru-gothic/ZenMaruGothic-Bold-subset.woff2", weight: "700" },
      { family: "Zen Maru Gothic Omamori", url: "../src/assets/fonts/zen-maru-gothic/ZenMaruGothic-Black-subset.woff2", weight: "900" },
    ]);
    for (const f of faces) {
      expect(f.url).not.toMatch(/^https?:|^\/\//);
      expect(existsSync(path.join(ROOT, "design", f.url))).toBe(true);
    }
    const tokens = read("design/tokens.css").toString("utf8");
    expect(tokens).toMatch(/--font-body:\s*"Noto Sans JP Omamori",/);
    // 見出しの書体は、見出しの字だけに絞ったもの。ない字は本文の書体で出る
    expect(tokens).toContain('--font-display: "Zen Maru Gothic Omamori", var(--font-body);');
  });
});

describe("本文の書体の塊（2026-11-06 案 A）", () => {
  const all = [...shiftJisChars()];
  const chunks: { id: string; chars: string }[] = notoChunks(listedUiChars());
  const css = read("design/fonts.css").toString("utf8");
  const ranges = new Map([...css.matchAll(/NotoSansJP-(\w+)\.woff2"\)[^}]*unicode-range:\s*([^;]+);/g)].map((m) => [m[1]!, parseUnicodeRange(m[2]!)]));

  it("どの字も、ちょうど 1 つの塊に入る（抜けも重なりもない）", () => {
    const seen = new Map<string, string>();
    for (const c of chunks) for (const ch of c.chars) {
      expect(seen.get(ch), ch).toBeUndefined();
      seen.set(ch, c.id);
    }
    expect(seen.size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(seen.keys()));
  });

  it("画面の字の一覧と EXTRA の記号は、画面の字の塊に入る", () => {
    const ui = new Set(chunks[0]!.chars);
    for (const ch of EXTRA) expect(ui.has(ch), ch).toBe(true);
    for (const ch of listedUiChars()) if (all.includes(ch)) expect(ui.has(ch), ch).toBe(true);
    // 画面でよく使う字（ひらがな・「検査」など）が入っている
    for (const ch of "あいう検査書類黒塗り") expect(ui.has(ch), ch).toBe(true);
  });

  it("design/fonts.css の unicode-range は、塊の字をすべて含み、塊どうしで重ならない", () => {
    expect([...ranges.keys()]).toEqual(chunks.map((c) => c.id));
    const owner = new Map<number, string>();
    for (const [id, set] of ranges) for (const cp of set) {
      expect(owner.get(cp), `U+${cp.toString(16)}`).toBeUndefined();
      owner.set(cp, id);
    }
    for (const c of chunks) for (const ch of c.chars) expect(owner.get(ch.codePointAt(0)!), ch).toBe(c.id);
  });

  it("画面の字が 1 字増えても、変わる塊は 2 つだけ（画面の字の塊と、その字があった塊）", () => {
    const ui = new Set(chunks[0]!.chars);
    const added = all.find((ch) => !ui.has(ch) && /\p{Script=Han}/u.test(ch))!;
    const next: { id: string; chars: string }[] = notoChunks([...ui, added].join(""));
    const changed = next.filter((c, i) => c.chars !== chunks[i]?.chars).map((c) => c.id);
    expect(changed).toHaveLength(2);
    expect(changed[0]).toBe("ui");
  });

  it("unicode-range は、書体にない字の番号を前の塊に含め、短くまとめる", () => {
    const r = chunkRanges([
      { id: "ui", chars: "AC" },
      { id: "r01", chars: "BD" },
    ]);
    expect(r).toEqual({ ui: "U+41,U+43", r01: "U+42,U+44" });
    expect(chunkRanges([{ id: "ui", chars: "AE" }, { id: "r01", chars: "G" }])).toEqual({ ui: "U+41-46", r01: "U+47" });
    // すき間は、どちらかのとなりが ui なら ui、どちらも ui でなければ前の塊
    expect(chunkRanges([{ id: "ui", chars: "E" }, { id: "r01", chars: "A" }, { id: "r02", chars: "C" }])).toEqual({ ui: "U+44-45", r01: "U+41-42", r02: "U+43" });
  });

  it("書体にない、画面でよく使う字（改行しない空白など）は、画面の字の塊の範囲に入る（余分な塊を読まない）", () => {
    for (const cp of [0xa0]) expect(ranges.get("ui")!.has(cp), `U+${cp.toString(16)}`).toBe(true);
  });

  it("画面の字は、エスケープした書き方からも集め、PDF.js の写しからは集めず、Worker の束は文字コードの表を外して集める", () => {
    // JS の \uXXXX・\u{XXXXX}、CSS の \XXXX、HTML の &#xXXXX; を字に戻す
    const got = charsOf(String.raw`t="` + String.fromCharCode(92) + "u691c" + String.raw`"+"\u{67FB}";a::before{content:"\25B6"}<b>&#x9ED2;</b>`);
    for (const ch of "検査▶黒") expect(got.has(ch), ch).toBe(true);
    expect(isSkipped("assets/inspect.worker-BJpgbo2u.js")).toBe(false);
    expect(isWorkerBundle("assets/inspect.worker-BJpgbo2u.js")).toBe(true);
    expect(isWorkerBundle("assets/check-ZXJwn3ZU.js")).toBe(false);
    // 結果の文（短い）は残し、表（ASCII 以外が 64 字以上続く）は外す
    const table = "亜".repeat(64);
    expect(withoutTables(`m="組織の名前";t="${table}";`)).toBe("m=\"組織の名前\";t=\"\";");
    expect(withoutTables("亜".repeat(63))).toBe("亜".repeat(63));
    expect(isSkipped("assets/pdf.min-jOkS1qa9.mjs")).toBe(true);
    expect(isSkipped("assets/pdf.worker.min-CjEcRF4W.mjs")).toBe(true);
    expect(isSkipped("pdfjs/wasm/openjpeg_nowasm_fallback.js")).toBe(true);
    expect(isSkipped("assets/check-ZXJwn3ZU.js")).toBe(false);
    expect(isSkipped("articles/index.html")).toBe(false);
  });
});


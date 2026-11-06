// SPDX-License-Identifier: AGPL-3.0-only
//
// 見出しの書体（Zen Maru Gothic）に入れる字の一覧（design/fonts/heading-chars.mjs）を確かめる。
// - h1〜h3 の字だけを集め、タグ・SVG・空白は字に入れない
// - いつも入れる字（英数・仮名）が入る
// - 一覧にない見出しの字を見つける（scripts/check-dist.mjs が使う）
// - リポジトリの一覧に、いつも入れる字がすべて入っている
// - 検査のページで画面のスクリプトが作る h3（種類の見出し）に出うる字が、一覧にある（ビルドした HTML には出ないので、作る元から集める）

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error JS のモジュール（型の宣言はない）
import { baseChars, formatChars, headingCharsOf, listedChars, missingHeadingChars } from "../design/fonts/heading-chars.mjs";
import { RULES } from "../src/inspect/rules.ts";

describe("見出しの字の一覧", () => {
  it("h1〜h3 の字だけを集め、タグ・SVG・空白・文字参照を字として数えない", () => {
    const html = `<h1 class="x"><svg><title>袋</title></svg>公開 &amp; 前</h1><h2>結<span>果</span></h2><h4>外</h4><p>本</p>`;
    const got = [...headingCharsOf(html)].sort().join("");
    expect(got).toBe([..."公開&前結果"].sort().join(""));
  });

  it("いつも入れる字に、英数・ひらがな・カタカナ・よく使う記号が入る", () => {
    const base = baseChars();
    for (const ch of "Aa0あんアンー、。「」▲✓") expect(base.has(ch)).toBe(true);
  });

  it("一覧にない見出しの字を、決まった順に返す", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heading-"));
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "a.html"), "<h1>見出し</h1>");
    writeFileSync(path.join(dir, "sub", "b.html"), "<h3>確かめる</h3><p>本文の字は見ない</p>");
    const list = path.join(dir, "list.txt");
    writeFileSync(list, formatChars(new Set("見出")));
    expect(missingHeadingChars(dir, list)).toEqual([..."かしめる確"].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!));
  });

  it("検査のページで画面のスクリプトが作る h3（種類の見出し）に出うる字が、すべて一覧にある（2026-11-06。丸ゴシックで出すため）", () => {
    const ROOT = path.resolve(import.meta.dirname, "..");
    const listed = listedChars();
    // 1. 種類の名前：検出ルールの名前（見つける段で型が増えると、ここで漏れが分かる）
    const labels = RULES.map((r) => r.label);
    expect(labels.length).toBeGreaterThanOrEqual(19);
    // 2. 字の決まった h3：src/main.ts の make("h3", "…")
    const main = readFileSync(path.join(ROOT, "src", "main.ts"), "utf8");
    const fixed = [...main.matchAll(/make\("h3", "([^"]*)"/g)].map((m) => m[1]!);
    expect(fixed).toContain("見た所・見なかった所");
    // h3 を作る所は、名前を入れる 1 つと、字の決まったものだけ（ほかの作り方が増えたら、ここも見直す）
    expect(main.match(/make\("h3"/g)).toHaveLength(fixed.length + 1);
    expect(main).toMatch(/const head = make\("h3", undefined, "group-head"\);\r?\n[\s\S]{0,200}head\.append\(make\("span", g\.label, "group-name"\)\)/);
    // 3. 見出しの前に CSS で付ける印（.group-name::before・.group-head::before の content）
    const css = readFileSync(path.join(ROOT, "src", "style.css"), "utf8");
    const marks = [...css.matchAll(/\.group-(?:name|head)::before \{[^}]*content: "([^"]*)"/g)].map((m) => m[1]!);
    expect(marks.length).toBeGreaterThanOrEqual(2);
    const need = new Set([...labels, ...fixed, ...marks].join(""));
    const lack = [...need].filter((ch) => !/\s/.test(ch) && !listed.has(ch));
    expect(lack, "design/fonts/heading-chars.txt に足し、npm run fonts:build で書体を作り直してください").toEqual([]);
  });

  it("リポジトリの一覧（design/fonts/heading-chars.txt）に、いつも入れる字がすべて入っている", () => {
    const listed = listedChars();
    const lack = [...baseChars()].filter((ch) => !listed.has(ch));
    expect(lack).toEqual([]);
  });
});

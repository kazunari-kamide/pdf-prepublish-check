// SPDX-License-Identifier: AGPL-3.0-only
//
// 結果の欄の案 A（2026-11-07 本人が承認）：一覧のすぐ下に大きなボタン・下の帯はなし・細かい情報は「詳しく見る」の中。
// - 要点の一覧：同じ種類は 1 行、5 種類を超えた分は「詳しく見る」だけ（src/ui/model.ts の kindSummary）
// - プロパティの中身：欄の名前と値の頭の 2 字だけ（src/ui/props-glance.ts）
// - check.html の並びと、「詳しく見る」へ移した部品（消さずに移しただけ）・確かめの窓に「やめる」がないこと
// - 入口で容量の上限を選んだときは、小さくする所を「詳しく見る」の外へ出す（動画の S16）

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InspectSummary, Item, RuleResult } from "../src/inspect/report";
import { buildView, KIND_LIMIT, kindSummary, shortHeadline } from "../src/ui/model";
import { buildGlance, GLANCE_LIMIT } from "../src/ui/props-glance";

const ROOT = path.resolve(import.meta.dirname, "..");
const html = readFileSync(path.join(ROOT, "check.html"), "utf8");
const main = readFileSync(path.join(ROOT, "src", "main.ts"), "utf8");

const item = (over: Partial<Item>): Item => ({
  pattern: "P6",
  severity: "high",
  title: "黒い四角の下に、画像の中身が残っています",
  why: "画像の上に重ねただけなので、四角を外したり画像を取り出したりすると、下に写っているものが見えます。",
  detail: "",
  page: 1,
  rect: [10, 10, 20, 20],
  ...over,
});
const rule = (pattern: Item["pattern"], label: string, items: Item[]): RuleResult => ({ ruleId: pattern.toLowerCase(), ruleVersion: "1", label, pattern, status: "ok", items, notices: [] });
const summary = (rules: RuleResult[]): InspectSummary => ({ pages: [{ page: 1, view: [0, 0, 100, 100], rotate: 0 }], pagesUnreadable: false, rules });

describe("要点の一覧（同じ種類は 1 行）", () => {
  it("同じ種類の 3 か所は 1 行にまとめ、場所と数を出す（見本の会議録と同じ形）", () => {
    const v = buildView(summary([rule("P6", "見せかけの黒塗り", [item({}), item({ rect: [10, 30, 20, 40] }), item({ rect: [10, 50, 20, 60] })])]));
    const k = kindSummary(v);
    expect(k.shown).toHaveLength(1);
    expect(k.shown[0]).toMatchObject({ pattern: "P6", title: "黒い四角の下に、画像の中身が残っています", sevLabel: "▲ 高", count: 3, check: 0, where: "ページ 1", firstNo: 1 });
    expect(k.moreKinds).toBe(0);
    expect(shortHeadline(v)).toBe("3 か所に、見えない情報が残っています");
  });

  it("題がそろわない種類は、種類の名前でまとめる。ファイル全体の指摘はそう書く", () => {
    const p1 = [item({ pattern: "P1", severity: "medium", title: "文書情報の「作成者」に値が入っています", page: null, rect: null }), item({ pattern: "P1", severity: "medium", title: "文書情報の「タイトル」に値が入っています", page: null, rect: null })];
    const k = kindSummary(buildView(summary([rule("P1", "文書情報", p1)])));
    expect(k.shown[0]).toMatchObject({ title: "文書情報が見つかりました", sevLabel: "■ 中", count: 2, where: "ファイル全体" });
  });

  it("同じ型（P6）を見るルールが複数あるとき、題がそろわない行の見出しは、当たっていないルールの名前にしない（2026-11-08）", () => {
    // main の並び（p6-text・barcode-scan・cross-page-redaction）。当たったのは p6-text の 2 種類の題だけ
    const p6 = [item({}), item({ title: "黒い四角の下に、字が残っています", rect: [10, 30, 20, 40] })];
    const main = buildView(summary([rule("P6", "見せかけの黒塗り", p6), rule("P6", "黒塗りのそばの記号", []), rule("P6", "同じ書式のページの塗り残し", [])]));
    expect(kindSummary(main).shown[0]!.title).toBe("見せかけの黒塗りが見つかりました");
    // p6-text と redacted-text-elsewhere が同じページに当たった形（rte-l03）
    const mixed = buildView(
      summary([
        rule("P6", "見せかけの黒塗り", [item({ title: "黒い四角の下に、字が残っています" })]),
        rule("P6", "塗った字が、ほかの所に出ている", [item({ title: "黒く塗った所の字が、ほかの所に塗られずに出ています", confidence: "check" })]),
        rule("P6", "同じ書式のページの塗り残し", []),
      ]),
    );
    expect(kindSummary(mixed).shown[0]!.title).toBe("見せかけの黒塗りが見つかりました");
    // 当たったのが 1 つのルールの別々の題なら、そのルールの名前
    const one = buildView(summary([rule("P6", "見せかけの黒塗り", []), rule("P6", "同じ書式のページの塗り残し", [item({ title: "a" }), item({ title: "b", rect: [10, 30, 20, 40] })])]));
    expect(kindSummary(one).shown[0]!.title).toBe("同じ書式のページの塗り残しが見つかりました");
  });

  it("並びは深刻度の順。確かめる所だけの種類は「？ 確かめる」で、高の次", () => {
    const v = buildView(
      summary([
        rule("P1", "文書情報", [item({ pattern: "P1", severity: "medium", title: "a", page: null, rect: null })]),
        rule("P7", "隠れたテキスト", [item({ pattern: "P7", severity: "high", title: "b", confidence: "check" })]),
        rule("P6", "見せかけの黒塗り", [item({})]),
      ]),
    );
    expect(kindSummary(v).shown.map((k) => k.sevLabel)).toEqual(["▲ 高", "？ 確かめる", "■ 中"]);
  });

  it(`${KIND_LIMIT} 種類を超えた分は、要点に出さず、種類と所の数だけを返す`, () => {
    const rules = (["P1", "P2", "P3", "P4", "P8", "P9", "P11"] as Item["pattern"][]).map((p, i) => rule(p, `種類${i}`, [item({ pattern: p, severity: "low", title: `t${i}`, page: null, rect: null }), item({ pattern: p, severity: "low", title: `t${i}`, page: null, rect: null })]));
    const k = kindSummary(buildView(summary(rules)));
    expect(k.shown).toHaveLength(KIND_LIMIT);
    expect(k.moreKinds).toBe(2);
    expect(k.moreCount).toBe(4);
  });

  it("個人情報の候補（見えている字）は、要点の一覧に入れない（「詳しく見る」の中で選ぶ）", () => {
    const v = buildView(summary([rule("P13", "個人情報らしい字", [item({ pattern: "P13", severity: "medium", title: "氏名らしい字" })])]));
    expect(kindSummary(v).shown).toEqual([]);
  });
});

describe("プロパティに入っていた情報（頭の 2 字だけ）", () => {
  const label = (k: string) => ({ Title: "タイトル", Author: "作成者" })[k] ?? null;
  it("欄の名前と、値の頭の 2 字だけ。独自の欄は名前を出さない。XMP は数だけ", () => {
    const g = buildGlance(
      { info: [{ key: "Author", value: "山田花子さん" }, { key: "Title", value: "審査会の会議録（案）" }, { key: "Company", value: "星見台事務サービス" }], xmp: [{ key: "dc:creator", value: "x" }] },
      label,
    );
    expect(g.empty).toBe(false);
    expect(g.rows.map((r) => r.label)).toEqual(["作成者", "タイトル", "独自の欄"]);
    for (const r of g.rows) expect(r.value.slice(2)).toMatch(/^●{1,4}…?$/);
    expect(g.rows[0]!.value.startsWith("山田")).toBe(true);
    expect(JSON.stringify(g)).not.toContain("Company");
    expect(g.xmp).toBe(1);
  });

  it("伏せ字は短く（●は 4 個まで。長い値は「…」）", () => {
    expect(buildGlance({ info: [{ key: "Author", value: "あいうえおかきくけこさしすせそ" }], xmp: [] }, label).rows[0]!.value).toBe("あい●●●●…");
    expect(buildGlance({ info: [{ key: "Author", value: "あいうえ" }], xmp: [] }, label).rows[0]!.value).toBe("あい●●");
  });

  it("3 字以下の値は、伏せずに出す（中身の決まりと同じ）", () => {
    expect(buildGlance({ info: [{ key: "Author", value: "総務課" }], xmp: [] }, label).rows[0]!.value).toBe("総務課");
  });

  it(`空なら empty。${GLANCE_LIMIT} 欄を超えた分は数だけ`, () => {
    expect(buildGlance({ info: [], xmp: [] }, label).empty).toBe(true);
    const many = Array.from({ length: GLANCE_LIMIT + 2 }, (_, i) => ({ key: `K${i}`, value: "あいうえお" }));
    const g = buildGlance({ info: many, xmp: [] }, label);
    expect(g.rows).toHaveLength(GLANCE_LIMIT);
    expect(g.more).toBe(2);
  });
});

describe("check.html の並び（案 A）", () => {
  const face = html.slice(html.indexOf('<div class="result-face" id="result-face">'), html.indexOf('<section id="clean"'));
  const more = html.slice(html.indexOf('<details id="more"'), html.indexOf('<p class="scope-note" id="scope-note"'));

  it("見出し → なぜの 1 文 → 要点の一覧 → プロパティ → 大きなボタン → 1 行の説明", () => {
    const order = ['id="result-title"', 'id="result-why"', 'id="kinds"', 'id="props-glance"', 'id="sanitize"', 'id="sanitize-note"'].map((s) => face.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("細かい情報は、消さずに「詳しく見る」の中へ移した（id はそのまま）", () => {
    for (const id of ["notices", "groups", "pick-tools", "candidate-slot", "sanitize-more", "coverage-slot", "props", "ruleset", "clean-more", "report-download", "compress"]) {
      expect(more, id).toContain(`id="${id}"`);
      expect(face, id).not.toContain(`id="${id}"`);
    }
    // 個人情報の候補は、「自分で黒塗りする所を選ぶ」の隣
    expect(more.indexOf('id="candidate-slot"')).toBeGreaterThan(more.indexOf('id="pick-tools"'));
    expect(more.indexOf('id="candidate-slot"')).toBeLessThan(more.indexOf('id="sanitize-more"'));
    expect(more).toMatch(/<summary>詳しく見る<\/summary>/);
  });

  it("「すべてを見つけるものではありません」に当たる一言は、小さく残す", () => {
    expect(html).toContain('<p class="scope-note" id="scope-note" hidden>見つけられるのは、ここに並べた種類だけです。すべての漏れを見つけられるわけではありません。</p>');
    expect(html).toContain("すべてを見つけるものではありません。");
  });

  it("確かめの窓に「やめる」はなく、押すボタンは本文の外の右下（閉じる・Esc・外を押す でやめる）", () => {
    const dialog = html.slice(html.indexOf('<dialog id="tidy-dialog"'), html.indexOf("</dialog>", html.indexOf('<dialog id="tidy-dialog"')));
    expect(dialog).not.toContain("やめる</button>");
    expect(dialog).not.toContain("tidy-dialog-cancel");
    expect(dialog).toContain('id="tidy-dialog-close"');
    expect(dialog).toMatch(/<summary>専門の名前で見る<\/summary>/);
    const actions = dialog.slice(dialog.indexOf('class="tidy-dialog-actions"'));
    expect(actions.indexOf('id="tidy-dialog-hint"')).toBeLessThan(actions.indexOf('id="tidy-dialog-run"'));
    expect(main).not.toContain("tidy-dialog-cancel");
  });
});

describe("「整える」のボタンが画面の外にあるときだけの帯（案 B の帯。2026-11-07 本人）", () => {
  const css = readFileSync(path.join(ROOT, "src", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("帯は右の欄の最後（キーボードの順と読み上げの並びを乱さない）。最初は隠す", () => {
    const aside = html.slice(html.indexOf('<aside class="results"'), html.indexOf("</aside>"));
    expect(aside).toContain('<div id="tidy-band" class="tidy-band" hidden>');
    expect(aside.indexOf('id="tidy-band"')).toBeGreaterThan(aside.indexOf('id="scope-note"'));
  });

  it("画面の下に貼り付ける（sticky なので幅は右の欄と同じ）。白い地に紅の細い線。下の端いっぱいの固定はしない", () => {
    const band = css.match(/\.tidy-band \{[^}]*\}/)![0];
    expect(band).toMatch(/position: sticky;/);
    expect(band).toMatch(/bottom: 0;/);
    expect(band).toMatch(/background: var\(--surface-page\);/);
    expect(band).toMatch(/border-top: var\(--bw-2\) solid var\(--danger\);/);
    expect(css).not.toMatch(/#sanitize[^{]*\{[^}]*position: fixed/);
  });

  it("窓の高さが字の大きさに比べて低いときは、帯を出さない（字だけ大きくしたとき、帯が中身を隠していた）", () => {
    expect(css).toMatch(/@media not \(min-height: 40rem\) \{\s*\.tidy-band \{\s*display: none;\s*\}\s*\}/);
  });

  it("出すのは、整える前で主のボタンが画面の外にあるときだけ（ボタンが見えたら消す）", () => {
    const sync = main.slice(main.indexOf("function syncTidyBand()"), main.indexOf("function renderPicks()"));
    for (const cond of ['s.phase === "before"', "!ui.sanitize.disabled", 'ui.sanitize.dataset.weight !== "sub"', 'ui.sanitize.dataset.busy !== "true"', "!sanitizeInView"]) expect(sync).toContain(cond);
    expect(sync).toContain(".observe(ui.sanitize)");
    // 帯から窓を開いてやめたときは、帯へフォーカスを戻す
    expect(main).toContain("tidyOpener = ui.tidyBandRun;");
  });
});

describe("入口で容量の上限を選んだとき（動画の S16）", () => {
  it("小さくする所の置き場は 2 つ：ふだんは「詳しく見る」の中、上限を選んだときは保存のすぐ下", () => {
    const clean = html.slice(html.indexOf('<section id="clean"'), html.indexOf('<details id="more"'));
    expect(clean).toContain('id="compress-slot"');
    expect(clean.indexOf('id="compress-slot"')).toBeGreaterThan(clean.indexOf('id="download"'));
    expect(html.slice(html.indexOf('<details id="more"'))).toContain('<div id="compress-home">');
  });

  it("上限まで小さくするときは、「詳しく見る」の外へ移す。最初の画面に戻ると元へ戻す", () => {
    const shrink = main.slice(main.indexOf("async function shrinkToLimit"), main.indexOf("function clearResults"));
    expect(shrink).toContain("placeCompress(true);");
    const reset = main.slice(main.indexOf("function reset()"), main.indexOf("function goHome()"));
    expect(reset).toContain("placeCompress(false);");
  });
});

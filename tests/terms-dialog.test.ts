// SPDX-License-Identifier: AGPL-3.0-only
//
// 検査のページの利用規約のダイアログ（src/site/pages.ts の renderTermsDialog・site.ts の withTermsDialog・src/ui/terms-click.ts）。
// - 文は利用規約のページと同じ元から作る（2 か所で文がずれない）
// - 検査のページの「利用規約」のリンクは、利用規約のページの場所のまま（新しいタブ・中クリックではそのページが開く）

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cspForMeta } from "../csp.ts";
import { OFFICIAL_ORIGIN } from "../htaccess.ts";
import { buildLicenses } from "../site-licenses.ts";
import { withTermsDialog } from "../site.ts";
import { TERMS_BLOCKS, TERMS_DIALOG_MARKER, TERMS_META, renderGuidePages, renderTermsDialog } from "../src/site/pages.ts";
import { TERMS_PATH, escapeHtml } from "../src/site/render.ts";
import { isOutside, isPlainClick } from "../src/ui/terms-click.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const index = readFileSync(path.join(ROOT, "check.html"), "utf8");
const REPO = "https://github.com/example-owner/example-repo";
const dialog = renderTermsDialog({ repoUrl: REPO });
const termsPage = renderGuidePages({ origin: OFFICIAL_ORIGIN, csp: cspForMeta, cssHref: "/assets/site.css", repoUrl: REPO }, buildLicenses(ROOT).data).get("terms.html")!;

/** 節の部分だけ（<section class="site-section"> … </section> を並べたもの）。見出しの段の違い（h2・h3）はそろえる */
const sections = (html: string) => [...html.matchAll(/<section class="site-section">[\s\S]*?<\/section>/g)].map((m) => m[0].replace(/<(\/?)h3>/g, "<$1h2>"));

describe("利用規約のダイアログの中身", () => {
  it("節は、利用規約のページと一字も違わない（同じ元から作る）", () => {
    expect(sections(dialog)).toHaveLength(TERMS_BLOCKS.length);
    expect(sections(dialog)).toEqual(sections(termsPage));
    expect(dialog).toContain(`<p class="site-lead">${escapeHtml(TERMS_META.description)}</p>`);
  });

  it("読み上げで「利用規約」のダイアログだと分かる：題（h2）を aria-labelledby で指し、題はフォーカスを受けられる", () => {
    expect(dialog).toMatch(/^<dialog class="terms-dialog" id="terms-dialog" aria-labelledby="terms-dialog-title"/);
    expect(dialog).toContain(`<h2 class="terms-dialog-title" id="terms-dialog-title" tabindex="-1">利用規約</h2>`);
    expect(dialog).toContain(`<button type="button" class="terms-dialog-close" id="terms-dialog-close">閉じる</button>`);
    // 節の見出しは、題の下の段（h3）
    expect(dialog).not.toMatch(/<h2>/);
    expect(dialog.match(/<h3>/g)).toHaveLength(TERMS_BLOCKS.length);
  });

  it("止めるリンクの場所（data-page）は利用規約のページの場所。中には、そのページを開くリンクもある", () => {
    expect(dialog).toContain(`data-page="${TERMS_PATH}"`);
    expect(dialog).toContain(`<a href="${TERMS_PATH}" data-terms-page>利用規約のページで開く</a>`);
  });

  it("スクリプト・外から読み込むものを入れない（検査のページは通信をしない）", () => {
    expect(dialog).not.toMatch(/<script|<img|<link|<iframe|\son\w+=/i);
  });
});

describe("検査のページへの埋め込み", () => {
  it("check.html に目印がちょうど 1 つあり、ビルドの時にダイアログに置き換わる", () => {
    expect(index.split(TERMS_DIALOG_MARKER)).toHaveLength(2);
    const out = withTermsDialog(index, REPO);
    expect(out).not.toContain(TERMS_DIALOG_MARKER);
    expect(out).toContain(dialog);
  });

  it("目印がない・2 つあるときは、ビルドを止める", () => {
    expect(() => withTermsDialog("<body></body>", null)).toThrow(/1 つではありません（0 個）/);
    expect(() => withTermsDialog(`${TERMS_DIALOG_MARKER}${TERMS_DIALOG_MARKER}`, null)).toThrow(/（2 個）/);
  });

  it("検査のページの「利用規約」のリンク（置き場の下と、下の帯）は、利用規約のページの場所のまま", () => {
    const links = [...index.matchAll(/<a href="([^"]+)">利用規約<\/a>/g)].map((m) => m[1]);
    expect(links).toHaveLength(2);
    for (const href of links) expect(href).toBe(TERMS_PATH);
  });
});

describe("押し方の見分け", () => {
  const click = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  it("修飾キーなしの左クリックだけ、ダイアログで開く", () => {
    expect(isPlainClick(click)).toBe(true);
    expect(isPlainClick({ ...click, button: 1 })).toBe(false); // 中クリック
    expect(isPlainClick({ ...click, ctrlKey: true })).toBe(false); // 新しいタブ
    expect(isPlainClick({ ...click, metaKey: true })).toBe(false);
    expect(isPlainClick({ ...click, shiftKey: true })).toBe(false); // 新しいウィンドウ
    expect(isPlainClick({ ...click, altKey: true })).toBe(false);
    expect(isPlainClick({ ...click, defaultPrevented: true })).toBe(false);
  });

  it("枠の外を押したかどうか", () => {
    const r = { left: 10, right: 110, top: 20, bottom: 220 };
    expect(isOutside(5, 50, r)).toBe(true);
    expect(isOutside(50, 230, r)).toBe(true);
    expect(isOutside(50, 50, r)).toBe(false);
    expect(isOutside(10, 20, r)).toBe(false);
  });
});

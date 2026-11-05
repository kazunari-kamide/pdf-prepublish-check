// SPDX-License-Identifier: AGPL-3.0-only
//
// ロゴマーク（design/logo/*.svg）を、ページに差し込む。このファイルのコードは AGPL-3.0-only で、
// 差し込む SVG そのものは別の条件（LicenseRef-OmamoriPDF-Logo。design/logo/README.md）。
// - 見出しのマークは、HTML の中に SVG を直接書き込む（ファイルを取りに行く通信を増やさない）
// - ファビコンは data: の形にする（/favicon.ico などへの要求を出さない。CSP の img-src は data: を許している）
// - SVG は fill= などの属性だけで書く（CSP の style-src 'self' で、style="…" は止まるため）
// ブラウザでは動かさない。Vite のプラグイン（ビルドと開発サーバー）と site.ts が呼ぶ。

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const LOGO_DIR = path.join(import.meta.dirname, "design", "logo");

export type LogoName = "mark" | "mark-on-dark" | "mark-small";

/** check.html（検査のページ）の中の、差し込む場所の目印 */
export const MARK_PLACEHOLDER = "<!--omamori:mark-->";
export const FAVICON_PLACEHOLDER = 'href="omamori:favicon"';

/** SVG のファイルから、注釈（<!-- -->）と前後の空白を除いた中身 */
export function logoSvg(name: LogoName): string {
  const raw = readFileSync(path.join(LOGO_DIR, `${name}.svg`), "utf8");
  const svg = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!svg.startsWith("<svg ") || !svg.endsWith("</svg>")) throw new Error(`design/logo/${name}.svg が SVG の形になっていません`);
  if (/\sstyle=|<style|<script|\shref=|\son[a-z]+=/i.test(svg)) {
    throw new Error(`design/logo/${name}.svg に、style・script・リンク・イベントが入っています（CSP で止まるか、通信のもとになる）`);
  }
  return svg;
}

/** 見出しに置くマーク。名前の字がすぐ横にあるので、読み上げでは飛ばす */
export function inlineMark(name: LogoName, className: string): string {
  return logoSvg(name).replace(/^<svg /, `<svg class="${className}" aria-hidden="true" focusable="false" `);
}

/** ファビコンの href（data:image/svg+xml の形） */
export function faviconHref(): string {
  return `data:image/svg+xml,${encodeURIComponent(logoSvg("mark-small"))}`;
}

/** check.html の目印を、ロゴに置き換える。目印が見つからなければ止める（ロゴが抜けたまま配らない） */
export function injectLogo(html: string): string {
  for (const p of [MARK_PLACEHOLDER, FAVICON_PLACEHOLDER]) {
    if (html.split(p).length !== 2) throw new Error(`check.html に、ロゴを差し込む目印 ${p} がちょうど1つありません`);
  }
  return html.replace(MARK_PLACEHOLDER, inlineMark("mark", "brand-mark")).replace(FAVICON_PLACEHOLDER, `href="${faviconHref()}"`);
}

export function logoPlugin(): Plugin {
  return {
    name: "omamori-logo",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return injectLogo(html);
      },
    },
  };
}

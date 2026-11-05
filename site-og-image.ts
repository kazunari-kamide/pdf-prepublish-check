// SPDX-License-Identifier: AGPL-3.0-only
//
// OGP・X のカードの画像（1200×630）を作る。できた画像は src/site/og-image.png としてリポジトリに置き、
// ビルドでは、そのファイルを dist/og-image.png にそのまま写す（site.ts）。ビルドのたびに描かないのは、
// 描き方が OS で少し変わり、配る成果物のハッシュがそろわなくなるため（CLAUDE.md §11-4）。
//
//   npm run og:build   … 作り直す（node site-og-image.ts --write）（@napi-rs/canvas と、同梱の書体 design/fonts/source/NotoSansJP[wght].ttf を使う）
//
// - 中身は、公式のロゴマーク（design/logo/mark.svg）と名前と短い一言だけ。
//   できた画像には公式のロゴが入るので、画像の使える条件はロゴと同じ（LicenseRef-OmamoriPDF-Logo。改変版には使えない。design/logo/README.md）。字の例（架空のものも）は入れない。
// - 色は design/tokens.css のベース色（墨）とアクセント色（紅）と、画面の下地。
// - 通信しない。書体はリポジトリの中のファイルを読む。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GlobalFonts, Image, createCanvas } from "@napi-rs/canvas";
import { OG_IMAGE_SIZE, SITE_NAME } from "./src/site/seo.ts";

const ROOT = import.meta.dirname;
const FONT = path.join(ROOT, "design", "fonts", "source", "NotoSansJP[wght].ttf");
const LOGO = path.join(ROOT, "design", "logo", "mark.svg");
export const OG_IMAGE_FILE = path.join(ROOT, "src", "site", "og-image.png");

const COLOR = { base: "#2b2a28", accent: "#a3201b", paper: "#fbfaf7", line: "#d9d4ca", muted: "#57534e" };
export const OG_LINES = { lead: "公開・提出の前に、", main: "PDF を自分で確かめる", note: "見た目では分からない情報を、ブラウザの中だけで調べます" } as const;

export function renderOgImage(): Buffer {
  if (!GlobalFonts.registerFromPath(FONT, "OmamoriOg")) throw new Error("書体を読めませんでした（design/fonts/source/）");
  const { width, height } = OG_IMAGE_SIZE;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = COLOR.paper;
  ctx.fillRect(0, 0, width, height);
  // 左の紅の帯
  ctx.fillStyle = COLOR.accent;
  ctx.fillRect(0, 0, 24, height);

  // ロゴ：公式のロゴマーク（design/logo/mark.svg。形・色を変えずに、明るい地に置く。design/logo/README.md）と、名前
  const logoX = 96, logoY = 100, logoSize = 176;
  const logo = new Image();
  logo.src = readFileSync(LOGO);
  ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
  ctx.fillStyle = COLOR.base;
  ctx.font = "700 92px OmamoriOg";
  ctx.textBaseline = "middle";
  ctx.fillText(SITE_NAME, logoX + logoSize + 36, logoY + logoSize / 2 + 4);

  // 一言
  ctx.fillStyle = COLOR.base;
  ctx.font = "500 52px OmamoriOg";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(OG_LINES.lead, 104, 392);
  ctx.font = "700 68px OmamoriOg";
  ctx.fillText(OG_LINES.main, 104, 476);

  // 区切りの線と、補足
  ctx.fillStyle = COLOR.line;
  ctx.fillRect(104, 520, 992, 3);
  ctx.fillStyle = COLOR.muted;
  ctx.font = "400 32px OmamoriOg";
  ctx.fillText(OG_LINES.note, 104, 574);
  return canvas.toBuffer("image/png");
}

if (process.argv.includes("--write")) {
  const png = renderOgImage();
  writeFileSync(OG_IMAGE_FILE, png);
  console.log(`作りました：src/site/og-image.png（${png.length} バイト・${OG_IMAGE_SIZE.width}×${OG_IMAGE_SIZE.height}）`);
}

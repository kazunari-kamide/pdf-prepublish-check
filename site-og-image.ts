// SPDX-License-Identifier: AGPL-3.0-only
//
// OGP・X のカードの画像（1200×630）を作る。できた画像は src/site/og-image.png としてリポジトリに置き、
// ビルドでは、そのファイルを dist/og-image.png にそのまま写す（site.ts）。ビルドのたびに描かないのは、
// 描き方が OS で少し変わり、配る成果物のハッシュがそろわなくなるため（CLAUDE.md §11-4）。
//
//   npm run og:build   … 作り直す（node site-og-image.ts --write）（@napi-rs/canvas と、同梱の書体 design/fonts/source/NotoSansJP[wght].ttf を使う）
//
// - 中身は、ロゴ（「守」の印）と名前と短い一言だけ。字の例（架空のものも）は入れない。
// - 色は design/tokens.css のベース色（墨）とアクセント色（紅）と、画面の下地。
// - 通信しない。書体はリポジトリの中のファイルを読む。

import { writeFileSync } from "node:fs";
import path from "node:path";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { OG_IMAGE_SIZE, SITE_NAME } from "./src/site/seo.ts";

const ROOT = import.meta.dirname;
const FONT = path.join(ROOT, "design", "fonts", "source", "NotoSansJP[wght].ttf");
export const OG_IMAGE_FILE = path.join(ROOT, "src", "site", "og-image.png");

const COLOR = { base: "#2b2a28", accent: "#a3201b", paper: "#fbfaf7", line: "#d9d4ca", muted: "#57534e" };
export const OG_LINES = { lead: "公開・提出の前に、", main: "PDF を自分で確かめる", note: "見た目では分からない情報を、ブラウザの中だけで調べます" } as const;

function roundRect(ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, x: number, y: number, w: number, h: number, r: [number, number, number, number]) {
  const [tl, tr, br, bl] = r;
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

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

  // ロゴ：「守」の印（画面の .seal と同じ形：紅の枠・上の角を大きく丸める）と、名前
  const sealX = 104, sealY = 112, sealW = 120, sealH = 152;
  ctx.lineWidth = 8;
  ctx.strokeStyle = COLOR.accent;
  roundRect(ctx, sealX, sealY, sealW, sealH, [36, 36, 22, 22]);
  ctx.stroke();
  ctx.fillStyle = COLOR.accent;
  ctx.font = "700 80px OmamoriOg";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("守", sealX + sealW / 2, sealY + sealH / 2 + 4);
  ctx.textAlign = "left";
  ctx.fillStyle = COLOR.base;
  ctx.font = "700 92px OmamoriOg";
  ctx.fillText(SITE_NAME, sealX + sealW + 44, sealY + sealH / 2 + 4);

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

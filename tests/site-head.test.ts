// SPDX-License-Identifier: AGPL-3.0-only
//
// ビルドしたあとの全ページの head を、数で確かめる（題・説明・canonical・OGP・X のカード。src/site/seo.ts）。
// vite の build を一時フォルダに出して、その HTML を読む。sitemap.xml・robots.txt・カードの画像もあわせて見る。

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OFFICIAL_ORIGIN } from "../htaccess.ts";
import { BANNED_WORDS, NOINDEX_PATHS, OG_IMAGE_PATH, OG_IMAGE_SIZE } from "../src/site/seo.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
let out = "";

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const chars = (s: string) => [...s].length;

beforeAll(async () => {
  out = mkdtempSync(path.join(tmpdir(), "omamori-head-"));
  await build({ root: ROOT, configFile: path.join(ROOT, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
}, 180_000);
afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

type Head = { file: string; url: string; all: (re: RegExp) => string[] };
/** 検索に載せるページ（noindex のページを除く） */
const pages = (): Head[] => allPages().filter((h) => !NOINDEX_PATHS.has(new URL(h.url).pathname));
const noindexPages = (): Head[] => allPages().filter((h) => NOINDEX_PATHS.has(new URL(h.url).pathname));
function allPages(): Head[] {
  return walk(out)
    .filter((f) => f.endsWith(".html") && !/^google[0-9a-f]+\.html$/.test(path.basename(f)))
    .map((f) => {
      const rel = path.relative(out, f).split(path.sep).join("/");
      const url = OFFICIAL_ORIGIN + "/" + rel.replace(/(^|\/)index\.html$/, "$1");
      const head = readFileSync(f, "utf8").split("</head>")[0] ?? "";
      return { file: rel, url, all: (re: RegExp) => [...head.matchAll(new RegExp(re.source, "g"))].map((m) => decode(m[1] ?? "")) };
    });
}
const meta = (h: Head, key: string) => h.all(new RegExp(`<meta (?:property|name)="${key.replace(/[.:]/g, "\\$&")}" content="([^"]*)"`));

describe("ビルドしたあとの全ページの head", () => {
  it("検索に載せないページ（404）は、noindex で、カードを付けない。canonical はそのページ。題と説明の長さは同じ決まり", () => {
    const list = noindexPages();
    expect(list.map((h) => h.file)).toEqual(["404.html"]);
    for (const h of list) {
      expect(meta(h, "robots"), h.file).toEqual(["noindex"]);
      expect(h.all(/<link rel="canonical" href="([^"]*)"/), h.file).toEqual([h.url]);
      expect(meta(h, "og:url"), h.file).toEqual([]);
      const t = h.all(/<title>([^<]*)<\/title>/)[0] ?? "";
      const d = meta(h, "description")[0] ?? "";
      expect(chars(t)).toBeGreaterThanOrEqual(20);
      expect(chars(d)).toBeGreaterThanOrEqual(80);
      expect(chars(d)).toBeLessThanOrEqual(120);
    }
  });

  it("検索に載せるページは、noindex を付けない", () => {
    for (const h of pages()) expect(meta(h, "robots"), h.file).toEqual([]);
  });

  it("ページが 40 以上あり、すべてに題・説明・canonical・OGP の 6 つがそろう", () => {
    const list = pages();
    expect(list.length).toBeGreaterThanOrEqual(40);
    const missing: string[] = [];
    for (const h of list) {
      const title = h.all(/<title>([^<]*)<\/title>/);
      const desc = meta(h, "description");
      const canonical = h.all(/<link rel="canonical" href="([^"]*)"/);
      const six = ["og:title", "og:description", "og:url", "og:type", "og:image", "twitter:card"].map((k) => [k, meta(h, k)] as const);
      for (const [k, v] of [["title", title], ["description", desc], ["canonical", canonical], ...six] as const) if (v.length !== 1) missing.push(`${h.file}：${k} が ${v.length} 個`);
    }
    expect(missing).toEqual([]);
  });

  it("題は 20〜40 字、説明は 80〜120 字（題は 30 字前後をめあてにする）", () => {
    const off: string[] = [];
    for (const h of pages()) {
      const t = h.all(/<title>([^<]*)<\/title>/)[0] ?? "";
      const d = meta(h, "description")[0] ?? "";
      if (chars(t) < 20 || chars(t) > 40) off.push(`${h.file}：題 ${chars(t)} 字`);
      if (chars(d) < 80 || chars(d) > 120) off.push(`${h.file}：説明 ${chars(d)} 字`);
    }
    expect(off).toEqual([]);
  });

  it("canonical と og:url は、公式の URL の、そのページの場所。og の題・説明は head の題・説明と同じ", () => {
    for (const h of pages()) {
      expect(h.all(/<link rel="canonical" href="([^"]*)"/)[0], h.file).toBe(h.url);
      expect(meta(h, "og:url")[0], h.file).toBe(h.url);
      expect(meta(h, "og:title")[0], h.file).toBe(h.all(/<title>([^<]*)<\/title>/)[0]);
      expect(meta(h, "og:description")[0], h.file).toBe(meta(h, "description")[0]);
    }
  });

  it("記事は article、ほかは website。画像は同じサイトの /og-image.png、カードは大きい画像", () => {
    for (const h of pages()) {
      // タグごとの記事の一覧のページ（articles/tags/）は記事ではなく一覧なので website
      const isArticle = /^articles\/(?!index\.html$|tags\/).+\.html$/.test(h.file);
      expect(meta(h, "og:type")[0], h.file).toBe(isArticle ? "article" : "website");
      expect(meta(h, "og:image")[0], h.file).toBe(OFFICIAL_ORIGIN + OG_IMAGE_PATH);
      expect(meta(h, "twitter:card")[0], h.file).toBe("summary_large_image");
    }
  });

  it("記事ごとに、題と説明が違う", () => {
    const arts = pages().filter((h) => h.file.startsWith("articles/"));
    const titles = new Set(arts.map((h) => h.all(/<title>([^<]*)<\/title>/)[0]));
    const descs = new Set(arts.map((h) => meta(h, "description")[0]));
    expect(titles.size).toBe(arts.length);
    expect(descs.size).toBe(arts.length);
  });

  it("題・説明に、言い切り・誇張の言い方を使わない", () => {
    const hits: string[] = [];
    for (const h of pages()) {
      const text = [...h.all(/<title>([^<]*)<\/title>/), ...meta(h, "description"), ...meta(h, "og:image:alt")].join(" ");
      for (const w of BANNED_WORDS) if (text.includes(w)) hits.push(`${h.file}：${w}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("カードの画像・sitemap.xml・robots.txt", () => {
  it("カードの画像は PNG で 1200×630、同じサイトに置く", () => {
    const png = readFileSync(path.join(out, OG_IMAGE_PATH.slice(1)));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(OG_IMAGE_SIZE.width);
    expect(png.readUInt32BE(20)).toBe(OG_IMAGE_SIZE.height);
  });

  it("sitemap.xml に、検索に載せる全ページ（検査・記事・案内）が1回ずつ入り、noindex のページは入らない", () => {
    const xml = readFileSync(path.join(out, "sitemap.xml"), "utf8");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(new Set(locs).size).toBe(locs.length);
    expect([...locs].sort()).toEqual(pages().map((h) => h.url).sort());
    for (const h of noindexPages()) expect(locs).not.toContain(h.url);
  });

  it("robots.txt は、すべてを許し、sitemap の場所を示す", () => {
    const txt = readFileSync(path.join(out, "robots.txt"), "utf8");
    expect(txt).toMatch(/^User-agent: \*$/m);
    expect(txt).toMatch(/^Allow: \/$/m);
    expect(txt).not.toMatch(/^Disallow: \/\s*$/m);
    expect(txt).toContain(`Sitemap: ${OFFICIAL_ORIGIN}/sitemap.xml`);
  });
});

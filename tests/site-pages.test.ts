// SPDX-License-Identifier: AGPL-3.0-only
//
// サイトの案内のページ（ライセンス・利用規約・お問い合わせ・よくある質問・公開前の自己点検。src/site/pages.ts と site-licenses.ts）を確かめる。
// - どのページにも同じ CSP・題・説明・canonical があり、検査のページへつながる。外を指すのは GitHub へ移るリンクだけ
// - ライセンスの一覧は、package-lock.json・docs/licenses.md・各部品のライセンスの文と食い違わない
// - 配るものに入る部品の一覧（SHIPPED_ROOTS）が、画面・ルール・片付けのコードの読み込みと食い違わない
// - 検査のページの下の帯が、サイトのページの下の帯と同じ並び

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTACT_REFERRER, cspForContactMeta, cspForMeta } from "../csp.ts";
import { NOT_FOUND_PAGE, OFFICIAL_ORIGIN } from "../htaccess.ts";
import { SHIPPED_FONT_DIR, SHIPPED_ROOTS, buildLicenses, copyrightLines, githubRepo, tableUnder } from "../site-licenses.ts";
import { renderSitemap, repoUrl, siteCss, siteFiles } from "../site.ts";
import {
  CHECKLIST_BLOCKS,
  CHECKLIST_META,
  CONTACT_BLOCKS,
  CONTACT_META,
  FAQ_BLOCKS,
  FAQ_META,
  GUIDE_PATHS,
  LICENSES_META,
  NOT_FOUND_META,
  TERMS_BLOCKS,
  TERMS_META,
  renderGuidePages,
} from "../src/site/pages.ts";
import { FOOT_LINKS, OFFICIAL_NOTE, escapeHtml, fileFor } from "../src/site/render.ts";
import type { Section } from "../src/site/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const REPO = "https://github.com/example-owner/example-repo";
const opts = { origin: OFFICIAL_ORIGIN, csp: cspForMeta, cssHref: "/assets/site.css", repoUrl: REPO };
const licenses = buildLicenses(ROOT);
const pages = renderGuidePages(opts, licenses.data);
const files = siteFiles();

describe("ページの形", () => {
  it("5 枚と 404 のページがあり、5 枚は sitemap にも並ぶ（404 は並べない）", () => {
    expect([...pages.keys()].sort()).toEqual(["404.html", "checklist.html", "contact.html", "faq.html", "licenses.html", "terms.html"]);
    for (const p of GUIDE_PATHS) {
      expect(files.has(fileFor(p)), p).toBe(true);
      expect(renderSitemap()).toContain(`<loc>${OFFICIAL_ORIGIN}${p}</loc>`);
    }
    expect(files.has("404.html")).toBe(true);
    expect(renderSitemap()).not.toContain("404.html");
  });

  it("404 のページは、.htaccess の ErrorDocument が指す場所にあり、検査のページ・記事の一覧へつながる", () => {
    expect(NOT_FOUND_PAGE).toBe(NOT_FOUND_META.path);
    const p = pages.get("404.html")!;
    expect(p).toContain("ページが見つかりません");
    expect(p).toContain('href="/articles/"');
    // どの場所の 404 でも読めるよう、CSS は / から始まる場所で読む
    expect(p).toMatch(/<link rel="stylesheet" href="\/assets\//);
  });

  it("どのページの下の帯にも、公式のサイトの場所の1文がある（検査のページも同じ文）", () => {
    for (const [name, page] of pages) expect(page, name).toContain(`<p class="site-official">${escapeHtml(OFFICIAL_NOTE)}</p>`);
    for (const [name, page] of files) if (name.endsWith(".html")) expect(page, name).toContain(escapeHtml(OFFICIAL_NOTE));
    expect(read("index.html")).toContain(`<p class="site-official">${OFFICIAL_NOTE}</p>`);
  });

  for (const [name, page] of pages) {
    it(`${name}：題・説明・canonical・CSP があり、検査のページへつながり、スクリプトがない`, () => {
      expect(page).toMatch(/<title>[^<]+｜お守りPDF<\/title>/);
      expect(page).toMatch(/<meta name="description" content="[^"]{20,}" \/>/);
      expect(page).toContain(`<link rel="canonical" href="${OFFICIAL_ORIGIN}/${name}" />`);
      // お問い合わせのページだけ、form-action 'self' だけが違う CSP（docs/contact.md）
      expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="${escapeHtml(name === "contact.html" ? cspForContactMeta : cspForMeta)}" />`);
      expect(page).toContain('href="/"');
      expect(page).not.toMatch(/<script\b|\sstyle=|\son[a-z]+=/);
      // 下の帯に、サイトの案内のリンクが全部ある
      for (const [href] of FOOT_LINKS) expect(page).toContain(`href="${href}"`);
    });

    it(`${name}：外を指すのは、GitHub へ移る <a> のリンクだけ`, () => {
      const rest = page.replace(/<link rel="canonical" href="[^"]+" \/>/, "");
      const external = [...rest.matchAll(/<(\w+)[^>]*\s(?:src|href)="((?:https?:)?\/\/[^"]*)"/g)].map((m) => [m[1], m[2]]);
      for (const [tag, url] of external) {
        expect(tag, url).toBe("a");
        expect(url).toMatch(/^https:\/\/github\.com\//);
      }
    });
  }

  it("description の長さは 40〜160 字", () => {
    for (const m of [TERMS_META, CONTACT_META, FAQ_META, CHECKLIST_META, LICENSES_META]) {
      expect(m.description.length, m.path).toBeGreaterThanOrEqual(40);
      expect(m.description.length, m.path).toBeLessThanOrEqual(160);
    }
  });

  it("リポジトリの場所が分からないときは、GitHub のリンクを出さず、文だけにする", () => {
    const none = renderGuidePages({ ...opts, repoUrl: null }, licenses.data);
    for (const [name, page] of none) expect(page, name).not.toContain("https://github.com/example-owner");
    expect(none.get("terms.html")).toContain("ソースコード（GitHub）（場所は、公式のサイトのこのページで示します）");
  });
});

describe("書き方の決まり", () => {
  const sec = (s: Section & { links?: Array<{ label: string }> }) => [s.heading, ...(s.paragraphs ?? []), ...(s.list ?? []), ...(s.steps ?? []), s.note ?? "", ...(s.links ?? []).map((l) => l.label)];
  const all = [
    ...[TERMS_META, CONTACT_META, FAQ_META, CHECKLIST_META, LICENSES_META].flatMap((m) => [m.title, m.description]),
    ...[TERMS_BLOCKS, CONTACT_BLOCKS, FAQ_BLOCKS, CHECKLIST_BLOCKS].flat().flatMap(sec),
  ];
  const NG: Array<[string, RegExp]> = [
    ["安全です", /安全です/],
    ["問題なし", /問題(なし|ありません)/],
    ["初めて", /初めて/],
    ["唯一", /唯一/],
    ["上位互換", /上位互換/],
    ["導入", /導入/],
    ["黒塗りミス", /黒塗りミス|黒塗りの不備/],
    ["外の URL", /https?:\/\/|www\./],
    ["見張り・監視", /見張|監視/],
    ["メールアドレス", /[\w.+-]+@[\w-]+\.[\w.]+/],
  ];
  for (const [label, re] of NG) {
    it(`「${label}」を使わない`, () => {
      expect(all.filter((t) => re.test(t))).toEqual([]);
    });
  }
});

describe("利用規約・お問い合わせ・よくある質問・自己点検の中身", () => {
  const page = (n: string) => pages.get(n)!;

  it("利用規約：無料・ブラウザの中だけ・保証しない・最後の確かめは利用者・AGPL・公式は1つ・禁止・変え方・運営者は空けておく", () => {
    const t = page("terms.html");
    for (const s of ["無料", "ブラウザの中だけ", "保証するものではありません", "最後の確かめは、利用者自身", "AGPL-3.0-only", "omamoripdf.com だけ", "禁止すること", "規約の変え方", "運営者：KK"]) {
      expect(t, s).toContain(s);
    }
  });

  it("利用規約：定めた日・変え方（効き始める日を前もって知らせる）・準拠法があり、免責は故意・重過失のときに責任を負うと書く", () => {
    const t = page("terms.html");
    for (const s of ["2026年11月5日", "効き始める日より前に", "日本の法律に従って解釈します", "故意または重大な過失がある場合は、法律に従って責任を負います"]) expect(t, s).toContain(s);
    // 契約の外の人（第三者）の損害まで免除する書き方はしない
    expect(t).not.toContain("第三者に生じた損害");
    expect(t).not.toContain("【定めた日");
  });

  it("プライバシー：PDF を入れたときにファイルを読み込む記録が残ることと、記録の使い方・お問い合わせの扱い・説明の変え方を書く", () => {
    const p = files.get("privacy.html")!;
    for (const s of ["検査に使うプログラムのファイルを、このサイトから読み込むことがあります", "過大な負担に対処すること", "不具合の原因を調べること", "お問い合わせで受け取るもの", "この説明の変え方"]) {
      expect(p, s).toContain(s);
    }
    // 「PDF を入れた」という操作が記録に残らない、とは言い切らない（ファイルの読み込みの記録は残りうる）
    expect(p).not.toContain("PDF を入れた、などの画面での操作");
  });

  it("お問い合わせ：同じサイトの送り先へのフォームだけ。GitHub・メールの窓口は出さない", () => {
    const c = page("contact.html");
    expect(c.match(/<form\b[^>]*>/g)).toEqual(['<form class="site-form" method="post" action="/contact-send.php" accept-charset="UTF-8">']);
    expect(c).not.toMatch(/github\.com|issues|advisories|mailto:/i);
    expect(c).toContain(`<meta name="referrer" content="${CONTACT_REFERRER}" />`);
  });

  it("お問い合わせ：種類と本文は必ず、メールアドレスは任意、名前の欄はない。人には見えない欄がある", () => {
    const c = page("contact.html");
    const radios = c.match(/<input type="radio" name="kind" value="(\w+)" required \/>/g) ?? [];
    expect(radios).toHaveLength(4);
    for (const label of ["質問", "不具合", "セキュリティの弱点", "その他"]) expect(c).toContain(`<span>${label}`);
    expect(c).toMatch(/<textarea id="contact-body" name="body" rows="8" maxlength="4000" required><\/textarea>/);
    expect(c).toMatch(/<input id="contact-email" name="email" type="email" maxlength="254"/);
    expect(c).not.toMatch(/name="email"[^>]*required/);
    expect(c).not.toMatch(/name="(name|namae|full_?name)"/);
    expect(c).toContain("（返事がほしいときだけ）");
    // 人には見えない欄：読み上げから外し、Tab でも止まらない
    expect(c).toMatch(/<div class="site-form-trap" aria-hidden="true">[\s\S]*<input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off" \/>/);
    expect(siteCss()).toMatch(/\.site-form-trap \{[^}]*left: -10000px/);
  });

  it("お問い合わせ：フォームのすぐ上に「書かないで」の注意、セキュリティの弱点には「連絡先だけ」", () => {
    const c = page("contact.html");
    const warn = c.indexOf('<p class="site-form-warn"><span aria-hidden="true">▲ </span>PDF や個人情報、見つかった字の中身は書かないでください。</p>');
    expect(warn).toBeGreaterThan(0);
    expect(c.indexOf("<form")).toBeGreaterThan(warn);
    // 注意とフォームの間に、ほかの段落を挟まない
    expect(c.slice(warn + 1, c.indexOf("<form"))).not.toMatch(/<p\b/);
    expect(c).toMatch(/セキュリティの弱点<span class="site-form-hint">弱点の詳しい中身は書かず、連絡先だけ書いてください。こちらから連絡します。<\/span>/);
  });

  it("よくある質問：10 問以上。送らないこと・サーバーの記録・「見つからなかった」の意味を答える", () => {
    expect(FAQ_BLOCKS.length).toBeGreaterThanOrEqual(10);
    const f = page("faq.html");
    for (const s of ["CSP", "外への要求を数えて", "配信先のサーバーがふつうに残す記録", "そうとは言えません", "PDF 以外", "小さく"]) expect(f, s).toContain(s);
  });

  it("今の検査の画面と食い違わない：「小さくする」はある機能として答え、画面の手順の名前（整える）を使う", () => {
    const f = page("faq.html");
    expect(f).not.toContain("小さくする機能はありません");
    expect(f).toContain("「ファイルを小さくする」");
    expect(read("index.html")).toContain("ファイルを小さくする（必要なときだけ）");
    // 画面の手順は「整える」。サイトのページで「片付ける」と書くと、画面のどこを押すのか分からなくなる
    expect(read("index.html")).toMatch(/<span class="step-name">[^<]*<span class="visually-hidden">3 <\/span>整える<\/span>/);
    for (const [name, p] of pages) expect(p, name).not.toMatch(/片付け/);
    expect(files.get("privacy.html")).not.toMatch(/片付け/);
  });

  it("自己点検：作る時・書き出す時・出す前の3段で、P1〜P12 をすべて含み、印刷用の見た目がある", () => {
    expect(CHECKLIST_BLOCKS.map((b) => b.heading).slice(1)).toEqual(["1. 作る時（元のファイル）", "2. 書き出す時（PDF にする時）", "3. 出す前（できあがった PDF）"]);
    const text = CHECKLIST_BLOCKS.flatMap((b) => b.list ?? []).join("\n");
    for (let i = 1; i <= 12; i++) expect(text, `P${i}`).toMatch(new RegExp(`P${i}(?!\\d)`));
    expect(page("checklist.html")).toContain('class="site-page site-checklist"');
    expect(siteCss()).toContain("@media print");
  });
});

describe("ライセンスの一覧（ブラウザに配るものだけ）", () => {
  const d = licenses.data;
  const lock = JSON.parse(read("package-lock.json")).packages;
  const md = read("docs/licenses.md");

  it("npm の部品は、pdf-lib・pdfjs-dist と pdf-lib の依存だけで、package-lock.json と同じ版・ライセンス", () => {
    expect(d.shipped.map((r) => r.name).sort()).toEqual(["@pdf-lib/standard-fonts", "@pdf-lib/upng", "pako", "pdf-lib", "pdfjs-dist", "tslib"]);
    for (const r of d.shipped) {
      expect(r.version, r.name).toBe(lock[`node_modules/${r.name}`].version);
      expect(r.license, r.name).toBe(lock[`node_modules/${r.name}`].license);
    }
  });

  it("開発・テスト・配信にだけ使う道具は並べない", () => {
    const l = pages.get("licenses.html")!;
    for (const name of ["@napi-rs/canvas", "@pdf-lib/fontkit", "vite", "vitest", "typescript", "subset-font", "@types/node", "actions/checkout", "lftp", "BIZ UDゴシック"]) {
      expect(l, name).not.toContain(`>${escapeHtml(name)}<`);
    }
    // 全文のファイルも、並べた部品・書体と当サービスの分だけ
    const listed = [...d.shipped, ...d.fonts].map((r) => r.textHref!.slice(1));
    expect([...licenses.files.keys()].sort()).toEqual([...listed, "licenses/AGPL-3.0.txt"].sort());
    expect([...files.keys()].filter((k) => k.startsWith("licenses/")).sort()).toEqual([...licenses.files.keys()].sort());
  });

  it("書体は、docs/licenses.md で置き場所が src/assets/ のもの（画面の書体）だけ", () => {
    const rows = tableUnder(md, "フォント・素材");
    const inDist = rows.filter((r) => SHIPPED_FONT_DIR.test(r["置き場所"]!)).map((r) => r["名前"]!.split("（")[0]!.replace(/\s+\d+(\.\d+)+$/, "").trim());
    expect(inDist).toEqual(["Noto Sans JP"]);
    expect(rows.length).toBeGreaterThan(inDist.length); // 合成 PDF の書体（fixtures/）は外れる
    expect(d.fonts.map((r) => r.name)).toEqual(inDist);
    const noto = d.fonts[0]!;
    expect(noto.version).toBe("2.004");
    expect(noto.license).toContain("SIL Open Font License 1.1");
    expect(noto.copyright.join("\n")).toContain("Copyright 2014-2021 Adobe");
    // 画面の書体は、本当に src/assets/fonts/ にある
    expect(read("src/style.css")).toMatch(/assets\/fonts\/NotoSansJP-subset\.woff2/);
  });

  it("ライセンスの全文は、部品のライセンスの文をそのまま写す", () => {
    for (const r of [...d.shipped, ...d.fonts]) {
      expect(r.textHref, r.name).not.toBeNull();
      const name = r.textHref!.slice(1);
      expect(files.get(name), name).toBe(licenses.files.get(name));
    }
    expect(files.get("licenses/pdf-lib-1.17.1.txt")).toBe(read("node_modules/pdf-lib/LICENSE.md"));
    expect(files.get("licenses/Noto-Sans-JP-OFL.txt")).toBe(read("src/assets/fonts/OFL.txt"));
    expect(files.get("licenses/AGPL-3.0.txt")).toBe(read("LICENSE"));
  });

  it("著作権の表示は、ライセンスの文にある行だけ（作らない）", () => {
    const pdfLib = d.shipped.find((r) => r.name === "pdf-lib")!;
    expect(pdfLib.copyright).toEqual(copyrightLines(read("node_modules/pdf-lib/LICENSE.md")));
    expect(pdfLib.copyright.length).toBeGreaterThan(0);
    for (const r of [...d.shipped, ...d.fonts]) {
      const text = licenses.files.get(r.textHref!.slice(1))!;
      for (const c of r.copyright) expect(text, r.name).toContain(c);
    }
    // Apache-2.0 の説明の文や、見本の行は拾わない
    expect(copyrightLines('"Licensor" shall mean the copyright owner\n   Copyright [yyyy] [name of copyright owner]\nCopyright (c) 2020 Example')).toEqual(["Copyright (c) 2020 Example"]);
  });

  it("出典のリンクは GitHub のものだけ", () => {
    for (const r of [...d.shipped, ...d.fonts]) if (r.source) expect(r.source, r.name).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/);
    expect(githubRepo("git+https://github.com/a/b.git")).toBe("https://github.com/a/b");
    expect(githubRepo({ url: "git://github.com/a/b.git" })).toBe("https://github.com/a/b");
    expect(githubRepo("a/b")).toBe("https://github.com/a/b");
    expect(githubRepo("https://gitlab.com/a/b")).toBeNull();
  });

  it("ページに、当サービスの AGPL-3.0・ソースの場所・部品の表が出る", () => {
    const l = pages.get("licenses.html")!;
    expect(l).toContain("AGPL-3.0-only");
    expect(l).toContain('href="/licenses/AGPL-3.0.txt"');
    expect(l).toContain(`href="${REPO}"`);
    expect(l).toContain('href="/licenses/Noto-Sans-JP-OFL.txt"');
    expect(l).toContain(escapeHtml("Copyright 2014-2021 Adobe"));
    expect(l).toContain("開発・テスト・配信にだけ使う道具は、このサイトのファイルに入らないので並べていません");
  });
});

describe("配るものに入る部品（SHIPPED_ROOTS）が、コードの読み込みと合う", () => {
  it("画面・ルール・片付けのコードが読み込む外の部品は、SHIPPED_ROOTS だけ", () => {
    const list = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = path.join(dir, n);
        return statSync(p).isDirectory() ? list(p) : /\.ts$/.test(n) ? [p] : [];
      });
    // Node でだけ動く所（sanitize/node・sanitize/check）は、配るものに入らない
    const files = ["src", "rules", "sanitize"].flatMap((d) => list(path.join(ROOT, d))).filter((f) => !/[\\/]sanitize[\\/](node|check)[\\/]/.test(f));
    const used = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"./][^"]*)"/g)) {
        const spec = m[1]!;
        if (spec.startsWith("node:")) continue;
        used.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
      }
    }
    expect([...used].sort()).toEqual([...SHIPPED_ROOTS].sort());
  });
});

describe("検査のページ（index.html）", () => {
  const html = read("index.html");
  it("下の帯のリンクは、サイトのページの下の帯と同じ並び", () => {
    const foot = html.match(/<footer class="site-links"[\s\S]*?<\/footer>/)![0];
    const links = [...foot.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(links).toEqual(FOOT_LINKS.map(([h, l]) => [h, l]));
  });

  it("書体と部品のライセンスは、下の帯のライセンスのページへのリンクで示す（結果の欄の一文は、2026-11-05 本人の指示で外した）", () => {
    const foot = html.match(/<footer class="site-links"[\s\S]*?<\/footer>/)![0];
    expect(foot).toContain('<a href="/licenses.html">');
    expect(html).not.toContain("© 2014-2021 Adobe");
  });
});

describe("リポジトリの場所", () => {
  it("GitHub Actions では GITHUB_REPOSITORY、手元では git の origin から取る", () => {
    expect(repoUrl({ GITHUB_REPOSITORY: "o/r" }, () => null)).toBe("https://github.com/o/r");
    expect(repoUrl({}, () => "https://github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(repoUrl({}, () => "git@github.com:o/r.git")).toBe("https://github.com/o/r");
    expect(repoUrl({}, () => "https://gitlab.com/o/r.git")).toBeNull();
    expect(repoUrl({ GITHUB_REPOSITORY: "o/r\"x" }, () => null)).toBeNull();
    expect(repoUrl({}, () => null)).toBeNull();
  });
});

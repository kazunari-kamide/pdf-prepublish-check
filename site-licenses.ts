// SPDX-License-Identifier: AGPL-3.0-only
//
// ライセンスのページ（/licenses。ファイルは licenses.html）の中身を、ビルドの時に作る（site.ts が呼ぶ。ブラウザでは動かさない）。
// - 部品の版とライセンスは package-lock.json から、著作権の表示とライセンスの全文は node_modules の各部品の
//   ライセンスの文（LICENSE など）から、そのまま写す。著作権の行が見つからないときは、作らずに「ない」とする。
// - 並べるのは、ブラウザに配るもの（dist/）に入る部品だけ。開発・テスト・配信にだけ使う道具は並べない（2026-11-05 の頼み）。
//   npm の部品：画面・ルール・片付けのコードが読み込む SHIPPED_ROOTS と、その依存（任意の依存は除く）。
//   書体：docs/licenses.md の「フォント・素材」の表で、置き場所が src/assets/ のもの。
// - ライセンスの全文は dist/license-texts/ に写して置く（外のサイトを指さない）。出典のリンクは GitHub のものだけ出す。
//   フォルダの名前を、ページの名前（licenses）と変えるのは、同じ名前だと本番の Apache が /licenses を /licenses/ へ
//   301 で移して 403 になるため（mod_dir が .htaccess の書き換えより先に効く。2026-11-05 の本番で起きた）。
//   前の場所（/licenses/*.txt）は、.htaccess で新しい場所へ 301 で移す（htaccess.ts の LICENSE_TEXTS_RULES）。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LICENSE_TEXTS_DIR } from "./htaccess.ts";
import type { LicenseData, LicenseEntry } from "./src/site/pages.ts";

/**
 * 画面（src/）・ルール（rules/）・片付け（sanitize/）が読み込むライブラリ。これとその依存が、配るもの（dist/）に入る。
 * ほかのライブラリを読み込むようにしたら、ここに足す（tests/site-pages.test.ts が、読み込みと食い違えば止める）
 */
export const SHIPPED_ROOTS = ["pdf-lib", "pdfjs-dist", "three"]; // three：記事の一覧の 3D の飾り（2026-11-05 本人が承認）

/** 書体のうち、ブラウザに配るもの（docs/licenses.md の置き場所が src/assets/ のもの） */
export const SHIPPED_FONT_DIR = /(^|[^\w/])src\/assets\//;

const GITHUB = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/[\w./%-]*)?$/;

interface LockPackage {
  version?: string;
  license?: string;
  dependencies?: Record<string, string>;
  optional?: boolean;
  dev?: boolean;
}

const slug = (s: string) => s.replace(/^@/, "").replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-|-$/g, "");

/** ライセンスの文から、著作権の行を拾う（「Copyright (c) 2019 …」の形だけ。説明の文の中の copyright は拾わない） */
export function copyrightLines(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(Copyright\s+(\(c\)|©|\(C\)|\d)|©\s*\d)/i.test(l) && !/\[yyyy\]|\[name of copyright owner\]/i.test(l));
  return [...new Set(lines)];
}

/** docs/licenses.md の、見出しのすぐ下の表を読む（行ごとのセル。` は外す） */
export function tableUnder(md: string, heading: string): Array<Record<string, string>> {
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{2,3} /.test(l) && l.replace(/^#+ /, "").startsWith(heading));
  if (at < 0) throw new Error(`docs/licenses.md に「${heading}」の見出しがありません`);
  let i = at + 1;
  while (i < lines.length && !lines[i]!.startsWith("|")) {
    if (/^#{1,3} /.test(lines[i]!)) throw new Error(`docs/licenses.md の「${heading}」の下に表がありません`);
    i++;
  }
  const cells = (l: string) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/`/g, ""));
  const head = cells(lines[i]!);
  const rows: Array<Record<string, string>> = [];
  for (i += 2; i < lines.length && lines[i]!.startsWith("|"); i++) {
    const c = cells(lines[i]!);
    rows.push(Object.fromEntries(head.map((h, k) => [h, c[k] ?? ""])));
  }
  return rows;
}

/** package.json の repository を、GitHub のリポジトリの https の場所にする（GitHub でなければ null） */
export function githubRepo(repository: unknown): string | null {
  const raw = typeof repository === "string" ? repository : (repository as { url?: unknown } | null)?.url;
  if (typeof raw !== "string") return null;
  const m = raw.match(/^(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/) ?? raw.match(/^(?:github:)?([\w.-]+)\/([\w.-]+)$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** 「名前（説明）」の説明を外す */
const beforeParen = (s: string) => s.split("（")[0]!.trim();

export interface BuiltLicenses {
  data: LicenseData;
  /** dist/ に置くライセンスの全文。鍵は dist/ の中の名前 */
  files: Map<string, string>;
}

export function buildLicenses(root: string): BuiltLicenses {
  const files = new Map<string, string>();
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")).packages as Record<string, LockPackage>;
  const md = readFileSync(path.join(root, "docs", "licenses.md"), "utf8");
  const info = (name: string) => {
    const p = lock[`node_modules/${name}`];
    if (!p) throw new Error(`package-lock.json に ${name} がありません`);
    return p;
  };

  // ライセンスの全文を写す。ないときは null
  const putText = (name: string, file: string, text: string) => {
    const out = `${LICENSE_TEXTS_DIR}/${slug(name)}-${file}`;
    files.set(out, text);
    return `/${out}`;
  };
  // 出典：docs/licenses.md の「直接の依存」の表の出典か、部品の package.json の repository（GitHub のものだけ）
  const docSource = new Map(tableUnder(md, "直接の依存").map((r) => [r["名前"] ?? "", (r["出典"] ?? "").split(/\s/)[0] ?? ""]));
  const npmSource = (name: string, dir: string): string | null => {
    const fromDoc = docSource.get(name);
    if (fromDoc && GITHUB.test(fromDoc)) return fromDoc;
    try {
      return githubRepo(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).repository);
    } catch {
      return null;
    }
  };
  const npmEntry = (name: string): LicenseEntry => {
    const p = info(name);
    const dir = path.join(root, "node_modules", name);
    const licFile = existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f)) : undefined;
    const text = licFile ? readFileSync(path.join(dir, licFile), "utf8") : null;
    return {
      name,
      version: p.version ?? "—",
      license: p.license ?? "（package-lock.json に記載なし）",
      copyright: text ? copyrightLines(text) : [],
      textHref: text ? putText(name, `${p.version}.txt`, text) : null,
      noText: text ? undefined : "部品の中にライセンスの文がありません（ライセンスの名前は package-lock.json のもの）",
      source: npmSource(name, dir),
    };
  };

  // 配るものに入る部品：SHIPPED_ROOTS と、その依存（任意の依存は除く。Node でだけ使うため）
  const shippedNames = new Set<string>();
  const walk = (name: string) => {
    if (shippedNames.has(name)) return;
    shippedNames.add(name);
    for (const dep of Object.keys(info(name).dependencies ?? {})) walk(dep);
  };
  SHIPPED_ROOTS.forEach(walk);
  const byName = (a: LicenseEntry, b: LicenseEntry) => a.name.localeCompare(b.name);
  const shipped = [...shippedNames].map(npmEntry).sort(byName);

  // 書体：docs/licenses.md の「フォント・素材」の表のうち、置き場所が src/assets/（Vite が dist/ に入れる所）のものだけ。
  // 合成 PDF にだけ使う書体（fixtures/）は、ブラウザに配らないので並べない。全文は、置き場所のフォルダの OFL.txt
  const fonts = tableUnder(md, "フォント・素材").filter((r) => SHIPPED_FONT_DIR.test(r["置き場所"] ?? "")).map((r): LicenseEntry => {
    const full = beforeParen(r["名前"] ?? "");
    const m = full.match(/^(.*?)\s+(\d+(?:\.\d+)+)$/);
    const name = m ? m[1]! : full;
    const dirs = [...(r["置き場所"] ?? "").matchAll(/[\w./-]+\//g)].map((x) => x[0]);
    const lic = dirs.map((d) => path.join(root, d, "OFL.txt")).find((f) => existsSync(f));
    if (!lic) throw new Error(`docs/licenses.md の ${name} の置き場所に、OFL.txt がありません`);
    const text = readFileSync(lic, "utf8");
    const source = (r["出典"] ?? "").split(/\s/)[0] ?? "";
    return {
      name,
      version: m ? m[2]! : "—",
      license: (r["ライセンス"] ?? "").split("。")[0]!,
      copyright: copyrightLines(text),
      textHref: putText(name, "OFL.txt", text),
      source: GITHUB.test(source) ? source : null,
    };
  });

  // この作品のライセンス
  const own = readFileSync(path.join(root, "LICENSE"), "utf8");
  files.set(`${LICENSE_TEXTS_DIR}/AGPL-3.0.txt`, own);

  if (!fonts.length) throw new Error("docs/licenses.md の「フォント・素材」に、src/assets/ に置く書体がありません");
  return { data: { ownTextHref: `/${LICENSE_TEXTS_DIR}/AGPL-3.0.txt`, shipped, fonts }, files };
}

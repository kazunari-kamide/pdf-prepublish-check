// SPDX-License-Identifier: AGPL-3.0-only
//
// 配信の手順（.github/workflows/deploy.yml）と、依存の更新・弱点の知らせ方の設定を確かめる（docs/deploy.md）。
// YAML を読む部品は入れていないので、ジョブごとに字で切り出して見る。
// - ビルドとテストのジョブは Environment・Secrets を使わず、依存のインストールのスクリプトを動かさない
// - 配信のジョブは成果物のハッシュを照らし、npm を動かさない
// - 他人の Action は、すべてコミットの SHA で固定する

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const wf = read(".github/workflows/deploy.yml");

/** jobs: の下の、2 字下げのジョブの名前から次のジョブの前まで */
function job(name: string): string {
  const lines = wf.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`ジョブ ${name} がありません`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[\w-]+:$/.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n");
}
/** run: の中身（コメントを除く）だけを集める */
const runs = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")
    .match(/run: [^\n]*|run: \|\n(?: {10,}[^\n]*\n?)*/g) ?? [];

describe("配信の手順（deploy.yml）", () => {
  const build = job("build");
  const deploy = job("deploy");

  it("ジョブは build と deploy の 2 つで、deploy は build のあとに動く", () => {
    expect([...wf.slice(wf.indexOf("\njobs:\n")).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1])).toEqual(["build", "deploy"]);
    expect(deploy).toMatch(/^ {4}needs: build$/m);
  });

  it("build は Environment・Secrets を使わず、インストールのスクリプトを動かさない", () => {
    expect(build).not.toMatch(/environment:/);
    expect(build).not.toMatch(/secrets\./);
    expect(build).toContain("run: npm ci --ignore-scripts");
    expect(build).toContain("run: npm run build");
    expect(build).toContain("run: npm test");
  });

  it("build は dist/ を、. で始まるファイル（.htaccess）も含めて成果物にし、ハッシュの一覧を出す", () => {
    expect(build).toContain("actions/upload-artifact@");
    expect(build).toMatch(/include-hidden-files: true/);
    expect(build).toMatch(/if-no-files-found: error/);
    expect(build).toContain("sha256sum > ../dist.sha256");
    expect(build).toContain("list-sha256=");
  });

  it("deploy は Environment「production」で、成果物のハッシュを照らしてから上げる", () => {
    expect(deploy).toMatch(/^ {4}environment: production$/m);
    expect(deploy).toContain("actions/download-artifact@");
    expect(deploy).toMatch(/digest-mismatch: error/);
    expect(deploy).toContain("WANT: ${{ needs.build.outputs.list-sha256 }}");
    expect(deploy).toContain("sha256sum --check --strict --quiet ../dist.sha256");
    expect(deploy.indexOf("sha256sum --check")).toBeLessThan(deploy.indexOf("lftp -c"));
  });

  it("deploy では npm を動かさない（本番の確かめは node で直接動かす）", () => {
    const cmds = runs(deploy).join("\n");
    expect(cmds).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(cmds).toContain("node scripts/check-live.mjs");
    // 本番では、検査のページ（/check。2026-11-05 に / から移した）を開く
    expect(cmds).toContain("node scripts/check-browser.mjs --url https://omamoripdf.com/check");
    expect(cmds).not.toMatch(/--url https:\/\/omamoripdf\.com\/(\s|$)/);
  });

  it("本番の確かめのスクリプトは、npm で入れる部品を読み込まない（vite は手元の preview のときだけ、あとから読む）", () => {
    for (const f of ["scripts/check-live.mjs", "scripts/check-browser.mjs"]) {
      const imports = [...read(f).matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]!);
      expect(imports.filter((s) => !s.startsWith("node:") && !s.startsWith("../")), f).toEqual([]);
    }
    expect(read("scripts/check-browser.mjs")).toContain('liveUrl ? null : await (await import("vite")).preview(');
  });

  it("他人の Action は、すべてコミットの SHA（40 字）で固定する", () => {
    const uses = [...wf.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(6);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it("動かすきっかけは main への push と手で動かすときだけ。権限は読むだけ", () => {
    const code = wf
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:$/m);
    expect(code).not.toMatch(/pull_request_target/);
    expect(code).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(code).not.toMatch(/set -x/);
  });
});

describe("依存の更新（dependabot.yml）", () => {
  const dep = read(".github/dependabot.yml");
  it("github-actions と npm の両方を、出てから 14 日たってから知らせる", () => {
    expect(dep).toMatch(/package-ecosystem: github-actions/);
    expect(dep).toMatch(/package-ecosystem: npm/);
    expect(dep.match(/default-days: 14/g)).toHaveLength(2);
  });
  it("commit-message の prefix は 50 字以内（Dependabot の決まり）", () => {
    for (const m of dep.matchAll(/prefix: "([^"]*)"/g)) expect(m[1]!.length).toBeLessThanOrEqual(50);
  });
});

describe("弱点の知らせ方・偽のサイト", () => {
  it("SECURITY.md は、お問い合わせのフォームだけを窓口にし、弱点の中身は本文に書いてもらい、メールアドレスを必ず書かせ、実物の PDF を送らせない", () => {
    const s = read("SECURITY.md");
    expect(s).toContain("お問い合わせのページ（`https://omamoripdf.com/contact`）のフォーム");
    expect(s).toContain("弱点の詳しい中身を本文に書いて");
    expect(s).toContain("メールアドレスは必ず書いてください。");
    expect(s).toContain("直すまでの間、中身を公開しないでください");
    expect(s).not.toContain("連絡先のメールアドレスだけ");
    expect(s).toContain("架空の名前・番号で作ったもの");
    // 本人が見ていない窓口（GitHub の Issues・非公開の報告）は案内しない（2026-11-05 本人が決定）
    for (const f of ["SECURITY.md", "README.md"]) expect(read(f), f).not.toMatch(/private vulnerability reporting|Report a vulnerability|Issue/);
  });
  it("偽のサイトの文書は、公式の URL と、知らせる窓口・ひな形を書く", () => {
    const f = read("docs/fake-sites.md");
    expect(f).toContain("`https://omamoripdf.com/` だけです");
    for (const w of ["セーフ ブラウジング", "フィッシング対策協議会", "JPCERT/CC", "知らせる文のひな形"]) expect(f).toContain(w);
  });
});

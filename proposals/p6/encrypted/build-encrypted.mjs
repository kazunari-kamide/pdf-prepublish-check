// SPDX-License-Identifier: AGPL-3.0-only
//
// P6（見せかけの黒塗り）の、暗号化した合成 PDF と正解データを作る案。
//   node proposals/p6/encrypted/build-encrypted.mjs   → proposals/p6/encrypted/fixtures/p6/ に書く
// fixtures/p6/ に移したら（encrypted-pdf.mjs と一緒に）、同じフォルダに書く。
//
// 暗号化は、標準のセキュリティハンドラ（V2・R3、RC4 128 ビット）。ライブラリは足さない（encrypted-pdf.mjs）。
// encrypted-pdf.mjs は tests/helpers/encrypted-pdf.mjs の写し（採点する側を、テストの側から独立させるため）。
// 中身：1ページ。「Taro Yamada」（架空の名前）の上に黒い四角を重ねた見せかけの黒塗り（四角は [15, 95, 135, 115]）。
// 日時も乱数も使わないので、何度作っても同じバイト列になる。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeEncryptedPdf } from "./encrypted-pdf.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.basename(HERE) === "p6" && path.basename(path.dirname(HERE)) === "fixtures" ? HERE : path.join(HERE, "fixtures", "p6");
const COVER = [15, 95, 135, 115];

const CASES = [
  {
    name: "p6-e01-encrypted-empty-userpw",
    description: "RC4 で暗号化（利用者のパスワードは空。開くときにパスワードを聞かれない）。中に見せかけの黒塗り",
    opts: {},
    leaks: [{ cover: "fill", rect: COVER, chars: 10 }],
  },
  {
    name: "p6-e02-encrypted-object-stream",
    description: "RC4 で、オブジェクトストリームごと暗号化（利用者のパスワードは空）。中に見せかけの黒塗り",
    opts: { objectStream: true },
    leaks: [{ cover: "fill", rect: COVER, chars: 10 }],
  },
  {
    name: "p6-e03-encrypted-user-password",
    description: "RC4 で暗号化（利用者のパスワードつき。開けない）",
    opts: { userPassword: "user-secret" },
    leaks: [],
    expected_error: "encrypted",
  },
];

mkdirSync(OUT, { recursive: true });
const hashes = [];
const rows = [];
for (const c of CASES) {
  const bytes = makeEncryptedPdf(c.opts);
  const file = `${c.name}.pdf`;
  writeFileSync(path.join(OUT, file), bytes);
  const expected = {
    file,
    description: c.description,
    pages: 1,
    leaks: c.leaks.map((l, i) => ({ id: `${c.name}#L${i + 1}`, pattern: "P6", layer: "text", cover: l.cover, page: 1, rect: l.rect, remaining: { chars: l.chars } })),
    negatives: [],
  };
  if (c.expected_error) expected.expected_error = c.expected_error;
  writeFileSync(path.join(OUT, `${c.name}.expected.json`), JSON.stringify(expected, null, 2) + "\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  hashes.push(`${sha}  ${file}`);
  rows.push(`| ${file} | ${c.description} | ${expected.leaks.length} | ${c.expected_error ?? "—"} | \`${sha.slice(0, 16)}\` |`);
}
writeFileSync(path.join(OUT, "hashes-encrypted.txt"), hashes.join("\n") + "\n");
writeFileSync(
  path.join(OUT, "index-encrypted.md"),
  `# P6（見せかけの黒塗り）の合成 PDF：暗号化したものの案の一覧

\`build-encrypted.mjs\` で作り直せる。日時も乱数も使わないので、作り直しても SHA-256 は変わらない。名前はすべて架空。

| ファイル | 何を再現しているか | 漏れ | 期待するエラー | SHA-256（先頭16桁） |
|---|---|---|---|---|
${rows.join("\n")}
`,
);
console.log(`暗号化した合成 PDF ${CASES.length} 個を ${path.relative(process.cwd(), OUT)} に書いた`);

// SPDX-License-Identifier: AGPL-3.0-only
//
// PDF.js の部品（2026-11-06 本人が決定。案 B）を、配信の中のどこに置くか。ブラウザのコードとビルドの設定（vite.config.ts）の両方が読む。
// - 部品は npm の pdfjs-dist のファイルを、手を加えずにそのまま /pdfjs/ の下に写す（scripts/check-dist.mjs が、1 バイトも違わないかを確かめる）。
// - 置くもの：
//   wasm/  … CCITT・JBIG2・JPEG 2000 の画像を解く部品の、WASM の代わりの JS（PDF.js が import() で読む。CSP の script-src 'self'）
//   cmaps/ … 字の対応表（cMap。埋め込まれていない日本語の書体の字を読み解くのに要る。PDF.js が fetch で読む。検査のページだけ connect-src 'self'）
// - 標準の書体（standard_fonts/）は置かない。PDF.js は Helvetica・Arial に Liberation の書体を使うが、Liberation は GPL 2.0 系で、
//   このリポジトリの決まり（AGPL-3.0 と両立する MIT・BSD・Apache などに限る。CLAUDE.md §10）に合わない。
//   Foxit の書体だけを置くと、Helvetica のたびに Liberation を読みに行って 404 になる。標準の書体がなくても、PDF.js は
//   代わりの書体で字を描く（埋め込みのない Helvetica の見本で、置く前と同じく描けた。2026-11-06）
// - 名前の後ろに ? などを付けない（ブラウザの拡張機能が、問い合わせの付いた要求を「送った」に数えるため）

/** 部品を置く場所（配信の根から。PDF.js には、この下のフォルダを、末尾の / 付きで渡す） */
export const PDFJS_PARTS_BASE = "/pdfjs/";

/** pdfjs-dist の中のフォルダごとに、配信に入れるファイルを決める（名前で選ぶ） */
export const PDFJS_PARTS: ReadonlyArray<{ dir: string; include: (name: string) => boolean }> = [
  { dir: "wasm", include: (n) => /^(jbig2|openjpeg)_nowasm_fallback\.js$/.test(n) || /^LICENSE_(PDFJS_)?(JBIG2|OPENJPEG)$/.test(n) },
  { dir: "cmaps", include: (n) => n.endsWith(".bcmap") || n === "LICENSE" },
];

/** PDF.js に渡す場所（末尾は /） */
export const PDFJS_WASM_URL = `${PDFJS_PARTS_BASE}wasm/`;
export const PDFJS_CMAP_URL = `${PDFJS_PARTS_BASE}cmaps/`;

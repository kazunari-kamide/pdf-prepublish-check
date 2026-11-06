// SPDX-License-Identifier: AGPL-3.0-only
//
// PDF.js の部品（2026-11-06 本人が決定。案 B）を、配信の中のどこに置くか。ブラウザのコードとビルドの設定（vite.config.ts）の両方が読む。
// - 部品は npm の pdfjs-dist のファイルを、手を加えずにそのまま /pdfjs/<版の印>/ の下に写す（scripts/check-dist.mjs が、1 バイトも違わないかを確かめる）。
//   <版の印> は、部品の中身から作るハッシュ（vite.config.ts の pdfjsPartsHash）。版が変わると場所が変わるので、長くキャッシュさせられる
//   （.htaccess で assets/ と同じ max-age=31536000, immutable。2026-11-06 本人の頼み：2 回目以降は通信で読まない）。
// - 置くもの：
//   wasm/      … CCITT・JBIG2・JPEG 2000 の画像を解く部品の、WASM の代わりの JS（PDF.js が import() で読む。CSP の script-src 'self'）
//   cmaps.mjs  … 字の対応表（cMap）169 個を 1 つにまとめたモジュール（中身は pdfjs-dist の cmaps/*.bcmap を base64 にしたもの）。
//                画面の表示が終わったあとに import() で読み、PDF.js にはメモリから渡す（PDF を入れた後に読みに行かないため。src/render/pdf-view.ts）
//   cmaps/LICENSE … cMap のライセンスの文
// - 標準の書体（standard_fonts/）は置かない。PDF.js は Helvetica・Arial に Liberation の書体を使うが、Liberation は GPL 2.0 系で、
//   このリポジトリの決まり（AGPL-3.0 と両立する MIT・BSD・Apache などに限る。CLAUDE.md §10）に合わない。
//   Foxit の書体だけを置くと、Helvetica のたびに Liberation を読みに行って 404 になる。標準の書体がなくても、PDF.js は
//   代わりの書体で字を描く（埋め込みのない Helvetica の見本で、置く前と同じく描けた。2026-11-06）
// - 名前の後ろに ? などを付けない（ブラウザの拡張機能が、問い合わせの付いた要求を「送った」に数えるため）

declare const __PDFJS_PARTS_HASH__: string | undefined;

/** 版の印（ビルドの設定が入れる。テストなど、入っていないときは "dev"） */
export const PDFJS_PARTS_HASH: string = typeof __PDFJS_PARTS_HASH__ === "string" ? __PDFJS_PARTS_HASH__ : "dev";

/** 部品を置く場所（配信の根から。PDF.js には、この下のフォルダを、末尾の / 付きで渡す） */
export const PDFJS_PARTS_BASE = `/pdfjs/${PDFJS_PARTS_HASH}/`;

/** pdfjs-dist の中のフォルダごとに、配信にそのまま写すファイルを決める（名前で選ぶ） */
export const PDFJS_PARTS: ReadonlyArray<{ dir: string; include: (name: string) => boolean }> = [
  { dir: "wasm", include: (n) => /^(jbig2|openjpeg)_nowasm_fallback\.js$/.test(n) || /^LICENSE_(PDFJS_)?(JBIG2|OPENJPEG)$/.test(n) },
  { dir: "cmaps", include: (n) => n === "LICENSE" },
];

/** 字の対応表をまとめたモジュールに入れる、pdfjs-dist の cmaps/ のファイル */
export const isBundledCmap = (name: string): boolean => name.endsWith(".bcmap");

/** PDF.js に渡す場所（末尾は /） */
export const PDFJS_WASM_URL = `${PDFJS_PARTS_BASE}wasm/`;
/** 字の対応表をまとめたモジュールの場所 */
export const PDFJS_CMAP_BUNDLE_URL = `${PDFJS_PARTS_BASE}cmaps.mjs`;

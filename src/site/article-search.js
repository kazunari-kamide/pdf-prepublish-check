// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧のページ（/articles/）でだけ動く、記事の検索。サイトのページで、ただ1つのスクリプト（tests/site.test.ts・scripts/check-dist.mjs）。
// - 探すのは、ページの中にある各記事の題・説明・タグ（data-search）だけ。通信しない（CSP の connect-src 'none' の中で動く）。
// - ページを書き換えるのは、hidden の付け外しと、件数の字（textContent）だけ。HTML として解釈させる書き方（innerHTML など）は使わない。
// - スクリプトが動かないときは、検索の欄は隠れたまま。一覧とタグの絞り込み（タグごとのページ）は、そのまま使える。
// ビルドの時に site.ts が、中身のハッシュの名前で assets/ に置く。

/** 比べるための形にそろえる（全角・半角、大文字・小文字、前後と続きの空白） */
export function normalize(s) {
  return String(s).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 探す語（空白で区切ったもの）が、すべて text に入っているか。語がなければ、すべて当たる */
export function matches(query, text) {
  const words = normalize(query).split(" ").filter(Boolean);
  const hay = normalize(text);
  return words.every((w) => hay.includes(w));
}

/** ページの検索の欄を動かす */
export function init(doc) {
  const box = doc.getElementById("article-search");
  const input = doc.getElementById("article-search-input");
  const count = doc.getElementById("article-search-count");
  if (!box || !input || !count) return;
  const items = Array.from(doc.querySelectorAll("[data-search]"));
  const sections = Array.from(doc.querySelectorAll("[data-search-section]"));
  const total = items.length;
  const update = () => {
    const q = input.value;
    let shown = 0;
    for (const li of items) {
      const hit = matches(q, li.getAttribute("data-search") ?? "");
      li.hidden = !hit;
      if (hit) shown++;
    }
    // 当たる記事が1つもない節は、見出しごと隠す
    for (const sec of sections) sec.hidden = !sec.querySelector("[data-search]:not([hidden])");
    count.textContent = normalize(q) === "" ? `${total} 本の記事` : shown === 0 ? "当てはまる記事はありませんでした" : `${total} 本のうち ${shown} 本`;
  };
  input.addEventListener("input", update);
  box.hidden = false;
  update();
}

if (typeof document !== "undefined") init(document);

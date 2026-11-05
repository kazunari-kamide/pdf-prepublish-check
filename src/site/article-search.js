// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧のページ（/articles/）でだけ動く、記事の検索と、タグの絞り込み。サイトのページで、ただ1つのスクリプト（tests/site.test.ts・scripts/check-dist.mjs）。
// - 探すのは、ページの中にある各記事の題・説明・タグ（data-search・data-tags）だけ。32 本の札は最初から全部ページにあり、通信しない（CSP の connect-src 'none' の中で動く）。
// - タグのリンク（data-tag）を押すと、ページを移らずにその場で札を絞り込み、アドレスを #slug にする（戻る・進むでも戻る）。#slug のアドレスを開くと、同じ絞り込みになる。
//   ブラウザに document.startViewTransition があれば、札が滑って並び替わる。動きを減らす設定の人には、動かさない。
// - ページを書き換えるのは、hidden と aria-current の付け外しと、件数の字（textContent。aria-live で読み上げる）だけ。HTML として解釈させる書き方（innerHTML など）は使わない。
// - スクリプトが動かないときは、検索の欄は隠れたまま。タグのリンクは、ふつうにタグごとのページ（/articles/tags/…）へ移る。
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

/** 札の data-tags（空白で区切った slug）に、tag があるか。tag が空なら、すべて当たる */
export function hasTag(tags, tag) {
  return tag === "" || String(tags ?? "").split(" ").includes(tag);
}

/** アドレスの #… から、知っているタグの slug を取る（タグの名前でもよい）。知らなければ "" */
export function tagFromHash(hash, labels) {
  let s = String(hash ?? "").replace(/^#/, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    return "";
  }
  if (labels.has(s)) return s;
  for (const [slug, label] of labels) if (label === s) return slug;
  return "";
}

/** 件数の字（読み上げにも使う） */
export function countText({ total, inTag, shown, query, label }) {
  if (normalize(query) === "") return label ? `「${label}」の記事 ${inTag} 本（${total} 本のうち）` : `${total} 本の記事`;
  if (shown === 0) return label ? `「${label}」の記事に、当てはまる記事はありませんでした` : "当てはまる記事はありませんでした";
  return label ? `「${label}」の記事 ${inTag} 本のうち ${shown} 本` : `${total} 本のうち ${shown} 本`;
}

/** ページの検索の欄と、タグの絞り込みを動かす。win がなければ（テストなど）、アドレスと動きは扱わない */
export function init(doc, win = doc.defaultView ?? undefined) {
  const box = doc.getElementById("article-search");
  const input = doc.getElementById("article-search-input");
  const count = doc.getElementById("article-search-count");
  if (!box || !input || !count) return;
  const items = Array.from(doc.querySelectorAll("[data-search]"));
  const sections = Array.from(doc.querySelectorAll("[data-search-section]"));
  const links = Array.from(doc.querySelectorAll("a[data-tag]"));
  const nav = doc.querySelector?.(".site-tag-nav") ?? null;
  const labels = new Map();
  for (const a of links) {
    const slug = a.getAttribute("data-tag") ?? "";
    if (slug !== "") labels.set(slug, a.getAttribute("data-tag-label") ?? slug);
  }
  const total = items.length;
  let tag = "";

  const update = () => {
    const q = input.value;
    let shown = 0;
    let inTag = 0;
    for (const li of items) {
      const tagged = hasTag(li.getAttribute("data-tags"), tag);
      const hit = tagged && matches(q, li.getAttribute("data-search") ?? "");
      li.hidden = !hit;
      if (tagged) inTag++;
      if (hit) shown++;
    }
    // 当たる記事が1つもない節は、見出しごと隠す
    for (const sec of sections) sec.hidden = !sec.querySelector("[data-search]:not([hidden])");
    // いま選んでいるタグ（「すべての記事」は data-tag=""）に aria-current を付ける。札の中のタグも同じ
    for (const a of links) {
      if ((a.getAttribute("data-tag") ?? "") === tag) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    count.textContent = countText({ total, inTag, shown, query: q, label: labels.get(tag) ?? "" });
  };

  const reduced = () => Boolean(win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  /** 絞り込みを変える。動かせるときは、札が滑って並び替わる */
  // 動きの途中は、まだ tag が変わっていない。戻るでは popstate と hashchange が続けて来るので、行き先（wanted）で比べる
  let wanted = tag;
  const setTag = (next, { animate = false, scroll = false } = {}) => {
    if (next === wanted) return;
    wanted = next;
    const apply = () => {
      tag = next;
      update();
      // 札の中のタグを押したときは、タグの並びが見える所まで戻る（並び替わった札を上から見られるように）
      if (scroll && nav && nav.getBoundingClientRect().top < 0) nav.scrollIntoView({ block: "start" });
    };
    if (animate && typeof doc.startViewTransition === "function" && !reduced()) {
      const t = doc.startViewTransition(apply);
      // 続けて押して前の動きが飛ばされたときの知らせ（AbortError）は、失敗ではないので受け流す（絞り込みは apply で済んでいる）
      t?.ready?.catch?.(() => {});
      t?.finished?.catch?.(() => {});
    } else apply();
  };

  input.addEventListener("input", update);
  if (win) {
    for (const a of links) {
      a.addEventListener("click", (ev) => {
        // 新しいタブで開く（Ctrl・⌘・Shift・中ボタン）ときは、ふつうのリンクのまま
        if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault();
        const next = a.getAttribute("data-tag") ?? "";
        if (next === wanted) return;
        const { pathname, search } = win.location;
        win.history.pushState(null, "", next ? `#${next}` : `${pathname}${search}`);
        setTag(next, { animate: true, scroll: !nav?.contains(a) });
      });
    }
    // 戻る・進む・アドレスの #… を書き換えたとき
    const fromAddress = () => setTag(tagFromHash(win.location.hash, labels), { animate: true });
    win.addEventListener("popstate", fromAddress);
    win.addEventListener("hashchange", fromAddress);
    tag = wanted = tagFromHash(win.location.hash, labels);
  }
  box.hidden = false;
  update();
}

if (typeof document !== "undefined") init(document);

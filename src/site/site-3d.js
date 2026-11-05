// SPDX-License-Identifier: AGPL-3.0-only
//
// 記事の一覧のページの 3D の飾りの読み込み役（とても小さく保つ。three.js は読まない）。
// - はじめは CSS の版（A：傾けた紙の束）が出ている。ページを読み終えて手が空いてから、同じサイトの 3D の描画（omamori-3d-scene.js を
//   ビルドで束ねたもの。場所は data-scene）を import() で読み、描けたら CSS の版と入れ替える。本文の表示は遅らせない。
// - 動きを減らす設定の人・WebGL が使えない端末・読み込みに失敗したときは、何もしない（CSS の版のまま）。
// - 通信のための仕組み（fetch など）は使わない。import() は、同じサイトの assets/ のファイルだけを読む（CSP の script-src 'self'）。

const hero = document.querySelector("[data-scene]");

function webglOk() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function start() {
  if (!hero) return;
  const src = hero.getAttribute("data-scene") || "";
  // 同じサイトの /assets/ の中のファイルだけ（ほかの場所は読まない）
  if (!/^\/assets\/omamori-3d-[0-9a-f]{10}\.js$/.test(src)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!webglOk()) return;
  const box = hero.querySelector(".site-hero-3d");
  if (!box) return;
  import(src)
    .then((m) => {
      if (m.mount(box)) hero.classList.add("is-3d");
    })
    .catch(() => {
      // 読めなくても、CSS の版のまま
    });
}

function later() {
  if ("requestIdleCallback" in window) window.requestIdleCallback(start, { timeout: 3000 });
  else setTimeout(start, 600);
}

if (document.readyState === "complete") later();
else window.addEventListener("load", later, { once: true });

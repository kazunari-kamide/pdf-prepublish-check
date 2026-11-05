// SPDX-License-Identifier: AGPL-3.0-only
//
// 拡張機能の確かめ用（手元だけ）。わざと要求を出す。宛先は、このページを出している手元のサーバーだけ。

const here = new URL(location.href);
const other = `${here.protocol}//localhost:${here.port}`; // 同じサーバーを別の名前で呼ぶ（別のサイトとして扱われる）
let n = 0;

function log(text) {
  const li = document.createElement("li");
  li.textContent = text;
  document.getElementById("log").append(li);
}

const actions = {
  signal: () => {
    document.documentElement.dataset.omamoriPdf = String(++n);
    log("合図を出しました");
  },
  post: () => fetch("/sink", { method: "POST", body: "a".repeat(1000) }).then(() => log("POST（同じサイト）")),
  cross: () => fetch(`${other}/sink`, { method: "POST", body: "b".repeat(2000), mode: "no-cors" }).then(() => log("POST（別のサイト）")),
  beacon: () => log(`sendBeacon：${navigator.sendBeacon("/sink", "c".repeat(300))}`),
  image: () => {
    const img = new Image();
    img.src = `/pixel.png?secret=${"d".repeat(100)}`;
    log("画像（? つき）");
  },
  load: () => fetch("/part.txt").then(() => log("部品（? なし）")),
};

for (const [id, fn] of Object.entries(actions)) {
  document.getElementById(id).addEventListener("click", () => void fn());
}

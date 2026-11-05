// SPDX-License-Identifier: AGPL-3.0-only
//
// 公式のサイトで動いているかを確かめる（CLAUDE.md §11-6）。丸写しの偽物を見分けるための目印で、守りの中心にはしない
// （コードは公開しているので、この確かめは消されれば効かない）。公式の場所は omamoripdf.com の1つだけ（CLAUDE.md §11-6）。
// 手元の開発・確かめ（npm run dev・preview、scripts/check-browser.mjs）は、手元の名前（localhost・127.0.0.1・::1）で開くので、出さない。

export const OFFICIAL_HOST = "omamoripdf.com";

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** location.hostname を受け取り、公式（または手元の開発用）なら true */
export function isOfficialHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  return h === OFFICIAL_HOST || LOCAL_HOSTS.has(h);
}

export const UNOFFICIAL_NOTE = `これは公式のサイトではありません。公式は ${OFFICIAL_HOST} です。PDF を入れる前に、アドレスを確かめてください。`;

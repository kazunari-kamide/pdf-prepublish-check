// SPDX-License-Identifier: AGPL-3.0-only
//
// 画面に出す字の整え（2026-11-05 夜のレビュー 8）。数と単位のあいだの空白を、折らない空白（U+00A0）に替える。
// 「10／か所」「164.4／KB」のように、数と単位が行の終わりと始まりに分かれないように。計算の側の文は変えず、出す直前に通す。

const UNIT = /(\d) (か所|件|字|個|種類|ページ|バイト|KB|MB|秒|dpi|%)/g;

export function keepUnits(text: string): string {
  return text.replace(UNIT, "$1 $2");
}

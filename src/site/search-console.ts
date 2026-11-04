// SPDX-License-Identifier: AGPL-3.0-only
//
// 検索エンジンの管理の道具（Google Search Console）で、このサイトの持ち主だと確かめるための印。
// 確認の方法は2つ。どちらもブラウザからの通信は増えない（検索エンジンが読みに来たときに見るだけ）。
//
// 1. メタタグ：下の GOOGLE_SITE_VERIFICATION に、渡された確認のコード（content="…" の中の値）を入れる。
//    空でなければ、ビルドの時にトップページ（index.html）の <head> に
//    <meta name="google-site-verification" content="…" /> が入る（site.ts）。
// 2. 確認のファイル：渡された googleXXXX.html を、そのまま public/ に置く。ビルドで dist/ の一番上に写る。
//    scripts/check-dist.mjs は、中身が「google-site-verification: <ファイルの名前>」の1行のときだけ、このファイルを通す。
//
// 確認のコードは秘密の値ではない（公開されるページに載る）。同じ手順で同じものをビルドできるよう、ここに書いてコミットする。

export const GOOGLE_SITE_VERIFICATION = "";

/** 確認のコードとして受け付ける字（英数字・-・_ だけ）。これ以外の字が入っていたら、ビルドを止める */
export const VERIFICATION_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;
